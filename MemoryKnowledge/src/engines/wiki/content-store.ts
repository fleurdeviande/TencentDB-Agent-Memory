/**
 * Dialect-neutral wiki content: pages (`wiki/**.md`), uploaded sources (`raw/sources/**`) and the
 * manager registry (`_wiki_engines/wiki-sources.json`).
 *
 * Filesystem (default): exactly upstream's layout under the wiki directory. Postgres (KNOWLEDGE_DB_URL):
 * rows keyed by wiki_id on the metadata pool (content-store-pg.ts) — pages as text, sources as bytea,
 * the registry as JSONB — so nothing durable of a wiki lives on disk.
 *
 * A wiki is addressed by `WikiLoc`: the filesystem uses `dir`, Postgres `wikiId`. Page paths are
 * project-relative POSIX paths starting with `wiki/`; source names are relative to `raw/sources/`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { createHash } from "node:crypto";

import type { KnowledgeDb } from "../../db/client.js";
import type { WikiSourceState } from "./types.js";
import { PostgresWikiContentStore } from "./content-store-pg.js";

export interface WikiLoc {
  wikiId: string;
  dir: string;
}

export interface WikiPageFile {
  /** `wiki/…` */
  path: string;
  content: string;
}

export interface WikiSourceEntry {
  filename: string;
  size: number;
  sha256: string;
}

export interface WikiSourceFile {
  filename: string;
  data: Buffer;
}

export interface PageChanges {
  put: WikiPageFile[];
  remove: string[];
}

export const DEFAULT_MAX_SOURCE_BYTES = 50 * 1024 * 1024;

/** A source exceeds KNOWLEDGE_MAX_SOURCE_BYTES; nothing of the batch was written. Maps to HTTP 413. */
export class SourceTooLargeError extends Error {
  readonly status = 413;
  constructor(
    readonly filename: string,
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`source ${filename} is ${size} bytes, over the ${maxBytes}-byte limit (KNOWLEDGE_MAX_SOURCE_BYTES)`);
    this.name = "SourceTooLargeError";
  }
}

export function isSourceTooLarge(err: unknown): err is SourceTooLargeError {
  return err instanceof SourceTooLargeError;
}

