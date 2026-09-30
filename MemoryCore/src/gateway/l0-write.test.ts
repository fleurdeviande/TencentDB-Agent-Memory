import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { IMemoryStore, L0Record } from "../core/store/types.js";
import { drainL0Embeddings, writeL0Records } from "./l0-write.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function record(i: number): L0Record {
  return {
    id: `msg-${i}`,
    sessionKey: "s1",
    sessionId: "s1",
    role: "user",
    messageText: `message ${i}`,
    recordedAt: new Date(0).toISOString(),
    timestamp: 0,
  };
}

interface FakeStore {
  store: IMemoryStore;
  inserted: string[];
  upserts: Array<{ id: string; withEmbedding: boolean }>;
  updated: string[];
}

function fakeStore(opts: { deferred: boolean; batch: boolean }): FakeStore {
  const inserted: string[] = [];
  const upserts: Array<{ id: string; withEmbedding: boolean }> = [];
  const updated: string[] = [];
  const store = {
    supportsDeferredEmbedding: opts.deferred,
    upsertL0: async (r: L0Record, emb?: Float32Array) => {
      upserts.push({ id: r.id, withEmbedding: emb !== undefined });
      return true;
    },
    ...(opts.batch ? { insertL0Batch: async (rs: L0Record[]) => { inserted.push(...rs.map((r) => r.id)); return rs.length; } } : {}),
    ...(opts.deferred ? { updateL0Embedding: async (id: string) => { updated.push(id); return true; } } : {}),
  } as unknown as IMemoryStore;
  return { store, inserted, upserts, updated };
}

function slowEmbedding(delayMs: number, failOn?: string): EmbeddingService & { calls: number } {
  const svc = {
    calls: 0,
    async embed(text: string) {
      svc.calls++;
      await new Promise((r) => setTimeout(r, delayMs));
      if (text === failOn) throw new Error("boom");
      return new Float32Array([1, 0]);
    },
    async embedBatch(texts: string[]) {
      return Promise.all(texts.map((t) => svc.embed(t)));
    },
    getDimensions: () => 2,
  };
  return svc as unknown as EmbeddingService & { calls: number };
}

afterEach(async () => {
  await drainL0Embeddings();
});

describe("writeL0Records", () => {
  it("deferred store: writes rows without waiting for embeddings, then fills vectors in the background", async () => {
    const fake = fakeStore({ deferred: true, batch: true });
    const embedding = slowEmbedding(200);
    const records = Array.from({ length: 5 }, (_, i) => record(i));

    const t0 = Date.now();
    await writeL0Records(fake.store, embedding, records, logger);
    // Five serial embeds would take ~1s; the write must not wait for any of them.
    expect(Date.now() - t0).toBeLessThan(150);
    expect(fake.inserted).toEqual(records.map((r) => r.id));
    expect(fake.updated).toEqual([]);

    await drainL0Embeddings();
    expect(fake.updated).toEqual(records.map((r) => r.id));
  });

  it("deferred store without batch insert: metadata-only upserts", async () => {
    const fake = fakeStore({ deferred: true, batch: false });
    await writeL0Records(fake.store, slowEmbedding(0), [record(1), record(2)], logger);
    expect(fake.upserts).toEqual([
      { id: "msg-1", withEmbedding: false },
      { id: "msg-2", withEmbedding: false },
    ]);
    await drainL0Embeddings();
    expect(fake.updated).toEqual(["msg-1", "msg-2"]);
  });

  it("one failing embedding does not drop the others", async () => {
    const fake = fakeStore({ deferred: true, batch: true });
    const records = [record(1), record(2), record(3)];
    await writeL0Records(fake.store, slowEmbedding(0, "message 2"), records, logger);
    await drainL0Embeddings();
    expect(fake.updated).toEqual(["msg-1", "msg-3"]);
  });

  it("store without deferred embedding keeps the inline embed + upsert path", async () => {
    const fake = fakeStore({ deferred: false, batch: true });
    const embedding = slowEmbedding(0);
    await writeL0Records(fake.store, embedding, [record(1)], logger);
    expect(embedding.calls).toBe(1);
    expect(fake.upserts).toEqual([{ id: "msg-1", withEmbedding: true }]);
    expect(fake.inserted).toEqual([]);
  });

  it("no embedding service: batch insert", async () => {
    const fake = fakeStore({ deferred: true, batch: true });
    await writeL0Records(fake.store, undefined, [record(1)], logger);
    await drainL0Embeddings();
    expect(fake.inserted).toEqual(["msg-1"]);
    expect(fake.updated).toEqual([]);
  });
});
