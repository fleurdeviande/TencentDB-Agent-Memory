/**
 * Shared `pg.Pool` registry keyed by connection URL, plus small SQL helpers.
 *
 * Many per-instance stores (one schema each) share one pool per URL, the same
 * way mongodb/client-pool.ts shares one MongoClient per endpoint. Stores never
 * end the pool; `closeSharedPostgresPools()` does, once, at shutdown.
 */

import pg from "pg";
import type { Pool, PoolClient } from "pg";
import { assertSchemaName } from "./config.js";

const pools = new Map<string, Pool>();

const INT8_OID = 20;

// BIGINT columns hold epoch-ms values well inside 2^53; return numbers, not strings.
// Scoped to our pools so other pg users in the process keep the driver default.
const types = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === INT8_OID && format !== "binary"
      ? (v: string) => Number(v)
      : pg.types.getTypeParser(oid, format as "text")) as typeof pg.types.getTypeParser,
};

export function getSharedPostgresPool(url: string, poolMax = 10): Pool {
  if (!url) throw new Error("[postgres] POSTGRES_URL is not set");
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: poolMax, types });
    // An idle client error must not crash the process; the next checkout reconnects.
    pool.on("error", () => {
      /* surfaced on the next query */
    });
    pools.set(url, pool);
  }
  return pool;
}

export async function closeSharedPostgresPools(): Promise<void> {
  const all = [...pools.values()];
  pools.clear();
  await Promise.allSettled(all.map((p) => p.end()));
}

/** Double-quote a validated identifier. */
export function qi(ident: string): string {
  return `"${assertSchemaName(ident)}"`;
}

export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may be gone */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Collects positional parameters: `p.add(v)` returns "$n". */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** pgvector text literal; callers cast with `::vector`. */
export function toVectorLiteral(v: Float32Array | number[]): string {
  return `[${Array.from(v).join(",")}]`;
}

export function isUsableVector(v: Float32Array | undefined, dims: number): v is Float32Array {
  if (!v || v.length !== dims) return false;
  let nonZero = false;
  for (const x of v) {
    if (!Number.isFinite(x)) return false;
    if (x !== 0) nonZero = true;
  }
  return nonZero;
}

/**
 * Extract the query tokens from an FTS5 MATCH expression (`"a" OR "b"`) as
 * produced by buildFtsQuery; falls back to whitespace splitting for raw text.
 */
export function ftsQueryToTokens(ftsQuery: string): string[] {
  const quoted = [...ftsQuery.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
  const tokens =
    quoted.length > 0 ? quoted : ftsQuery.split(/\s+/).filter((t) => t && t !== "OR" && t !== "AND" && t !== "NOT");
  return [...new Set(tokens)];
}

/** ts_rank_cd (all weights 1) → 0..1 with the same r/(1+r) transform as bm25RankToScore. */
export function tsRankToScore(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  return rank / (1 + rank);
}
