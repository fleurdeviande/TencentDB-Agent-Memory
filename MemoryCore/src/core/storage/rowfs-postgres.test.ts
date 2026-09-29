/**
 * The file plane on Postgres: backend selection (rowfs + pgfs is the default for
 * STORE_MODE=postgres), rowfs over PostgresMemoryStore's profile rows, and the
 * composite with a per-domain pgfs others leg. The database parts skip when
 * POSTGRES_TEST_URL does not answer.
 */
import { afterAll, describe, expect, it } from "vitest";
import { LocalBackendResolver, validateResolution } from "../backend-selection/index.js";
import type { BackendConfigSource, BackendResolution } from "../backend-selection/index.js";
import { BackendCapabilityError } from "../store/profile-row-store.js";
import { resolveFileStoreMode, resolveFileStoreOthersMode } from "../../gateway/config.js";
import { runStorageBackendContract } from "./__contract__/storage-backend.contract.js";
import { ProfileRowStorageBackend } from "./profile-row-backend.js";
import { CompositeStorageBackend } from "./composite-backend.js";
import { PostgresFSBackend } from "./postgres-fs-backend.js";
import { StorageAdapter, createScopedStorageAdapter, scopeProfileStorageView } from "./adapter.js";
import type { IStorageBackend } from "./types.js";
import { PostgresMemoryStore } from "../store/postgres/memory-store.js";
import { closeSharedPostgresPools } from "../store/postgres/client.js";
import { dropTestSchema, postgresReachable, testPool, uniqueTestSchema } from "../store/postgres/test-support.js";

const noSource: BackendConfigSource = {
  resolveVdb: () => Promise.reject(new Error("unused")),
  resolveMongo: () => Promise.reject(new Error("unused")),
  resolveCos: () => Promise.resolve(null),
};

describe("file plane selection for postgres", () => {
  it("STORE_MODE=postgres defaults to rows + pgfs; explicit overrides win", async () => {
    const pg = await new LocalBackendResolver({ deployMode: "standalone", storeMode: "postgres", source: noSource }).resolve("i");
    expect(pg.fs).toEqual({ profile: "rows", others: { kind: "pgfs", conn: null } });

    const local = await new LocalBackendResolver({
      deployMode: "standalone",
      storeMode: "postgres",
      fileStore: "local",
      source: noSource,
    }).resolve("i");
    expect(local.fs).toEqual({ profile: "files", others: { kind: "local", conn: null } });

    const rowsLocal = await new LocalBackendResolver({
      deployMode: "standalone",
      storeMode: "postgres",
      fileStore: "rowfs",
      fileStoreOthers: "local",
      source: noSource,
    }).resolve("i");
    expect(rowsLocal.fs).toEqual({ profile: "rows", others: { kind: "local", conn: null } });

    // sqlite keeps the upstream default.
    const sqlite = await new LocalBackendResolver({ deployMode: "standalone", source: noSource }).resolve("i");
    expect(sqlite.fs).toEqual({ profile: "files", others: { kind: "local", conn: null } });
  });

  it("validateResolution accepts rows/pgfs on postgres and rejects them elsewhere", () => {
    const res = (db: BackendResolution["db"], fs: BackendResolution["fs"]): BackendResolution => ({ db, fs });
    expect(() =>
      validateResolution(res({ kind: "postgres", conn: null }, { profile: "rows", others: { kind: "pgfs", conn: null } })),
    ).not.toThrow();
    expect(() =>
      validateResolution(res({ kind: "sqlite", conn: null }, { profile: "rows", others: { kind: "local", conn: null } })),
    ).toThrow(BackendCapabilityError);
    expect(() =>
      validateResolution(res({ kind: "sqlite", conn: null }, { profile: "files", others: { kind: "pgfs", conn: null } })),
    ).toThrow(/pgfs.*requires db.kind="postgres"/);
    expect(() =>
      validateResolution(res({ kind: "postgres", conn: null }, { profile: "rows", others: { kind: "mongofs", conn: null } })),
    ).toThrow(/mongofs/);
  });

  it("gateway config defaults follow STORE_MODE, explicit values stay as given", () => {
    expect(resolveFileStoreMode(undefined, "standalone")).toBe("local");
    expect(resolveFileStoreMode(undefined, "standalone", "sqlite")).toBe("local");
    expect(resolveFileStoreMode(undefined, "standalone", "postgres")).toBe("rowfs");
    expect(resolveFileStoreMode("local", "standalone", "postgres")).toBe("local");
    expect(resolveFileStoreOthersMode(undefined, "standalone", "postgres")).toBe("pgfs");
    expect(resolveFileStoreOthersMode(undefined, "service")).toBe("cos");
    expect(resolveFileStoreOthersMode("pgfs", "standalone")).toBe("pgfs");
    expect(() => resolveFileStoreOthersMode("disk", "standalone")).toThrow(/pgfs/);
  });
});

