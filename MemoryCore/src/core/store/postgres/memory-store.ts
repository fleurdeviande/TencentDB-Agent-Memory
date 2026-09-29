/**
 * PostgresMemoryStore — PostgreSQL + pgvector backend for IMemoryStore.
 *
 * - One schema per memory instance; tables created by versioned migrations.
 * - FTS: the same jieba-pre-tokenised text sqlite feeds FTS5 is stored in
 *   `tokens`; a generated `fts tsvector` (simple config) + GIN index serves
 *   keyword search, ranked with ts_rank_cd.
 * - Vectors: `embedding vector(N)` columns + HNSW (cosine). N comes from the
 *   embedding config; a mismatch with stored vectors blocks vector I/O and asks
 *   for a reindex (keyword paths keep working), as the sqlite store does.
 * - Isolation filters are pushed into WHERE clauses — no post-filtering.
 *
 * Error policy mirrors sqlite: L0/L1 reads/writes are fault-tolerant (log and
 * return empty/false/0); entity/profile/audit methods throw; init failures
 * leave the store degraded.
 */

import type { Pool, PoolClient } from "pg";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "../embedding.js";
import type {
  IMemoryStore,
  StoreCapabilities,
  StoreInitResult,
  StoreLogger,
  L0Record,
  L0QueryRow,
  L0SearchResult,
  L0FtsResult,
  L0SessionGroup,
  L0CountFilter,
  L0PaginatedFilter,
  L0PaginatedResult,
  L1RecordRow,
  L1SearchResult,
  L1FtsResult,
  L1QueryFilter,
  L1CountFilter,
  L1PaginatedFilter,
  L1PaginatedResult,
  IsolationFilter,
  ProfileRecord,
  ProfileSyncRecord,
  ProfileFilter,
  MemoryContentClearFilter,
  MemoryContentClearResult,
  AuditEntry,
  AuditQueryFilter,
  TeamEntity,
  UserEntity,
  AgentEntity,
  TaskEntity,
  KnowledgeEntity,
  KnowledgeType,
  KnowledgeListResult,
  BatchDeleteResult,
} from "../types.js";
import { DEFAULT_ISOLATION_ID } from "../isolation.js";
import { tokenizeForFts } from "../tokenize.js";
import type {
  MemoryPromptDeleteResult,
  MemoryPromptListFilter,
  MemoryPromptRecord,
  MemoryPromptSettingListFilter,
  MemoryPromptSettingLogFilter,
  MemoryPromptSettingLogRecord,
  MemoryPromptSettingRecord,
} from "../../memory-prompt/types.js";
import type { MemoryGenerationLayer, MemoryGenerationRefRecord } from "../../memory-generation-log/types.js";
import {
  Params,
  ftsQueryToTokens,
  getSharedPostgresPool,
  isUsableVector,
  qi,
  toVectorLiteral,
  tsRankToScore,
  withTransaction,
} from "./client.js";
import { assertSchemaName } from "./config.js";
import { MEMORY_MIGRATIONS, ensureVectorExtension, runMigrations } from "./migrations.js";
import { PostgresEntityRepo } from "./entities.js";

const TAG = "[memory-tdai][postgres]";

/** pgvector HNSW supports at most 2000 dims for `vector`; beyond that we search exactly. */
const HNSW_MAX_DIMS = 2000;
/** tsvector is capped at 1 MB; keep the indexed text comfortably below. */
const MAX_TOKENS_CHARS = 500_000;
/** sqlite's safety guard: never let a TTL pass delete more than this share. */
const EXPIRE_MAX_RATIO = 0.8;

const L1_COLS = `record_id, content, type, priority, scene_name, session_key, session_id, team_id, task_id,
  user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json`;
const L0_COLS = `record_id, session_key, session_id, team_id, task_id, user_id, agent_id, role, message_text,
  recorded_at, timestamp`;

/** SQL that turns a text[] of query tokens ($1) into one OR-ed tsquery (NULL when nothing is left). */
const TSQUERY_FROM_TOKENS = (param: string) => `(
  SELECT string_agg('(' || x::text || ')', ' | ')::tsquery
  FROM (SELECT phraseto_tsquery('simple', t) AS x FROM unnest(${param}::text[]) AS t) s
  WHERE numnode(x) > 0
)`;

interface EmbeddingMeta {
  provider: string;
  model: string;
  dimensions: number;
  schemaIdentity?: string;
  modelRevision?: string;
  normalization?: string;
}

export interface PostgresMemoryStoreOptions {
  /** Connection URL; ignored when `pool` is given. */
  url?: string;
  pool?: Pool;
  poolMax?: number;
  /** Target schema (already resolved per instance). */
  schema: string;
  /** Embedding dimensions (0 = keyword-only). */
  dimensions: number;
  logger?: StoreLogger;
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function contractKey(m: EmbeddingMeta): string {
  return [
    m.provider,
    m.schemaIdentity ?? m.model,
    m.modelRevision ?? "",
    m.normalization ?? "l2-v1",
    m.dimensions,
  ].join("|");
}

function tokensFor(text: string): string {
  const t = tokenizeForFts(text);
  return t.length > MAX_TOKENS_CHARS ? t.slice(0, MAX_TOKENS_CHARS) : t;
}

function isolationConds(filter: IsolationFilter | undefined, p: Params, prefix = ""): string[] {
  const conds: string[] = [];
  if (!filter) return conds;
  const eq = (col: string, v: string | undefined) => {
    if (v !== undefined) conds.push(`${prefix}${col} = ${p.add(v)}`);
  };
  eq("team_id", filter.teamId);
  eq("user_id", filter.userId);
  eq("agent_id", filter.agentId);
  eq("session_id", filter.sessionId);
  eq("task_id", filter.taskId);
  eq("session_key", filter.sessionKey);
  return conds;
}

const whereOf = (conds: string[]) => (conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "");

function toL1Row(r: Row): L1RecordRow {
  return {
    record_id: r.record_id,
    content: r.content,
    type: r.type ?? "",
    priority: Number(r.priority ?? 0),
    scene_name: r.scene_name ?? "",
    session_key: r.session_key ?? "",
    session_id: r.session_id ?? "",
    team_id: r.team_id ?? "",
    task_id: r.task_id ?? "",
    user_id: r.user_id ?? "",
    agent_id: r.agent_id ?? "",
    version: Number(r.version ?? 0),
    timestamp_str: r.timestamp_str ?? "",
    timestamp_start: r.timestamp_start ?? "",
    timestamp_end: r.timestamp_end ?? "",
    created_time: r.created_time ?? "",
    updated_time: r.updated_time ?? "",
    metadata_json: r.metadata_json ?? "{}",
  };
}

function toL1Hit(r: Row, score: number): L1SearchResult {
  const row = toL1Row(r);
  return {
    record_id: row.record_id,
    content: row.content,
    type: row.type,
    priority: row.priority,
    scene_name: row.scene_name,
    score,
    timestamp_str: row.timestamp_str,
    timestamp_start: row.timestamp_start,
    timestamp_end: row.timestamp_end,
    version: row.version,
    session_key: row.session_key,
    session_id: row.session_id,
    team_id: row.team_id,
    task_id: row.task_id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    metadata_json: row.metadata_json,
  };
}

function toL0Row(r: Row): L0QueryRow {
  return {
    record_id: r.record_id,
    session_key: r.session_key ?? "",
    session_id: r.session_id ?? "",
    team_id: r.team_id ?? "",
    task_id: r.task_id ?? "",
    user_id: r.user_id ?? "",
    agent_id: r.agent_id ?? "",
    role: r.role ?? "",
    message_text: r.message_text,
    recorded_at: r.recorded_at ?? "",
    timestamp: Number(r.timestamp ?? 0),
  };
}

function toProfile(r: Row): ProfileRecord {
  return {
    id: r.id,
    type: r.type,
    filename: r.filename,
    content: r.content,
    contentMd5: r.content_md5 ?? "",
    teamId: r.team_id ?? "",
    agentId: r.agent_id ?? "",
    userId: r.user_id ?? "",
    sessionId: r.session_id ?? "",
    version: Number(r.version ?? 0),
    createdAtMs: Number(r.created_at_ms ?? 0),
    updatedAtMs: Number(r.updated_at_ms ?? 0),
  };
}

export class PostgresMemoryStore implements IMemoryStore {
  readonly supportsDeferredEmbedding = true;

