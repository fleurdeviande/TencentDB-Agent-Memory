/**
 * Postgres wiki content (DDL in db/migrate-pg.ts): pages as text, sources as bytea, the manager registry
 * as JSONB. Every statement is parameterised; wiki ids and paths are never interpolated. Writes take a
 * per-wiki advisory lock in their own namespace, so they never wait on an index write of the same wiki.
 *
 * Blobs are read and written whole (no streaming): a source costs its size in a Buffer plus the hex text
 * node-postgres decodes it from (~3× in flight), bounded by KNOWLEDGE_MAX_SOURCE_BYTES.
 */

import type { Pool, PoolClient } from "pg";

import type { WikiSourceState } from "./types.js";
import {
  assertPagePath,
  assertSourceName,
  checkSourceSizes,
  isListedPage,
  sha256Of,
  type PageChanges,
  type WikiContentStore,
  type WikiLoc,
  type WikiPageFile,
  type WikiSourceEntry,
  type WikiSourceFile,
} from "./content-store.js";

const LOCK_NAMESPACE = 0x77696b63; // "wikc" — content writes; the index uses "wiki"
const PAGE_CHUNK = 200;

export class PostgresWikiContentStore implements WikiContentStore {
  readonly kind = "postgres" as const;

  constructor(
    private readonly pool: Pool,
    readonly maxSourceBytes: number,
  ) {}

  private async tx<T>(wikiId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1::int, hashtext($2))", [LOCK_NAMESPACE, wikiId]);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async init(): Promise<void> {
    /* tables come from migratePg; there are no directories */
  }

  async hasPages(loc: WikiLoc): Promise<boolean> {
    const res = await this.pool.query<{ ok: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM knowledge_wiki_page_file WHERE wiki_id = $1) AS ok",
      [loc.wikiId],
    );
    return res.rows[0]?.ok === true;
  }

  async listPages(loc: WikiLoc): Promise<WikiPageFile[]> {
    const res = await this.pool.query<WikiPageFile>(
      "SELECT path, content FROM knowledge_wiki_page_file WHERE wiki_id = $1 ORDER BY path",
      [loc.wikiId],
    );
    return res.rows.filter((r) => isListedPage(r.path));
  }

  async readPage(loc: WikiLoc, path: string): Promise<string | null> {
    const res = await this.pool.query<{ content: string }>(
      "SELECT content FROM knowledge_wiki_page_file WHERE wiki_id = $1 AND path = $2",
      [loc.wikiId, assertPagePath(path)],
    );
    return res.rows[0]?.content ?? null;
  }

  async applyPages(loc: WikiLoc, changes: PageChanges): Promise<void> {
    for (const p of changes.put) assertPagePath(p.path);
    for (const p of changes.remove) assertPagePath(p);
    if (changes.put.length === 0 && changes.remove.length === 0) return;
    const now = new Date().toISOString();
    await this.tx(loc.wikiId, async (c) => {
      if (changes.remove.length > 0) {
        await c.query("DELETE FROM knowledge_wiki_page_file WHERE wiki_id = $1 AND path = ANY($2::text[])", [
          loc.wikiId,
          changes.remove,
        ]);
      }
      for (let i = 0; i < changes.put.length; i += PAGE_CHUNK) {
        const chunk = changes.put.slice(i, i + PAGE_CHUNK);
        await c.query(
          `INSERT INTO knowledge_wiki_page_file (wiki_id, path, content, updated_at)
           SELECT $1, p, t, $4 FROM unnest($2::text[], $3::text[]) AS u(p, t)
           ON CONFLICT (wiki_id, path) DO UPDATE SET content = EXCLUDED.content, updated_at = EXCLUDED.updated_at`,
          [loc.wikiId, chunk.map((p) => p.path), chunk.map((p) => p.content), now],
        );
      }
    });
  }

  async listSources(loc: WikiLoc, match?: (filename: string) => boolean): Promise<WikiSourceEntry[]> {
    const res = await this.pool.query<{ filename: string; size: string; sha256: string }>(
      "SELECT filename, size, sha256 FROM knowledge_wiki_source_file WHERE wiki_id = $1 ORDER BY filename",
      [loc.wikiId],
    );
    return res.rows
      .filter((r) => !match || match(r.filename))
      .map((r) => ({ filename: r.filename, size: Number(r.size), sha256: r.sha256 }));
  }

  async readSource(loc: WikiLoc, filename: string): Promise<Buffer | null> {
    const res = await this.pool.query<{ data: Buffer }>(
      "SELECT data FROM knowledge_wiki_source_file WHERE wiki_id = $1 AND filename = $2",
      [loc.wikiId, assertSourceName(filename)],
    );
    return res.rows[0]?.data ?? null;
  }

  async writeSources(loc: WikiLoc, files: WikiSourceFile[]): Promise<void> {
    checkSourceSizes(files, this.maxSourceBytes);
    for (const f of files) assertSourceName(f.filename);
    if (files.length === 0) return;
    const now = new Date().toISOString();
    await this.tx(loc.wikiId, async (c) => {
      for (const f of files) {
        await c.query(
          `INSERT INTO knowledge_wiki_source_file (wiki_id, filename, data, size, sha256, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (wiki_id, filename) DO UPDATE
             SET data = EXCLUDED.data, size = EXCLUDED.size, sha256 = EXCLUDED.sha256, updated_at = EXCLUDED.updated_at`,
          [loc.wikiId, f.filename, f.data, f.data.length, sha256Of(f.data), now],
        );
      }
    });
  }

  async deleteSources(loc: WikiLoc, filenames: string[]): Promise<void> {
    if (filenames.length === 0) return;
    await this.tx(loc.wikiId, (c) =>
      c.query("DELETE FROM knowledge_wiki_source_file WHERE wiki_id = $1 AND filename = ANY($2::text[])", [
        loc.wikiId,
        filenames,
      ]),
    );
  }

  async drop(loc: WikiLoc): Promise<void> {
    await this.tx(loc.wikiId, async (c) => {
      await c.query("DELETE FROM knowledge_wiki_page_file WHERE wiki_id = $1", [loc.wikiId]);
      await c.query("DELETE FROM knowledge_wiki_source_file WHERE wiki_id = $1", [loc.wikiId]);
      // The manager names registry entries by wiki id; a build finishing after the delete may re-put it.
      await c.query("DELETE FROM knowledge_wiki_registry WHERE name = $1", [loc.wikiId]);
    });
  }

  async loadRegistry(): Promise<Record<string, WikiSourceState>> {
    const res = await this.pool.query<{ name: string; state: WikiSourceState }>(
      "SELECT name, state FROM knowledge_wiki_registry ORDER BY name",
    );
    const out: Record<string, WikiSourceState> = {};
    for (const r of res.rows) out[r.name] = r.state;
    return out;
  }

  async putRegistry(state: WikiSourceState): Promise<void> {
    await this.pool.query(
      `INSERT INTO knowledge_wiki_registry (name, state, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (name) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [state.name, JSON.stringify(state), new Date().toISOString()],
    );
  }

  async removeRegistry(name: string): Promise<void> {
    await this.pool.query("DELETE FROM knowledge_wiki_registry WHERE name = $1", [name]);
  }
}
