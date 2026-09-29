/**
 * Postgres backend configuration and instance → schema mapping.
 *
 * One database, one schema per memory instance: "default" maps to the base
 * schema, any other instanceId to `<base>_i_<slug>_<hash>` (mirrors sqlite's
 * per-instance vectors.db files).
 */

import { createHash } from "node:crypto";

export interface PostgresStoreConfig {
  /** libpq connection string, e.g. postgres://user:pass@host:5432/db. */
  url: string;
  /** Base schema; per-instance schemas derive from it. Default "tdai". */
  schema?: string;
  /** Max pool connections per URL. Default 10. */
  poolMax?: number;
}

export const DEFAULT_POSTGRES_SCHEMA = "tdai";

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** Reject anything that is not a plain lower-case identifier (schemas are interpolated, not bound). */
export function assertSchemaName(schema: string): string {
  if (!IDENT_RE.test(schema)) {
    throw new Error(`[postgres] invalid schema name ${JSON.stringify(schema)}: expected ${IDENT_RE}`);
  }
  return schema;
}

export function schemaForInstance(baseSchema: string, instanceId: string): string {
  assertSchemaName(baseSchema);
  if (!instanceId || instanceId === "default") return baseSchema;
  const slug = instanceId
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 24);
  const hash = createHash("sha256").update(instanceId).digest("hex").slice(0, 10);
  // base (≤ 26 chars kept) + "_i_" + slug + "_" + hash stays within 63.
  return assertSchemaName(`${baseSchema.slice(0, 26)}_i_${slug}_${hash}`);
}
