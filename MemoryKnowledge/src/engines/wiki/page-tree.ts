/**
 * In-memory working copy of a wiki's pages for the ingest pipeline and the delete cascades, which
 * walk and rewrite many pages synchronously. Loaded from the WikiContentStore, mutated in memory,
 * written back with one `flush` (only changed and removed pages). A stage that fails before its
 * flush leaves the stored pages untouched, where upstream left the pages it had written so far.
 *
 * Memory: the whole wiki's pages are held while a stage runs (page/write caps a page at 512 KiB).
 */

import { isListedPage, type PageChanges, type WikiContentStore, type WikiLoc, type WikiPageFile } from "./content-store.js";

export class PageTree {
  private readonly pages = new Map<string, string>();
  private baseline = new Map<string, string>();
  private present: boolean;

  /** `exists`: the wiki has a page area at all (upstream: `wiki/` exists). */
  constructor(pages: WikiPageFile[] = [], exists = true) {
    for (const p of pages) this.pages.set(p.path, p.content);
    this.baseline = new Map(this.pages);
    this.present = exists;
  }

  static async load(store: WikiContentStore, loc: WikiLoc): Promise<PageTree> {
    const [pages, exists] = await Promise.all([store.listPages(loc), store.hasPages(loc)]);
    return new PageTree(pages, exists);
  }

  get exists(): boolean {
    return this.present;
  }

  /** Listed pages (`.md`, outside `media/`), in store order. */
  paths(): string[] {
    return [...this.pages.keys()].filter(isListedPage);
  }

  has(path: string): boolean {
    return this.pages.has(path);
  }

  get(path: string): string | undefined {
    return this.pages.get(path);
  }

  set(path: string, content: string): void {
    this.pages.set(path, content);
    this.present = true;
  }

  delete(path: string): boolean {
    return this.pages.delete(path);
  }

  changes(): PageChanges {
    const put: WikiPageFile[] = [];
    for (const [path, content] of this.pages) {
      if (this.baseline.get(path) !== content) put.push({ path, content });
    }
    const remove = [...this.baseline.keys()].filter((p) => !this.pages.has(p));
    return { put, remove };
  }

  async flush(store: WikiContentStore, loc: WikiLoc): Promise<void> {
    const changes = this.changes();
    if (changes.put.length === 0 && changes.remove.length === 0) return;
    await store.applyPages(loc, changes);
    this.baseline = new Map(this.pages);
  }
}
