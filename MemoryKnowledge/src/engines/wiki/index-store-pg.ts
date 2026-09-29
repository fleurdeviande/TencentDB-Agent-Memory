/**
 * Postgres wiki index: upstream's per-wiki index.db tables as shared tables keyed by wiki_id
 * (DDL in db/migrate-pg.ts). Every statement is parameterised; wiki ids are never interpolated.
 *
 * Full-text: FTS5 (unicode61) over `tokenize()` output becomes a generated tsvector ('simple') over the
 * same tokens, split into letter/digit runs exactly as unicode61 splits them, so "node.js" or "v2.0"
 * index as two words on both sides instead of Postgres' host/version tokens. Queries mirror the FTS5
 * expression `"tok"*` OR …: each token is a prefix phrase `'w1' <-> 'w2':*`, OR-ed.
 */

import type { Pool, PoolClient } from "pg";

import type { SourceRow, SourceStatus } from "./index-db.js";
import type {
  EdgeRow,
  IndexPageRow,
  PageMetaRow,
  SourceIngestResult,
  SourceStates,
  SourceUpsert,
  WikiIndexStore,
  WikiIndexWriter,
} from "./index-store.js";

/** First key of the per-wiki advisory lock (second: hashtext(wiki_id)). */
const LOCK_NAMESPACE = 0x77696b69; // "wiki"
/** tsvector caps lexeme data at 1 MB; keep the indexed text below it. */
const MAX_TOK_CHARS = 500_000;
/**
 * ts_rank_cd weights {D, C, B, A} for content (D) and title (A). Upstream calls bm25(wiki_fts, 5.0, 1.0),
 * but bm25 weights follow column order and column 0 is the UNINDEXED page_id, so title_tok and
 * content_tok both weigh 1.0 in practice. Mirrored here as 1 : 1; "{0.2,0.2,0.2,1.0}" would be the intended 5 : 1.
 */
const RANK_WEIGHTS = "{1,1,1,1}";
/** ts_rank_cd normalisation 1: divide by 1 + log(document length), a mild stand-in for BM25's length norm. */
const RANK_NORMALIZATION = 1;
const INSERT_CHUNK = 500;

const SOURCE_COLS = "filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error";

/** unicode61 token characters: letters, digits, marks. */
function words(token: string): string[] {
  return token.split(/[^\p{L}\p{N}\p{M}]+/u).filter((w) => w.length > 0);
}

/** Space-joined tokens → the text the generated tsvector indexes. */
export function toIndexText(tokText: string): string {
  const out: string[] = [];
  let len = 0;
  for (const tok of tokText.split(" ")) {
    for (const w of words(tok)) {
      if (len + w.length + 1 > MAX_TOK_CHARS) return out.join(" ");
      out.push(w);
      len += w.length + 1;
    }
  }
  return out.join(" ");
}

/** Query tokens → to_tsquery('simple', …) text, or null when nothing is searchable. Words are [\p{L}\p{N}\p{M}]+, so quoting is safe. */
export function toTsQuery(tokens: string[]): string | null {
  const parts = new Set<string>();
  for (const tok of tokens) {
    const ws = words(tok);
    if (ws.length === 0) continue;
    parts.add(`${ws.map((w) => `'${w}'`).join(" <-> ")}:*`);
  }
  return parts.size > 0 ? [...parts].join(" | ") : null;
}

/** ts_rank_cd ≥ 0 → (0, 1), as MemoryCore's postgres store does. */
export function tsRankToScore(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) return 0;
  return rank / (1 + rank);
}

async function lockWiki(client: PoolClient, wikiId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [LOCK_NAMESPACE, wikiId]);
}

