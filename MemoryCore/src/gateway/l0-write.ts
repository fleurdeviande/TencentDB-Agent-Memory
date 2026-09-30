/**
 * L0 write path of `/v2|v3/conversation/add`.
 *
 * Embedding every message inline made one 100-message add take ~45 s against a remote
 * embedding service — longer than the Claude Code hook waits, so the hook retried and
 * wrote the same batch again. Stores that support deferred embedding (postgres, sqlite)
 * now get the rows first and the vectors from a background task, as auto-capture does.
 */

import type { EmbeddingService } from "../core/store/embedding.js";
import type { IMemoryStore, L0Record } from "../core/store/types.js";
import type { Logger } from "../core/types.js";

const TAG = "[l0-write]";

const pending = new Set<Promise<void>>();

/** Wait for every background L0 embedding started so far (tests, graceful shutdown). */
export async function drainL0Embeddings(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

export async function writeL0Records(
  store: IMemoryStore,
  embedding: EmbeddingService | undefined,
  records: L0Record[],
  logger: Logger,
): Promise<void> {
  const deferred = embedding !== undefined
    && store.supportsDeferredEmbedding === true
    && typeof store.updateL0Embedding === "function";

  if (!embedding || deferred) {
    if (store.insertL0Batch) {
      await store.insertL0Batch(records);
    } else {
      for (const record of records) await store.upsertL0(record, undefined);
    }
    if (deferred && records.length > 0) scheduleEmbeddings(store, embedding, records, logger);
    return;
  }

  // Stores that need the vector up front (tcvdb and friends).
  for (const record of records) {
    let emb: Float32Array | undefined;
    try {
      emb = await embedding.embed(record.messageText);
    } catch (e) {
      logger.warn(`${TAG} L0 embedding failed for ${record.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await store.upsertL0(record, emb);
  }
}

function scheduleEmbeddings(store: IMemoryStore, embedding: EmbeddingService, records: L0Record[], logger: Logger): void {
  const task = (async () => {
    const t0 = Date.now();
    let updated = 0;
    for (const record of records) {
      try {
        const emb = await embedding.embed(record.messageText);
        if (await store.updateL0Embedding!(record.id, emb)) updated++;
      } catch (e) {
        logger.warn(`${TAG} background L0 embedding failed for ${record.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    logger.debug?.(`${TAG} background L0 embedding: ${updated}/${records.length} vectors in ${Date.now() - t0}ms`);
  })();
  pending.add(task);
  void task.finally(() => pending.delete(task));
}
