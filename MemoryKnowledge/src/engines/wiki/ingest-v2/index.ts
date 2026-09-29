/**
 * index.ts — ingest 引擎入口。
 *
 * 两阶段模型（wiki-ingest-optimization）：
 *   1. extractSource() — 纯 LLM 抽取，返回候选页 Map（可并发）
 *   2. commitCandidates() — 串行 merge + 落盘 + index.md/log.md 收尾
 *
 * ingestSource() 保留为薄封装（= extract + commit 串行），现有单测/外部调用不变。 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import type { LimitFunction } from "p-limit";
import { createLlmClient, type LlmClient, type RawLlmConfig } from "./llm.js";
import { loadTemplate } from "./template.js";
import {
  buildSystemPrompt,
  buildGeneratePrompt,
  buildAnalysisSystemPrompt,
  buildAnalysisPrompt,
  buildGenerateFromAnalysisPrompt,
  type ExistingPageInfo,
} from "./prompts.js";
import { parseFileBlocks } from "./file-protocol.js";
import { parseFrontmatter, buildPage } from "./frontmatter.js";
import { mergePage, type MergeOptions } from "./merge.js";
import { chunkText } from "./chunker.js";
import { slugify, dirForType } from "./slug.js";
import { isInsideRoot } from "./safe-path.js";
import { rebuildIndexFile } from "./index-builder.js";
import { appendIngestLog, appendIngestLogBatch } from "./log-writer.js";
import { createLogger } from "../../../logger.js";
import type { PageTree } from "../page-tree.js";

const log = createLogger("wiki-ingest");

/** Characters of an unparsable generate output logged when there is no debug directory (Postgres content). */
const DUMP_LOG_CHARS = 4000;

/**
 * generate 解析失败时落盘原文，便于 FILE 协议排查（不改变成功路径）。
 * `debugDir` null (content in Postgres): the output goes to the log instead of a file.
 */