export function sha256Of(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Normalised `wiki/…` path without `.`/`..` segments; throws otherwise (callers validate first). */
export function assertPagePath(path: string): string {
  const norm = posix.normalize(path);
  if (norm !== path || !path.startsWith("wiki/") || path.split("/").some((s) => s === ".." || s === "." || s === "")) {
    throw new Error(`invalid wiki page path: ${path}`);
  }
  return path;
}

export function assertSourceName(filename: string): string {
  const norm = posix.normalize(filename);
  if (!filename || norm !== filename || filename.startsWith("/") || filename.split("/").some((s) => s === ".." || s === "." || s === "")) {
    throw new Error(`invalid source filename: ${filename}`);
  }
  return filename;
}

/** The pages every upstream walk sees: `.md` files, skipping any directory named `media`. */
export function isListedPage(path: string): boolean {
  if (!path.startsWith("wiki/") || !path.endsWith(".md")) return false;
  const dirs = path.split("/").slice(1, -1);
  return !dirs.includes("media");
}

export interface WikiContentStore {
  readonly kind: "fs" | "postgres";
  readonly maxSourceBytes: number;
  /** Idempotent. Filesystem: create these directories (relative to the wiki dir); Postgres: nothing. */
  init(loc: WikiLoc, dirs: readonly string[]): Promise<void>;
  /** Filesystem: `wiki/` exists; Postgres: the wiki has at least one page. */
  hasPages(loc: WikiLoc): Promise<boolean>;
  listPages(loc: WikiLoc): Promise<WikiPageFile[]>;
  readPage(loc: WikiLoc, path: string): Promise<string | null>;
  /** All or nothing: the filesystem restores what it overwrote, Postgres runs one transaction. */
  applyPages(loc: WikiLoc, changes: PageChanges): Promise<void>;
  /** `match` filters by name before anything is read (the filesystem hashes every listed file). */
  listSources(loc: WikiLoc, match?: (filename: string) => boolean): Promise<WikiSourceEntry[]>;
  readSource(loc: WikiLoc, filename: string): Promise<Buffer | null>;
  /** All or nothing; throws SourceTooLargeError before writing anything. */
  writeSources(loc: WikiLoc, files: WikiSourceFile[]): Promise<void>;
  deleteSources(loc: WikiLoc, filenames: string[]): Promise<void>;
  /** Wiki deleted: filesystem removes the directory, Postgres the wiki's page, source and registry rows. */
  drop(loc: WikiLoc): Promise<void>;
  loadRegistry(): Promise<Record<string, WikiSourceState>>;
  putRegistry(state: WikiSourceState): Promise<void>;
  removeRegistry(name: string): Promise<void>;
}

export interface WikiContentStoreOptions {
  /** Filesystem registry directory (`{dataDir}/_wiki_engines`). */
  registryDir: string;
  maxSourceBytes?: number;
}

export function checkSourceSizes(files: WikiSourceFile[], maxBytes: number): void {
  for (const f of files) {
    if (f.data.length > maxBytes) throw new SourceTooLargeError(f.filename, f.data.length, maxBytes);
  }
}

function resolveMaxBytes(n: number | undefined): number {
  if (n === undefined) return DEFAULT_MAX_SOURCE_BYTES;
  if (!Number.isInteger(n) || n < 1) throw new Error(`KNOWLEDGE_MAX_SOURCE_BYTES must be a positive integer: ${n}`);
  return n;
}

// ── Filesystem: upstream's layout ──

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

export class FsWikiContentStore implements WikiContentStore {
  readonly kind = "fs" as const;
  readonly maxSourceBytes: number;
  private readonly registryFile: string;
  private readonly registryDir: string;
  /** Same object references the manager holds, so a write serialises its current view as upstream did. */
  private readonly registry = new Map<string, WikiSourceState>();

  constructor(opts: WikiContentStoreOptions) {
    this.registryDir = opts.registryDir;
    this.registryFile = join(opts.registryDir, "wiki-sources.json");
    this.maxSourceBytes = resolveMaxBytes(opts.maxSourceBytes);
  }

  async init(loc: WikiLoc, dirs: readonly string[]): Promise<void> {
    for (const d of dirs) mkdirSync(join(loc.dir, d), { recursive: true });
  }

  async hasPages(loc: WikiLoc): Promise<boolean> {
    return existsSync(join(loc.dir, "wiki"));
  }

  async listPages(loc: WikiLoc): Promise<WikiPageFile[]> {
    const out: WikiPageFile[] = [];
    const walk = (dir: string) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        let isDir: boolean;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          if (entry !== "media") walk(full);
        } else if (entry.endsWith(".md")) {
          try {
            out.push({ path: relative(loc.dir, full).replace(/\\/g, "/"), content: readFileSync(full, "utf-8") });
          } catch {
            /* unreadable page: skipped, as upstream */
          }
        }
      }
    };
    walk(join(loc.dir, "wiki"));
    return out;
  }

  async readPage(loc: WikiLoc, path: string): Promise<string | null> {
    return readOrNull(join(loc.dir, assertPagePath(path)))?.toString("utf-8") ?? null;
  }

  async applyPages(loc: WikiLoc, changes: PageChanges): Promise<void> {
    const plan = [
      ...changes.put.map((p) => ({ full: join(loc.dir, assertPagePath(p.path)), content: p.content as string | null })),
      ...changes.remove.map((p) => ({ full: join(loc.dir, assertPagePath(p)), content: null })),
    ].map((p) => ({ ...p, pre: readOrNull(p.full) }));
    const done: typeof plan = [];
    try {
      for (const p of plan) {
        if (p.content === null) {
          rmSync(p.full, { force: true });
        } else {
          mkdirSync(dirname(p.full), { recursive: true });
          writeFileSync(p.full, p.content, "utf-8");
        }
        done.push(p);
      }
    } catch (err) {
      for (const p of done.reverse()) {
        try {
          if (p.pre === null) rmSync(p.full, { force: true });
          else writeFileSync(p.full, p.pre);
        } catch {
          /* best-effort rollback, as upstream */
        }
      }
      throw err;
    }
  }

  async listSources(loc: WikiLoc, match?: (filename: string) => boolean): Promise<WikiSourceEntry[]> {
    const base = join(loc.dir, "raw", "sources");
    if (!existsSync(base)) return [];
    const out: WikiSourceEntry[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        const filename = relative(base, full).replace(/\\/g, "/");
        if (match && !match(filename)) continue;
        const data = readFileSync(full);
        out.push({ filename, size: data.length, sha256: sha256Of(data) });
      }
    };
    walk(base);
    return out;
  }

  async readSource(loc: WikiLoc, filename: string): Promise<Buffer | null> {
    return readOrNull(join(loc.dir, "raw", "sources", assertSourceName(filename)));
  }

  async writeSources(loc: WikiLoc, files: WikiSourceFile[]): Promise<void> {
    checkSourceSizes(files, this.maxSourceBytes);
    const base = join(loc.dir, "raw", "sources");
    const plan = files.map((f) => {
      const full = join(base, assertSourceName(f.filename));
      return { full, data: f.data, pre: readOrNull(full) };
    });
    // Upstream creates raw/sources/ only; a nested name needs its directory to exist already.
    mkdirSync(base, { recursive: true });
    const done: typeof plan = [];
    try {
      for (const p of plan) {
        writeFileSync(p.full, p.data);
        done.push(p);
      }
    } catch (err) {
      for (const p of done) {
        try {
          if (p.pre === null) rmSync(p.full, { force: true });
          else writeFileSync(p.full, p.pre);
        } catch {
          /* best-effort rollback, as upstream */
        }
      }
      throw err;
    }
  }

  async deleteSources(loc: WikiLoc, filenames: string[]): Promise<void> {
    for (const f of filenames) {
      try {
        rmSync(join(loc.dir, "raw", "sources", assertSourceName(f)), { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  async drop(loc: WikiLoc): Promise<void> {
    rmSync(loc.dir, { recursive: true, force: true });
  }

  async loadRegistry(): Promise<Record<string, WikiSourceState>> {
    mkdirSync(this.registryDir, { recursive: true });
    if (!existsSync(this.registryFile)) return {};
    let raw: Record<string, WikiSourceState>;
    try {
      raw = JSON.parse(readFileSync(this.registryFile, "utf-8"));
    } catch {
      return {}; // fresh start, as upstream
    }
    for (const [name, state] of Object.entries(raw)) this.registry.set(name, state);
    return raw;
  }

  async putRegistry(state: WikiSourceState): Promise<void> {
    this.registry.set(state.name, state);
    this.writeRegistry();
  }

  async removeRegistry(name: string): Promise<void> {
    this.registry.delete(name);
    this.writeRegistry();
  }

  private writeRegistry(): void {
    mkdirSync(this.registryDir, { recursive: true });
    writeFileSync(this.registryFile, JSON.stringify(Object.fromEntries(this.registry.entries()), null, 2), "utf-8");
  }
}

/** Postgres rows when the metadata DB is Postgres, otherwise upstream's files. */
export function createWikiContentStore(
  db: Pick<KnowledgeDb, "dialect" | "pgPool"> | undefined,
  opts: WikiContentStoreOptions,
): WikiContentStore {
  if (db?.dialect === "postgres") {
    if (!db.pgPool) throw new Error("Postgres KnowledgeDb without a pool: cannot open the wiki content store");
    return new PostgresWikiContentStore(db.pgPool, resolveMaxBytes(opts.maxSourceBytes));
  }
  return new FsWikiContentStore(opts);
}
