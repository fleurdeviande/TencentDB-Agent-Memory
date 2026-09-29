/**
 * WikiService — wiki 资产的异步编排（与 CodeGraphService 对称）。
 *
 * IKnowledgeStore（元数据/状态）+ BuildQueue（后台串行）+ 可注入 worker
 * （实际 ingest / 建索引）。状态机：pending → processing(scanning/ingesting)
 * → ready / failed(+sync_error)。memory + team 隔离、幂等（同 memory+team+name 返回已存在）、
 * 软删 + 清目录。物理目录 {dataRoot}/{service_id}/{team_id}/{wiki_id}/（001 多租户）。
 *
 * 文件层（11 文档定稿）：raw / page 各一套 ls/read/write/rm，对齐 L2 Scenario。
 * - raw/* 仅操作 raw/sources/，不触发 ingest。
 * - page/* 操作 wiki/，写入自动注入 frontmatter `locked: true`，删除调
 *   lib 层 cascadeDeleteWikiPagesWithRefs 做引用级联。
 */

import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AuditAction,
  IKnowledgeStore,
  WikiRow,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";
import type { SourceStatus } from "../engines/wiki/index-db.js";
import { isWikiIndexMissing, sqliteWikiIndex, type WikiIndexStore } from "../engines/wiki/index-store.js";
import {
  FsWikiContentStore,
  isSourceTooLarge,
  sha256Of,
  type WikiContentStore,
  type WikiLoc,
} from "../engines/wiki/content-store.js";
import { PageTree } from "../engines/wiki/page-tree.js";

export interface WikiBuildContext {
  wikiId: string;
  serviceId: string;
  teamId: string;
  name: string;
  dir: string;
  setInternalStatus: (s: string) => void;
  /** 单次 ingest 代际；进度/终态 callback 共用，防 Panel 迟到包 */
  ingestRunId: string;
}

export interface WikiBuildResult {
  pageCount?: number;
}

export type WikiWorker = (ctx: WikiBuildContext) => Promise<WikiBuildResult | void>;

/**
 * ingest 结果（判别联合）：
 *   - ok       已入队重建；
 *   - not_found memory/team/id 不匹配；
 *   - busy     正在 pending/processing（并发拒绝，对应 HTTP 409），step 为内部阶段（可 null）。
 */
export type IngestResult =
  | { kind: "ok"; row: WikiRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null };

export interface WikiServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface WikiServiceOptions {
  store: IKnowledgeStore;
  dataRoot: string;
  worker: WikiWorker;
  /** Wiki index backend (default upstream's per-wiki index.db); module.ts passes the Postgres one when configured. */
  wikiIndex?: WikiIndexStore;
  /** Pages and sources (default upstream's files under dataRoot); module.ts passes the Postgres one when configured. */
  wikiContent?: WikiContentStore;
  queue?: BuildQueue;
  logger?: WikiServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: {
    tmcCallbackUrl: string;
    /** Per-instance LLM resolver for summary generation (keyed by service_id). */
    resolveLlm: (serviceId: string) => Promise<import("../config.js").LlmConfig>;
  };
}

export interface CreateWikiParams {
  service_id: string;
  team_id: string;
  name: string;
  source_type?: string;
  source_url?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  service_url?: string;
}

// ── 文件层 result 类型（对齐 yaml schema） ──

export interface RawFileEntry {
  filename: string;
  size: number;
  /** 源文件生命周期状态（uploaded/ingested/failed，设计 003）。 */
  status: SourceStatus;
  /** 首次上传时间（此后不变）。 */
  created_at: string;
  /** 最近一次内容变更时间。 */
  updated_at: string;
  /** 最后变更人 user_id（无历史流水）。 */
  last_modified_by: string | null;
  /** 最近成功抽取时间（未抽为 null）。 */
  ingested_at: string | null;
  /** @deprecated 兼容旧字段，等于 created_at。 */
  uploaded_at: string;
}

export interface RawWriteResult {
  filename: string;
  size: number;
}

export interface RawReadItem {
  filename: string;
  /** UTF-8 text, or base64 when requested with encoding "base64". */
  content?: string;
  not_found?: boolean;
}

export interface RawWriteManyItem {
  filename: string;
  size: number;
}

export interface RawRmResult {
  deleted_files: string[];
  deleted_pages: string[];
  rewritten_pages: number;
}

export interface PageWriteResult {
  ref: string;
  locked_injected: boolean;
}

export interface PageReadItem {
  ref: string;
  content?: string;
  not_found?: boolean;
}

export interface PageWriteManyItem {
  ref: string;
  locked_injected: boolean;
}

export interface PageRmResult {
  deleted_pages: string[];
  rewritten_files: number;
}