export function dumpGenerateFailure(args: {
  debugDir: string | null;
  sourceName: string;
  chunkTag: string;
  output: string;
  reason: string;
}): string | null {
  const { debugDir, sourceName, chunkTag, output, reason } = args;
  if (debugDir === null) {
    log.warn("generate 无合法 FILE（原文见日志）", {
      source: sourceName,
      chunk: chunkTag,
      reason,
      outputChars: output.length,
      output: output.slice(0, DUMP_LOG_CHARS),
    });
    return null;
  }
  try {
    mkdirSync(debugDir, { recursive: true });
    const safeSource = sourceName.replace(/[^\w.\-]+/g, "_");
    const safeChunk = chunkTag.replace(/[^\w.\-#]+/g, "_");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(debugDir, `generate-fail-${safeSource}-${safeChunk}-${ts}.txt`);
    const header = [
      `# generate failure dump`,
      `# source=${sourceName}`,
      `# chunk=${chunkTag}`,
      `# reason=${reason}`,
      `# outputChars=${output.length}`,
      `# dumpedAt=${new Date().toISOString()}`,
      ``,
      ``,
    ].join("\n");
    writeFileSync(file, header + output, "utf-8");
    return file;
  } catch (err) {
    log.warn("generate 失败原文落盘失败", { source: sourceName, error: String(err) });
    return null;
  }
}

/** 不允许 ingest 写入/覆盖的结构性文件（PRD §3.7-2）。 */
const STRUCTURAL_FILES = new Set([
  "wiki/index.md",
  "wiki/schema.md",
  "wiki/purpose.md",
  "wiki/log.md",
  "wiki/overview.md",
]);

/** 粗略上下文预算（字符）：保留余量给 prompt 框架与输出。 */
const SOURCE_CHAR_BUDGET = 28_000;

export interface IngestOptions {
  /** 注入的 LLM 客户端（测试用）；不传则用 llmConfig 构造真实客户端。 */
  llm?: LlmClient;
  /** 合并时旧页正文超过此字符数则走追加模式（OQ-1）；不传用 merge 默认值。 */
  mergeFullRewriteMaxChars?: number;
  /** Where unparsable generate output is dumped (upstream `{wiki}/_debug`); null logs it instead. */
  debugDir?: string | null;
  /**
   * 摄取流程（OQ-4）：
   *   - "two-stage"（默认）：先分析（抽取计划）再生成 FILE 块，质量更稳。
   *   - "single-stage"：源全文直接产出 FILE 块（少一次 LLM 调用，省 token）。
   */
  mode?: "two-stage" | "single-stage";
}

export interface CommitResult {
  written: string[];
  /** 合并阶段按页失败记录（不影响其他页） */
  mergeErrors: Array<{ relPath: string; source: string; error: string }>;
}

export interface CommitOptions extends MergeOptions {
  /** 全局 LLM 信号量（mergePage 内 LLM 合并调用纳入限流） */
  globalLlmLimit?: LimitFunction;
  /** 跳过 batch log 写入（薄封装调用时由外层自行写单源日志） */
  skipLog?: boolean;
}

/** One source document handed to extraction: its basename and UTF-8 text. */
export interface SourceDoc {
  name: string;
  text: string;
}

/**
 * 阶段1：对单个源文件调 LLM 生成候选 wiki 页（纯内存，不落盘）。
 * 可安全并发调用（只读 `tree` 里的 schema/purpose 模板）。
 *
 * 空候选语义：candidates.size === 0 视为失败（throw），与现有行为一致。
 */
export async function extractSource(
  tree: PageTree,
  source: SourceDoc,
  llmConfig: RawLlmConfig,
  existingPages: ExistingPageInfo[],
  options: IngestOptions = {},
): Promise<Map<string, string>> {
  const sourceText = source.text;
  const sourceName = source.name;
  if (!sourceText.trim()) throw new Error(`源文件为空: ${sourceName}`);

  const llm = options.llm ?? createLlmClient(llmConfig);
  const template = loadTemplate(tree);
  const systemPrompt = buildSystemPrompt(template);
  const mode = options.mode ?? "two-stage";

  const chunks =
    sourceText.length > SOURCE_CHAR_BUDGET
      ? chunkText(sourceText, { targetChars: SOURCE_CHAR_BUDGET })
      : [sourceText];

  log.info("extractSource 开始", {
    source: sourceName,
    sourceChars: sourceText.length,
    mode,
    chunks: chunks.length,
    existingPages: existingPages.length,
    templateCustomized: template.customized,
  });

  const candidates = new Map<string, string>();
  const warnings: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkLabel = chunks.length > 1 ? `${sourceName} (chunk ${i + 1}/${chunks.length})` : sourceName;
    const tag = chunks.length > 1 ? `${sourceName}#${i + 1}` : sourceName;

    let out: string;
    if (mode === "two-stage") {
      log.debug("阶段A 分析开始", { chunk: tag });
      const analysis = await llm.chat({
        system: buildAnalysisSystemPrompt(template),
        prompt: buildAnalysisPrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages }),
        label: `analysis:${tag}`,
      });
      log.debug("阶段A 分析完成", { chunk: tag, analysisChars: analysis.length, empty: !analysis.trim() });
      log.debug("阶段A 分析内容预览", { chunk: tag, preview: analysis.slice(0, 200) });
      const genPrompt = analysis.trim()
        ? buildGenerateFromAnalysisPrompt({ sourceName: chunkLabel, sourceText: chunks[i], analysis, existingPages })
        : buildGeneratePrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages });
      if (!analysis.trim()) log.warn("分析为空，降级单阶段生成", { chunk: tag });
      out = await llm.chat({ system: systemPrompt, prompt: genPrompt, label: `generate:${tag}` });
    } else {
      const prompt = buildGeneratePrompt({ sourceName: chunkLabel, sourceText: chunks[i], existingPages });
      out = await llm.chat({ system: systemPrompt, prompt, label: `generate:${tag}` });
    }

    const { files, warnings: w } = parseFileBlocks(out);
    warnings.push(...w);
    log.debug("FILE 块解析", { chunk: tag, outChars: out.length, files: files.length, warnings: w.length });
    if (files.length === 0 && out.trim()) {
      const dumpPath = dumpGenerateFailure({
        debugDir: options.debugDir ?? null,
        sourceName,
        chunkTag: tag,
        output: out,
        reason: w.length ? `parse_empty warnings=${w.length}` : "parse_empty files=0",
      });
      if (dumpPath) log.warn("generate 无合法 FILE，已落盘", { source: sourceName, dumpPath });
    }
    for (const f of files) {
      const canonicalPath = canonicalizePagePath(f.path, f.content);
      if (STRUCTURAL_FILES.has(canonicalPath)) {
        warnings.push(`跳过结构性文件: ${canonicalPath}`);
        continue;
      }
      candidates.set(canonicalPath, ensureSources(f.content, sourceName));
    }
  }

  if (candidates.size === 0) {
    log.error("未生成任何合法 wiki 页", { source: sourceName, warnings });
    throw new Error(
      `未生成任何合法 wiki 页（no files generated）: ${sourceName}${warnings.length ? ` [${warnings.join("; ")}]` : ""}`,
    );
  }

  log.info("extractSource 完成", { source: sourceName, candidates: candidates.size, warnings: warnings.length });
  return candidates;
}

