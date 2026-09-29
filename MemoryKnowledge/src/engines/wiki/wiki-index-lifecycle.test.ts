/**
 * Wiki index lifecycle through WikiService + WikiSourceManager on the test dialect (SQLite index.db by
 * default, Postgres rows with KNOWLEDGE_TEST_DB_URL): upload → ingest → search (English, Chinese) →
 * graph → restart → delete. The LLM stages of ingest-v2 are stubbed: each source file is its own page.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const extractCalls: string[] = [];

vi.mock("./ingest-v2/index.js", () => ({
  scanExistingPages: () => [],
  extractSource: async (_projectPath: string, abs: string) => {
    extractCalls.push(basename(abs));
    return new Map([[`wiki/concepts/${basename(abs)}`, readFileSync(abs, "utf-8")]]);
  },
  commitCandidates: async (
    projectPath: string,
    all: Array<{ sourceFilename: string; candidates: Map<string, string> }>,
  ) => {
    const written: string[] = [];
    for (const { candidates } of all) {
      for (const [rel, content] of candidates) {
        mkdirSync(dirname(join(projectPath, rel)), { recursive: true });
        writeFileSync(join(projectPath, rel), content, "utf-8");
        written.push(rel);
      }
    }
    return { written, mergeErrors: [] };
  },
}));
vi.mock("./ingest-v2/llm.js", () => ({ createLlmClient: () => ({}) }));
vi.mock("./ingest-v2/overview.js", () => ({ generateOverview: async () => true }));

import { createTestDb, TEST_DIALECT, type TestDb } from "../../test-utils/db.js";
import { SqliteKnowledgeStore } from "../../store/sqlite-store.js";
import { WikiService } from "../../store/wiki-service.js";
import { createWikiIndexStore, type WikiIndexStore } from "./index-store.js";
import { createWikiSourceManager, type WikiSourceManager } from "./manager.js";

const SVC = "svc-A";
const TEAM = "team-1";

const SOURCES: Record<string, string> = {
  "redis.md": "---\ntitle: Redis\ntype: concept\ndescription: In-memory cache\n---\n\n# Redis\n\nRedis caches hot keys in memory. See [[postgres]] for durable storage.\n",
  "postgres.md": "---\ntitle: Postgres\ntype: concept\n---\n\n# Postgres\n\nRelational database with transactions and full text search.\n",
  "召回.md": "---\ntitle: 记忆召回\ntype: concept\n---\n\n# 记忆召回\n\n检索时先做关键词匹配，再做向量召回，最后按分数合并。\n",
};

let db: TestDb;
let index: WikiIndexStore;
let root: string;

interface Stack {
  mgr: WikiSourceManager;
  service: WikiService;
}

/** One "process": manager + service over the shared DB and data dir. */
async function boot(): Promise<Stack> {
  const mgr = await createWikiSourceManager(join(root, "_wiki_engines"), { index });
  const service = new WikiService({
    store: new SqliteKnowledgeStore(db),
    dataRoot: root,
    wikiIndex: index,
    worker: async (ctx) => {
      await mgr.init({ name: ctx.wikiId, path: ctx.dir });
      await mgr.ingest(ctx.wikiId, {});
      return { pageCount: mgr.getPages(ctx.wikiId).length };
    },
  });
  return { mgr, service };
}

async function ingest(s: Stack, wikiId: string): Promise<void> {
  const res = await s.service.ingest(SVC, TEAM, wikiId);
  expect(res.kind).toBe("ok");
  await s.service.onIdle(wikiId);
  expect((await s.service.get(SVC, TEAM, wikiId))?.status).toBe("ready");
}

async function titles(s: Stack, wikiId: string, q: string): Promise<string[]> {
  return (await s.mgr.search(wikiId, q)).results.map((r) => r.title);
}

beforeEach(async () => {
  extractCalls.length = 0;
  db = await createTestDb();
  index = createWikiIndexStore(db);
  root = mkdtempSync(join(tmpdir(), "wiki-life-"));
});