const reachable = await postgresReachable();

describe.skipIf(!reachable)("rowfs + pgfs on Postgres", () => {
  const schemas: string[] = [];

  async function freshStore(): Promise<PostgresMemoryStore> {
    const schema = uniqueTestSchema();
    schemas.push(schema);
    const store = new PostgresMemoryStore({ pool: testPool(), schema, dimensions: 0 });
    await store.init();
    return store;
  }

  afterAll(async () => {
    for (const s of schemas) await dropTestSchema(s);
    await closeSharedPostgresPools();
  });

  runStorageBackendContract(
    "rowfs over PostgresMemoryStore",
    async () => ({ backend: new ProfileRowStorageBackend({ store: await freshStore() }) }),
    { root: "scene_blocks/", supportsAppend: false },
  );

  function composite(store: PostgresMemoryStore): { adapter: StorageAdapter; others: PostgresFSBackend } {
    const others = new PostgresFSBackend({ pool: testPool(), schema: store.getSchema() });
    const backend = new CompositeStorageBackend({
      profileBackend: new ProfileRowStorageBackend({ store }),
      others,
      scopeOthers: (b: IStorageBackend, prefix: string) =>
        createScopedStorageAdapter(new StorageAdapter(b), prefix).getBackend(),
    });
    return { adapter: new StorageAdapter(backend), others };
  }

  it("profile keys become rows, every other key a pgfs object, and domains stay apart", async () => {
    const store = await freshStore();
    const { adapter, others } = composite(store);
    const teamA = scopeProfileStorageView(adapter, "profiles/team%3AA%7Cagent%3Ax/", { teamId: "A", agentId: "x" });
    const teamB = scopeProfileStorageView(adapter, "profiles/team%3AB%7Cagent%3Ax/", { teamId: "B", agentId: "x" });

    await teamA.writeFile("scene_blocks/work.md", "# A work");
    await teamA.writeFile("persona.md", "persona A");
    await teamA.writeFile(".metadata/checkpoint.json", '{"scenes_processed":1}');
    await teamB.writeFile(".metadata/checkpoint.json", '{"scenes_processed":7}');
    await adapter.appendFile("records/2026-09-29.jsonl", "{}\n");

    // Rows, not objects, for L2/L3.
    const rows = await store.queryProfiles({ teamId: "A", agentId: "x" });
    expect(rows.map((r) => [r.type, r.filename]).sort()).toEqual([
      ["l2", "work.md"],
      ["l3", "persona.md"],
    ]);
    expect(await teamB.readFile("scene_blocks/work.md")).toBeNull();

    // Each domain its own checkpoint; the instance-level JSONL stays at the root.
    expect(await teamA.readFile(".metadata/checkpoint.json")).toBe('{"scenes_processed":1}');
    expect(await teamB.readFile(".metadata/checkpoint.json")).toBe('{"scenes_processed":7}');
    const keys = (await others.listObjects("", { recursive: true })).entries.map((e) => e.key).sort();
    expect(keys).toEqual([
      "profiles/team%3AA%7Cagent%3Ax/.metadata/checkpoint.json",
      "profiles/team%3AB%7Cagent%3Ax/.metadata/checkpoint.json",
      "records/2026-09-29.jsonl",
    ]);

    // L3 discovers scopes by listing "profiles/" on the unscoped view.
    const listed = await adapter.getBackend().listObjects("profiles/", { recursive: true });
    expect(new Set(listed.entries.map((e) => e.key.split("/")[1]))).toEqual(
      new Set(["team%3AA%7Cagent%3Ax", "team%3AB%7Cagent%3Ax"]),
    );
  });

  it("without scopeOthers the composite keeps the upstream single .metadata/", async () => {
    const store = await freshStore();
    const others = new PostgresFSBackend({ pool: testPool(), schema: store.getSchema() });
    const adapter = new StorageAdapter(
      new CompositeStorageBackend({ profileBackend: new ProfileRowStorageBackend({ store }), others }),
    );
    const view = scopeProfileStorageView(adapter, "profiles/team%3AA%7Cagent%3Ax/", { teamId: "A", agentId: "x" });
    await view.writeFile(".metadata/checkpoint.json", "{}");
    expect((await others.listObjects("", { recursive: true })).entries.map((e) => e.key)).toEqual([
      ".metadata/checkpoint.json",
    ]);
  });
});