  private readonly pool: Pool;
  private readonly schema: string;
  /** Quoted schema, safe to interpolate. */
  private readonly s: string;
  private readonly dimensions: number;
  private readonly logger?: StoreLogger;
  private readonly entities: PostgresEntityRepo;

  private initPromise: Promise<StoreInitResult> | null = null;
  private ready = false;
  private degraded = false;
  private closed = false;
  private ftsAvailable = false;

  /** Dimension of the live `embedding` columns (0 = none). */
  private activeDims = 0;
  /** Stored vectors belong to another embedding contract: skip vector writes, reindex required. */
  private vectorIoBlocked = false;
  private hasVectorExt = false;
  private iterativeScan = false;
  private targetMeta: EmbeddingMeta | null = null;

  constructor(opts: PostgresMemoryStoreOptions) {
    this.schema = assertSchemaName(opts.schema);
    this.s = qi(this.schema);
    this.pool = opts.pool ?? getSharedPostgresPool(opts.url ?? "", opts.poolMax);
    this.dimensions = Math.max(0, opts.dimensions | 0);
    this.logger = opts.logger;
    this.entities = new PostgresEntityRepo(this.pool, this.s);
  }

  getSchema(): string {
    return this.schema;
  }

  // ════════════════════════════ Lifecycle ════════════════════════════

  init(providerInfo?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    if (!this.initPromise) {
      this.initPromise = this.doInit(providerInfo);
    }
    return this.initPromise;
  }

  private async doInit(providerInfo?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    try {
      this.hasVectorExt = this.dimensions > 0 ? await ensureVectorExtension(this.pool) : false;
      const applied = await runMigrations(this.pool, this.schema, "memory", MEMORY_MIGRATIONS);
      if (applied.length > 0) {
        this.logger?.info?.(`${TAG} schema ${this.schema}: applied memory migrations ${applied.join(",")}`);
      }
      this.ftsAvailable = true;
      const result = await this.reconcileVectors(providerInfo);
      this.ready = true;
      this.degraded = false;
      this.logger?.info?.(
        `${TAG} initialized schema=${this.schema} dims=${this.dimensions} activeDims=${this.activeDims} ` +
          `vectorIoBlocked=${this.vectorIoBlocked}`,
      );
      return result;
    } catch (err) {
      this.degraded = true;
      this.initPromise = null; // allow a later retry
      this.logger?.error?.(`${TAG} init failed for schema=${this.schema}: ${errMsg(err)} — store degraded`);
      return { needsReindex: false, reason: `postgres init failed: ${errMsg(err)}` };
    }
  }

  private async readMeta(key: string): Promise<string | undefined> {
    const res = await this.pool.query(`SELECT value FROM ${this.s}.embedding_meta WHERE key = $1`, [key]);
    return res.rows[0]?.value;
  }

  private async writeMeta(key: string, value: string, c: Pick<Pool, "query"> = this.pool): Promise<void> {
    await c.query(
      `INSERT INTO ${this.s}.embedding_meta (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value],
    );
  }

  /** Dimension of an existing `vector(N)` column, or null when absent. */
  private async columnDims(table: string, column: string): Promise<number | null> {
    const res = await this.pool.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS t
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 AND NOT a.attisdropped`,
      [this.schema, table, column],
    );
    const t: string | undefined = res.rows[0]?.t;
    if (!t) return null;
    const m = t.match(/vector\((\d+)\)/);
    return m ? Number(m[1]) : null;
  }

