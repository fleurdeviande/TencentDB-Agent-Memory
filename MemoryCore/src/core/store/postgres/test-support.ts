/**
 * Test helpers for the Postgres backend: every test gets its own throw-away
 * schema, so parallel runs never collide. Only schemas created here are dropped.
 */

import { randomBytes } from "node:crypto";
import pg from "pg";
import type { Pool } from "pg";
import { getSharedPostgresPool, qi } from "./client.js";

export const TEST_POSTGRES_URL =
  process.env.POSTGRES_TEST_URL || process.env.POSTGRES_URL || "postgres://tdai:tdai-dev@127.0.0.1:55432/tdai";

/** True when the test database answers; suites skip otherwise. */
export async function postgresReachable(url = TEST_POSTGRES_URL): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function uniqueTestSchema(prefix = "tdai_test"): string {
  return `${prefix}_${process.pid}_${randomBytes(4).toString("hex")}`;
}

export function testPool(): Pool {
  return getSharedPostgresPool(TEST_POSTGRES_URL, 4);
}

export async function dropTestSchema(schema: string): Promise<void> {
  if (!schema.startsWith("tdai_test_")) throw new Error(`refusing to drop non-test schema ${schema}`);
  await testPool().query(`DROP SCHEMA IF EXISTS ${qi(schema)} CASCADE`);
}