/** Virtual project root for the path-escape check; pages live in the content store, not under a real dir. */
const PROJECT_ROOT = resolve("/wiki-project");

/**
 * 阶段2：串行合并进 `tree` + 收尾（调用方 flush）。
 * - 按 relPath 聚合所有源产出的候选页，逐页 merge。
 * - 每页 try/catch：单页 merge 失败不阻塞其他页。
 * - mergePage 内部可能调 LLM，通过 globalLlmLimit 纳入全局限流。
 * - 全部落盘完成后统一跑一次 rebuildIndexFile + appendIngestLogBatch。
 */
export async function commitCandidates(
  tree: PageTree,
  allCandidates: Array<{ sourceFilename: string; candidates: Map<string, string> }>,
  /** 无候选页时可省略（仅 rebuild index）；有候选但缺失时对应页记入 mergeErrors。 */
  llm: LlmClient | undefined,
  options?: CommitOptions,
): Promise<CommitResult> {
  const { globalLlmLimit, skipLog, ...mergeOpts } = options ?? {};

  const byPage = new Map<string, Array<{ source: string; content: string }>>();
  for (const { sourceFilename, candidates } of allCandidates) {
    for (const [relPath, content] of candidates) {
      if (!byPage.has(relPath)) byPage.set(relPath, []);
      byPage.get(relPath)!.push({ source: sourceFilename, content });
    }
  }

  const written: string[] = [];
  const mergeErrors: CommitResult["mergeErrors"] = [];

  for (const [relPath, entries] of byPage) {
    // 最后一道边界卡口：relPath 由 LLM 输出间接推导而来，必须确认它没逃出项目目录。
    // 必须早于下面的读取——否则越界文件内容会被读进 merge prompt 而外泄。
    if (!isInsideRoot(PROJECT_ROOT, join(PROJECT_ROOT, relPath)) || posix.normalize(relPath) !== relPath || !relPath.startsWith("wiki/")) {
      for (const entry of entries) {
        mergeErrors.push({
          relPath,
          source: entry.source,
          error: `path escapes project root: ${relPath}`,
        });
      }
      log.error("阻断越界落盘路径", { relPath });
      continue;
    }
    let existing = tree.get(relPath) ?? null;

    for (const entry of entries) {
      if (!llm) {
        mergeErrors.push({
          relPath,
          source: entry.source,
          error: "LLM client unavailable",
        });
        continue;
      }
      try {
        const decision = globalLlmLimit
          ? await globalLlmLimit(() => mergePage(existing, entry.content, llm, mergeOpts))
          : await mergePage(existing, entry.content, llm, mergeOpts);
        if (decision.action === "skip") {
          log.debug("跳过页（locked）", { relPath, source: entry.source });
          continue;
        }
        tree.set(relPath, decision.content);
        existing = decision.content;
        if (!written.includes(relPath)) written.push(relPath);
        log.debug("写盘", { relPath, source: entry.source, bytes: decision.content.length });
      } catch (err) {
        mergeErrors.push({ relPath, source: entry.source, error: String(err) });
        log.error("页面合并失败", { relPath, source: entry.source, error: String(err) });
      }
    }
  }

  try {
    rebuildIndexFile(tree);
  } catch (err) {
    log.warn("index.md 重建失败（不影响主流程）", { error: String(err) });
  }

  try {
    if (!skipLog) {
      appendIngestLogBatch(tree, {
        sourcesProcessed: allCandidates.map((c) => c.sourceFilename),
        pagesWritten: written,
        mergeErrors: mergeErrors.map((e) => `${e.relPath} (from ${e.source}): ${e.error}`),
      });
    }
  } catch (err) {
    log.warn("log.md 写入失败（不影响主流程）", { error: String(err) });
  }

  return { written, mergeErrors };
}