function pgWriter(client: PoolClient, wikiId: string): WikiIndexWriter {
  return {
    async replacePages(pages: IndexPageRow[], edges: Array<{ source: string; target: string }>) {
      await client.query("DELETE FROM knowledge_wiki_page WHERE wiki_id = $1", [wikiId]);
      await client.query("DELETE FROM knowledge_wiki_edge WHERE wiki_id = $1", [wikiId]);
      for (let i = 0; i < pages.length; i += INSERT_CHUNK) {
        const chunk = pages.slice(i, i + INSERT_CHUNK);
        await client.query(
          `INSERT INTO knowledge_wiki_page (wiki_id, page_id, title, type, rel_path, snippet, title_tok, content_tok)
           SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])`,
          [
            wikiId,
            chunk.map((p) => p.page_id),
            chunk.map((p) => p.title),
            chunk.map((p) => p.type),
            chunk.map((p) => p.rel_path),
            chunk.map((p) => p.snippet),
            chunk.map((p) => toIndexText(p.title_tok)),
            chunk.map((p) => toIndexText(p.content_tok)),
          ],
        );
      }
      for (let i = 0; i < edges.length; i += INSERT_CHUNK) {
        const chunk = edges.slice(i, i + INSERT_CHUNK);
        await client.query(
          `INSERT INTO knowledge_wiki_edge (wiki_id, source_id, target_id)
           SELECT $1, * FROM unnest($2::text[], $3::text[])
           ON CONFLICT DO NOTHING`,
          [wikiId, chunk.map((e) => e.source), chunk.map((e) => e.target)],
        );
      }
    },

    // Same read-then-write rules as index-db.ts#upsertSource; the wiki lock makes them race-free.
    async upsertSource(entry: SourceUpsert) {
      const now = new Date().toISOString();
      const old = await client.query<{ sha256: string }>(
        "SELECT sha256 FROM knowledge_wiki_source WHERE wiki_id = $1 AND filename = $2",
        [wikiId, entry.filename],
      );
      if (old.rowCount === 0) {
        await client.query(
          `INSERT INTO knowledge_wiki_source (wiki_id, ${SOURCE_COLS})
           VALUES ($1, $2, $3, $4, 'uploaded', $5, $5, $6, NULL, NULL)`,
          [wikiId, entry.filename, entry.sha256, entry.size, now, entry.userId ?? null],
        );
        return "created";
      }
      if (old.rows[0].sha256 !== entry.sha256) {
        await client.query(
          `UPDATE knowledge_wiki_source
           SET sha256 = $3, size = $4, status = 'uploaded', updated_at = $5, last_modified_by = $6, ingest_error = NULL
           WHERE wiki_id = $1 AND filename = $2`,
          [wikiId, entry.filename, entry.sha256, entry.size, now, entry.userId ?? null],
        );
        return "updated";
      }
      return "unchanged";
    },

    async recordSourceIngestResult(entry: SourceIngestResult) {
      const now = new Date().toISOString();
      const status: SourceStatus = entry.ok ? "ingested" : "failed";
      const ingestedAt = entry.ok ? now : null;
      const ingestError = entry.ok ? null : (entry.error ?? "unknown").slice(0, 500);
      const upd = await client.query(
        `UPDATE knowledge_wiki_source SET status = $3, ingested_at = $4, ingest_error = $5
         WHERE wiki_id = $1 AND filename = $2`,
        [wikiId, entry.filename, status, ingestedAt, ingestError],
      );
      if (upd.rowCount === 0) {
        await client.query(
          `INSERT INTO knowledge_wiki_source (wiki_id, ${SOURCE_COLS})
           VALUES ($1, $2, $3, $4, $5, $6, $6, NULL, $7, $8)`,
          [wikiId, entry.filename, entry.sha256, entry.size, status, now, ingestedAt, ingestError],
        );
      }
    },

    async deleteSources(filenames: string[]) {
      if (filenames.length === 0) return;
      await client.query("DELETE FROM knowledge_wiki_source WHERE wiki_id = $1 AND filename = ANY($2::text[])", [
        wikiId,
        filenames,
      ]);
    },
  };
}

export class PostgresWikiIndexStore implements WikiIndexStore {
  readonly dialect = "postgres" as const;

  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    /* tables come from migratePg */
  }

  async withWrite<T>(wikiId: string, _wikiDir: string, fn: (w: WikiIndexWriter) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockWiki(client, wikiId);
      const out = await fn(pgWriter(client, wikiId));
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async search(wikiId: string, _wikiDir: string, tokens: string[], limit: number) {
    const q = toTsQuery(tokens);
    if (!q) return [];
    const res = await this.pool.query<{ page_id: string; rank: number }>(
      `SELECT p.page_id, ts_rank_cd($3::float4[], p.fts, q.q, $4) AS rank
       FROM knowledge_wiki_page p, to_tsquery('simple', $2) AS q(q)
       WHERE p.wiki_id = $1 AND p.fts @@ q.q
       ORDER BY rank DESC, p.page_id
       LIMIT $5`,
      [wikiId, q, RANK_WEIGHTS, RANK_NORMALIZATION, limit],
    );
    return res.rows.map((r) => ({ id: r.page_id, score: tsRankToScore(Number(r.rank)) }));
  }

  async loadPages(wikiId: string): Promise<PageMetaRow[]> {
    const res = await this.pool.query<PageMetaRow>(
      "SELECT page_id, title, type, rel_path, snippet FROM knowledge_wiki_page WHERE wiki_id = $1 ORDER BY page_id",
      [wikiId],
    );
    return res.rows;
  }

  async loadEdges(wikiId: string): Promise<EdgeRow[]> {
    const res = await this.pool.query<EdgeRow>(
      "SELECT source_id, target_id FROM knowledge_wiki_edge WHERE wiki_id = $1",
      [wikiId],
    );
    return res.rows;
  }

  async listSources(wikiId: string): Promise<SourceRow[]> {
    const res = await this.pool.query<SourceRow>(
      `SELECT ${SOURCE_COLS} FROM knowledge_wiki_source WHERE wiki_id = $1 ORDER BY filename`,
      [wikiId],
    );
    return res.rows;
  }

  async readSourceStates(wikiId: string): Promise<SourceStates> {
    const res = await this.pool.query<{ filename: string; sha256: string; status: SourceStatus }>(
      "SELECT filename, sha256, status FROM knowledge_wiki_source WHERE wiki_id = $1",
      [wikiId],
    );
    const m: SourceStates = new Map();
    for (const r of res.rows) m.set(r.filename, { sha256: r.sha256, status: r.status });
    return m;
  }

  async release(): Promise<void> {
    /* no per-wiki handles */
  }

  async drop(wikiId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockWiki(client, wikiId);
      await client.query("DELETE FROM knowledge_wiki_page WHERE wiki_id = $1", [wikiId]);
      await client.query("DELETE FROM knowledge_wiki_edge WHERE wiki_id = $1", [wikiId]);
      await client.query("DELETE FROM knowledge_wiki_source WHERE wiki_id = $1", [wikiId]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