/**
 * 写操作的返回封装：
 * - `null`：wiki 不存在或不属于 memory/team
 * - `"processing"`：wiki 当前处于 processing 状态，拒绝写
 * - `"invalid_path"`：路径穿越校验失败
 * - `"forbidden_path"`：写入了结构性文件等禁止路径
 * - `"too_large"`：超过容量限制
 * - 否则：实际结果对象
 */
/** raw/read and raw/write content encoding: UTF-8 text (default) or base64 bytes. */
export type RawEncoding = "utf-8" | "base64";

export type WriteOutcome<T> =
  | T
  | null
  | "processing"
  | "invalid_path"
  | "forbidden_path"
  | "too_large";

const PAGE_WRITE_MAX_BYTES = 512 * 1024;
const RAW_WRITE_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_RM_MAX = 20;
const RAW_RM_MAX = 50;
const RAW_READ_MAX = 50;
const RAW_WRITE_MAX = 50;
const PAGE_READ_MAX = 20;
const PAGE_WRITE_MAX = 20;

/** wiki/ 下不允许 page/write 与 page/rm 触碰的结构性文件（去掉 .md 也算）。 */
const PAGE_FORBIDDEN_REFS = new Set([
  "index",
  "schema",
  "purpose",
  "wiki/index",
  "wiki/schema",
  "wiki/purpose",
]);