  private async embeddedRowCount(): Promise<number> {
    const res = await this.pool.query(
      `SELECT (SELECT COUNT(*) FROM ${this.s}.l1_records WHERE embedding IS NOT NULL)
            + (SELECT COUNT(*) FROM ${this.s}.l0_conversations WHERE embedding IS NOT NULL) AS n`,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** (Re)create the embedding column + HNSW index on both tables, inside `c`. */
  private async createVectorColumns(c: Pick<PoolClient, "query">, dims: number, column = "embedding"): Promise<void> {
    for (const [table, idx] of [
      ["l1_records", "idx_l1_embedding"],
      ["l0_conversations", "idx_l0_embedding"],
    ]) {
      await c.query(`ALTER TABLE ${this.s}.${table} ADD COLUMN IF NOT EXISTS ${column} vector(${dims})`);
      if (column === "embedding" && dims <= HNSW_MAX_DIMS) {
        await c.query(
          `CREATE INDEX IF NOT EXISTS ${idx} ON ${this.s}.${table} USING hnsw (embedding vector_cosine_ops)`,
        );
      }
    }
  }

  private async dropVectorColumns(c: Pick<PoolClient, "query">, column = "embedding"): Promise<void> {
    await c.query(`ALTER TABLE ${this.s}.l1_records DROP COLUMN IF EXISTS ${column}`);
    await c.query(`ALTER TABLE ${this.s}.l0_conversations DROP COLUMN IF EXISTS ${column}`);
  }

  private async reconcileVectors(providerInfo?: EmbeddingProviderInfo): Promise<StoreInitResult> {
    if (this.dimensions === 0) return { needsReindex: false };
    if (!this.hasVectorExt) {
      this.logger?.warn?.(`${TAG} pgvector extension unavailable — vector search disabled, keyword search only`);
      return { needsReindex: false, reason: "pgvector extension unavailable" };
    }
    const ver = await this.pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    const [major, minor] = String(ver.rows[0]?.extversion ?? "0.0")
      .split(".")
      .map(Number);
    this.iterativeScan = major > 0 || minor >= 8;

    // A Noop embedder (provider "noop") produces no vectors and must not pin the contract.
    const current: EmbeddingMeta | null =
      providerInfo && providerInfo.provider !== "noop"
      ? {
          provider: providerInfo.provider,
          model: providerInfo.model,
          dimensions: this.dimensions,
          schemaIdentity: providerInfo.schemaIdentity,
          modelRevision: providerInfo.modelRevision,
          normalization: providerInfo.normalization ?? "l2-v1",
        }
      : null;
    const savedRaw = await this.readMeta("embedding_provider_info");
    const saved: EmbeddingMeta | null = savedRaw ? JSON.parse(savedRaw) : null;

    const l1Dims = await this.columnDims("l1_records", "embedding");
    const l0Dims = await this.columnDims("l0_conversations", "embedding");
    const existing = l1Dims ?? l0Dims;

    if (existing !== null && (existing !== this.dimensions || l1Dims !== l0Dims)) {
      if ((await this.embeddedRowCount()) === 0) {
        // Nothing to preserve: rebuild with the configured dimension.
        await withTransaction(this.pool, async (c) => {
          await this.dropVectorColumns(c);
          await this.createVectorColumns(c, this.dimensions);
          if (current) await this.writeMeta("embedding_provider_info", JSON.stringify(current), c);
        });
        this.activeDims = this.dimensions;
        return { needsReindex: false };
      }
      this.activeDims = existing;
      this.vectorIoBlocked = true;
      this.targetMeta = current ?? { provider: "unknown", model: "unknown", dimensions: this.dimensions };
      const reason = `dimensions: ${existing} → ${this.dimensions}`;
      this.logger?.warn?.(`${TAG} embedding dimension mismatch (${reason}); vectors preserved, reindex required`);
      return { needsReindex: true, reason };
    }

    if (existing === null) {
      await withTransaction(this.pool, async (c) => this.createVectorColumns(c, this.dimensions));
    }
    this.activeDims = this.dimensions;

    if (current && saved && contractKey(saved) !== contractKey(current) && (await this.embeddedRowCount()) > 0) {
      this.vectorIoBlocked = true;
      this.targetMeta = current;
      const reason = `embedding contract: ${contractKey(saved)} → ${contractKey(current)}`;
      this.logger?.warn?.(`${TAG} ${reason}; vectors preserved, reindex required`);
      return { needsReindex: true, reason };
    }
    if (current) await this.writeMeta("embedding_provider_info", JSON.stringify(current));
    return { needsReindex: false };
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): StoreCapabilities {
    return {
      vectorSearch: this.ready && this.activeDims > 0 && !this.vectorIoBlocked,
      ftsSearch: this.ftsAvailable,
      nativeHybridSearch: false,
      sparseVectors: false,
      profileRows: true,
    };
  }

  isFtsAvailable(): boolean {
    return this.ftsAvailable;
  }

  /** The pool is shared across instances; closing only retires this handle. */
  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Awaits init (running it lazily if nobody did) and reports usability. */
  private async usable(): Promise<boolean> {
    if (this.closed) return false;
    if (!this.ready && !this.degraded) await this.init();
    return this.ready && !this.degraded;
  }

  private async requireUsable(op: string): Promise<void> {
    if (!(await this.usable())) throw new Error(`${TAG} ${op}: store is ${this.closed ? "closed" : "degraded"}`);
  }

  private vectorWritable(embedding: Float32Array | undefined): embedding is Float32Array {
    return !this.vectorIoBlocked && this.activeDims > 0 && isUsableVector(embedding, this.activeDims);
  }

  // ════════════════════════════ L1 write ════════════════════════════

  async upsertL1(record: MemoryRecord, embedding?: Float32Array): Promise<boolean> {
    if (!(await this.usable())) return false;
    try {
      const ts = record.timestamps ?? [];
      const tsStr = ts[0] ?? "";
      const tsStart = ts.length > 0 ? ts.reduce((a, b) => (a < b ? a : b)) : tsStr;
      const tsEnd = ts.length > 0 ? ts.reduce((a, b) => (a > b ? a : b)) : tsStr;
      const withVec = this.vectorWritable(embedding);
      const p = new Params();
      const values = [
        p.add(record.id),
        p.add(record.content),
        p.add(tokensFor(record.content)),
        p.add(record.type ?? ""),
        p.add(record.priority ?? 50),
        p.add(record.scene_name ?? ""),
        p.add(record.sessionKey ?? ""),
        p.add(record.sessionId || DEFAULT_ISOLATION_ID),
        p.add(record.teamId || DEFAULT_ISOLATION_ID),
        p.add(record.taskId || ""),
        p.add(record.userId || DEFAULT_ISOLATION_ID),
        p.add(record.agentId || DEFAULT_ISOLATION_ID),
        p.add(record.version ?? 0),
        p.add(tsStr),
        p.add(tsStart),
        p.add(tsEnd),
        p.add(record.createdAt ?? ""),
        p.add(record.updatedAt ?? ""),
        p.add(JSON.stringify(record.metadata ?? {})),
      ];
      if (withVec) values.push(`${p.add(toVectorLiteral(embedding))}::vector`);
      await this.pool.query(
        `INSERT INTO ${this.s}.l1_records (record_id, content, tokens, type, priority, scene_name, session_key,
           session_id, team_id, task_id, user_id, agent_id, version, timestamp_str, timestamp_start, timestamp_end,
           created_time, updated_time, metadata_json${withVec ? ", embedding" : ""})
         VALUES (${values.join(", ")})
         ON CONFLICT (record_id) DO UPDATE SET content = EXCLUDED.content, tokens = EXCLUDED.tokens,
           type = EXCLUDED.type, priority = EXCLUDED.priority, scene_name = EXCLUDED.scene_name,
           team_id = EXCLUDED.team_id, task_id = EXCLUDED.task_id, user_id = EXCLUDED.user_id,
           agent_id = EXCLUDED.agent_id, version = EXCLUDED.version, timestamp_str = EXCLUDED.timestamp_str,
           timestamp_start = EXCLUDED.timestamp_start, timestamp_end = EXCLUDED.timestamp_end,
           updated_time = EXCLUDED.updated_time, metadata_json = EXCLUDED.metadata_json
           ${withVec ? ", embedding = EXCLUDED.embedding" : ""}`,
        p.values,
      );
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-upsert] FAILED id=${record.id}: ${errMsg(err)}`);
      return false;
    }
  }

  async deleteL1(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    if (!(await this.usable())) return false;
    try {
      const p = new Params();
      const conds = [`record_id = ${p.add(recordId)}`, ...isolationConds(filter, p)];
      const res = await this.pool.query(`DELETE FROM ${this.s}.l1_records ${whereOf(conds)}`, p.values);
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-delete] FAILED id=${recordId}: ${errMsg(err)}`);
      return false;
    }
  }

