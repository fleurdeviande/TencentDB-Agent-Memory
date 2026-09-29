/**
 * Test DB factory. Default: in-memory SQLite (upstream behaviour).
 * `KNOWLEDGE_TEST_DB_URL=postgres://…` runs the same suites on Postgres, each DB in its own
 * throw-away schema so parallel runs never collide; dispose() drops only that schema.
 */

import { randomBytes } from "node:crypto";
import pg from "pg";

import { isPostgresUrl, openKnowledgeDb, type KnowledgeDb } from "../db/client.js";

export const TEST_DB_URL = process.env.KNOWLEDGE_TEST_DB_URL?.trim() || "";
export const TEST_DIALECT = isPostgresUrl(TEST_DB_URL) ? "postgres" : "sqlite";

export interface TestDb extends KnowledgeDb {
  /** Postgres schema of this DB (undefined on SQLite). */
  schema?: string;
  dispose(): Promise<void>;
}

export function uniqueSchemaName(): string {
  return `kt_${process.pid}_${randomBytes(4).toString("hex")}`;
}

export async function dropSchema(url: string, schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // schema comes from uniqueSchemaName(): a safe identifier.
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}

export async function createTestDb(): Promise<TestDb> {
  if (TEST_DIALECT === "sqlite") {
    const kdb = await openKnowledgeDb({ path: ":memory:" });
    return { ...kdb, dispose: () => kdb.close() };
  }
  const schema = uniqueSchemaName();
  const kdb = await openKnowledgeDb({ url: TEST_DB_URL, path: "", schema, poolMax: 4 });
  return {
    ...kdb,
    schema,
    dispose: async () => {
      await kdb.close();
      await dropSchema(TEST_DB_URL, schema);
    },
  };
}