export class WikiService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: WikiWorker;
  private readonly index: WikiIndexStore;
  private readonly content: WikiContentStore;
  private readonly queue: BuildQueue;
  private readonly logger?: WikiServiceLogger;
  private readonly callbackConfig?: {
    tmcCallbackUrl: string;
    resolveLlm: (serviceId: string) => Promise<import("../config.js").LlmConfig>;
  };
  /**
   * In-flight delete 标记：delete 命中一个正在排队/执行的 wiki 时置位，
   * worker 在检查点读取以决定中止。仅内存态（同 id 由 SerialQueue 串行 +
   * Node 单线程，读写无并发）。清理收尾后移除。
   */
  private readonly cancelled = new Set<string>();

  constructor(opts: WikiServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.index = opts.wikiIndex ?? sqliteWikiIndex;
    this.content = opts.wikiContent ?? new FsWikiContentStore({ registryDir: join(opts.dataRoot, "_wiki_engines") });
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
  }

  dirFor(serviceId: string, teamId: string, wikiId: string): string {
    return join(this.dataRoot, serviceId, teamId, wikiId);
  }

  private locFor(serviceId: string, teamId: string, wikiId: string): WikiLoc {
    return { wikiId, dir: this.dirFor(serviceId, teamId, wikiId) };
  }

  /**
   * 创建 wiki 元数据 + 目录壳。**不自动 ingest**。
   * 幂等：同 (service_id, team_id, name) 返回已有行。
   */
  async create(params: CreateWikiParams): Promise<{ row: WikiRow; existed: boolean }> {
    const { row, existed } = await this.store.createWiki(params);
    if (!existed) {
      const dir = this.dirFor(row.service_id, row.team_id, row.wiki_id);
      await this.content.init({ wikiId: row.wiki_id, dir }, ["raw/sources"]);
      // 显式建 index.db（4 表，含 source）——此后 rawWrite/rawLs 直接读写 source 表（设计 006/003）。
      try {
        await this.index.init(row.wiki_id, dir);
      } catch (err) {
        this.logger?.warn?.(`[wiki] initIndexDb failed for ${row.wiki_id}: ${String(err)}`);
      }
      await this.audit(row, "create", `create wiki ${row.name}`, params.user_id);
    }
    return { row, existed };
  }

  /** Persist service_url for a wiki. Returns updated row or null. */
  async updateServiceUrl(serviceId: string, wikiId: string, serviceUrl: string): Promise<WikiRow | null> {
    await this.store.updateWikiStatus(serviceId, wikiId, { service_url: serviceUrl });
    return this.store.getWikiById(serviceId, wikiId);
  }

  /** Update wiki metadata (name, summary). Returns updated row or null. */
  updateMeta(
    serviceId: string,
    wikiId: string,
    patch: { name?: string; summary?: string | null },
  ): Promise<WikiRow | null> {
    return this.store.updateWikiMeta(serviceId, wikiId, patch);
  }

  /**
   * 显式触发 ingest（LLM 加工 raw → page + 建索引）。
   * 立即返回，后台异步执行。memory/team 不匹配返回 not_found；pending/processing 返回 busy。
   */
  async ingest(serviceId: string, teamId: string, wikiId: string, requesterUserId?: string): Promise<IngestResult> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return { kind: "not_found" };
    // 并发拒绝：正在排队/执行中直接拒绝，不覆盖状态、不重复入队、不写 audit。
    if (row.status === "pending" || row.status === "processing") {
      return { kind: "busy", status: row.status, step: row.internal_status };
    }
    const nextVersion = row.version + 1;
    await this.store.updateWikiStatus(serviceId, wikiId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    await this.audit({ ...row, version: nextVersion }, "ingest", "manual ingest", requesterUserId);
    const fresh = await this.store.getWiki(serviceId, teamId, wikiId);
    if (fresh) this.enqueueBuild(fresh);
    return fresh ? { kind: "ok", row: fresh } : { kind: "not_found" };
  }

  /** sync 语义 = 重跑 ingest（管控显式触发）。 */
  sync(serviceId: string, teamId: string, wikiId: string, requesterUserId?: string): Promise<IngestResult> {
    return this.ingest(serviceId, teamId, wikiId, requesterUserId);
  }

  get(serviceId: string, teamId: string, wikiId: string): Promise<WikiRow | null> {
    return this.store.getWiki(serviceId, teamId, wikiId);
  }

  /** 按全局唯一 wiki_id 查询（仍按 service_id 收敛防跨租户）。spec id-only 端点专用。 */
  getById(serviceId: string, wikiId: string): Promise<WikiRow | null> {
    return this.store.getWikiById(serviceId, wikiId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): Promise<WikiRow[]> {
    return this.store.listWikis(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): Promise<number> {
    return this.store.countWikis(serviceId, teamId, opts);
  }

  /**
   * 删除 wiki（008 / 007 §5.5）。任何状态均可删（含 pending/processing）。
   * memory/team 不匹配返回 false；否则硬删 + 四类资源清理，返回 true。
   *
   * 若资源正在排队/执行，先置 cancelled 标记通知 worker 在检查点中止，随后立即
   * 硬删 + 清理（不等 worker）。worker 结束前重查发现已删则跳过 ready/回调并再做
   * 一次幂等清理，无残留。
   */
  async delete(serviceId: string, teamId: string, wikiId: string): Promise<boolean> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return false;

    if (row.status === "pending" || row.status === "processing") {
      this.cancelled.add(wikiId);
    }

    await this.audit(row, "delete", null);
    await this.cleanupResources(serviceId, teamId, wikiId);
    // 不在此删 cancelled 标记（覆盖 delete 先于 worker 检查点的窗口）；
    // worker 结束时由 finishCancelled 移除。cleanup 幂等，重复无害。
    return true;
  }

  /**
   * 四类资源幂等清理（顺序：先释放连接，再删盘）。每步独立 try/catch，异常安全。
   *   1. wiki 索引：index.drop（SQLite 关读连接；Postgres 删该 wiki 的 page/edge/source 行；幂等）
   *   2. 元数据行：硬删（命中 0 行也安全，支持 worker + delete 双重清理）
   *   3. 内容：content.drop（文件系统：rmSync 目录 wiki/ raw/ index.db 及 -wal/-shm；Postgres：删页/源/registry 行；幂等）
   * BuildQueue 排队任务由 runBuild 入口检查 cancelled/行存在性跳过，无需在此处理。
   */
  private async cleanupResources(serviceId: string, teamId: string, wikiId: string): Promise<void> {
    try {
      await this.index.drop(wikiId, this.dirFor(serviceId, teamId, wikiId));
    } catch (err) {
      this.logger?.warn?.(`[wiki] evict index.db failed ${wikiId}: ${String(err)}`);
    }
    try {
      await this.store.deleteWiki(serviceId, teamId, wikiId);
    } catch (err) {
      this.logger?.warn?.(`[wiki] hard-delete row failed ${wikiId}: ${String(err)}`);
    }
    try {
      await this.content.drop(this.locFor(serviceId, teamId, wikiId));
    } catch (err) {
      this.logger?.warn?.(`[wiki] drop content failed ${wikiId}: ${String(err)}`);
    }
  }

  /**
   * worker 检查点：wiki 是否已被删除（cancelled 标记命中，或行已不在库）。
   * 双判据覆盖 delete-during-run 与 delete-already-done 两种时序。
   */
  private async isDeleted(serviceId: string, wikiId: string): Promise<boolean> {
    return this.cancelled.has(wikiId) || (await this.store.getWikiById(serviceId, wikiId)) === null;
  }

  /**
   * worker 检查点判定“已删”后的收尾：幂等清理 worker 可能刚写下的盘/连接，
   * 并移除 cancelled 标记。
   */
  private async finishCancelled(serviceId: string, teamId: string, wikiId: string): Promise<void> {
    await this.cleanupResources(serviceId, teamId, wikiId);
    this.cancelled.delete(wikiId);
    this.logger?.info?.(`[wiki] ${wikiId} build aborted (deleted during processing)`);
  }

  /** 写一条 wiki 审计记录。失败不阻断主流程。 */
  private async audit(
    row: WikiRow,
    action: AuditAction,
    detail: string | null,
    requesterUserId?: string,
  ): Promise<void> {
    try {
      await this.store.appendWikiAudit({
        service_id: row.service_id,
        asset_id: row.wiki_id,
        version: row.version,
        action,
        // 优先记录触发者（ingest/create 的发起人），回退到行上的创建者。
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] audit ${action} failed: ${String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // 文件层 — raw/* （raw/sources/ 下的素材）
  // ═══════════════════════════════════════════════════════════════════

  /** 列出 raw/sources/ 下的素材文件（改查 source 表，设计 003 §3.5）。wiki 不存在返回 null。 */
  async rawLs(serviceId: string, teamId: string, wikiId: string): Promise<RawFileEntry[] | null> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      return (await this.index.listSources(wikiId, dir)).map((s) => ({
        filename: s.filename,
        size: s.size,
        status: s.status,
        created_at: s.created_at,
        updated_at: s.updated_at,
        last_modified_by: s.last_modified_by,
        ingested_at: s.ingested_at,
        uploaded_at: s.created_at, // 兼容旧字段
      }));
    } catch (err) {
      if (!isWikiIndexMissing(err)) throw err;
      // index.db 尚未创建（老 wiki / 从未 rawWrite）→ 无 source 登记。
      return [];
    }
  }

  /** 读单个 raw 文件原文（UTF-8）。文件不存在返回 null（含 wiki 不存在）。 */
  async rawRead(serviceId: string, teamId: string, wikiId: string, filename: string): Promise<string | null> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const name = this.rawName(filename);
    if (!name) return null;
    const data = await this.content.readSource(this.locFor(serviceId, teamId, wikiId), name);
    return data ? data.toString("utf-8") : null;
  }

  /**
   * 批量读 raw 文件。
   * - wiki 不存在 → null
   * - 任一 filename 路径穿越 → "invalid_path"
   * - 超 RAW_READ_MAX → 抛错（router 转 400）
   * 单个文件不存在不报错，对应 item 标 not_found:true（spec：整体仍 200）。
   * `encoding: "base64"` returns the bytes base64-encoded (binary sources); default UTF-8 text.
   */
  async rawReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
    opts: { encoding?: RawEncoding } = {},
  ): Promise<WriteOutcome<RawReadItem[]>> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (filenames.length > RAW_READ_MAX) {
      throw new Error(`filenames exceeds max ${RAW_READ_MAX}`);
    }
    // 先全部校验路径合法性（任一不合法整批 400）
    const names: string[] = [];
    for (const fn of filenames) {
      const name = this.rawName(fn);
      if (!name) return "invalid_path";
      names.push(name);
    }
    const loc = this.locFor(serviceId, teamId, wikiId);
    const items: RawReadItem[] = [];
    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      const data = await this.content.readSource(loc, names[i]);
      if (data) items.push({ filename, content: data.toString(opts.encoding === "base64" ? "base64" : "utf-8") });
      else items.push({ filename, not_found: true });
    }
    return items;
  }

  /**
   * 写入/覆盖单个 raw 文件（upsert）+ 登记 source 表（设计 003 §3.4）。
   * - wiki 不存在 → null
   * - processing 中 → "processing"
   * - 路径穿越 → "invalid_path"
   * - 超 5MB 或超 KNOWLEDGE_MAX_SOURCE_BYTES → "too_large"
   * `content` is UTF-8 text or raw bytes (binary sources).
   */
  async rawWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filename: string,
    content: string | Buffer,
    userId?: string,
  ): Promise<WriteOutcome<RawWriteResult>> {
    const out = await this.rawWriteMany(serviceId, teamId, wikiId, [{ filename, content }], userId);
    return Array.isArray(out) ? out[0] : out;
  }

  /**
   * 批量写入 raw 文件（整批原子）。
   * - 先全部校验：路径穿越 → "invalid_path"；任一项超 5MB / KNOWLEDGE_MAX_SOURCE_BYTES → "too_large"
   * - 全部通过后由 content store 整批写入：文件系统逐文件落盘、失败回滚已写文件；
   *   Postgres 一个事务。整批要么都成功要么都没生效。
   * 错误码同 rawWrite。
   */
  async rawWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; content: string | Buffer }[],
    userId?: string,
  ): Promise<WriteOutcome<RawWriteManyItem[]>> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (files.length > RAW_WRITE_MAX) {
      throw new Error(`files exceeds max ${RAW_WRITE_MAX}`);
    }

    const plans: { filename: string; name: string; data: Buffer }[] = [];
    for (const { filename, content } of files) {
      if (typeof content !== "string" && !Buffer.isBuffer(content)) return "invalid_path";
      const data = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
      if (data.length > RAW_WRITE_MAX_BYTES) return "too_large";
      const name = this.rawName(filename);
      if (!name) return "invalid_path";
      plans.push({ filename, name, data });
    }

    try {
      await this.content.writeSources(
        this.locFor(serviceId, teamId, wikiId),
        plans.map((p) => ({ filename: p.name, data: p.data })),
      );
    } catch (err) {
      if (isSourceTooLarge(err)) return "too_large";
      throw err;
    }

    // 全部写入成功后登记 source 表（先查再更新，sha 未变幂等）。
    await this.registerSources(
      serviceId,
      teamId,
      wikiId,
      plans.map((p) => ({ filename: p.name, data: p.data })),
      userId,
    );
    return plans.map(({ filename, data }) => ({ filename, size: data.length }));
  }

  /**
   * 批量删除 raw 文件 + 级联清理下游 page。
   * 调用 lib 层 deleteSourceFiles，由其内部决定 page 命运。
   * - wiki 不存在 → null
   * - processing → "processing"
   * - filenames 含路径穿越 → "invalid_path"
   * - 超 50 → 抛错（由 router 转 400）
   */
  async rawRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
  ): Promise<WriteOutcome<RawRmResult>> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (filenames.length > RAW_RM_MAX) {
      throw new Error(`filenames exceeds max ${RAW_RM_MAX}`);
    }

    const names: string[] = [];
    for (const fn of filenames) {
      const name = this.rawName(fn);
      if (!name) return "invalid_path";
      names.push(name);
    }

    // 自研级联删除：删 raw 源并清理引用它的 page（frontmatter sources 驱动）。
    const loc = this.locFor(serviceId, teamId, wikiId);
    await this.content.deleteSources(loc, names);
    const { deleteSourceFiles } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const tree = await PageTree.load(this.content, loc);
    const result = await deleteSourceFiles(tree, names, {
      logReason: "wiki/raw/rm",
    });
    await tree.flush(this.content, loc);

    // 删除对应 source 行（与文件级联删除对应，设计 003 §5）。
    try {
      await this.index.init(wikiId, loc.dir);
      await this.index.withWrite(wikiId, loc.dir, (w) => w.deleteSources(names));
    } catch (err) {
      this.logger?.warn?.(`[wiki] source rows delete failed: ${String(err)}`);
    }

    return {
      deleted_files: filenames,
      deleted_pages: result.deletedWikiPaths.map((p: string) => this.pathToPageRef(p)),
      rewritten_pages: result.rewrittenSourcePages,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 文件层 — page/* （wiki/ 下的 processed page）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 列出 wiki/ 下的 page 文件（recursive 扫描 .md 取 frontmatter）。
   * status≠ready 时返回空数组。
   */
  async pageLs(
    serviceId: string,
    teamId: string,
    wikiId: string,
  ): Promise<{ id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] | null> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status !== "ready") return [];

    const items: { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] = [];
    for (const page of await this.content.listPages(this.locFor(serviceId, teamId, wikiId))) {
      const rel = page.path.slice("wiki/".length);
      const entry = posix.basename(rel);
      const fm = parseFrontmatterMin(page.content);
      items.push({
        id: rel.replace(/\.md$/, ""),
        title: fm.title || entry.replace(/\.md$/, "").replace(/-/g, " "),
        type: fm.type || "other",
        path: page.path,
        ...(fm.description ? { description: fm.description } : {}),
        locked: fm.locked,
      });
    }
    return items;
  }

  /** 读单个 page 原文。ref 可以是 page id 或 relPath。 */
  async pageRead(serviceId: string, teamId: string, wikiId: string, ref: string): Promise<string | null> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const found = await this.findPage(this.locFor(serviceId, teamId, wikiId), ref);
    return found ? found.content : null;
  }

  /**
   * 批量读 page 原文。
   * - wiki 不存在 → null
   * - 任一 ref 路径穿越 → "invalid_path"
   * - 超 PAGE_READ_MAX → 抛错
   * 单个 ref 不存在不报错，对应 item 标 not_found:true（spec：整体仍 200）。
   */
  async pageReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): Promise<WriteOutcome<PageReadItem[]>> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (refs.length > PAGE_READ_MAX) {
      throw new Error(`refs exceeds max ${PAGE_READ_MAX}`);
    }
    // 区分"路径合法但文件不存在（not_found）"与"路径非法（invalid_path）"；读的是 ref 的 .md 路径（同 write）。
    const paths: string[] = [];
    for (const r of refs) {
      const path = this.pageWritePath(r);
      if (!path) return "invalid_path";
      paths.push(path);
    }
    const loc = this.locFor(serviceId, teamId, wikiId);
    const items: PageReadItem[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const content = await this.content.readPage(loc, paths[i]);
      if (content !== null) items.push({ ref, content });
      else items.push({ ref, not_found: true });
    }
    return items;
  }

  /**
   * 写入/覆盖单个 page（upsert）。自动在 frontmatter 注入 `locked: true`。
   * - wiki 不存在 → null
   * - processing → "processing"
   * - 路径穿越 → "invalid_path"
   * - 结构性文件 → "forbidden_path"
   * - 超 512KB → "too_large"
   */
  async pageWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    ref: string,
    content: string,
  ): Promise<WriteOutcome<PageWriteResult>> {
    const out = await this.pageWriteMany(serviceId, teamId, wikiId, [{ ref, content }]);
    return Array.isArray(out) ? out[0] : out;
  }

  /**
   * 批量写 page（整批原子）。每项自动注入 frontmatter `locked: true`。
   * - 先全部校验：处理中 → "processing"；路径穿越 → "invalid_path"；
   *   结构性文件 → "forbidden_path"；超 512KB → "too_large"
   * - 全部通过后由 content store 整批写入；任一失败整批不生效。
   */
  async pageWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    pages: { ref: string; content: string }[],
  ): Promise<WriteOutcome<PageWriteManyItem[]>> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (pages.length > PAGE_WRITE_MAX) {
      throw new Error(`pages exceeds max ${PAGE_WRITE_MAX}`);
    }

    const plans: { ref: string; path: string; finalContent: string; lockedInjected: boolean }[] = [];
    for (const { ref, content } of pages) {
      if (typeof content !== "string") return "invalid_path";
      if (this.isForbiddenPageRef(ref)) return "forbidden_path";
      const size = Buffer.byteLength(content, "utf-8");
      if (size > PAGE_WRITE_MAX_BYTES) return "too_large";
      const path = this.pageWritePath(ref);
      if (!path) return "invalid_path";
      const { content: finalContent, lockedInjected } = injectLockedTrue(content);
      plans.push({ ref, path, finalContent, lockedInjected });
    }

    await this.content.applyPages(this.locFor(serviceId, teamId, wikiId), {
      put: plans.map((p) => ({ path: p.path, content: p.finalContent })),
      remove: [],
    });
    return plans.map(({ ref, lockedInjected }) => ({ ref, locked_injected: lockedInjected }));
  }

  /**
   * 批量删除 page + 级联清理引用。调用 lib 层 cascadeDeleteWikiPagesWithRefs。
   * - wiki 不存在 → null
   * - processing → "processing"
   * - 含路径穿越（或 page 不存在）→ "invalid_path"
   * - 含结构性文件 → "forbidden_path"
   * - 超 20 → 抛错
   */
  async pageRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): Promise<WriteOutcome<PageRmResult>> {
    const row = await this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (refs.length > PAGE_RM_MAX) {
      throw new Error(`refs exceeds max ${PAGE_RM_MAX}`);
    }

    const loc = this.locFor(serviceId, teamId, wikiId);
    const paths: string[] = [];
    for (const r of refs) {
      if (this.isForbiddenPageRef(r)) return "forbidden_path";
      const found = await this.findPage(loc, r);
      if (!found) return "invalid_path";
      paths.push(found.path);
    }

    const { cascadeDeleteWikiPagesWithRefs } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const tree = await PageTree.load(this.content, loc);
    const result = await cascadeDeleteWikiPagesWithRefs(tree, paths);
    await tree.flush(this.content, loc);

    return {
      deleted_pages: result.deletedPaths.map((p: string) => this.pathToPageRef(p)),
      rewritten_files: result.rewrittenFiles,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 内部 helper
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 登记一批源文件到 source 表（rawWrite/rawWriteMany 用）。
   * 保证 index.db 存在（幂等 initIndexDb），在一个写事务里对每个文件 upsertSource
   * （先查再更新：新建 uploaded / sha 变则重置 uploaded / sha 未变幂等）。
   * 登记失败不阻断写入主流程（内容已写入）——记 warn，交由后续 ingest/rawLs 兜底。
   */
  private async registerSources(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; data: Buffer }[],
    userId?: string,
  ): Promise<void> {
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      await this.index.init(wikiId, dir);
      await this.index.withWrite(wikiId, dir, async (w) => {
        for (const f of files) {
          await w.upsertSource({
            filename: f.filename,
            sha256: sha256Of(f.data),
            size: f.data.length,
            userId: userId ?? null,
          });
        }
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] source register failed for ${wikiId}: ${String(err)}`);
    }
  }

  /** Validated source name relative to raw/sources/ (upstream resolveRawPath rules), or null. */
  private rawName(filename: string): string | null {
    if (!filename || filename.includes("..") || filename.startsWith("/")) return null;
    const normalized = posix.normalize(filename).replace(/\/+$/, "");
    if (!normalized || normalized === "." || normalized.startsWith("..") || normalized.startsWith("/")) return null;
    return normalized;
  }

  /**
   * page ref（id 或 relPath）→ 候选 `wiki/…` 路径（先原样、再补 .md），要求落在 wiki/ 子树下。
   * null = 路径非法。
   */
  private pageCandidates(ref: string): string[] | null {
    if (!ref || ref.includes("..") || ref.startsWith("/")) return null;
    const cleanRef = ref.replace(/^wiki\//, "");
    if (cleanRef.includes("..")) return null;
    const out: string[] = [];
    for (const c of cleanRef.endsWith(".md") ? [cleanRef] : [cleanRef + ".md", cleanRef]) {
      const norm = posix.normalize(c).replace(/\/+$/, "");
      if (!norm || norm === "." || norm.startsWith("../") || norm.startsWith("/")) continue;
      out.push(`wiki/${norm}`);
    }
    return out.length > 0 ? out : null;
  }

  /** The `.md` path a write (or batch read) of `ref` targets; null = invalid. */
  private pageWritePath(ref: string): string | null {
    const md = this.pageCandidates(ref)?.find((c) => c.endsWith(".md"));
    return md ?? null;
  }

  /** An existing page for `ref` (read/rm); null when invalid or missing. */
  private async findPage(loc: WikiLoc, ref: string): Promise<{ path: string; content: string } | null> {
    for (const path of this.pageCandidates(ref) ?? []) {
      const content = await this.content.readPage(loc, path);
      if (content !== null) return { path, content };
    }
    return null;
  }

  /** `wiki/concepts/redis.md` → ref `concepts/redis`. */
  private pathToPageRef(path: string): string {
    return path.replace(/^wiki\//, "").replace(/\.md$/, "");
  }

  private isForbiddenPageRef(ref: string): boolean {
    const cleanRef = ref.replace(/^wiki\//, "").replace(/\.md$/, "");
    return PAGE_FORBIDDEN_REFS.has(cleanRef) || PAGE_FORBIDDEN_REFS.has(`wiki/${cleanRef}`);
  }

  // ═══════════════════════════════════════════════════════════════════

  private enqueueBuild(row: WikiRow): void {
    this.queue.enqueue(row.wiki_id, () => this.runBuild(row.service_id, row.wiki_id, row.team_id, row.name));
  }

  private async runBuild(serviceId: string, wikiId: string, teamId: string, name: string): Promise<void> {
    // 入口检查点：pending 期间被删 → 跳过，不置 processing、不 ingest。
    if (await this.isDeleted(serviceId, wikiId)) {
      await this.finishCancelled(serviceId, teamId, wikiId);
      return;
    }
    await this.store.updateWikiStatus(serviceId, wikiId, {
      status: "processing",
      internal_status: "scanning",
      sync_error: null,
    });
    // 进度/终态 callback 共用同一代际，Panel 可拒绝 clear 后的迟到 progress
    const ingestRunId = randomUUID();
    let statusWrites: Promise<void> = Promise.resolve();
    try {
      const result = await this.worker({
        wikiId,
        serviceId,
        teamId,
        name,
        dir: this.dirFor(serviceId, teamId, wikiId),
        setInternalStatus: (s) => {
          // Workers call this synchronously; chain the writes so they land in order and before the final status.
          statusWrites = statusWrites
            .then(() => this.store.updateWikiStatus(serviceId, wikiId, { status: "processing", internal_status: s }))
            .catch((err) => this.logger?.warn?.(`[wiki] internal status ${s} failed ${wikiId}: ${String(err)}`));
        },
        ingestRunId,
      });
      await statusWrites;
      // 结束前检查点：processing 期间被删 → 跳过 ready/audit/回调，幂等收尾清理。
      if (await this.isDeleted(serviceId, wikiId)) {
        await this.finishCancelled(serviceId, teamId, wikiId);
        return;
      }
      await this.store.updateWikiStatus(serviceId, wikiId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        page_count: result?.pageCount ?? null,
        last_sync_at: new Date().toISOString(),
      });
      const synced = await this.store.getWikiById(serviceId, wikiId);
      if (synced) {
        await this.audit(synced, "ready", result?.pageCount != null ? `pages: ${result.pageCount}` : null);
      }
      this.logger?.info?.(`[wiki] ${wikiId} ready (pages: ${result?.pageCount ?? '?'})`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, ingestRunId);
    } catch (err) {
      await statusWrites;
      const msg = err instanceof Error ? err.message : String(err);
      // worker 抛错，但若期间已被删，视为取消而非失败：跳过 failed 状态/回调，做清理。
      if (await this.isDeleted(serviceId, wikiId)) {
        await this.finishCancelled(serviceId, teamId, wikiId);
        return;
      }
      await this.store.updateWikiStatus(serviceId, wikiId, {
        status: "failed",
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      const failed = await this.store.getWikiById(serviceId, wikiId);
      if (failed) await this.audit(failed, "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[wiki] ${wikiId} failed: ${msg}`);

      // Callback TMC about failure
      await this.onBuildComplete(failed, "failed", msg, ingestRunId);
    }
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: WikiRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    ingestRunId?: string,
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready") {
      // Generate summary via LLM (即使部分源失败也尝试生成——只要有页面就生成)
      try {
        const pages = (await this.pageLs(row.service_id, row.team_id, row.wiki_id)) ?? [];
        this.logger?.info?.(`[wiki] summary generation start (wikiId=${row.wiki_id}, pages=${pages.length}, status=${status})`);
        const { generateWikiSummary } = await import("../callback.js");
        summary = await generateWikiSummary(
          row.wiki_id,
          row.name,
          pages.map((p) => ({ title: p.title, description: p.description })),
          await this.callbackConfig.resolveLlm(row.service_id),
        );
        this.logger?.info?.(`[wiki] summary generation done (wikiId=${row.wiki_id}, len=${summary?.length ?? 0}, empty=${!summary})`);
        if (summary) {
          await this.store.updateWikiStatus(row.service_id, row.wiki_id, { summary });
        }
      } catch (err) {
        this.logger?.warn?.(`[wiki] summary generation failed: ${String(err)}`);
      }
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.wiki_id,
        service_id: row.service_id,
        type: "wiki",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
        ...(ingestRunId ? { run_id: ingestRunId } : {}),
      },
      this.callbackConfig,
    );
  }

  async onIdle(wikiId?: string): Promise<void> {
    await this.queue.onIdle(wikiId);
  }
}

