/**
 * WikiIndexStore on the dialect selected by the test setup: upstream's per-wiki index.db (default) or
 * the Postgres tables (KNOWLEDGE_TEST_DB_URL).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, TEST_DIALECT, type TestDb } from "../../test-utils/db.js";
import { createWikiIndexStore, type IndexPageRow, type WikiIndexStore } from "./index-store.js";
import { toIndexText, toTsQuery } from "./index-store-pg.js";
import { tokenize } from "./manager.js";

let db: TestDb;
let index: WikiIndexStore;
let root: string;

function wikiDir(id: string): string {
  return join(root, id);
}

async function openWiki(id: string): Promise<void> {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(wikiDir(id), { recursive: true });
  await index.init(id, wikiDir(id));
}

function page(id: string, title: string, content: string, type = "concept"): IndexPageRow {
  return {
    page_id: id,
    title,
    type,
    rel_path: `wiki/${id}.md`,
    snippet: content.slice(0, 20),
    title_tok: tokenize(title).join(" "),
    content_tok: tokenize(content).join(" "),
  };
}

async function search(id: string, q: string, limit = 10): Promise<string[]> {
  return (await index.search(id, wikiDir(id), tokenize(q), limit)).map((h) => h.id);
}

beforeEach(async () => {
  db = await createTestDb();
  index = createWikiIndexStore(db);
  root = mkdtempSync(join(tmpdir(), "wiki-index-"));
});

afterEach(async () => {
  await index.release("w1");
  await index.release("w2");
  await db.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe(`wiki index (${TEST_DIALECT})`, () => {
  it("uses the dialect of the metadata DB", () => {
    expect(index.dialect).toBe(TEST_DIALECT);
  });

  it("searches English with prefix matching; more occurrences rank higher", async () => {
    await openWiki("w1");
    await index.withWrite("w1", wikiDir("w1"), (w) =>
      w.replacePages(
        [
          page("concepts/redis", "Redis cache", "Redis is an in-memory store; redis cluster shards keys."),
          page("concepts/postgres", "Postgres", "Relational database. Often paired with a redis cache layer."),
          page("concepts/kafka", "Kafka", "A distributed log for streaming events."),
          // Filler so BM25's IDF for "redis" is positive (FTS5 clamps it to ~1e-6 when n >= N/2).
          page("concepts/nginx", "Nginx", "Reverse proxy."),
          page("concepts/grafana", "Grafana", "Dashboards."),
          page("concepts/qdrant", "Qdrant", "Vector database."),
        ],
        [],
      ),
    );
    expect(await search("w1", "redis")).toEqual(["concepts/redis", "concepts/postgres"]);
    expect(await search("w1", "stream")).toEqual(["concepts/kafka"]); // prefix of "streaming"
    expect(await search("w1", "the what")).toEqual([]); // stop words only
    const hits = await index.search("w1", wikiDir("w1"), tokenize("redis"), 10);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });

  it("searches Chinese through the bigram tokens", async () => {
    await openWiki("w1");
    await index.withWrite("w1", wikiDir("w1"), (w) =>
      w.replacePages(
        [
          page("concepts/l0-录入", "L0 录入流程", "对话消息先写入 L0 层，再异步抽取为结构化记忆。"),
          page("concepts/召回", "记忆召回", "检索时先做关键词匹配，再做向量召回。"),
        ],
        [],
      ),
    );
    expect(await search("w1", "录入")).toEqual(["concepts/l0-录入"]);
    expect(await search("w1", "召回")).toEqual(["concepts/召回"]);
    expect(await search("w1", "l0")).toEqual(["concepts/l0-录入"]);
    expect((await search("w1", "记忆")).sort()).toEqual(["concepts/l0-录入", "concepts/召回"]);
  });

  it("splits punctuation inside tokens the way FTS5 unicode61 does", async () => {
    await openWiki("w1");
    await index.withWrite("w1", wikiDir("w1"), (w) =>
      w.replacePages([page("concepts/node", "Runtime", "Built on node.js and released as v2.0.")], []),
    );
    expect(await search("w1", "node.js")).toEqual(["concepts/node"]);
    expect(await search("w1", "js")).toEqual(["concepts/node"]);
    expect(await search("w1", "v2.0")).toEqual(["concepts/node"]);
  });

  it("keeps wikis apart and rebuilds replace only pages and edges", async () => {
    await openWiki("w1");
    await openWiki("w2");
    await index.withWrite("w1", wikiDir("w1"), async (w) => {
      await w.replacePages([page("a", "Alpha", "shared term"), page("b", "Beta", "other")], [{ source: "a", target: "b" }]);
      await w.upsertSource({ filename: "s.md", sha256: "x", size: 1 });
    });
    await index.withWrite("w2", wikiDir("w2"), (w) => w.replacePages([page("c", "Gamma", "shared term")], []));

    expect(await search("w1", "shared")).toEqual(["a"]);
    expect(await search("w2", "shared")).toEqual(["c"]);
    expect(await index.loadEdges("w1", wikiDir("w1"))).toEqual([{ source_id: "a", target_id: "b" }]);
    expect(await index.loadEdges("w2", wikiDir("w2"))).toEqual([]);

    await index.withWrite("w1", wikiDir("w1"), (w) =>
      w.replacePages([page("b", "Beta", "other")], [{ source: "b", target: "b" }, { source: "b", target: "b" }]),
    );
    await index.release("w1");
    expect((await index.loadPages("w1", wikiDir("w1"))).map((p) => p.page_id)).toEqual(["b"]);
    expect(await index.loadEdges("w1", wikiDir("w1"))).toEqual([{ source_id: "b", target_id: "b" }]);
    expect((await index.listSources("w1", wikiDir("w1"))).map((s) => s.filename)).toEqual(["s.md"]);
  });

  it("source lifecycle: upload, re-upload, ingest result, delete", async () => {
    await openWiki("w1");
    const dir = wikiDir("w1");
    const r1 = await index.withWrite("w1", dir, (w) =>
      w.upsertSource({ filename: "a.md", sha256: "h1", size: 3, userId: "u1" }),
    );
    const r2 = await index.withWrite("w1", dir, (w) => w.upsertSource({ filename: "a.md", sha256: "h1", size: 3 }));
    expect([r1, r2]).toEqual(["created", "unchanged"]);
    const [created] = await index.listSources("w1", dir);
    expect(created).toMatchObject({ filename: "a.md", size: 3, status: "uploaded", last_modified_by: "u1", ingested_at: null });

    await index.withWrite("w1", dir, async (w) => {
      await w.recordSourceIngestResult({ filename: "a.md", sha256: "h1", size: 3, ok: true });
      await w.recordSourceIngestResult({ filename: "b.md", sha256: "h2", size: 4, ok: false, error: "boom" });
    });
    const states = await index.readSourceStates("w1", dir);
    expect(Object.fromEntries(states)).toEqual({
      "a.md": { sha256: "h1", status: "ingested" },
      "b.md": { sha256: "h2", status: "failed" },
    });
    const rows = await index.listSources("w1", dir);
    expect(rows[0].created_at).toBe(created.created_at);
    expect(rows[0].ingested_at).not.toBeNull();
    expect(rows[1].ingest_error).toBe("boom");

    expect(await index.withWrite("w1", dir, (w) => w.upsertSource({ filename: "a.md", sha256: "h9", size: 5, userId: "u2" }))).toBe(
      "updated",
    );
    const [updated] = await index.listSources("w1", dir);
    expect(updated).toMatchObject({ status: "uploaded", sha256: "h9", size: 5, last_modified_by: "u2", created_at: created.created_at });

    await index.withWrite("w1", dir, (w) => w.deleteSources(["a.md", "missing.md"]));
    expect((await index.listSources("w1", dir)).map((s) => s.filename)).toEqual(["b.md"]);
  });

  it("a failing write rolls back as a whole", async () => {
    await openWiki("w1");
    const dir = wikiDir("w1");
    await expect(
      index.withWrite("w1", dir, async (w) => {
        await w.replacePages([page("a", "Alpha", "text")], []);
        await w.upsertSource({ filename: "a.md", sha256: "h", size: 1 });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await index.loadPages("w1", dir)).toEqual([]);
    expect(await index.listSources("w1", dir)).toEqual([]);
  });

  it("concurrent writes to one wiki are serialised", async () => {
    await openWiki("w1");
    const dir = wikiDir("w1");
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        index.withWrite("w1", dir, async (w) => {
          await w.replacePages([page(`p${i}`, `Page ${i}`, "body")], []);
          return w.upsertSource({ filename: "same.md", sha256: "h", size: 1 });
        }),
      ),
    );
    expect(results.filter((r) => r === "created")).toHaveLength(1);
    expect(await index.loadPages("w1", dir)).toHaveLength(1);
  });

  it.runIf(TEST_DIALECT === "postgres")("drop deletes every row of that wiki only", async () => {
    await openWiki("w1");
    await openWiki("w2");
    for (const id of ["w1", "w2"]) {
      await index.withWrite(id, wikiDir(id), async (w) => {
        await w.replacePages([page("a", "Alpha", "x"), page("b", "Beta", "y")], [{ source: "a", target: "b" }]);
        await w.upsertSource({ filename: "s.md", sha256: "h", size: 1 });
      });
    }
    await index.drop("w1", wikiDir("w1"));
    const count = async (table: string, id: string) =>
      Number((await db.pgPool!.query(`SELECT count(*) AS n FROM ${table} WHERE wiki_id = $1`, [id])).rows[0].n);
    for (const t of ["knowledge_wiki_page", "knowledge_wiki_edge", "knowledge_wiki_source"]) {
      expect(await count(t, "w1")).toBe(0);
      expect(await count(t, "w2")).toBeGreaterThan(0);
    }
  });

  it.runIf(TEST_DIALECT === "sqlite")("readers throw when index.db was never created (upstream semantics)", async () => {
    await expect(index.listSources("w1", wikiDir("w1"))).rejects.toThrow(/index\.db missing/);
    await expect(index.search("w1", wikiDir("w1"), ["x"], 5)).rejects.toThrow(/index\.db missing/);
  });
});

describe("Postgres FTS text helpers", () => {
  it("split tokens into unicode61 words and build prefix phrases", () => {
    expect(toIndexText("node.js v2.0 录入 l0")).toBe("node js v2 0 录入 l0");
    expect(toTsQuery(["node.js", "录入", "..."])).toBe("'node' <-> 'js':* | '录入':*");
    expect(toTsQuery(["'; drop", "a'b"])).toBe("'drop':* | 'a' <-> 'b':*");
    expect(toTsQuery(["--", ""])).toBeNull();
  });

  it("caps the indexed text below the tsvector limit", () => {
    const text = toIndexText(Array.from({ length: 200_000 }, (_, i) => `w${i}`).join(" "));
    expect(text.length).toBeLessThanOrEqual(500_000);
    expect(text.endsWith(" ")).toBe(false);
  });
});
