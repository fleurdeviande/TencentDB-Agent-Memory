/**
 * cascade.ts — 删除级联（raw/rm 与 page/rm 的下游清理）。
 *
 * 行为契约见 PRD §3.7-3 与 wiki-service.ts 的调用签名。
 *
 *  - deleteSourceFiles：删 raw 源文件，并按各 page 的 frontmatter `sources` 级联——
 *      独占该源的 page → 删除；共享的 page → 重写去掉该源。
 *  - cascadeDeleteWikiPagesWithRefs：删 wiki page 文件，并清理其它 page 正文中
 *      指向已删页的 [[wikilink]]（悬空链接）。
 */

import { posix } from "node:path";
import { parseFrontmatter, buildPage } from "./frontmatter.js";
import { slugify } from "./slug.js";
import type { PageTree } from "../page-tree.js";

export interface DeleteSourceFilesResult {
  /** 被级联删除的 wiki page 路径（`wiki/…`）。 */
  deletedWikiPaths: string[];
  /** 被重写（去掉某源）的 wiki page 数量。 */
  rewrittenSourcePages: number;
}

export interface DeleteSourceFilesOptions {
  /** 仅用于日志标记，便于审计。 */
  logReason?: string;
}

/** 结构性文件不参与级联删除/重写。 */
function isStructural(relFromWiki: string): boolean {
  return relFromWiki === "index.md" || relFromWiki === "schema.md" || relFromWiki === "purpose.md";
}

/**
 * 按被删源文件级联清理引用它们的 wiki page（源文件本身由调用方从 WikiContentStore 删除）。
 * Pages are edited in `tree`; the caller flushes it.
 *
 * @param tree wiki 页工作副本
 * @param sourceNames 被删源文件名（相对 raw/sources/；page frontmatter 记的是 basename）
 */
export async function deleteSourceFiles(
  tree: PageTree,
  sourceNames: string[],
  _opts: DeleteSourceFilesOptions = {},
): Promise<DeleteSourceFilesResult> {
  const deletedNames = new Set(sourceNames.map((n) => posix.basename(n)));
  const deletedWikiPaths: string[] = [];
  let rewrittenSourcePages = 0;

  for (const pagePath of tree.paths()) {
    const relFromWiki = pagePath.slice("wiki/".length);
    if (isStructural(relFromWiki)) continue;

    const content = tree.get(pagePath)!;
    const parsed = parseFrontmatter(content);
    const sources = Array.isArray(parsed.frontmatter.sources)
      ? parsed.frontmatter.sources.filter((x): x is string => typeof x === "string")
      : [];
    if (sources.length === 0) continue;

    const remaining = sources.filter((s) => !deletedNames.has(s));
    if (remaining.length === sources.length) continue; // 本页不引用被删源

    if (remaining.length === 0) {
      // 独占被删源 → 删页
      tree.delete(pagePath);
      deletedWikiPaths.push(pagePath);
    } else {
      // 共享 → 重写去掉被删源
      tree.set(pagePath, buildPage({ ...parsed.frontmatter, sources: remaining }, parsed.body));
      rewrittenSourcePages++;
    }
  }

  return { deletedWikiPaths, rewrittenSourcePages };
}

export interface CascadeDeletePagesResult {
  /** 实际删除的 wiki page 路径（`wiki/…`）。 */
  deletedPaths: string[];
  /** 被重写（清理悬空 wikilink）的 page 数量。 */
  rewrittenFiles: number;
}

/** 从一个页路径与内容推导出它可能被 [[wikilink]] 引用的标识符（小写归一）。 */
function linkAliasesFor(pagePath: string, content: string): Set<string> {
  const aliases = new Set<string>();
  const base = posix.basename(pagePath, ".md");
  aliases.add(base.toLowerCase());
  aliases.add(slugify(base).toLowerCase());
  const { frontmatter } = parseFrontmatter(content);
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) {
    aliases.add(frontmatter.title.trim().toLowerCase());
    aliases.add(slugify(frontmatter.title).toLowerCase());
  }
  return aliases;
}

/** 归一化一个 wikilink 目标（去 |label、trim、小写）。 */
function normalizeLinkTarget(raw: string): string {
  const target = raw.split("|")[0].trim();
  return target.toLowerCase();
}

/**
 * 删除 wiki page，并清理其它 page 正文中指向已删页的 [[wikilink]]。Edits `tree`; the caller flushes it.
 *
 * @param tree wiki 页工作副本
 * @param pagePaths 要删除的 wiki page 路径（`wiki/…`）
 */
export async function cascadeDeleteWikiPagesWithRefs(
  tree: PageTree,
  pagePaths: string[],
): Promise<CascadeDeletePagesResult> {
  // 删除前先收集被删页的 wikilink 别名，用于后续悬空链接清理。
  const deletedAliases = new Set<string>();
  const toDelete = new Set(pagePaths);
  for (const p of pagePaths) {
    for (const a of linkAliasesFor(p, tree.get(p) ?? "")) deletedAliases.add(a);
  }

  // 执行删除。
  const deletedPaths: string[] = [];
  for (const p of pagePaths) {
    if (tree.delete(p)) deletedPaths.push(p);
  }

  // 清理剩余 page 中指向已删页的 [[wikilink]]：把 [[X]] / [[X|label]] 替换为其展示文本。
  let rewrittenFiles = 0;
  const linkRe = /\[\[([^\]]+?)\]\]/g;
  for (const pagePath of tree.paths()) {
    if (toDelete.has(pagePath)) continue;
    const content = tree.get(pagePath)!;
    let changed = false;
    const next = content.replace(linkRe, (whole, inner: string) => {
      const target = normalizeLinkTarget(inner);
      if (deletedAliases.has(target)) {
        changed = true;
        // 保留可读文本：有 |label 用 label，否则用原目标名。
        const parts = String(inner).split("|");
        return (parts[1] ?? parts[0]).trim();
      }
      return whole;
    });
    if (changed) {
      tree.set(pagePath, next);
      rewrittenFiles++;
    }
  }

  return { deletedPaths, rewrittenFiles };
}
