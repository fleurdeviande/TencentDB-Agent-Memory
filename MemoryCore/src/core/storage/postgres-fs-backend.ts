/**
 * PostgresFSBackend (`pgfs`) — general-purpose IStorageBackend over Postgres rows.
 *
 * The Postgres counterpart of MongoFSBackend: every key the file plane writes
 * outside the profile space (checkpoints, `.metadata/*`, generation logs,
 * JSONL shards, skill resources, …) lives in the instance's own schema, so
 * `STORE_MODE=postgres` needs no data directory. Mounted as the rowfs
 * composite's others leg (`FILE_STORE_OTHERS=pgfs`).
 *
 * Data model (component "files" in `<schema>.schema_migrations`):
 *   fs_objects (key PK, size, next_seq, version, content_type, metadata, updated_at_ms)
 *   fs_chunks  (key → fs_objects ON DELETE CASCADE, seq, data BYTEA)
 *
 * Every write is one transaction. The object row is upserted first, which
 * takes its row lock, so concurrent appends to one key serialise and get
 * disjoint, ordered seq ranges; a put replaces the chunks atomically. Reads are
 * a single statement, i.e. one snapshot: a reader never sees a half-written
 * put. That is what the local backend gets from O_APPEND and tmp+rename.
 *
 * Semantics mirror LocalStorageBackend/MongoFSBackend (the contract's
 * reference): put replaces, append appends, prefixes are string prefixes.
 */

import type { Pool, PoolClient } from "pg";
import { getSharedPostgresPool, qi, withTransaction } from "../store/postgres/client.js";
import { assertSchemaName } from "../store/postgres/config.js";
import { type Migration, runMigrations } from "../store/postgres/migrations.js";
import { pageEntries } from "./list-page.js";
import type {
  IStorageBackend,
  ListEntry,
  ListObjectsOptions,
  ListResult,
  PutObjectOptions,
  StorageLogger,
  StorageObject,
} from "./types.js";

const TAG = "[storage][pgfs]";

/** Content chunk size; keeps single BYTEA values and wire messages small. */
const CHUNK_SIZE = 1024 * 1024;

export const PGFS_COMPONENT = "files";

export const PGFS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "file plane objects and chunks",
    sql: (s) => `
      CREATE TABLE IF NOT EXISTS ${s}.fs_objects (
        key TEXT COLLATE "C" PRIMARY KEY,
        size BIGINT NOT NULL DEFAULT 0,
        next_seq INTEGER NOT NULL DEFAULT 0,
        version BIGINT NOT NULL DEFAULT 0,
        content_type TEXT,
        metadata JSONB,
        updated_at_ms BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${s}.fs_chunks (
        key TEXT COLLATE "C" NOT NULL REFERENCES ${s}.fs_objects (key) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        data BYTEA NOT NULL,
        PRIMARY KEY (key, seq)
      );`,
  },
];

export interface PostgresFSBackendOptions {
  /** Instance schema (the same one the instance's memory store uses). */
  schema: string;
  /** Connection URL; the shared pool per URL is used. Ignored when `pool` is given. */
  url?: string;
  pool?: Pool;
  logger?: StorageLogger;
}

interface ObjectRow {
  size: number;
  content_type: string | null;
  metadata: Record<string, string> | null;
  updated_at_ms: number;
  seq: number | null;
  data: Buffer | null;
}

function toBuffer(content: string | Buffer): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf-8") : content;
}

function splitChunks(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < buf.length; off += CHUNK_SIZE) out.push(buf.subarray(off, off + CHUNK_SIZE));
  return out;
}

export class PostgresFSBackend implements IStorageBackend {
  readonly type = "pgfs" as const;

  private readonly pool: Pool;
  private readonly schema: string;
  private readonly s: string;
  private readonly logger?: StorageLogger;
  private initPromise: Promise<void> | null = null;

  constructor(opts: PostgresFSBackendOptions) {
    this.schema = assertSchemaName(opts.schema);
    this.s = qi(this.schema);
    this.pool = opts.pool ?? getSharedPostgresPool(opts.url ?? "");
    this.logger = opts.logger;
  }

  getSchema(): string {
    return this.schema;
  }

