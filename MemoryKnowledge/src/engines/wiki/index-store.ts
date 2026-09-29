/**
 * Dialect-neutral wiki index (page meta + full-text + graph edges + source lifecycle rows).
 *
 * SQLite: upstream's per-wiki `index.db` (index-db.ts) — FTS5 over pre-tokenised text, one file per
 * wiki, deleted with the wiki directory. Postgres (KNOWLEDGE_DB_URL): the same rows in shared tables
 * keyed by wiki_id (index-store-pg.ts), reusing the metadata pool. Callers tokenise with the wiki
 * `tokenize()` and pass tokens; each backend builds its own match expression from them.
 */

import { resolve } from "node:path";
import type Database from "better-sqlite3";

import type { KnowledgeDb } from "../../db/client.js";
import {
  deleteSources as sqliteDeleteSources,
  evictWikiDb,
  getReadDb,
  initIndexDb,
  listSources as sqliteListSources,
  openWriteDb,
  readSourceStates as sqliteReadSourceStates,
  recordSourceIngestResult as sqliteRecordSourceIngestResult,
  upsertSource as sqliteUpsertSource,
  type SourceRow,
  type SourceStatus,
} from "./index-db.js";
import { PostgresWikiIndexStore } from "./index-store-pg.js";

/** One page as written to the index (page_meta + wiki_fts in upstream terms). */
export interface IndexPageRow {
  page_id: string;
  title: string;
  type: string;
  rel_path: string;
  snippet: string;
  /** `tokenize(title).join(" ")` */
  title_tok: string;
  /** `tokenize(content).join(" ")` */
  content_tok: string;
}

export interface PageMetaRow {
  page_id: string;
  title: string | null;
  type: string | null;
  rel_path: string | null;
  snippet: string | null;
}

export interface EdgeRow {
  source_id: string;
  target_id: string;
}

export type SourceStates = Map<string, { sha256: string; status: SourceStatus }>;

export interface SourceUpsert {
  filename: string;
  sha256: string;
  size: number;
  userId?: string | null;
}

export interface SourceIngestResult {
  filename: string;
  sha256: string;
  size: number;
  ok: boolean;
  error?: string | null;
}

/** Writes inside one transaction (see WikiIndexStore.withWrite). */
export interface WikiIndexWriter {
  /** Replace all pages and edges of the wiki; source rows are untouched. */
  replacePages(pages: IndexPageRow[], edges: Array<{ source: string; target: string }>): Promise<void>;
  upsertSource(entry: SourceUpsert): Promise<"created" | "updated" | "unchanged">;
  recordSourceIngestResult(entry: SourceIngestResult): Promise<void>;
  deleteSources(filenames: string[]): Promise<void>;
}

/** SQLite: the wiki's index.db cannot be opened (never created / removed). Callers treat it as empty, as upstream did. */
export class WikiIndexMissingError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "WikiIndexMissingError";
  }
}

export function isWikiIndexMissing(err: unknown): err is WikiIndexMissingError {
  return err instanceof WikiIndexMissingError;
}

/**
 * `wikiId` keys the Postgres rows and the SQLite read pool; `wikiDir` locates the SQLite file.
 * SQLite readers throw WikiIndexMissingError when index.db is missing; Postgres readers return empty
 * results for an unknown wiki and let real database errors through.
 */
export interface WikiIndexStore {
  readonly dialect: "sqlite" | "postgres";
  /** Idempotent. SQLite creates index.db; Postgres has nothing to do (tables come from migrations). */
  init(wikiId: string, wikiDir: string): Promise<void>;
  /** One transaction, serialised per wiki. */
  withWrite<T>(wikiId: string, wikiDir: string, fn: (w: WikiIndexWriter) => Promise<T>): Promise<T>;
  /** Best-first page ids; score grows with relevance. */
  search(wikiId: string, wikiDir: string, tokens: string[], limit: number): Promise<Array<{ id: string; score: number }>>;
  loadPages(wikiId: string, wikiDir: string): Promise<PageMetaRow[]>;
  loadEdges(wikiId: string, wikiDir: string): Promise<EdgeRow[]>;
  listSources(wikiId: string, wikiDir: string): Promise<SourceRow[]>;
  readSourceStates(wikiId: string, wikiDir: string): Promise<SourceStates>;
  /** Drop cached read handles (after a rebuild, or when the manager forgets the wiki). */
  release(wikiId: string): Promise<void>;
  /** The wiki is being deleted: SQLite closes handles (the caller removes the directory), Postgres deletes its rows. */
  drop(wikiId: string, wikiDir: string): Promise<void>;
}

/** Serialises async critical sections per key (SQLite must not block the event loop on busy_timeout). */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

// ── SQLite: upstream index.db ──

