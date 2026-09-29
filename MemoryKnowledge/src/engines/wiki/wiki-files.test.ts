/**
 * Where wiki content lives, end to end through createKnowledgeModule + the /wiki routes, with only the
 * LLM client stubbed (the real ingest-v2 extract/merge/index.md/log.md/overview run):
 * create → upload a markdown and a binary source → ingest → search → restart → delete.
 *
 * Postgres (KNOWLEDGE_TEST_DB_URL): the data dir stays empty, the restart uses a fresh one, and the delete
 * leaves no wiki rows. SQLite: upstream's files under the data dir, restart on the same dir.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatParams } from "./ingest-v2/llm.js";

/** One FILE block per source, named after it (broken.md gets none); an overview for the batch. */
function stubChat({ label = "" }: ChatParams): Promise<string> {
  if (label.startsWith("generate:")) {
    const source = label.slice("generate:".length);
    if (source === "broken.md") return Promise.resolve("no FILE blocks in this answer"); // → _debug dump
    const page = source === "redis.md"
      ? { slug: "redis", title: "Redis", body: "Redis caches hot keys in memory. See [[Postgres]] for durable storage." }
      : { slug: "postgres", title: "Postgres", body: "Relational database with transactions and full text search." };
    return Promise.resolve(
      `<<<FILE path="wiki/concepts/${page.slug}.md">>>\n---\ntype: concept\ntitle: ${page.title}\ndescription: ${page.title} page\n---\n\n# ${page.title}\n\n${page.body}\n<<<END>>>`,
    );
  }
  if (label === "overview") return Promise.resolve("[[Redis]] caches in front of [[Postgres]].");
  return Promise.resolve(""); // analysis: empty → single-stage generate
}

vi.mock("./ingest-v2/llm.js", () => ({
  createLlmClient: () => ({ chat: stubChat, config: {} }),
}));

import { createTestDb, TEST_DIALECT, type TestDb } from "../../test-utils/db.js";
import { createKnowledgeModule, type KnowledgeModule } from "../../module.js";
import { createWikiRoutes } from "../../routes/wiki.js";

const SVC = "svc-files";
const TEAM = "team-1";
const LLM = {
  mode: "custom" as const,
  protocol: "openai" as const,
  provider: "custom",
  apiKey: "stub",
  model: "stub",
  baseUrl: "http://127.0.0.1:9",
  maxTokens: 1024,
  timeoutMs: 1000,
};
const README = "# Redis\n\nRedis caches hot keys in memory.\n";
const POSTGRES = "# Postgres\n\nTransactions and full text search.\n";
const BROKEN = "# Broken\n\nThe stub LLM answers without FILE blocks.\n";
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0xfe]);
const MAX_SOURCE_BYTES = 4096;

interface Stack {
  mod: KnowledgeModule;
  app: Hono;
}

let db: TestDb;
const dirs: string[] = [];
const stacks: Stack[] = [];

function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wiki-files-"));
  dirs.push(d);
  return d;
}

/** Every file under `dir`, relative. */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

async function boot(dataDir: string): Promise<Stack> {
  const mod = await createKnowledgeModule({ dataDir, db, llmConfig: LLM, maxSourceBytes: MAX_SOURCE_BYTES });
  const app = new Hono();
  app.route("/wiki", createWikiRoutes({ wikiService: mod.wikiService, wikiMgr: mod.wikiMgr, publicBaseUrl: "" }));
  const s = { mod, app };
  stacks.push(s);
  return s;
}