  /** Idempotent migration, lazy on first use; a failed init is retried by the next call. */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = runMigrations(this.pool, this.schema, PGFS_COMPONENT, PGFS_MIGRATIONS).then(
        () => undefined,
        (err) => {
          this.initPromise = null;
          throw err;
        },
      );
    }
    return this.initPromise;
  }

  private validateKey(key: string): void {
    if (!key || typeof key !== "string") {
      throw new Error(`${TAG} invalid storage key: ${JSON.stringify(key)}`);
    }
    if (key.includes("\0")) throw new Error(`${TAG} storage key must not contain NUL character`);
    if (key.startsWith("/") || key.startsWith("\\")) {
      throw new Error(`${TAG} storage key must be relative, got absolute: ${key}`);
    }
    if (key.split(/[\\/]/).includes("..")) throw new Error(`${TAG} path traversal rejected: ${key}`);
  }

  private async insertChunks(c: PoolClient, key: string, chunks: Buffer[], baseSeq: number): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      await c.query(`INSERT INTO ${this.s}.fs_chunks (key, seq, data) VALUES ($1, $2, $3)`, [key, baseSeq + i, chunks[i]]);
    }
  }

  async putObject(key: string, content: string | Buffer, opts?: PutObjectOptions): Promise<void> {
    this.validateKey(key);
    await this.init();
    const buf = toBuffer(content);
    const chunks = splitChunks(buf);
    const metadata = opts?.metadata && Object.keys(opts.metadata).length > 0 ? JSON.stringify(opts.metadata) : null;

    await withTransaction(this.pool, async (c) => {
      // Absent contentType/metadata keep the stored ones, as the local sidecar and mongofs do.
      await c.query(
        `INSERT INTO ${this.s}.fs_objects (key, size, next_seq, version, content_type, metadata, updated_at_ms)
         VALUES ($1, $2, $3, 1, $4, $5::jsonb, $6)
         ON CONFLICT (key) DO UPDATE SET
           size = EXCLUDED.size,
           next_seq = EXCLUDED.next_seq,
           version = ${this.s}.fs_objects.version + 1,
           content_type = COALESCE(EXCLUDED.content_type, ${this.s}.fs_objects.content_type),
           metadata = COALESCE(EXCLUDED.metadata, ${this.s}.fs_objects.metadata),
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [key, buf.length, chunks.length, opts?.contentType ?? null, metadata, Date.now()],
      );
      await c.query(`DELETE FROM ${this.s}.fs_chunks WHERE key = $1`, [key]);
      await this.insertChunks(c, key, chunks, 0);
    });
    this.logger?.debug?.(`${TAG} putObject: ${key} (${buf.length} bytes, ${chunks.length} chunks)`);
  }

  async appendObject(key: string, content: string | Buffer): Promise<void> {
    this.validateKey(key);
    await this.init();
    const buf = toBuffer(content);
    if (buf.length === 0) return;
    const chunks = splitChunks(buf);

    await withTransaction(this.pool, async (c) => {
      // The upsert holds the object's row lock until COMMIT: concurrent appenders
      // queue here and each gets the seq range right after the previous one.
      const res = await c.query<{ next_seq: number }>(
        `INSERT INTO ${this.s}.fs_objects (key, size, next_seq, version, updated_at_ms)
         VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT (key) DO UPDATE SET
           size = ${this.s}.fs_objects.size + EXCLUDED.size,
           next_seq = ${this.s}.fs_objects.next_seq + EXCLUDED.next_seq,
           version = ${this.s}.fs_objects.version + 1,
           updated_at_ms = EXCLUDED.updated_at_ms
         RETURNING next_seq`,
        [key, buf.length, chunks.length, Date.now()],
      );
      await this.insertChunks(c, key, chunks, res.rows[0].next_seq - chunks.length);
    });
    this.logger?.debug?.(`${TAG} appendObject: ${key} (+${buf.length} bytes)`);
  }

  async getObject(key: string): Promise<StorageObject | null> {
    this.validateKey(key);
    await this.init();
    // One statement = one snapshot, so metadata and chunks always belong to the same write.
    const res = await this.pool.query<ObjectRow>(
      `SELECT o.size, o.content_type, o.metadata, o.updated_at_ms, c.seq, c.data
         FROM ${this.s}.fs_objects o
         LEFT JOIN ${this.s}.fs_chunks c ON c.key = o.key
        WHERE o.key = $1
        ORDER BY c.seq`,
      [key],
    );
    if (res.rows.length === 0) return null;
    const head = res.rows[0];
    const parts = res.rows.filter((r) => r.data !== null).map((r) => r.data as Buffer);
    return {
      key,
      content: Buffer.concat(parts),
      contentType: head.content_type ?? undefined,
      metadata: head.metadata ?? undefined,
      lastModified: new Date(head.updated_at_ms),
      size: head.size,
    };
  }

  async exists(key: string): Promise<boolean> {
    this.validateKey(key);
    await this.init();
    const res = await this.pool.query(`SELECT 1 FROM ${this.s}.fs_objects WHERE key = $1`, [key]);
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * D9.2 listing: string prefix, non-recursive folds deeper paths into one
   * trailing-slash directory entry (mtime = newest child, deterministic),
   * recursive yields files only.
   */
  async listObjects(prefix: string, opts?: ListObjectsOptions): Promise<ListResult> {
    if (prefix.includes("\0")) throw new Error(`${TAG} prefix must not contain NUL character`);
    await this.init();
    const recursive = opts?.recursive ?? false;
    const res = await this.pool.query<{ key: string; size: number; updated_at_ms: number }>(
      `SELECT key, size, updated_at_ms FROM ${this.s}.fs_objects WHERE starts_with(key, $1)`,
      [prefix],
    );

    const lastSlash = prefix.lastIndexOf("/");
    const dirKey = lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : "";
    const entries: ListEntry[] = [];
    const dirs = new Map<string, number>();

    for (const row of res.rows) {
      const file: ListEntry = { key: row.key, size: row.size, lastModified: new Date(row.updated_at_ms), isDirectory: false };
      if (recursive) {
        entries.push(file);
        continue;
      }
      const rest = row.key.slice(dirKey.length);
      const slash = rest.indexOf("/");
      if (slash < 0) {
        entries.push(file);
        continue;
      }
      const folded = `${dirKey}${rest.slice(0, slash + 1)}`;
      dirs.set(folded, Math.max(dirs.get(folded) ?? 0, row.updated_at_ms));
    }
    for (const [key, mtime] of dirs) {
      entries.push({ key, size: 0, lastModified: new Date(mtime), isDirectory: true });
    }
    return pageEntries(entries, opts);
  }

  async deleteObject(key: string): Promise<void> {
    this.validateKey(key);
    await this.init();
    await this.pool.query(`DELETE FROM ${this.s}.fs_objects WHERE key = $1`, [key]);
    this.logger?.debug?.(`${TAG} deleteObject: ${key}`);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    if (prefix.includes("\0")) throw new Error(`${TAG} prefix must not contain NUL character`);
    await this.init();
    const res = await this.pool.query(`DELETE FROM ${this.s}.fs_objects WHERE starts_with(key, $1)`, [prefix]);
    const n = res.rowCount ?? 0;
    this.logger?.debug?.(`${TAG} deleteByPrefix: ${prefix} (${n} objects)`);
    return n;
  }
}
