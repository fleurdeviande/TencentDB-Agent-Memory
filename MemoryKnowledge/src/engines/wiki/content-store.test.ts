/**
 * WikiContentStore contract on the test dialect: files under a temp dir (SQLite runs) or Postgres rows
 * (KNOWLEDGE_TEST_DB_URL).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, TEST_DIALECT, type TestDb } from "../../test-utils/db.js";
import {
  createWikiContentStore,
  isListedPage,
  isSourceTooLarge,
  sha256Of,
  type WikiContentStore,
  type WikiLoc,
} from "./content-store.js";

let db: TestDb;
let root: string;
let store: WikiContentStore;
let a: WikiLoc;
let b: WikiLoc;

const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a, 0x00]);

beforeEach(async () => {
  db = await createTestDb();
  root = mkdtempSync(join(tmpdir(), "wiki-content-"));
  store = createWikiContentStore(db, { registryDir: join(root, "_wiki_engines"), maxSourceBytes: 64 });
  a = { wikiId: "wiki_a", dir: join(root, "svc", "team", "wiki_a") };
  b = { wikiId: "wiki_b", dir: join(root, "svc", "team", "wiki_b") };
  await store.init(a, ["raw/sources"]);
  await store.init(b, ["raw/sources"]);
});

afterEach(async () => {
  await db.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe(`WikiContentStore (${TEST_DIALECT})`, () => {
  it("is the backend of the dialect", () => {
    expect(store.kind).toBe(TEST_DIALECT === "postgres" ? "postgres" : "fs");
  });

  it("pages: put, read, list (the upstream walk's filter), remove; wikis are isolated", async () => {
    expect(await store.hasPages(a)).toBe(false);
    await store.applyPages(a, {
      put: [
        { path: "wiki/concepts/redis.md", content: "# Redis 缓存\n" },
        { path: "wiki/index.md", content: "# Index\n" },
        { path: "wiki/media/pic.md", content: "hidden" },
        { path: "wiki/notes.txt", content: "not a page" },
      ],
      remove: [],
    });
    await store.applyPages(b, { put: [{ path: "wiki/other.md", content: "b" }], remove: [] });

    expect(await store.hasPages(a)).toBe(true);
    expect(await store.readPage(a, "wiki/concepts/redis.md")).toBe("# Redis 缓存\n");
    expect(await store.readPage(a, "wiki/media/pic.md")).toBe("hidden");
    expect(await store.readPage(a, "wiki/missing.md")).toBeNull();
    expect(await store.readPage(b, "wiki/concepts/redis.md")).toBeNull();
    const listed = (await store.listPages(a)).map((p) => p.path).sort();
    expect(listed).toEqual(["wiki/concepts/redis.md", "wiki/index.md"]);

    await store.applyPages(a, {
      put: [{ path: "wiki/index.md", content: "# Index v2\n" }],
      remove: ["wiki/concepts/redis.md", "wiki/never-existed.md"],
    });
    expect(await store.readPage(a, "wiki/concepts/redis.md")).toBeNull();
    expect(await store.readPage(a, "wiki/index.md")).toBe("# Index v2\n");
    expect((await store.listPages(b)).map((p) => p.path)).toEqual(["wiki/other.md"]);
  });

  it("rejects paths outside wiki/ and traversal", async () => {
    for (const bad of ["raw/x.md", "wiki/../x.md", "/etc/passwd", "wiki//x.md", "wiki/./x.md"]) {
      await expect(store.applyPages(a, { put: [{ path: bad, content: "x" }], remove: [] })).rejects.toThrow(/invalid/);
    }
    await expect(store.readSource(a, "../secret")).rejects.toThrow(/invalid/);
  });

  it("sources: text and binary round-trip byte for byte, list carries size and sha256", async () => {
    await store.writeSources(a, [
      { filename: "readme.md", data: Buffer.from("# 你好\n", "utf-8") },
      { filename: "logo.png", data: BINARY },
    ]);
    expect((await store.readSource(a, "logo.png"))?.equals(BINARY)).toBe(true);
    expect((await store.readSource(a, "readme.md"))?.toString("utf-8")).toBe("# 你好\n");
    expect(await store.readSource(b, "logo.png")).toBeNull();

    const listed = (await store.listSources(a)).sort((x, y) => x.filename.localeCompare(y.filename));
    expect(listed).toEqual([
      { filename: "logo.png", size: BINARY.length, sha256: sha256Of(BINARY) },
      { filename: "readme.md", size: Buffer.byteLength("# 你好\n"), sha256: sha256Of("# 你好\n") },
    ]);
    expect((await store.listSources(a, (f) => f.endsWith(".md"))).map((s) => s.filename)).toEqual(["readme.md"]);

    await store.writeSources(a, [{ filename: "readme.md", data: Buffer.from("v2") }]);
    expect((await store.readSource(a, "readme.md"))?.toString()).toBe("v2");
    await store.deleteSources(a, ["logo.png", "unknown.bin"]);
    expect((await store.listSources(a)).map((s) => s.filename)).toEqual(["readme.md"]);
  });

  it("over KNOWLEDGE_MAX_SOURCE_BYTES: a 413 error and nothing of the batch is written", async () => {
    const err = await store
      .writeSources(a, [
        { filename: "ok.md", data: Buffer.from("small") },
        { filename: "big.bin", data: Buffer.alloc(65) },
      ])
      .catch((e: unknown) => e);
    expect(isSourceTooLarge(err)).toBe(true);
    expect(err).toMatchObject({ status: 413, filename: "big.bin", size: 65, maxBytes: 64 });
    expect(await store.listSources(a)).toEqual([]);
    await store.writeSources(a, [{ filename: "edge.bin", data: Buffer.alloc(64) }]);
    expect((await store.listSources(a)).map((s) => s.size)).toEqual([64]);
  });

  it("registry: put, load, remove", async () => {
    await store.putRegistry({ name: "wiki_a", path: a.dir, status: "ready", pageCount: 2 });
    await store.putRegistry({ name: "wiki_b", path: b.dir, status: "scanning" });
    await store.putRegistry({ name: "wiki_b", path: b.dir, status: "error", error: "boom" });
    await store.removeRegistry("wiki_a");
    const fresh = createWikiContentStore(db, { registryDir: join(root, "_wiki_engines") });
    expect(await fresh.loadRegistry()).toEqual({ wiki_b: { name: "wiki_b", path: b.dir, status: "error", error: "boom" } });
    if (TEST_DIALECT === "sqlite") {
      expect(JSON.parse(readFileSync(join(root, "_wiki_engines", "wiki-sources.json"), "utf-8"))).toHaveProperty("wiki_b");
    }
  });

  it("drop removes the wiki's pages, sources (and on Postgres its registry row) only", async () => {
    await store.applyPages(a, { put: [{ path: "wiki/x.md", content: "x" }], remove: [] });
    await store.writeSources(a, [{ filename: "s.md", data: Buffer.from("s") }]);
    await store.applyPages(b, { put: [{ path: "wiki/y.md", content: "y" }], remove: [] });
    await store.putRegistry({ name: "wiki_a", path: a.dir, status: "ready" });

    await store.drop(a);
    await store.drop(a); // idempotent
    expect(await store.listPages(a)).toEqual([]);
    expect(await store.listSources(a)).toEqual([]);
    expect(await store.hasPages(a)).toBe(false);
    expect((await store.listPages(b)).map((p) => p.path)).toEqual(["wiki/y.md"]);
    if (TEST_DIALECT === "postgres") {
      expect(await store.loadRegistry()).toEqual({});
      for (const t of ["knowledge_wiki_page_file", "knowledge_wiki_source_file"]) {
        const res = await db.pgPool!.query(`SELECT count(*) AS n FROM ${t} WHERE wiki_id = $1`, ["wiki_a"]);
        expect(Number(res.rows[0].n)).toBe(0);
      }
    } else {
      expect(existsSync(a.dir)).toBe(false);
    }
  });

  it("isListedPage mirrors the upstream walks", () => {
    expect(isListedPage("wiki/a.md")).toBe(true);
    expect(isListedPage("wiki/media.md")).toBe(true);
    expect(isListedPage("wiki/x/media/a.md")).toBe(false);
    expect(isListedPage("wiki/a.txt")).toBe(false);
    expect(isListedPage("raw/a.md")).toBe(false);
  });
});
