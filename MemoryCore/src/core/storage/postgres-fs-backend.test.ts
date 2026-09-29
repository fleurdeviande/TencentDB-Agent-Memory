/**
 * PostgresFSBackend: the shared IStorageBackend contract plus pgfs specifics
 * (atomic appends, chunking, metadata, instance schema isolation).
 * Needs a reachable Postgres (POSTGRES_TEST_URL); skipped otherwise.
 */
import { afterAll, describe, expect, it } from "vitest";
import { runStorageBackendContract } from "./__contract__/storage-backend.contract.js";
import { PostgresFSBackend } from "./postgres-fs-backend.js";
import { closeSharedPostgresPools } from "../store/postgres/client.js";
import { dropTestSchema, postgresReachable, testPool, uniqueTestSchema } from "../store/postgres/test-support.js";

const reachable = await postgresReachable();

async function freshBackend(): Promise<{ backend: PostgresFSBackend; cleanup: () => Promise<void> }> {
  const backend = new PostgresFSBackend({ pool: testPool(), schema: uniqueTestSchema() });
  await backend.init();
  return { backend, cleanup: () => dropTestSchema(backend.getSchema()) };
}

if (!reachable) {
  describe.skip("PostgresFSBackend (no database)", () => {
    it("skipped", () => undefined);
  });
} else {
  afterAll(async () => {
    await closeSharedPostgresPools();
  });

  runStorageBackendContract("pgfs", freshBackend);
  runStorageBackendContract("pgfs under a prefix", freshBackend, { root: "profiles/team%3At/" });

  describe("PostgresFSBackend specifics", () => {
    it("concurrent appends to one key all land, none interleaved", async () => {
      const { backend, cleanup } = await freshBackend();
      try {
        const lines = Array.from({ length: 50 }, (_, i) => `line-${String(i).padStart(2, "0")}\n`);
        await Promise.all(lines.map((l) => backend.appendObject("records/2026-09-29.jsonl", l)));
        const obj = await backend.getObject("records/2026-09-29.jsonl");
        const got = obj!.content.toString().split("\n").filter(Boolean).sort();
        expect(got).toEqual(lines.map((l) => l.trim()));
        expect(obj!.size).toBe(lines.join("").length);
      } finally {
        await cleanup();
      }
    });

    it("chunks large objects and reassembles them byte for byte", async () => {
      const { backend, cleanup } = await freshBackend();
      try {
        const big = Buffer.alloc(2.5 * 1024 * 1024);
        for (let i = 0; i < big.length; i++) big[i] = i % 251;
        await backend.putObject("skills/s1/blob.bin", big);
        await backend.appendObject("skills/s1/blob.bin", Buffer.from([1, 2, 3]));
        const obj = await backend.getObject("skills/s1/blob.bin");
        expect(obj!.content.equals(Buffer.concat([big, Buffer.from([1, 2, 3])]))).toBe(true);
        const chunks = await testPool().query(
          `SELECT count(*)::int AS n FROM "${backend.getSchema()}".fs_chunks WHERE key = $1`,
          ["skills/s1/blob.bin"],
        );
        expect(chunks.rows[0].n).toBe(4);

        await backend.putObject("skills/s1/blob.bin", "small");
        expect((await backend.getObject("skills/s1/blob.bin"))!.content.toString()).toBe("small");
      } finally {
        await cleanup();
      }
    });

    it("keeps contentType/metadata across a put without them, and drops chunks on delete", async () => {
      const { backend, cleanup } = await freshBackend();
      try {
        await backend.putObject(".metadata/checkpoint.json", "{}", { contentType: "application/json", metadata: { a: "1" } });
        await backend.putObject(".metadata/checkpoint.json", '{"v":2}');
        const obj = await backend.getObject(".metadata/checkpoint.json");
        expect(obj!.contentType).toBe("application/json");
        expect(obj!.metadata).toEqual({ a: "1" });
        expect(obj!.content.toString()).toBe('{"v":2}');

        expect(await backend.deleteByPrefix(".metadata/")).toBe(1);
        const left = await testPool().query(`SELECT count(*)::int AS n FROM "${backend.getSchema()}".fs_chunks`);
        expect(left.rows[0].n).toBe(0);
      } finally {
        await cleanup();
      }
    });

    it("an empty object round-trips and appending to a missing key creates it", async () => {
      const { backend, cleanup } = await freshBackend();
      try {
        await backend.putObject("empty.txt", "");
        const empty = await backend.getObject("empty.txt");
        expect(empty!.content.length).toBe(0);
        expect(await backend.exists("empty.txt")).toBe(true);
        await backend.appendObject("conversations/new.jsonl", "a\n");
        expect((await backend.getObject("conversations/new.jsonl"))!.content.toString()).toBe("a\n");
      } finally {
        await cleanup();
      }
    });

    it("rejects traversal, absolute and NUL keys", async () => {
      const { backend, cleanup } = await freshBackend();
      try {
        await expect(backend.putObject("../x", "a")).rejects.toThrow(/traversal/);
        await expect(backend.putObject("/abs", "a")).rejects.toThrow(/relative/);
        await expect(backend.getObject("a\0b")).rejects.toThrow(/NUL/);
        await expect(backend.putObject("", "a")).rejects.toThrow(/invalid/);
      } finally {
        await cleanup();
      }
    });

    it("two instance schemas do not see each other's objects", async () => {
      const a = await freshBackend();
      const b = await freshBackend();
      try {
        await a.backend.putObject("persona-notes.md", "A");
        expect(await b.backend.exists("persona-notes.md")).toBe(false);
        expect((await b.backend.listObjects("", { recursive: true })).entries).toEqual([]);
      } finally {
        await a.cleanup();
        await b.cleanup();
      }
    });
  });
}