/**
 * 单源完整流程（抽取 + 合并 + index.md + log.md），
 * 等价于 extractSource → commitCandidates 的串行组合。
 * 现有单测和外部直接调用无需改动。
 */
export async function ingestSource(
  tree: PageTree,
  source: SourceDoc,
  llmConfig: RawLlmConfig,
  options: IngestOptions = {},
): Promise<string[]> {
  const existingPages = scanExistingPages(tree);
  const candidates = await extractSource(tree, source, llmConfig, existingPages, options);
  const llm = options.llm ?? createLlmClient(llmConfig);
  const sourceName = source.name;
  const { written } = await commitCandidates(
    tree,
    [{ sourceFilename: sourceName, candidates }],
    llm,
    { fullRewriteMaxChars: options.mergeFullRewriteMaxChars, skipLog: true },
  );
  if (written.length === 0) {
    log.warn("无页写入（全部 locked 跳过）", { source: sourceName });
    return [];
  }
  try {
    appendIngestLog(tree, sourceName, written.length);
  } catch (err) {
    log.warn("log.md 追加失败", { error: err instanceof Error ? err.message : String(err) });
  }
  log.info("ingestSource 完成", { source: sourceName, written: written.length });
  return written;
}

/** 扫 wiki/ 得到已有页的精简信息（供 LLM 判断新建/更新）。不含结构性文件。 */
export function scanExistingPages(tree: PageTree): ExistingPageInfo[] {
  const out: ExistingPageInfo[] = [];
  for (const rel of tree.paths()) {
    if (STRUCTURAL_FILES.has(rel)) continue;
    try {
      const { frontmatter } = parseFrontmatter(tree.get(rel)!);
      out.push({
        relPath: rel,
        title: typeof frontmatter.title === "string" ? frontmatter.title : posix.basename(rel, ".md"),
        type: frontmatter.type,
        description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
      });
    } catch {
      /* 坏页跳过 */
    }
  }
  return out;
}

/**
 * 确保候选页 frontmatter 的 sources 至少包含当前源文件名（§3.7-3 / AC-10）。
 * LLM 可能漏写或写错 sources，这里强制补上当前源。
 */
export function ensureSources(content: string, sourceName: string): string {
  const parsed = parseFrontmatter(content);
  const cur = Array.isArray(parsed.frontmatter.sources)
    ? parsed.frontmatter.sources.filter((x): x is string => typeof x === "string")
    : [];
  if (cur.includes(sourceName)) return content;
  return buildPage({ ...parsed.frontmatter, sources: [...cur, sourceName] }, parsed.body);
}

/**
 * OQ-6: 规范化页面落盘路径，保证 dedup 稳定性。
 *
 * LLM 选的 path（如 `wiki/entity/redis.md`）可能与我方目录约定（`wiki/entities/redis.md`）
 * 不一致，或对同一实体在不同次摄取里给出不同 slug，破坏「同一实体 → 同一路径」的去重不变量。
 *
 * 策略：优先用页面 frontmatter 的 `type` + `title` 通过 `pageRelPath` 推导规范路径
 * （目录由 type 决定、文件名由 title slug 决定，与 dedup 命中逻辑一致）。
 * 当 frontmatter 缺 type/title 时，回退到「规范化 LLM 原路径的目录段」——
 * 即把目录通过 `dirForType` 归一（entity→entities），文件名沿用原 slug。
 *
 * @param llmPath  LLM 在 FILE 块里声明的 path（已过 normalizeWikiPath 白名单校验）
 * @param content  页面完整内容（含 frontmatter）
 * @returns 规范化后的 wiki 相对路径（始终以 `wiki/` 开头）
 */
export function canonicalizePagePath(llmPath: string, content: string): string {
  const { frontmatter } = parseFrontmatter(content);
  const type = typeof frontmatter.type === "string" ? frontmatter.type.trim() : "";
  const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";

  if (type && title) {
    const slug = slugify(title);
    if (slug) return `wiki/${dirForType(type)}/${slug}.md`;
  }

  const segments = llmPath.split("/");
  const fileName = segments[segments.length - 1];
  if (segments.length >= 3) {
    const dirSeg = segments[1];
    const canonicalDir = type ? dirForType(type) : dirForType(dirSeg);
    const middle = segments.slice(2, -1);
    return ["wiki", canonicalDir, ...middle, fileName].join("/");
  }
  return llmPath;
}