// ─── 模块级 helper（不依赖 class state，便于单测） ───

/** 极简 frontmatter 解析（取 title/type/description/locked），与 manager 一致风格。 */
function parseFrontmatterMin(content: string): { title: string; type: string; description: string; locked: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  // description 由 ingest-v2 写入（见 engines/wiki/ingest-v2/frontmatter.ts），
  // 是页面的一句话概述——比标题更能说明内容，用于生成 wiki summary。
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const lockedMatch = fm.match(/^locked:\s*(true|false)\s*$/m);
  return {
    title: titleMatch ? titleMatch[1].trim() : "",
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "",
    description: descMatch ? descMatch[1].trim() : "",
    locked: lockedMatch ? lockedMatch[1] === "true" : false,
  };
}

/**
 * 在 frontmatter 中注入 `locked: true`：
 * - 有 frontmatter：若已有 locked: 字段，强制改 true；否则在 frontmatter 末尾追加一行
 * - 无 frontmatter：在文件最前面包一段 frontmatter（仅含 locked: true）
 *
 * 返回 { content, lockedInjected }；lockedInjected 表示**本次**是否真正补/改了 locked
 * 字段（已是 true 也算 lockedInjected=false，因为没有改动）。
 */
function injectLockedTrue(content: string): { content: string; lockedInjected: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    const wrapped = `---\nlocked: true\n---\n${content.startsWith("\n") ? content.slice(1) : content}`;
    return { content: wrapped, lockedInjected: true };
  }
  const fmBody = fmMatch[1];
  const lockedMatch = fmBody.match(/^locked:\s*(true|false)\s*$/m);
  if (lockedMatch) {
    if (lockedMatch[1] === "true") return { content, lockedInjected: false };
    const newFmBody = fmBody.replace(/^locked:\s*(true|false)\s*$/m, "locked: true");
    return {
      content: content.replace(fmBody, newFmBody),
      lockedInjected: true,
    };
  }
  const newFmBody = fmBody.endsWith("\n") ? `${fmBody}locked: true` : `${fmBody}\nlocked: true`;
  return {
    content: content.replace(fmBody, newFmBody),
    lockedInjected: true,
  };
}

export const __testing = { parseFrontmatterMin, injectLockedTrue };
