/**
 * Selecting the postgres backend: config parsing, backend resolution,
 * StorePool per-instance schemas and the core factory. SQLite stays the default.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../../config.js";
import { LocalBackendResolver, dbChoiceToStoreConfigs } from "../../backend-selection/index.js";
import type { BackendConfigSource } from "../../backend-selection/index.js";
import { createStoreBundle } from "../factory.js";
import { StorePool } from "../store-pool.js";
import { closeSharedPostgresPools } from "./client.js";
import { schemaForInstance } from "./config.js";
import { PostgresMemoryStore } from "./memory-store.js";
import { TEST_POSTGRES_URL, dropTestSchema, postgresReachable, uniqueTestSchema } from "./test-support.js";

const reachable = await postgresReachable();

const noSource: BackendConfigSource = {
  resolveVdb: () => Promise.reject(new Error("unused")),
  resolveMongo: () => Promise.reject(new Error("unused")),
  resolveCos: () => Promise.resolve(null),
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("postgres backend selection", () => {
  it("parseConfig keeps sqlite as the default and accepts storeBackend=postgres", () => {
    expect(parseConfig({}).storeBackend).toBe("sqlite");
    const cfg = parseConfig({ storeBackend: "postgres", postgres: { url: "postgres://h/db", schema: "mem" } });
    expect(cfg.storeBackend).toBe("postgres");
    expect(cfg.postgres).toEqual({ url: "postgres://h/db", schema: "mem" });
  });

  it("LocalBackendResolver maps STORE_MODE=postgres to a conn-less db choice", async () => {
    const pg = new LocalBackendResolver({ deployMode: "standalone", storeMode: "postgres", source: noSource });
    const res = await pg.resolve("inst-1");
    expect(res.db).toEqual({ kind: "postgres", conn: null });
    expect(dbChoiceToStoreConfigs(res.db)).toEqual({ vdbConfig: null, mongoConfig: null });

    const dflt = new LocalBackendResolver({ deployMode: "standalone", source: noSource });
    expect((await dflt.resolve("inst-1")).db.kind).toBe("sqlite");
  });

  it("createStoreBundle builds a PostgresMemoryStore on the base schema", () => {
    vi.stubEnv("POSTGRES_URL", "postgres://u:secret@db.example:5433/tdai");
    vi.stubEnv("POSTGRES_SCHEMA", "");
    const cfg = parseConfig({ storeBackend: "postgres" });
    const bundle = createStoreBundle(cfg, { dataDir: "/tmp/unused" });
    expect(bundle.store).toBeInstanceOf(PostgresMemoryStore);
    expect((bundle.store as PostgresMemoryStore).getSchema()).toBe("tdai");
    expect(bundle.storeSnapshot).toEqual({
      type: "postgres",
      postgresEndpoint: "db.example:5433/tdai",
      postgresSchema: "tdai",
    });
  });

  it("createStoreBundle fails fast without a URL", () => {
    vi.stubEnv("POSTGRES_URL", "");
    expect(() => createStoreBundle(parseConfig({ storeBackend: "postgres" }), { dataDir: "/tmp/unused" })).toThrow(
      /POSTGRES_URL/,
    );
  });
});

describe.skipIf(!reachable)("StorePool in postgres mode", () => {
  const base = uniqueTestSchema();
  const created = [base, schemaForInstance(base, "inst-x")];

  afterAll(async () => {
    for (const s of created) await dropTestSchema(s);
    await closeSharedPostgresPools();
  });

  it("serves one initialised schema per instance and caches it", async () => {
    vi.stubEnv("POSTGRES_URL", TEST_POSTGRES_URL);
    vi.stubEnv("POSTGRES_SCHEMA", base);
    const pool = new StorePool({ mode: "postgres", memoryCfg: parseConfig({ storeBackend: "postgres" }), logger });
    pool.setGraceCloseDelay(0);

    const dflt = await pool.getStore("default", null, null);
    const other = await pool.getStore("inst-x", null, null);
    expect(dflt.store).toBeInstanceOf(PostgresMemoryStore);
    expect((dflt.store as PostgresMemoryStore).getSchema()).toBe(base);
    expect((other.store as PostgresMemoryStore).getSchema()).toBe(created[1]);
    expect(dflt.store.isDegraded()).toBe(false);

    await dflt.store.upsertL0({
      id: "m1",
      sessionKey: "sk",
      sessionId: "sid",
      role: "user",
      messageText: "hello",
      recordedAt: new Date().toISOString(),
      timestamp: Date.now(),
    });
    expect(await dflt.store.countL0()).toBe(1);
    expect(await other.store.countL0()).toBe(0);
    expect((await pool.getStore("default", null, null)).store).toBe(dflt.store);
  });
});