function sqliteWriter(db: Database.Database): WikiIndexWriter {
  return {
    async replacePages(pages, edges) {
      db.prepare("DELETE FROM wiki_fts").run();
      db.prepare("DELETE FROM page_meta").run();
      db.prepare("DELETE FROM graph_edge").run();
      const insFts = db.prepare("INSERT INTO wiki_fts(page_id, title_tok, content_tok) VALUES (?,?,?)");
      const insMeta = db.prepare("INSERT INTO page_meta(page_id, title, type, rel_path, snippet) VALUES (?,?,?,?,?)");
      const insEdge = db.prepare("INSERT OR IGNORE INTO graph_edge(source_id, target_id) VALUES (?,?)");
      for (const p of pages) {
        insFts.run(p.page_id, p.title_tok, p.content_tok);
        insMeta.run(p.page_id, p.title, p.type, p.rel_path, p.snippet);
      }
      for (const e of edges) insEdge.run(e.source, e.target);
    },
    async upsertSource(entry) {
      return sqliteUpsertSource(db, entry);
    },
    async recordSourceIngestResult(entry) {
      sqliteRecordSourceIngestResult(db, entry);
    },
    async deleteSources(filenames) {
      sqliteDeleteSources(db, filenames);
    },
  };
}

class SqliteWikiIndexStore implements WikiIndexStore {
  readonly dialect = "sqlite" as const;
  private readonly locks = new KeyedLock();

  private read(wikiId: string, wikiDir: string): Database.Database {
    try {
      return getReadDb(wikiId, wikiDir);
    } catch (err) {
      throw new WikiIndexMissingError(err);
    }
  }

  async init(_wikiId: string, wikiDir: string): Promise<void> {
    initIndexDb(wikiDir);
  }

  withWrite<T>(_wikiId: string, wikiDir: string, fn: (w: WikiIndexWriter) => Promise<T>): Promise<T> {
    return this.locks.run(resolve(wikiDir), async () => {
      const db = openWriteDb(wikiDir);
      try {
        db.exec("BEGIN");
        let out: T;
        try {
          out = await fn(sqliteWriter(db));
          db.exec("COMMIT");
        } catch (err) {
          if (db.inTransaction) db.exec("ROLLBACK");
          throw err;
        }
        db.pragma("wal_checkpoint(TRUNCATE)");
        return out;
      } finally {
        db.close();
      }
    });
  }

  /**
   * FTS5: every token becomes a `"tok"*` prefix phrase, OR-ed; bm25() is negative-is-better, negated
   * into a positive score for decay/minScore. Upstream SQL, unchanged: its weights (5.0, 1.0) land on
   * page_id and title_tok, so title and content effectively weigh the same.
   */
  async search(wikiId: string, wikiDir: string, tokens: string[], limit: number) {
    if (tokens.length === 0) return [];
    const db = this.read(wikiId, wikiDir);
    const expr = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" OR ");
    const rows = db
      .prepare(
        "SELECT page_id, bm25(wiki_fts, 5.0, 1.0) AS score FROM wiki_fts WHERE wiki_fts MATCH ? ORDER BY score LIMIT ?",
      )
      .all(expr, limit) as Array<{ page_id: string; score: number }>;
    return rows.map((r) => ({ id: r.page_id, score: -r.score }));
  }

  async loadPages(wikiId: string, wikiDir: string): Promise<PageMetaRow[]> {
    return this.read(wikiId, wikiDir)
      .prepare("SELECT page_id, title, type, rel_path, snippet FROM page_meta ORDER BY page_id")
      .all() as PageMetaRow[];
  }

  async loadEdges(wikiId: string, wikiDir: string): Promise<EdgeRow[]> {
    return this.read(wikiId, wikiDir).prepare("SELECT source_id, target_id FROM graph_edge").all() as EdgeRow[];
  }

  async listSources(wikiId: string, wikiDir: string): Promise<SourceRow[]> {
    return sqliteListSources(this.read(wikiId, wikiDir));
  }

  async readSourceStates(wikiId: string, wikiDir: string): Promise<SourceStates> {
    return sqliteReadSourceStates(this.read(wikiId, wikiDir));
  }

  async release(wikiId: string): Promise<void> {
    evictWikiDb(wikiId);
  }

  async drop(wikiId: string): Promise<void> {
    evictWikiDb(wikiId);
  }
}

/** Process-wide SQLite index (upstream default). */
export const sqliteWikiIndex: WikiIndexStore = new SqliteWikiIndexStore();

/** Postgres rows in the metadata database when it is Postgres, otherwise upstream's per-wiki index.db. */
export function createWikiIndexStore(db?: Pick<KnowledgeDb, "dialect" | "pgPool">): WikiIndexStore {
  if (db?.dialect === "postgres") {
    if (!db.pgPool) throw new Error("Postgres KnowledgeDb without a pool: cannot open the wiki index");
    return new PostgresWikiIndexStore(db.pgPool);
  }
  return sqliteWikiIndex;
}
