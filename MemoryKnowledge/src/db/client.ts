/**
 * Drizzle client initialization — creates better-sqlite3 Database + drizzle wrapper.
 *
 * `createDb` is upstream's synchronous SQLite entry point. `openKnowledgeDb` picks the dialect:
 * Postgres (drizzle node-postgres) when a `postgres://` URL is given, otherwise this SQLite file.
 * Stores take a `KnowledgeDb` and `await` drizzle builders, which are thenables on both drivers.
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export type Dialect = "sqlite" | "postgres";

/** The tables the stores query. Typed with the SQLite schema; Postgres passes its twins (schema.pg.ts). */
export interface KnowledgeTables {
  knowledgeCodeGraph: typeof schema.knowledgeCodeGraph;
  knowledgeWiki: typeof schema.knowledgeWiki;
  knowledgeWikiAudit: typeof schema.knowledgeWikiAudit;
  knowledgeCodeGraphAudit: typeof schema.knowledgeCodeGraphAudit;
  knowledgeGitCredential: typeof schema.knowledgeGitCredential;
  knowledgeGitCredentialAudit: typeof schema.knowledgeGitCredentialAudit;
  llmBinding: typeof schema.llmBinding;
}

/**
 * Dialect-neutral handle. `orm` is typed as the SQLite drizzle db so builder chains type-check once;
 * on Postgres it is a node-postgres drizzle db with the pg tables — only the builder methods both
 * dialects share (select/insert/update/delete/onConflictDoUpdate) may be used, always via `await`.
 */
export interface KnowledgeDb {
  readonly dialect: Dialect;
  readonly orm: Db;
  readonly tables: KnowledgeTables;
  close(): Promise<void>;
}

const SQLITE_TABLES: KnowledgeTables = {
  knowledgeCodeGraph: schema.knowledgeCodeGraph,
  knowledgeWiki: schema.knowledgeWiki,
  knowledgeWikiAudit: schema.knowledgeWikiAudit,
  knowledgeCodeGraphAudit: schema.knowledgeCodeGraphAudit,
  knowledgeGitCredential: schema.knowledgeGitCredential,
  knowledgeGitCredentialAudit: schema.knowledgeGitCredentialAudit,
  llmBinding: schema.llmBinding,
};

export function sqliteKnowledgeDb(db: Db, raw?: Database.Database): KnowledgeDb {
  return {
    dialect: "sqlite",
    orm: db,
    tables: SQLITE_TABLES,
    close: async () => {
      raw?.close();
    },
  };
}

/** Accept upstream-style `Db` (SQLite) wherever a `KnowledgeDb` is expected. */
export function asKnowledgeDb(db: Db | KnowledgeDb): KnowledgeDb {
  return "dialect" in db && "tables" in db ? (db as KnowledgeDb) : sqliteKnowledgeDb(db as Db);
}

export interface OpenKnowledgeDbOptions {
  /** `postgres://…` / `postgresql://…` selects Postgres; empty keeps SQLite at `path`. */
  url?: string;
  /** SQLite file (ignored when `url` is set). */
  path: string;
  /** Postgres schema for the tables (created if missing); default: the connection's search_path. */
  schema?: string;
  /** Postgres pool size. */
  poolMax?: number;
  autoMigrate?: boolean;
}

export function isPostgresUrl(url: string | undefined): url is string {
  return !!url && /^postgres(ql)?:\/\//i.test(url.trim());
}

export async function openKnowledgeDb(opts: OpenKnowledgeDbOptions): Promise<KnowledgeDb> {
  if (opts.url && !isPostgresUrl(opts.url)) {
    throw new Error("KNOWLEDGE_DB_URL must start with postgres:// or postgresql://");
  }
  if (isPostgresUrl(opts.url)) {
    // Loaded lazily so SQLite deployments never import pg.
    const { openPostgresDb } = await import("./client-pg.js");
    return openPostgresDb({
      url: opts.url,
      schema: opts.schema,
      poolMax: opts.poolMax,
      autoMigrate: opts.autoMigrate,
    });
  }
  const { db, raw } = createDb({ path: opts.path, autoMigrate: opts.autoMigrate });
  return sqliteKnowledgeDb(db, raw);
}

/** Rows touched by an awaited insert/update/delete: better-sqlite3 `changes`, node-postgres `rowCount`. */
export function affectedRows(res: unknown): number {
  const r = res as { changes?: number; rowCount?: number | null } | undefined;
  return Number(r?.changes ?? r?.rowCount ?? 0);
}

/** Unique/PK violation on either dialect; drizzle may wrap the driver error in `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === "23505") return true;
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg)) return true;
  }
  return false;
}

export interface CreateDbOptions {
  /** Path to SQLite file. Use ":memory:" for in-memory DB. */
  path: string;
  /** Whether to run migrations (CREATE TABLE IF NOT EXISTS) on init. Default true. */
  autoMigrate?: boolean;
}

/**
 * Create a Drizzle-wrapped better-sqlite3 database.
 * Sets WAL mode + busy_timeout for production safety.
 */