  async deleteL1Batch(recordIds: string[], filter?: IsolationFilter): Promise<boolean> {
    if (!(await this.usable())) return false;
    if (recordIds.length === 0) return true;
    try {
      const p = new Params();
      const conds = [`record_id = ANY(${p.add(recordIds)}::text[])`, ...isolationConds(filter, p)];
      await this.pool.query(`DELETE FROM ${this.s}.l1_records ${whereOf(conds)}`, p.values);
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-deleteBatch] FAILED: ${errMsg(err)}`);
      return false;
    }
  }

  async deleteL1Expired(cutoffIso: string): Promise<number> {
    return this.deleteExpired("l1_records", "updated_time", cutoffIso);
  }

  private async deleteExpired(
    table: "l1_records" | "l0_conversations",
    column: string,
    cutoffIso: string,
  ): Promise<number> {
    if (!(await this.usable())) return 0;
    try {
      return await withTransaction(this.pool, async (c) => {
        const res = await c.query(
          `SELECT COUNT(*) FILTER (WHERE ${column} <> '' AND ${column} < $1) AS expired, COUNT(*) AS total
           FROM ${this.s}.${table}`,
          [cutoffIso],
        );
        const expired = Number(res.rows[0]?.expired ?? 0);
        const total = Number(res.rows[0]?.total ?? 0);
        if (expired === 0) return 0;
        if (total > 0 && expired / total > EXPIRE_MAX_RATIO) {
          this.logger?.warn?.(
            `${TAG} [${table}-deleteExpired] BLOCKED: would delete ${expired}/${total} ` +
              `(> ${EXPIRE_MAX_RATIO * 100}%), cutoff=${cutoffIso}`,
          );
          return 0;
        }
        const del = await c.query(`DELETE FROM ${this.s}.${table} WHERE ${column} <> '' AND ${column} < $1`, [
          cutoffIso,
        ]);
        return del.rowCount ?? 0;
      });
    } catch (err) {
      this.logger?.warn?.(`${TAG} [${table}-deleteExpired] FAILED: ${errMsg(err)}`);
      return 0;
    }
  }

  // ════════════════════════════ L1 read ════════════════════════════

  private l1CountConds(filter: L1CountFilter | undefined, p: Params): string[] {
    const conds: string[] = [];
    if (!filter) return conds;
    if (filter.type) conds.push(`type = ${p.add(filter.type)}`);
    if (filter.sessionId) conds.push(`session_id = ${p.add(filter.sessionId)}`);
    conds.push(
      ...isolationConds(
        { teamId: filter.teamId, userId: filter.userId, agentId: filter.agentId, taskId: filter.taskId },
        p,
      ),
    );
    if (filter.timeStart) conds.push(`updated_time >= ${p.add(filter.timeStart)}`);
    if (filter.timeEnd) conds.push(`updated_time <= ${p.add(filter.timeEnd)}`);
    return conds;
  }

  async countL1(filter?: L1CountFilter): Promise<number> {
    if (!(await this.usable())) return 0;
    try {
      const p = new Params();
      const res = await this.pool.query(
        `SELECT COUNT(*) AS n FROM ${this.s}.l1_records ${whereOf(this.l1CountConds(filter, p))}`,
        p.values,
      );
      return Number(res.rows[0]?.n ?? 0);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-count] FAILED: ${errMsg(err)}`);
      return 0;
    }
  }

  async queryL1Records(filter?: L1QueryFilter): Promise<L1RecordRow[]> {
    if (!(await this.usable())) return [];
    try {
      const p = new Params();
      const conds: string[] = [];
      // Same precedence as sqlite: sessionId beats sessionKey.
      if (filter?.sessionId) conds.push(`session_id = ${p.add(filter.sessionId)}`);
      else if (filter?.sessionKey) conds.push(`session_key = ${p.add(filter.sessionKey)}`);
      if (filter?.updatedAfter) conds.push(`updated_time > ${p.add(filter.updatedAfter)}`);
      conds.push(
        ...isolationConds(
          { teamId: filter?.teamId, userId: filter?.userId, agentId: filter?.agentId, taskId: filter?.taskId },
          p,
        ),
      );
      if (filter?.recordIds && filter.recordIds.length > 0) {
        conds.push(`record_id = ANY(${p.add(filter.recordIds)}::text[])`);
      }
      const res = await this.pool.query(
        `SELECT ${L1_COLS} FROM ${this.s}.l1_records ${whereOf(conds)} ORDER BY updated_time ASC, record_id ASC`,
        p.values,
      );
      return res.rows.map(toL1Row);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-query] FAILED: ${errMsg(err)}`);
      return [];
    }
  }

  async getAllL1Texts(): Promise<Array<{ record_id: string; content: string; updated_time: string }>> {
    if (!(await this.usable())) return [];
    try {
      const res = await this.pool.query(`SELECT record_id, content, updated_time FROM ${this.s}.l1_records`);
      return res.rows as Array<{ record_id: string; content: string; updated_time: string }>;
    } catch (err) {
      this.logger?.warn?.(`${TAG} getAllL1Texts FAILED: ${errMsg(err)}`);
      return [];
    }
  }

  async queryL1Paginated(filter: L1PaginatedFilter): Promise<L1PaginatedResult> {
    if (!(await this.usable())) return { rows: [], total: 0 };
    try {
      const p = new Params();
      const where = whereOf(this.l1CountConds(filter, p));
      const total = await this.pool.query(`SELECT COUNT(*) AS n FROM ${this.s}.l1_records ${where}`, p.values);
      const limit = p.add(filter.limit);
      const offset = p.add(filter.offset);
      const res = await this.pool.query(
        `SELECT ${L1_COLS} FROM ${this.s}.l1_records ${where}
         ORDER BY updated_time DESC, record_id DESC LIMIT ${limit} OFFSET ${offset}`,
        p.values,
      );
      return { rows: res.rows.map(toL1Row), total: Number(total.rows[0]?.n ?? 0) };
    } catch (err) {
      this.logger?.warn?.(`${TAG} queryL1Paginated FAILED: ${errMsg(err)}`);
      return { rows: [], total: 0 };
    }
  }

  // ════════════════════════════ Search ════════════════════════════

  /** Run a KNN query; with pgvector ≥ 0.8 iterative scans keep filtered HNSW recall exact. */
  private async knn(sql: string, params: unknown[]): Promise<Row[]> {
    if (!this.iterativeScan) return (await this.pool.query(sql, params)).rows;
    return withTransaction(this.pool, async (c) => {
      await c.query("SET LOCAL hnsw.iterative_scan = strict_order");
      return (await c.query(sql, params)).rows;
    });
  }

  private canSearchVector(q: Float32Array): boolean {
    return this.activeDims > 0 && isUsableVector(q, this.activeDims);
  }

  async searchL1Vector(
    queryEmbedding: Float32Array,
    topK = 5,
    _queryText?: string,
    filter?: IsolationFilter,
  ): Promise<L1SearchResult[]> {
    if (!(await this.usable()) || !this.canSearchVector(queryEmbedding)) return [];
    try {
      const p = new Params();
      const vec = p.add(toVectorLiteral(queryEmbedding));
      const conds = ["embedding IS NOT NULL", ...isolationConds(filter, p)];
      const rows = await this.knn(
        `SELECT ${L1_COLS}, embedding <=> ${vec}::vector AS distance FROM ${this.s}.l1_records
         ${whereOf(conds)} ORDER BY embedding <=> ${vec}::vector LIMIT ${p.add(topK)}`,
        p.values,
      );
      return rows.map((r) => toL1Hit(r, 1 - Number(r.distance)));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-vector] FAILED: ${errMsg(err)}`);
      return [];
    }
  }

  async searchL1Fts(ftsQuery: string, limit = 20, filter?: IsolationFilter): Promise<L1FtsResult[]> {
    if (!(await this.usable()) || !this.ftsAvailable) return [];
    const tokens = ftsQueryToTokens(ftsQuery);
    if (tokens.length === 0) return [];
    try {
      const p = new Params();
      const q = TSQUERY_FROM_TOKENS(p.add(tokens));
      const conds = ["l.fts @@ q.q", ...isolationConds(filter, p, "l.")];
      const res = await this.pool.query(
        `WITH q AS (SELECT ${q} AS q)
         SELECT ${L1_COLS.replace(/(\w+)/g, "l.$1")}, ts_rank_cd('{1,1,1,1}', l.fts, q.q) AS rank
         FROM ${this.s}.l1_records l, q ${whereOf(conds)}
         ORDER BY rank DESC, l.record_id LIMIT ${p.add(limit)}`,
        p.values,
      );
      return res.rows.map((r) => toL1Hit(r, tsRankToScore(Number(r.rank))));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L1-fts] FAILED: ${errMsg(err)}`);
      return [];
    }
  }

  async searchL0Vector(
    queryEmbedding: Float32Array,
    topK = 5,
    _queryText?: string,
    filter?: IsolationFilter,
  ): Promise<L0SearchResult[]> {
    if (!(await this.usable()) || !this.canSearchVector(queryEmbedding)) return [];
    try {
      const p = new Params();
      const vec = p.add(toVectorLiteral(queryEmbedding));
      const conds = ["embedding IS NOT NULL", ...isolationConds(filter, p)];
      const rows = await this.knn(
        `SELECT ${L0_COLS}, embedding <=> ${vec}::vector AS distance FROM ${this.s}.l0_conversations
         ${whereOf(conds)} ORDER BY embedding <=> ${vec}::vector LIMIT ${p.add(topK)}`,
        p.values,
      );
      return rows.map((r) => ({ ...toL0Row(r), score: 1 - Number(r.distance) }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-vector] FAILED: ${errMsg(err)}`);
      return [];
    }
  }

  async searchL0Fts(ftsQuery: string, limit = 20, filter?: IsolationFilter): Promise<L0FtsResult[]> {
    if (!(await this.usable()) || !this.ftsAvailable) return [];
    const tokens = ftsQueryToTokens(ftsQuery);
    if (tokens.length === 0) return [];
    try {
      const p = new Params();
      const q = TSQUERY_FROM_TOKENS(p.add(tokens));
      const conds = ["l.fts @@ q.q", ...isolationConds(filter, p, "l.")];
      const res = await this.pool.query(
        `WITH q AS (SELECT ${q} AS q)
         SELECT ${L0_COLS.replace(/(\w+)/g, "l.$1")}, ts_rank_cd('{1,1,1,1}', l.fts, q.q) AS rank
         FROM ${this.s}.l0_conversations l, q ${whereOf(conds)}
         ORDER BY rank DESC, l.record_id LIMIT ${p.add(limit)}`,
        p.values,
      );
      return res.rows.map((r) => ({ ...toL0Row(r), score: tsRankToScore(Number(r.rank)) }));
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-fts] FAILED: ${errMsg(err)}`);
      return [];
    }
  }

  // ════════════════════════════ L0 write ════════════════════════════

  async upsertL0(record: L0Record, embedding?: Float32Array): Promise<boolean> {
    if (!(await this.usable())) return false;
    try {
      const withVec = this.vectorWritable(embedding);
      const p = new Params();
      const values = [
        p.add(record.id),
        p.add(record.sessionKey ?? ""),
        p.add(record.sessionId || DEFAULT_ISOLATION_ID),
        p.add(record.teamId || DEFAULT_ISOLATION_ID),
        p.add(record.taskId || ""),
        p.add(record.userId || DEFAULT_ISOLATION_ID),
        p.add(record.agentId || DEFAULT_ISOLATION_ID),
        p.add(record.role ?? ""),
        p.add(record.messageText),
        p.add(tokensFor(record.messageText)),
        p.add(record.recordedAt ?? ""),
        p.add(record.timestamp ?? 0),
      ];
      if (withVec) values.push(`${p.add(toVectorLiteral(embedding))}::vector`);
      await this.pool.query(
        `INSERT INTO ${this.s}.l0_conversations (record_id, session_key, session_id, team_id, task_id, user_id,
           agent_id, role, message_text, tokens, recorded_at, timestamp${withVec ? ", embedding" : ""})
         VALUES (${values.join(", ")})
         ON CONFLICT (record_id) DO UPDATE SET message_text = EXCLUDED.message_text, tokens = EXCLUDED.tokens,
           recorded_at = EXCLUDED.recorded_at, timestamp = EXCLUDED.timestamp, team_id = EXCLUDED.team_id,
           task_id = EXCLUDED.task_id, user_id = EXCLUDED.user_id, agent_id = EXCLUDED.agent_id
           ${withVec ? ", embedding = EXCLUDED.embedding" : ""}`,
        p.values,
      );
      return true;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-upsert] FAILED id=${record.id}: ${errMsg(err)}`);
      return false;
    }
  }

  async updateL0Embedding(recordId: string, embedding: Float32Array): Promise<boolean> {
    if (!(await this.usable()) || !this.vectorWritable(embedding)) return false;
    try {
      const res = await this.pool.query(
        `UPDATE ${this.s}.l0_conversations SET embedding = $2::vector WHERE record_id = $1`,
        [recordId, toVectorLiteral(embedding)],
      );
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-update-embedding] FAILED id=${recordId}: ${errMsg(err)}`);
      return false;
    }
  }

  /** Plain multi-row INSERT: a duplicate id surfaces as an error (contract of insertL0Batch). */
  async insertL0Batch(records: L0Record[]): Promise<number> {
    if (records.length === 0) return 0;
    await this.requireUsable("insertL0Batch");
    let inserted = 0;
    const CHUNK = 500;
    await withTransaction(this.pool, async (c) => {
      for (let i = 0; i < records.length; i += CHUNK) {
        const p = new Params();
        const tuples = records
          .slice(i, i + CHUNK)
          .map(
            (r) =>
              `(${[
                p.add(r.id),
                p.add(r.sessionKey ?? ""),
                p.add(r.sessionId || DEFAULT_ISOLATION_ID),
                p.add(r.teamId || DEFAULT_ISOLATION_ID),
                p.add(r.taskId || ""),
                p.add(r.userId || DEFAULT_ISOLATION_ID),
                p.add(r.agentId || DEFAULT_ISOLATION_ID),
                p.add(r.role ?? ""),
                p.add(r.messageText),
                p.add(tokensFor(r.messageText)),
                p.add(r.recordedAt ?? ""),
                p.add(r.timestamp ?? 0),
              ].join(", ")})`,
          );
        const res = await c.query(
          `INSERT INTO ${this.s}.l0_conversations (record_id, session_key, session_id, team_id, task_id, user_id,
             agent_id, role, message_text, tokens, recorded_at, timestamp) VALUES ${tuples.join(", ")}`,
          p.values,
        );
        inserted += res.rowCount ?? 0;
      }
    });
    return inserted;
  }

  async deleteL0(recordId: string, filter?: IsolationFilter): Promise<boolean> {
    if (!(await this.usable())) return false;
    try {
      const p = new Params();
      const conds = [`record_id = ${p.add(recordId)}`, ...isolationConds(filter, p)];
      const res = await this.pool.query(`DELETE FROM ${this.s}.l0_conversations ${whereOf(conds)}`, p.values);
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-delete] FAILED id=${recordId}: ${errMsg(err)}`);
      return false;
    }
  }

  async deleteL0Expired(cutoffIso: string): Promise<number> {
    return this.deleteExpired("l0_conversations", "recorded_at", cutoffIso);
  }

  async deleteL0BySession(sessionId: string, filter?: IsolationFilter): Promise<number> {
    const sid = (sessionId ?? "").trim();
    // An empty id would match every legacy row with an empty session — refuse, as sqlite does.
    if (!sid) throw new Error("[postgres] deleteL0BySession requires a non-empty sessionId");
    if (!(await this.usable())) return 0;
    try {
      const p = new Params();
      const ph = p.add(sid);
      const conds = [`(session_key = ${ph} OR session_id = ${ph})`, ...isolationConds(filter, p)];
      const res = await this.pool.query(`DELETE FROM ${this.s}.l0_conversations ${whereOf(conds)}`, p.values);
      return res.rowCount ?? 0;
    } catch (err) {
      this.logger?.warn?.(`${TAG} deleteL0BySession FAILED: ${errMsg(err)}`);
      return 0;
    }
  }

  // ════════════════════════════ L0 read ════════════════════════════

  private l0CountConds(filter: L0CountFilter | undefined, p: Params): string[] {
    const conds: string[] = [];
    if (!filter) return conds;
    if (filter.sessionId) {
      const ph = p.add(filter.sessionId);
      conds.push(`(session_key = ${ph} OR session_id = ${ph})`);
    }
    conds.push(
      ...isolationConds(
        { teamId: filter.teamId, userId: filter.userId, agentId: filter.agentId, taskId: filter.taskId },
        p,
      ),
    );
    if (filter.timeStartMs !== undefined) conds.push(`timestamp >= ${p.add(filter.timeStartMs)}`);
    if (filter.timeEndMs !== undefined) conds.push(`timestamp <= ${p.add(filter.timeEndMs)}`);
    return conds;
  }

  async countL0(filter?: L0CountFilter): Promise<number> {
    if (!(await this.usable())) return 0;
    try {
      const p = new Params();
      const res = await this.pool.query(
        `SELECT COUNT(*) AS n FROM ${this.s}.l0_conversations ${whereOf(this.l0CountConds(filter, p))}`,
        p.values,
      );
      return Number(res.rows[0]?.n ?? 0);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-count] FAILED: ${errMsg(err)}`);
      return 0;
    }
  }

  /** Oldest-first above the recorded_at cursor, so a backlog never skips rows (see sqlite). */
  async queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit = 50): Promise<L0QueryRow[]> {
    if (!(await this.usable())) return [];
    try {
      const p = new Params();
      const conds = [`session_key = ${p.add(sessionKey)}`];
      if (afterRecordedAtMs && afterRecordedAtMs > 0) {
        conds.push(`recorded_at > ${p.add(new Date(afterRecordedAtMs).toISOString())}`);
      }
      const res = await this.pool.query(
        `SELECT ${L0_COLS} FROM ${this.s}.l0_conversations ${whereOf(conds)}
         ORDER BY recorded_at ASC, record_id ASC LIMIT ${p.add(limit)}`,
        p.values,
      );
      return res.rows.map(toL0Row);
    } catch (err) {
      this.logger?.warn?.(`${TAG} [L0-query] FAILED: ${errMsg(err)}`);
      return [];
    }
  }

  async queryL0GroupedBySessionId(
    sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
  ): Promise<L0SessionGroup[]> {
    const rows = await this.queryL0ForL1(sessionKey, afterRecordedAtMs, limit);
    // Group by the full isolation tuple + session so tenants never merge.
    const groups = new Map<string, L0SessionGroup>();
    for (const row of rows) {
      const teamId = row.team_id || undefined;
      const taskId = row.task_id || undefined;
      const key = [teamId ?? "", row.user_id, row.agent_id, row.session_id, taskId ?? ""].join("\u0000");
      let g = groups.get(key);
      if (!g) {
        g = { sessionId: row.session_id, teamId, taskId, userId: row.user_id, agentId: row.agent_id, messages: [] };
        groups.set(key, g);
      }
      g.messages.push({
        id: row.record_id,
        role: row.role,
        content: row.message_text,
        timestamp: row.timestamp,
        recordedAtMs: row.recorded_at ? Date.parse(row.recorded_at) || 0 : 0,
      });
    }
    return [...groups.values()]
      .filter((g) => g.messages.length > 0)
      .sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);
  }

  async getAllL0Texts(): Promise<Array<{ record_id: string; message_text: string; recorded_at: string }>> {
    if (!(await this.usable())) return [];
    try {
      const res = await this.pool.query(`SELECT record_id, message_text, recorded_at FROM ${this.s}.l0_conversations`);
      return res.rows as Array<{ record_id: string; message_text: string; recorded_at: string }>;
    } catch (err) {
      this.logger?.warn?.(`${TAG} getAllL0Texts FAILED: ${errMsg(err)}`);
      return [];
    }
  }

  async queryL0Paginated(filter: L0PaginatedFilter): Promise<L0PaginatedResult> {
    if (!(await this.usable())) return { rows: [], total: 0 };
    try {
      const p = new Params();
      const where = whereOf(this.l0CountConds(filter, p));
      const total = await this.pool.query(`SELECT COUNT(*) AS n FROM ${this.s}.l0_conversations ${where}`, p.values);
      const limit = p.add(filter.limit);
      const offset = p.add(filter.offset);
      const res = await this.pool.query(
        `SELECT ${L0_COLS} FROM ${this.s}.l0_conversations ${where}
         ORDER BY timestamp DESC, record_id DESC LIMIT ${limit} OFFSET ${offset}`,
        p.values,
      );
      return { rows: res.rows.map(toL0Row), total: Number(total.rows[0]?.n ?? 0) };
    } catch (err) {
      this.logger?.warn?.(`${TAG} queryL0Paginated FAILED: ${errMsg(err)}`);
      return { rows: [], total: 0 };
    }
  }

  // ════════════════════════════ Re-index ════════════════════════════

  /**
   * Re-embed every L0/L1 text. When the stored vectors belong to another
   * contract, embeddings go into a shadow column and are swapped in only when
   * every row succeeded; otherwise the active vectors stay untouched.
   */
  async reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }> {
    if (!(await this.usable()) || !this.hasVectorExt || this.dimensions === 0) return { l1Count: 0, l0Count: 0 };
    const shadow = this.vectorIoBlocked;
    const column = shadow ? "embedding_next" : "embedding";
    if (shadow) {
      await withTransaction(this.pool, async (c) => {
        await this.dropVectorColumns(c, "embedding_next");
        await this.createVectorColumns(c, this.dimensions, "embedding_next");
      });
    }
    let failed = 0;
    const run = async (
      layer: "L1" | "L0",
      table: string,
      rows: Array<{ record_id: string; text: string }>,
    ): Promise<number> => {
      let ok = 0;
      for (let i = 0; i < rows.length; i++) {
        try {
          const e = await embedFn(rows[i].text);
          const dims = e?.length;
          if (!isUsableVector(e, this.dimensions)) throw new Error(`unusable vector (dims=${dims})`);
          await this.pool.query(`UPDATE ${this.s}.${table} SET ${column} = $2::vector WHERE record_id = $1`, [
            rows[i].record_id,
            toVectorLiteral(e),
          ]);
          ok++;
        } catch (err) {
          failed++;
          this.logger?.warn?.(`${TAG} reindex ${layer} skip ${rows[i].record_id}: ${errMsg(err)}`);
        }
        onProgress?.(i + 1, rows.length, layer);
      }
      return ok;
    };
    const l1 = (await this.getAllL1Texts()).map((r) => ({ record_id: r.record_id, text: r.content }));
    const l1Count = await run("L1", "l1_records", l1);
    const l0 = (await this.getAllL0Texts()).map((r) => ({ record_id: r.record_id, text: r.message_text }));
    const l0Count = await run("L0", "l0_conversations", l0);

    if (shadow) {
      if (failed > 0) {
        this.logger?.warn?.(`${TAG} shadow reindex incomplete (${failed} failures) — active vectors kept`);
        return { l1Count, l0Count };
      }
      await withTransaction(this.pool, async (c) => {
        await this.dropVectorColumns(c, "embedding");
        await c.query(`ALTER TABLE ${this.s}.l1_records RENAME COLUMN embedding_next TO embedding`);
        await c.query(`ALTER TABLE ${this.s}.l0_conversations RENAME COLUMN embedding_next TO embedding`);
        await this.createVectorColumns(c, this.dimensions);
        if (this.targetMeta) await this.writeMeta("embedding_provider_info", JSON.stringify(this.targetMeta), c);
      });
      this.activeDims = this.dimensions;
      this.vectorIoBlocked = false;
      this.targetMeta = null;
      this.logger?.info?.(`${TAG} shadow reindex committed (L1=${l1Count}, L0=${l0Count})`);
    }
    return { l1Count, l0Count };
  }

  // ════════════════════════════ L2/L3 profiles ════════════════════════════

  private profileConds(filter: ProfileFilter | undefined, p: Params): string[] {
    const conds: string[] = [];
    if (!filter) return conds;
    if (filter.type !== undefined) conds.push(`type = ${p.add(filter.type)}`);
    if (filter.teamId !== undefined) conds.push(`team_id = ${p.add(filter.teamId)}`);
    if (filter.userId !== undefined) conds.push(`user_id = ${p.add(filter.userId)}`);
    if (filter.agentId !== undefined) conds.push(`agent_id = ${p.add(filter.agentId)}`);
    if (filter.pathPrefix) conds.push(`starts_with(filename, ${p.add(filter.pathPrefix)})`);
    return conds;
  }

  async pullProfiles(): Promise<ProfileRecord[]> {
    return this.queryProfiles();
  }

  async queryProfilesByIds(ids: string[]): Promise<ProfileRecord[]> {
    if (ids.length === 0) return [];
    await this.requireUsable("queryProfilesByIds");
    const res = await this.pool.query(`SELECT * FROM ${this.s}.profiles WHERE id = ANY($1::text[])`, [ids]);
    return res.rows.map(toProfile);
  }

  async queryProfiles(filter?: ProfileFilter): Promise<ProfileRecord[]> {
    await this.requireUsable("queryProfiles");
    const p = new Params();
    const res = await this.pool.query(
      `SELECT * FROM ${this.s}.profiles ${whereOf(this.profileConds(filter, p))} ORDER BY filename, id`,
      p.values,
    );
    return res.rows.map(toProfile);
  }

  async countProfiles(filter?: ProfileFilter): Promise<number> {
    await this.requireUsable("countProfiles");
    const p = new Params();
    const res = await this.pool.query(
      `SELECT COUNT(*) AS n FROM ${this.s}.profiles ${whereOf(this.profileConds(filter, p))}`,
      p.values,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /**
   * Upsert profile rows. Unchanged content (same md5) is a no-op; with a
   * `baselineVersion` the write is an optimistic lock and a concurrent writer
   * makes it throw (as the mongo store does). Versions only move forward.
   */
  async syncProfiles(records: ProfileSyncRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.requireUsable("syncProfiles");
    await withTransaction(this.pool, async (c) => {
      for (const r of records) {
        const cur = await c.query(`SELECT version, content_md5 FROM ${this.s}.profiles WHERE id = $1 FOR UPDATE`, [
          r.id,
        ]);
        const row = cur.rows[0];
        const common = [
          r.type,
          r.filename,
          r.content,
          r.contentMd5,
          r.teamId ?? "",
          r.agentId ?? "",
          r.userId ?? "",
          r.sessionId ?? "",
        ];
        if (!row) {
          const ins = await c.query(
            `INSERT INTO ${this.s}.profiles (id, type, filename, content, content_md5, team_id, agent_id, user_id,
               session_id, version, created_at_ms, updated_at_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (id) DO NOTHING`,
            [r.id, ...common, r.version ?? 0, r.createdAtMs || Date.now(), r.updatedAtMs || Date.now()],
          );
          if ((ins.rowCount ?? 0) === 0) {
            throw new Error(`${TAG} profile optimistic-lock conflict id=${r.id}: row created concurrently`);
          }
          continue;
        }
        if (row.content_md5 === r.contentMd5) continue;
        if (r.baselineVersion !== undefined && r.baselineVersion !== Number(row.version)) {
          throw new Error(
            `${TAG} profile optimistic-lock conflict id=${r.id} baseline=${r.baselineVersion} current=${row.version}`,
          );
        }
        await c.query(
          `UPDATE ${this.s}.profiles SET type = $2, filename = $3, content = $4, content_md5 = $5, team_id = $6,
             agent_id = $7, user_id = $8, session_id = $9, version = GREATEST($10::int, version + 1),
             updated_at_ms = $11 WHERE id = $1`,
          [r.id, ...common, r.version ?? 0, r.updatedAtMs || Date.now()],
        );
      }
    });
  }

  async deleteProfiles(recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return;
    await this.requireUsable("deleteProfiles");
    await this.pool.query(`DELETE FROM ${this.s}.profiles WHERE id = ANY($1::text[])`, [recordIds]);
  }

  // ════════════════════════════ Clear ════════════════════════════

  async clearMemoryContent(filter: MemoryContentClearFilter): Promise<MemoryContentClearResult> {
    const teamId = (filter?.teamId ?? "").trim();
    const agentId = (filter?.agentId ?? "").trim();
    if (!teamId || !agentId) throw new Error("clearMemoryContent requires non-empty teamId and agentId");
    const userId = filter.userId?.trim() || undefined;
    await this.requireUsable("clearMemoryContent");
    const params = userId ? [teamId, agentId, userId] : [teamId, agentId];
    const where = `team_id = $1 AND agent_id = $2${userId ? " AND user_id = $3" : ""}`;
    return withTransaction(this.pool, async (c) => {
      const l0 = await c.query(`DELETE FROM ${this.s}.l0_conversations WHERE ${where}`, params);
      const l1 = await c.query(`DELETE FROM ${this.s}.l1_records WHERE ${where}`, params);
      const pr = await c.query(`DELETE FROM ${this.s}.profiles WHERE ${where}`, params);
      return { l0Deleted: l0.rowCount ?? 0, l1Deleted: l1.rowCount ?? 0, profilesDeleted: pr.rowCount ?? 0 };
    });
  }

  // ════════════════════════════ Entities (delegated) ════════════════════════════

  private async repo(op: string): Promise<PostgresEntityRepo> {
    await this.requireUsable(op);
    return this.entities;
  }

  async createTeam(input: Parameters<PostgresEntityRepo["createTeam"]>[0]): Promise<TeamEntity> {
    return (await this.repo("createTeam")).createTeam(input);
  }
  async getTeam(teamId: string): Promise<TeamEntity | null> {
    return (await this.repo("getTeam")).getTeam(teamId);
  }
  async updateTeam(teamId: string, patch: Parameters<PostgresEntityRepo["updateTeam"]>[1]): Promise<TeamEntity | null> {
    return (await this.repo("updateTeam")).updateTeam(teamId, patch);
  }
  async deleteTeams(ids: string[]): Promise<BatchDeleteResult> {
    return (await this.repo("deleteTeams")).deleteTeams(ids);
  }

  async createUser(input: Parameters<PostgresEntityRepo["createUser"]>[0]): Promise<UserEntity> {
    return (await this.repo("createUser")).createUser(input);
  }
  async getUser(userId: string): Promise<UserEntity | null> {
    return (await this.repo("getUser")).getUser(userId);
  }
  async updateUser(userId: string, patch: Parameters<PostgresEntityRepo["updateUser"]>[1]): Promise<UserEntity | null> {
    return (await this.repo("updateUser")).updateUser(userId, patch);
  }
  async deleteUsers(ids: string[]): Promise<BatchDeleteResult> {
    return (await this.repo("deleteUsers")).deleteUsers(ids);
  }

  async createAgent(input: Parameters<PostgresEntityRepo["createAgent"]>[0]): Promise<AgentEntity> {
    return (await this.repo("createAgent")).createAgent(input);
  }
  async getAgent(agentId: string): Promise<AgentEntity | null> {
    return (await this.repo("getAgent")).getAgent(agentId);
  }
  async updateAgent(
    agentId: string,
    patch: Parameters<PostgresEntityRepo["updateAgent"]>[1],
  ): Promise<AgentEntity | null> {
    return (await this.repo("updateAgent")).updateAgent(agentId, patch);
  }
  async deleteAgents(ids: string[]): Promise<BatchDeleteResult> {
    return (await this.repo("deleteAgents")).deleteAgents(ids);
  }

  async createTask(input: Parameters<PostgresEntityRepo["createTask"]>[0]): Promise<TaskEntity> {
    return (await this.repo("createTask")).createTask(input);
  }
  async getTask(taskId: string): Promise<TaskEntity | null> {
    return (await this.repo("getTask")).getTask(taskId);
  }
  async updateTask(taskId: string, patch: Parameters<PostgresEntityRepo["updateTask"]>[1]): Promise<TaskEntity | null> {
    return (await this.repo("updateTask")).updateTask(taskId, patch);
  }
  async deleteTasks(ids: string[]): Promise<BatchDeleteResult> {
    return (await this.repo("deleteTasks")).deleteTasks(ids);
  }

  async createKnowledge(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): Promise<KnowledgeEntity> {
    return (await this.repo("createKnowledge")).createKnowledge(input);
  }
  async getKnowledge(id: string): Promise<KnowledgeEntity | null> {
    return (await this.repo("getKnowledge")).getKnowledge(id);
  }
  async updateKnowledge(
    id: string,
    patch: Parameters<PostgresEntityRepo["updateKnowledge"]>[1],
  ): Promise<KnowledgeEntity | null> {
    return (await this.repo("updateKnowledge")).updateKnowledge(id, patch);
  }
  async deleteKnowledge(ids: string[], teamId?: string): Promise<BatchDeleteResult> {
    return (await this.repo("deleteKnowledge")).deleteKnowledge(ids, teamId);
  }
  async listKnowledge(input: {
    team_id: string;
    type?: KnowledgeType;
    knowledge_ids?: string[];
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeListResult> {
    return (await this.repo("listKnowledge")).listKnowledge(input);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    return (await this.repo("appendAudit")).appendAudit(entry);
  }
  async queryAudit(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    return (await this.repo("queryAudit")).queryAudit(filter);
  }

  async upsertMemoryGenerationRefs(records: MemoryGenerationRefRecord[]): Promise<void> {
    return (await this.repo("upsertMemoryGenerationRefs")).upsertMemoryGenerationRefs(records);
  }
  async getMemoryGenerationRef(
    layer: MemoryGenerationLayer,
    memoryId: string,
  ): Promise<MemoryGenerationRefRecord | null> {
    return (await this.repo("getMemoryGenerationRef")).getMemoryGenerationRef(layer, memoryId);
  }

  async countMemoryPrompts(): Promise<number> {
    return (await this.repo("countMemoryPrompts")).countMemoryPrompts();
  }
  async createMemoryPrompt(record: MemoryPromptRecord): Promise<MemoryPromptRecord> {
    return (await this.repo("createMemoryPrompt")).createMemoryPrompt(record);
  }
  async getMemoryPrompts(ids: string[]): Promise<MemoryPromptRecord[]> {
    return (await this.repo("getMemoryPrompts")).getMemoryPrompts(ids);
  }
  async listMemoryPrompts(filter: MemoryPromptListFilter): Promise<MemoryPromptRecord[]> {
    return (await this.repo("listMemoryPrompts")).listMemoryPrompts(filter);
  }
  async updateMemoryPrompt(
    id: string,
    patch: { name?: string; prompt?: string; updated_by?: string; updated_at_ms: number },
  ): Promise<MemoryPromptRecord | null> {
    return (await this.repo("updateMemoryPrompt")).updateMemoryPrompt(id, patch);
  }
  async deleteMemoryPrompts(ids: string[], operatorId?: string): Promise<MemoryPromptDeleteResult> {
    return (await this.repo("deleteMemoryPrompts")).deleteMemoryPrompts(ids, operatorId);
  }
  async getMemoryPromptSettings(ids: string[]): Promise<MemoryPromptSettingRecord[]> {
    return (await this.repo("getMemoryPromptSettings")).getMemoryPromptSettings(ids);
  }
  async listMemoryPromptSettings(filter: MemoryPromptSettingListFilter): Promise<MemoryPromptSettingRecord[]> {
    return (await this.repo("listMemoryPromptSettings")).listMemoryPromptSettings(filter);
  }
  async upsertMemoryPromptSettings(
    records: MemoryPromptSettingRecord[],
    logs: MemoryPromptSettingLogRecord[],
  ): Promise<void> {
    return (await this.repo("upsertMemoryPromptSettings")).upsertMemoryPromptSettings(records, logs);
  }
  async clearMemoryPromptSettings(ids: string[], logs: MemoryPromptSettingLogRecord[]): Promise<void> {
    return (await this.repo("clearMemoryPromptSettings")).clearMemoryPromptSettings(ids, logs);
  }
  async queryMemoryPromptSettingLogs(filter: MemoryPromptSettingLogFilter): Promise<MemoryPromptSettingLogRecord[]> {
    return (await this.repo("queryMemoryPromptSettingLogs")).queryMemoryPromptSettingLogs(filter);
  }
}