afterEach(async () => {
  await db.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe(`wiki index lifecycle (${TEST_DIALECT})`, () => {
  it("upload → ingest → search, graph; restart keeps sources and index; delete removes everything", async () => {
    const a = await boot();
    const { row } = await a.service.create({ service_id: SVC, team_id: TEAM, name: "kb" });
    const wikiId = row.wiki_id;
    const dir = a.service.dirFor(SVC, TEAM, wikiId);

    const files = Object.entries(SOURCES).map(([filename, content]) => ({ filename, content }));
    expect(await a.service.rawWriteMany(SVC, TEAM, wikiId, files, "u1")).toHaveLength(3);
    const uploaded = await a.service.rawLs(SVC, TEAM, wikiId);
    expect(uploaded?.map((f) => [f.filename, f.status, f.last_modified_by])).toEqual([
      ["postgres.md", "uploaded", "u1"],
      ["redis.md", "uploaded", "u1"],
      ["召回.md", "uploaded", "u1"],
    ]);

    await ingest(a, wikiId);
    expect(extractCalls.sort()).toEqual(["postgres.md", "redis.md", "召回.md"]);
    const ingested = await a.service.rawLs(SVC, TEAM, wikiId);
    expect(ingested?.every((f) => f.status === "ingested" && f.ingested_at !== null)).toBe(true);

    // English: title and body hits, prefix match; the static snippet comes back unchanged.
    const redis = await a.mgr.search(wikiId, "redis");
    expect(redis.results.map((r) => r.path)).toEqual(["wiki/concepts/redis.md"]);
    expect(redis.results[0]).toMatchObject({ title: "Redis", snippet: "In-memory cache", hop: 0 });
    expect(redis.results[0].related).toEqual([
      { title: "Postgres", path: "wiki/concepts/postgres.md", type: "concept", direction: "out" },
    ]);
    expect(await titles(a, wikiId, "transact")).toEqual(["Postgres"]);
    // Chinese: bigram tokens.
    expect(await titles(a, wikiId, "召回")).toEqual(["记忆召回"]);
    expect(await titles(a, wikiId, "向量")).toEqual(["记忆召回"]);
    expect(await titles(a, wikiId, "nothing-like-this")).toEqual([]);

    // Graph: the [[postgres]] wikilink is an edge; hop=1 reaches Postgres through Redis.
    const graph = await a.mgr.graph(wikiId);
    expect(graph.edges).toEqual([{ source: "concepts/redis", target: "concepts/postgres", weight: 1 }]);
    const hop = await a.mgr.search(wikiId, "redis", 10, { hop: 1, minScore: 0 });
    expect(hop.results.map((r) => [r.title, r.hop, r.via])).toEqual([
      ["Redis", 0, undefined],
      ["Postgres", 1, "Redis"],
    ]);
    expect(hop.links).toEqual([{ source: "wiki/concepts/redis.md", target: "wiki/concepts/postgres.md", weight: 1 }]);

    // Restart: a fresh manager + service over the same DB and data dir.
    const b = await boot();
    const afterRestart = await b.service.rawLs(SVC, TEAM, wikiId);
    expect(afterRestart).toEqual(ingested);
    expect(await titles(b, wikiId, "召回")).toEqual(["记忆召回"]);
    extractCalls.length = 0;
    await ingest(b, wikiId);
    expect(extractCalls).toEqual([]); // unchanged sources are skipped: their state survived the restart

    // Delete: rows (Postgres) or the directory with index.db (SQLite) go away.
    expect(await b.service.delete(SVC, TEAM, wikiId)).toBe(true);
    await b.mgr.remove(wikiId);
    expect(existsSync(dir)).toBe(false);
    expect((await b.mgr.search(wikiId, "redis")).results).toEqual([]);
    if (TEST_DIALECT === "postgres") {
      for (const t of ["knowledge_wiki_page", "knowledge_wiki_edge", "knowledge_wiki_source"]) {
        const res = await db.pgPool!.query(`SELECT count(*) AS n FROM ${t} WHERE wiki_id = $1`, [wikiId]);
        expect(Number(res.rows[0].n)).toBe(0);
      }
    }
  });

  it("raw/rm removes the source row; a missing index reads as empty", async () => {
    const a = await boot();
    const { row } = await a.service.create({ service_id: SVC, team_id: TEAM, name: "kb2" });
    await a.service.rawWrite(SVC, TEAM, row.wiki_id, "redis.md", SOURCES["redis.md"]);
    await a.service.rawRm(SVC, TEAM, row.wiki_id, ["redis.md"]);
    expect(await a.service.rawLs(SVC, TEAM, row.wiki_id)).toEqual([]);

    // A wiki the manager never registered, and (SQLite) one whose index.db was never created.
    expect((await a.mgr.search("unknown", "redis")).results).toEqual([]);
    expect(await index.listSources("never", join(root, "never")).catch((e: Error) => e.name)).toEqual(
      TEST_DIALECT === "sqlite" ? "WikiIndexMissingError" : [],
    );
  });
});