export function createDb(opts: CreateDbOptions): { db: Db; raw: Database.Database } {
  if (opts.path !== ":memory:") {
    mkdirSync(dirname(opts.path), { recursive: true });
  }

  const raw = new Database(opts.path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("busy_timeout = 5000");

  const db = drizzle(raw, { schema });

  if (opts.autoMigrate !== false) {
    migrate(db, raw);
  }

  return { db, raw };
}

/**
 * Run idempotent CREATE TABLE IF NOT EXISTS for all tables + indexes.
 * Uses raw SQL for partial unique indexes (Drizzle schema definition generates them
 * via drizzle-kit, but for runtime we ensure tables exist).
 */
export function migrate(_db: Db, raw: Database.Database): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_code_graph (
      code_graph_id   TEXT PRIMARY KEY,
      service_id      TEXT NOT NULL,
      team_id         TEXT NOT NULL,
      repo_name       TEXT NOT NULL DEFAULT '',
      repo_url        TEXT NOT NULL,
      branch          TEXT NOT NULL,
      commit_hash     TEXT,
      owner_user_id   TEXT,
      user_id         TEXT,
      agent_id        TEXT,
      task_id         TEXT,
      visibility      TEXT NOT NULL DEFAULT 'team',
      status          TEXT NOT NULL DEFAULT 'pending',
      internal_status TEXT,
      sync_error      TEXT,
      stats_json      TEXT,
      version         INTEGER NOT NULL DEFAULT 0,
      last_sync_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kcg_team_repo_branch
      ON knowledge_code_graph(service_id, team_id, repo_url, branch)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_kcg_team_status
      ON knowledge_code_graph(service_id, team_id, status);

    CREATE TABLE IF NOT EXISTS knowledge_wiki (
      wiki_id         TEXT PRIMARY KEY,
      service_id      TEXT NOT NULL,
      team_id         TEXT NOT NULL,
      name            TEXT NOT NULL,
      source_type     TEXT,
      source_url      TEXT,
      owner_user_id   TEXT,
      user_id         TEXT,
      agent_id        TEXT,
      task_id         TEXT,
      visibility      TEXT NOT NULL DEFAULT 'team',
      status          TEXT NOT NULL DEFAULT 'draft',
      internal_status TEXT,
      sync_error      TEXT,
      page_count      INTEGER,
      version         INTEGER NOT NULL DEFAULT 0,
      last_sync_at    TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL,
      deleted_at      TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kwiki_team_name
      ON knowledge_wiki(service_id, team_id, name)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_kwiki_team_status
      ON knowledge_wiki(service_id, team_id, status);

    CREATE TABLE IF NOT EXISTS knowledge_wiki_audit (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      wiki_id    TEXT NOT NULL,
      service_id TEXT,
      version    INTEGER NOT NULL DEFAULT 0,
      action     TEXT NOT NULL,
      user_id    TEXT,
      agent_id   TEXT,
      detail     TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kwa_wiki_version
      ON knowledge_wiki_audit(wiki_id, version DESC);

    CREATE TABLE IF NOT EXISTS knowledge_code_graph_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code_graph_id TEXT NOT NULL,
      service_id    TEXT,
      version       INTEGER NOT NULL DEFAULT 0,
      action        TEXT NOT NULL,
      user_id       TEXT,
      agent_id      TEXT,
      detail        TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kcga_cg_version
      ON knowledge_code_graph_audit(code_graph_id, version DESC);

    CREATE TABLE IF NOT EXISTS llm_binding (
      service_id     TEXT PRIMARY KEY,
      mode           TEXT NOT NULL DEFAULT 'proxy',
      proxy_base_url TEXT,
      api_key        TEXT,
      model          TEXT,
      base_url       TEXT,
      enabled        INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_git_credential (
      credential_id TEXT PRIMARY KEY,
      service_id    TEXT NOT NULL,
      team_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      host          TEXT NOT NULL,
      username      TEXT,
      secret_enc    TEXT NOT NULL,
      fingerprint   TEXT NOT NULL,
      created_by    TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      deleted_at    TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_kgcred_team_name
      ON knowledge_git_credential(service_id, team_id, name)
      WHERE deleted_at IS NULL;

    CREATE INDEX IF NOT EXISTS idx_kgcred_team_host
      ON knowledge_git_credential(service_id, team_id, host);

    CREATE TABLE IF NOT EXISTS knowledge_git_credential_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id TEXT NOT NULL,
      service_id    TEXT,
      action        TEXT NOT NULL,
      user_id       TEXT,
      detail        TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kgca_cred
      ON knowledge_git_credential_audit(credential_id, id DESC);
  `);

  // Column migrations — SQLite ALTER TABLE ADD COLUMN is not idempotent,
  // so we check PRAGMA table_info first.
  addColumnIfMissing(raw, "knowledge_code_graph", "service_url", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "summary", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph", "credential_id", "TEXT");
  addColumnIfMissing(raw, "knowledge_wiki", "service_url", "TEXT");
  addColumnIfMissing(raw, "knowledge_wiki", "summary", "TEXT");
  // service_id on audit tables is nullable → safe to add to existing dev DBs.
  addColumnIfMissing(raw, "knowledge_wiki_audit", "service_id", "TEXT");
  addColumnIfMissing(raw, "knowledge_code_graph_audit", "service_id", "TEXT");
}

/** Add a column to a table if it doesn't already exist. SQLite-safe. */
function addColumnIfMissing(
  raw: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = raw.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
}
