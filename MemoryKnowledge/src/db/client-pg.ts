/**
 * Postgres side of `openKnowledgeDb`: pg.Pool + drizzle node-postgres + idempotent DDL.
 */

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as pgSchema from "./schema.pg.js";
import { migratePg, PG_SCHEMA_RE } from "./migrate-pg.js";
import type { Db, KnowledgeDb, KnowledgeTables } from "./client.js";
import { createLogger } from "../logger.js";

const log = createLogger("db-pg");

export interface OpenPostgresOptions {
  url: string;
  schema?: string;
  poolMax?: number;
  autoMigrate?: boolean;
}

export async function openPostgresDb(opts: OpenPostgresOptions): Promise<KnowledgeDb> {
  const schema = opts.schema?.trim() || undefined;
  if (schema && !PG_SCHEMA_RE.test(schema)) {
    throw new Error(`KNOWLEDGE_DB_SCHEMA must match ${PG_SCHEMA_RE}: ${schema}`);
  }

  const pool = new pg.Pool({
    connectionString: opts.url,
    max: opts.poolMax ?? 10,
    // Every pooled connection resolves unqualified table names in our schema.
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  // An idle client dropping (Postgres restart) must not crash the process; the pool reconnects.
  pool.on("error", (err) => log.warn(`idle Postgres client error: ${err.message}`));

  try {
    if (opts.autoMigrate !== false) await migratePg(pool, schema);
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }

  const orm = drizzle(pool, { schema: pgSchema });
  const tables: KnowledgeTables = {
    knowledgeCodeGraph: pgSchema.knowledgeCodeGraph,
    knowledgeWiki: pgSchema.knowledgeWiki,
    knowledgeWikiAudit: pgSchema.knowledgeWikiAudit,
    knowledgeCodeGraphAudit: pgSchema.knowledgeCodeGraphAudit,
    knowledgeGitCredential: pgSchema.knowledgeGitCredential,
    knowledgeGitCredentialAudit: pgSchema.knowledgeGitCredentialAudit,
    llmBinding: pgSchema.llmBinding,
  } as unknown as KnowledgeTables;

  return {
    dialect: "postgres",
    // Same builder surface as the SQLite db for everything the stores use; see KnowledgeDb.
    orm: orm as unknown as Db,
    tables,
    close: () => pool.end(),
  };
}
