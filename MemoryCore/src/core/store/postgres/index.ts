/**
 * Wiring helpers shared by store/factory.ts (core path) and store/store-pool.ts
 * (gateway, per instance).
 */

import type { EmbeddingConfig, MemoryTdaiConfig } from "../../../config.js";
import type { StoreLogger } from "../types.js";
import { createEmbeddingService, NoopEmbeddingService } from "../embedding.js";
import type { EmbeddingService } from "../embedding.js";
import { PostgresMemoryStore } from "./memory-store.js";
import { describePostgresUrl, resolvePostgresStoreConfig, schemaForInstance } from "./config.js";

export { PostgresMemoryStore } from "./memory-store.js";
export { closeSharedPostgresPools, getSharedPostgresPool } from "./client.js";
export { describePostgresUrl, resolvePostgresStoreConfig, schemaForInstance } from "./config.js";

/** Remote embedding service when configured, else Noop (keyword-only), same rules as the sqlite path. */
export function createPostgresEmbeddingService(emb: EmbeddingConfig, logger?: StoreLogger): EmbeddingService {
  if (!emb.enabled || emb.provider === "local" || emb.provider === "none" || !emb.apiKey) {
    return new NoopEmbeddingService() as unknown as EmbeddingService;
  }
  return createEmbeddingService(
    {
      provider: emb.provider,
      baseUrl: emb.baseUrl,
      apiKey: emb.apiKey,
      model: emb.model,
      schemaIdentity: emb.schemaIdentity,
      modelRevision: emb.modelRevision,
      normalization: emb.normalization,
      dimensions: emb.dimensions,
      sendDimensions: emb.sendDimensions,
      maxInputChars: emb.maxInputChars,
      maxInputTokens: emb.maxInputTokens,
      maxRetries: emb.maxRetries,
      retryBaseDelayMs: emb.retryBaseDelayMs,
      timeoutMs: emb.timeoutMs,
    },
    logger,
  );
}

export interface CreatedPostgresStore {
  store: PostgresMemoryStore;
  url: string;
  schema: string;
  endpoint: string;
}

/** Build (not init) the store for one instance; throws when no URL is configured. */
export function createPostgresStoreForInstance(
  config: MemoryTdaiConfig,
  instanceId: string,
  logger?: StoreLogger,
): CreatedPostgresStore {
  const { url, schema: baseSchema } = resolvePostgresStoreConfig(config.postgres);
  if (!url) {
    throw new Error("[postgres] store backend 'postgres' requires POSTGRES_URL (or memory.postgres.url)");
  }
  const schema = schemaForInstance(baseSchema, instanceId);
  const dims = config.embedding.provider === "none" ? 0 : (config.embedding.dimensions ?? 0);
  const store = new PostgresMemoryStore({ url, schema, dimensions: dims, logger });
  return { store, url, schema, endpoint: describePostgresUrl(url) };
}