async function post(s: Stack, path: string, body: Record<string, unknown>) {
  const res = await s.app.request(`/wiki${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-tdai-service-id": SVC },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as { code: number; message: string; data: any } };
}

async function searchTitles(s: Stack, wikiId: string, query: string): Promise<string[]> {
  const res = await post(s, "/search", { wiki_id: wikiId, query });
  expect(res.status).toBe(200);
  return res.body.data.results.map((r: { title: string }) => r.title);
}

async function rowCounts(wikiId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const byWikiId = [
    "knowledge_wiki",
    "knowledge_wiki_page",
    "knowledge_wiki_edge",
    "knowledge_wiki_source",
    "knowledge_wiki_page_file",
    "knowledge_wiki_source_file",
  ];
  for (const t of byWikiId) {
    // t comes from the list above.
    const res = await db.pgPool!.query(`SELECT count(*) AS n FROM ${t} WHERE wiki_id = $1`, [wikiId]);
    out[t] = Number(res.rows[0].n);
  }
  const reg = await db.pgPool!.query("SELECT count(*) AS n FROM knowledge_wiki_registry WHERE name = $1", [wikiId]);
  out.knowledge_wiki_registry = Number(reg.rows[0].n);
  return out;
}

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  for (const s of stacks.splice(0)) {
    s.mod.autoSyncScheduler.stop();
    await s.mod.wikiService.onIdle();
  }
  // Let the module's background restore settle before the DB goes away.
  await new Promise((r) => setTimeout(r, 50));
  await db.dispose();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe(`wiki files (${TEST_DIALECT})`, () => {
  it("create → upload md + binary → ingest → search → restart → delete", async () => {
    const dataDir = freshDir();
    const a = await boot(dataDir);

    const created = await post(a, "/create", { team_id: TEAM, name: "kb" });
    expect(created.status).toBe(201);
    const wikiId: string = created.body.data.wiki_id;

    const up = await post(a, "/raw/write", {
      team_id: TEAM,
      wiki_id: wikiId,
      user_id: "u1",
      files: [
        { filename: "redis.md", content: README },
        { filename: "postgres.md", content: POSTGRES },
        { filename: "logo.png", content: LOGO.toString("base64"), encoding: "base64" },
        { filename: "broken.md", content: BROKEN },
      ],
    });
    expect(up.status).toBe(200);
    expect(up.body.data.items).toEqual([
      { filename: "redis.md", size: Buffer.byteLength(README) },
      { filename: "postgres.md", size: Buffer.byteLength(POSTGRES) },
      { filename: "logo.png", size: LOGO.length },
      { filename: "broken.md", size: Buffer.byteLength(BROKEN) },
    ]);

    // Over KNOWLEDGE_MAX_SOURCE_BYTES → 413, nothing written.
    const tooBig = await post(a, "/raw/write", {
      team_id: TEAM,
      wiki_id: wikiId,
      files: [{ filename: "big.txt", content: "x".repeat(MAX_SOURCE_BYTES + 1) }],
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.code).toBe(413);
    const bad64 = await post(a, "/raw/write", {
      team_id: TEAM,
      wiki_id: wikiId,
      files: [{ filename: "x.bin", content: "not base64!", encoding: "base64" }],
    });
    expect(bad64.status).toBe(400);

    const ingest = await post(a, "/ingest", { wiki_id: wikiId });
    expect(ingest.status).toBe(202);
    await a.mod.wikiService.onIdle(wikiId);
    const got = await post(a, "/get", { wiki_id: wikiId });
    expect(got.body.data.status).toBe("ready");

    const pages = await post(a, "/page/ls", { wiki_id: wikiId });
    const pagePaths = pages.body.data.items.map((p: { path: string }) => p.path).sort();
    expect(pagePaths).toEqual([
      "wiki/concepts/postgres.md",
      "wiki/concepts/redis.md",
      "wiki/index.md",
      "wiki/log.md",
      "wiki/overview.md",
      "wiki/purpose.md",
      "wiki/schema.md",
    ]);
    expect(await searchTitles(a, wikiId, "redis")).toContain("Redis");
    const graph = await post(a, "/graph", { wiki_id: wikiId });
    expect(graph.body.data.edges).toContainEqual({ source: "concepts/redis", target: "concepts/postgres", weight: 1 });

    const raws = await post(a, "/raw/ls", { wiki_id: wikiId });
    expect(raws.body.data.items.map((f: { filename: string; status: string }) => [f.filename, f.status])).toEqual([
      ["broken.md", "failed"],
      ["logo.png", "uploaded"], // not a .md/.txt: stored, never extracted
      ["postgres.md", "ingested"],
      ["redis.md", "ingested"],
    ]);

    const files = listFiles(dataDir);
    if (TEST_DIALECT === "postgres") {
      // Nothing of the wiki on disk: no pages, sources, registry, index.db, nor the _debug dump of broken.md.
      expect(files).toEqual([]);
    } else {
      const base = join(SVC, TEAM, wikiId);
      expect(files).toEqual(
        expect.arrayContaining([
          "_wiki_engines/wiki-sources.json",
          join(base, "index.db"),
          join(base, "raw/sources/logo.png"),
          join(base, "raw/sources/redis.md"),
          join(base, "wiki/concepts/redis.md"),
          join(base, "wiki/log.md"),
        ]),
      );
      expect(files.some((f) => f.startsWith(join(base, "_debug", "generate-fail-broken.md")))).toBe(true);
    }

    // Restart: Postgres on a fresh data dir, SQLite on the same one (its content is the files).
    const b = await boot(TEST_DIALECT === "postgres" ? freshDir() : dataDir);
    const pagesAfter = await post(b, "/page/ls", { wiki_id: wikiId });
    expect(pagesAfter.body.data.items.map((p: { path: string }) => p.path).sort()).toEqual(pagePaths);
    const redisPage = await post(b, "/page/read", { wiki_id: wikiId, refs: ["concepts/redis"] });
    expect(redisPage.body.data.items[0].content).toContain("Redis caches hot keys");
    const logo = await post(b, "/raw/read", { wiki_id: wikiId, filenames: ["logo.png"], encoding: "base64" });
    expect(Buffer.from(logo.body.data.items[0].content, "base64").equals(LOGO)).toBe(true);
    const readme = await post(b, "/raw/read", { wiki_id: wikiId, filenames: ["redis.md"] });
    expect(readme.body.data.items[0].content).toBe(README);
    expect(await searchTitles(b, wikiId, "transactions")).toEqual(["Postgres"]);
    if (TEST_DIALECT === "postgres") expect(listFiles(stacks[1].mod.wikiService.dirFor(SVC, TEAM, wikiId))).toEqual([]);

    // raw/rm cascades to the page that only that source produced.
    const rm = await post(b, "/raw/rm", { team_id: TEAM, wiki_id: wikiId, filenames: ["postgres.md"] });
    expect(rm.body.data.deleted_pages).toEqual(["concepts/postgres"]);
    expect(await searchTitles(b, wikiId, "transactions")).toEqual([]);

    // Delete: no wiki rows (Postgres) / no wiki directory (SQLite).
    const del = await post(b, "/delete", { wiki_ids: [wikiId] });
    expect(del.body.data.deleted_ids).toEqual([wikiId]);
    expect((await post(b, "/get", { wiki_id: wikiId })).status).toBe(404);
    if (TEST_DIALECT === "postgres") {
      expect(await rowCounts(wikiId)).toEqual({
        knowledge_wiki: 0,
        knowledge_wiki_page: 0,
        knowledge_wiki_edge: 0,
        knowledge_wiki_source: 0,
        knowledge_wiki_page_file: 0,
        knowledge_wiki_source_file: 0,
        knowledge_wiki_registry: 0,
      });
    } else {
      expect(existsSync(join(dataDir, SVC, TEAM, wikiId))).toBe(false);
    }
  });
});
