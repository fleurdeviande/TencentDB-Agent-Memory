/**
 * PostgresSkillStore — ISkillStore on PostgreSQL, semantics of sqlite/skill-store.ts.
 *
 * One table of immutable version rows per instance schema (next to the memory
 * tables). appendVersion demotes the old head and inserts the new row in one
 * transaction with the head row locked; unique constraints turn races into
 * SKILL_NAME_DUPLICATE / SKILL_VERSION_STALE instead of silent duplicates.
 * Search is keyword-only: a generated tsvector over jieba-tokenised
 * name/description/content, ranked with ts_rank_cd.
 */

import type { Pool } from "pg";
import { randomBase62 } from "../../../utils/short-id.js";
import { buildFtsQuery, tokenizeForFts } from "../tokenize.js";
import type { StoreLogger } from "../types.js";
import type {
  ISkillStore,
  ExpiredVersionMeta,
  SkillStoreCapabilities,
  SkillSearchResult,
} from "../../skill/skill-store.interface.js";
import { SkillStoreError } from "../../skill/skill-store.interface.js";
import { FTS_CONTENT_MAX } from "../../skill/skill-store-ddl.js";
import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  Skill,
  SkillManifestEntry,
  SkillStatus,
} from "../../skill/types.js";
import { Params, ftsQueryToTokens, getSharedPostgresPool, qi, tsRankToScore, withTransaction } from "./client.js";
import { assertSchemaName } from "./config.js";
import { type Migration, runMigrations } from "./migrations.js";

const TAG = "[postgres-skill-store]";

const UNIQ_NAME_HEAD = "uniq_skills_team_agent_name_head";
const UNIQ_SKILL_VERSION = "uniq_skills_skill_version";

export const SKILL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "skills table",
    sql: (s) => `
      CREATE TABLE IF NOT EXISTS ${s}.skills (
        row_id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        is_head BOOLEAN NOT NULL DEFAULT true,
        user_id TEXT NOT NULL,
        owner_agent_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        task_id TEXT NOT NULL DEFAULT '',
        name TEXT COLLATE "C" NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        manifest_json TEXT NOT NULL DEFAULT '[]',
        storage_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        search_tokens TEXT NOT NULL DEFAULT '',
        fts TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, search_tokens)) STORED,
        CONSTRAINT ${UNIQ_SKILL_VERSION} UNIQUE (skill_id, version)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQ_NAME_HEAD}
        ON ${s}.skills (team_id, owner_agent_id, name) WHERE is_head AND status = 'active';
      CREATE INDEX IF NOT EXISTS idx_skills_team_head ON ${s}.skills (team_id, is_head, status);
      CREATE INDEX IF NOT EXISTS idx_skills_owner_head ON ${s}.skills (owner_agent_id, is_head, status);
      CREATE INDEX IF NOT EXISTS idx_skills_user ON ${s}.skills (user_id, is_head);
      CREATE INDEX IF NOT EXISTS idx_skills_skill_version ON ${s}.skills (skill_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_skills_task_audit ON ${s}.skills (task_id, created_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_skills_fts ON ${s}.skills USING GIN (fts) WHERE is_head AND status = 'active';
    `,
  },
];

export interface PostgresSkillStoreOptions {
  url?: string;
  pool?: Pool;
  schema: string;
  logger?: StoreLogger;
  now?: () => number;
  ulid?: () => string;
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toSkill(r: Row): Skill {
  let manifest: SkillManifestEntry[];
  try {
    manifest = JSON.parse(r.manifest_json);
    if (!Array.isArray(manifest)) manifest = [];
  } catch {
    manifest = [];
  }
  return {
    row_id: r.row_id,
    skill_id: r.skill_id,
    version: Number(r.version),
    is_head: r.is_head === true,
    user_id: r.user_id,
    owner_agent_id: r.owner_agent_id,
    team_id: r.team_id,
    task_id: r.task_id,
    name: r.name,
    description: r.description,
    content: r.content,
    content_hash: r.content_hash,
    manifest,
    storage_dir: r.storage_dir,
    status: r.status as SkillStatus,
    metadata_json: r.metadata_json,
    created_at_ms: Number(r.created_at_ms),
    updated_at_ms: Number(r.updated_at_ms),
  };
}

function searchTokens(input: AppendVersionInput): string {
  const content = input.content.length > FTS_CONTENT_MAX ? input.content.slice(0, FTS_CONTENT_MAX) : input.content;
  return [input.name, input.description, content].map((t) => tokenizeForFts(t ?? "")).join(" ");
}

export class PostgresSkillStore implements ISkillStore {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly s: string;
  private readonly logger?: StoreLogger;
  private readonly now: () => number;
  private readonly ulid: () => string;

  private initPromise: Promise<void> | null = null;
  private degraded = false;
  private closed = false;

  constructor(opts: PostgresSkillStoreOptions) {
    this.schema = assertSchemaName(opts.schema);
    this.s = qi(this.schema);
    this.pool = opts.pool ?? getSharedPostgresPool(opts.url ?? "");
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.ulid = opts.ulid ?? (() => randomBase62(12));
  }

  getSchema(): string {
    return this.schema;
  }

  // ── Lifecycle ──

  /** ISkillStore.init is sync: start migrations here, every call awaits them. */
  init(): void {
    if (this.initPromise) return;
    this.initPromise = runMigrations(this.pool, this.schema, "skill", SKILL_MIGRATIONS).then(
      () => {
        this.degraded = false;
      },
      (err) => {
        this.degraded = true;
        this.logger?.error?.(
          `${TAG} init failed for schema=${this.schema}: ${err instanceof Error ? err.message : String(err)}`,
        );
      },
    );
  }

  /** Resolves once init finished (for callers that need a definite state). */
  async ready(): Promise<boolean> {
    this.init();
    await this.initPromise;
    return !this.degraded && !this.closed;
  }

  private async use(): Promise<void> {
    if (!(await this.ready())) {
      throw new Error(`${TAG} store is ${this.closed ? "closed" : "degraded"} (schema=${this.schema})`);
    }
  }

  isDegraded(): boolean {
    return this.degraded || this.closed;
  }

  getCapabilities(): SkillStoreCapabilities {
    return { vectorSearch: false, ftsSearch: !this.isDegraded(), nativeHybridSearch: false, sparseVectors: false };
  }

  /** The pool is shared; closing retires this handle only. */
  close(): void {
    this.closed = true;
  }

  // ── CRUD ──

  async appendVersion(input: AppendVersionInput): Promise<Skill> {
    await this.use();
    const tid = input.team_id ?? "default";
    try {
      return await withTransaction(this.pool, async (c) => {
        const headRes = await c.query(
          `SELECT * FROM ${this.s}.skills
           WHERE skill_id = $1 AND team_id = $2 AND is_head AND status = 'active' LIMIT 1 FOR UPDATE`,
          [input.skill_id, tid],
        );
        const head = headRes.rows[0] ? toSkill(headRes.rows[0]) : null;
        if (!head) {
          const dup = await c.query(
            `SELECT skill_id FROM ${this.s}.skills
             WHERE team_id = $1 AND owner_agent_id = $2 AND name = $3 AND is_head AND status = 'active' LIMIT 1`,
            [tid, input.owner_agent_id ?? "default", input.name],
          );
          if (dup.rows[0]?.skill_id === input.skill_id) {
            // The head we waited on was replaced by a concurrent append (READ COMMITTED re-check).
            throw new SkillStoreError("SKILL_VERSION_STALE", `concurrent appendVersion on ${input.skill_id}`);
          }
          if ((dup.rowCount ?? 0) > 0) {
            throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${input.name}' already exists for agent in team`);
          }
        } else if (head.name !== input.name) {
          throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
        } else {
          await c.query(`UPDATE ${this.s}.skills SET is_head = false WHERE row_id = $1`, [head.row_id]);
        }
        const ts = this.now();
        const res = await c.query(
          `INSERT INTO ${this.s}.skills (row_id, skill_id, version, is_head, user_id, owner_agent_id, team_id, task_id,
             name, description, content, content_hash, manifest_json, storage_dir, status, metadata_json,
             created_at_ms, updated_at_ms, search_tokens)
           VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active', $14, $15, $15, $16)
           RETURNING *`,
          [
            this.ulid(),
            input.skill_id,
            head ? head.version + 1 : 1,
            input.user_id ?? "default",
            head ? head.owner_agent_id : (input.owner_agent_id ?? "default"),
            tid,
            input.task_id ?? "default",
            input.name,
            input.description,
            input.content,
            input.content_hash,
            JSON.stringify(input.manifest ?? []),
            input.storage_dir,
            input.metadata_json ?? "{}",
            ts,
            searchTokens(input),
          ],
        );
        return toSkill(res.rows[0]);
      });
    } catch (err) {
      const constraint =
        (err as { code?: string; constraint?: string }).code === "23505"
          ? (err as { constraint?: string }).constraint
          : undefined;
      if (constraint === UNIQ_NAME_HEAD) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${input.name}' already exists for agent in team`);
      }
      if (constraint === UNIQ_SKILL_VERSION) {
        throw new SkillStoreError("SKILL_VERSION_STALE", `concurrent appendVersion on ${input.skill_id}`);
      }
      throw err;
    }
  }

  private async oneSkill(sql: string, params: unknown[]): Promise<Skill | null> {
    await this.use();
    const res = await this.pool.query(sql, params);
    return res.rows[0] ? toSkill(res.rows[0]) : null;
  }

  /** "AND team_id = $n" when a team is given (sqlite: optional team scoping). */
  private teamCond(p: Params, teamId?: string): string {
    return teamId ? ` AND team_id = ${p.add(teamId)}` : "";
  }

  async getHead(skillId: string, teamId?: string): Promise<Skill | null> {
    const p = new Params();
    const sid = p.add(skillId);
    return this.oneSkill(
      `SELECT * FROM ${this.s}.skills WHERE skill_id = ${sid}${this.teamCond(p, teamId)}
       AND is_head AND status = 'active' LIMIT 1`,
      p.values,
    );
  }

  async getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null> {
    const p = new Params();
    const sid = p.add(skillId);
    return this.oneSkill(
      `SELECT * FROM ${this.s}.skills WHERE skill_id = ${sid}${this.teamCond(p, teamId)} AND is_head LIMIT 1`,
      p.values,
    );
  }

  async getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null> {
    const p = new Params();
    const sid = p.add(skillId);
    const ver = p.add(version);
    return this.oneSkill(
      `SELECT * FROM ${this.s}.skills WHERE skill_id = ${sid} AND version = ${ver}${this.teamCond(p, teamId)} LIMIT 1`,
      p.values,
    );
  }

  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    await this.use();
    const p = new Params();
    const ts = p.add(this.now());
    const sid = p.add(skillId);
    // Matches an already-archived head too, so a repeated archive stays { archived: true }.
    const res = await this.pool.query(
      `UPDATE ${this.s}.skills SET status = 'archived', updated_at_ms = ${ts}
       WHERE skill_id = ${sid}${this.teamCond(p, teamId)} AND is_head`,
      p.values,
    );
    return { archived: (res.rowCount ?? 0) > 0 };
  }

  // ── Queries ──

  async listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }> {
    await this.use();
    const status = opts.status?.length ? opts.status : (["active"] as SkillStatus[]);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const p = new Params();
    const conds = ["is_head"];
    if (opts.team_id) conds.push(`team_id = ${p.add(opts.team_id)}`);
    if (opts.owner_agent_id) conds.push(`owner_agent_id = ${p.add(opts.owner_agent_id)}`);
    if (opts.user_id) conds.push(`user_id = ${p.add(opts.user_id)}`);
    if (opts.task_id) conds.push(`task_id = ${p.add(opts.task_id)}`);
    conds.push(`status = ANY(${p.add(status)}::text[])`);
    // sqlite LIKE 'x%' is ASCII case-insensitive; a literal prefix keeps % and _ from acting as wildcards.
    if (opts.name_prefix) conds.push(`starts_with(lower(name), lower(${p.add(opts.name_prefix)}))`);
    const where = conds.join(" AND ");
    const total = await this.pool.query(`SELECT COUNT(*) AS n FROM ${this.s}.skills WHERE ${where}`, p.values);
    const rows = await this.pool.query(
      `SELECT * FROM ${this.s}.skills WHERE ${where}
       ORDER BY updated_at_ms DESC, row_id DESC LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
      p.values,
    );
    return { items: rows.rows.map(toSkill), total: Number(total.rows[0]?.n ?? 0) };
  }

  /** BM25-style keyword search over active heads; embedding/hybrid modes degrade to keyword, as in sqlite. */
  async searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
    const query = (opts.query ?? "").trim();
    if (!query) return [];
    const fts = buildFtsQuery(query);
    const tokens = fts ? ftsQueryToTokens(fts) : [];
    if (tokens.length === 0) return [];
    if (opts.mode === "embedding" || opts.mode === "hybrid") {
      this.logger?.warn?.(`${TAG} search mode='${opts.mode}' downgraded to 'bm25' (no skill vectors in postgres)`);
    }
    await this.use();
    const p = new Params();
    const tok = p.add(tokens);
    const conds = ["s.is_head", "s.status = 'active'", "s.fts @@ q.q"];
    if (opts.team_id) conds.push(`s.team_id = ${p.add(opts.team_id)}`);
    if (opts.agent_id) conds.push(`s.owner_agent_id = ${p.add(opts.agent_id)}`);
    if (opts.task_id) conds.push(`s.task_id = ${p.add(opts.task_id)}`);
    if (opts.user_id) conds.push(`s.user_id = ${p.add(opts.user_id)}`);
    const res = await this.pool.query(
      `WITH q AS (
         SELECT string_agg('(' || x::text || ')', ' | ')::tsquery AS q
         FROM (SELECT phraseto_tsquery('simple', t) AS x FROM unnest(${tok}::text[]) AS t) z
         WHERE numnode(x) > 0
       )
       SELECT s.*, ts_rank_cd('{1,1,1,1}', s.fts, q.q) AS rank,
              ts_headline('simple', left(s.content, ${FTS_CONTENT_MAX}), q.q,
                'StartSel=<mark>, StopSel=</mark>, MaxWords=16, MinWords=4, ShortWord=0') AS snippet
       FROM ${this.s}.skills s, q
       WHERE ${conds.join(" AND ")}
       ORDER BY rank DESC, s.skill_id LIMIT ${p.add(topK)}`,
      p.values,
    );
    return res.rows.map((r) => ({ skill: toSkill(r), score: tsRankToScore(Number(r.rank)), snippet: r.snippet ?? "" }));
  }

  async listVersions(
    skillId: string,
    teamId?: string,
    pagination: { limit?: number; offset?: number } = {},
  ): Promise<Skill[]> {
    await this.use();
    const limit = Math.min(Math.max(pagination.limit ?? 50, 1), 1000);
    const offset = Math.max(pagination.offset ?? 0, 0);
    const p = new Params();
    const sid = p.add(skillId);
    const res = await this.pool.query(
      `SELECT * FROM ${this.s}.skills WHERE skill_id = ${sid}${this.teamCond(p, teamId)}
       ORDER BY version DESC LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
      p.values,
    );
    return res.rows.map(toSkill);
  }

  async countVersions(skillId: string, teamId?: string): Promise<number> {
    await this.use();
    const p = new Params();
    const sid = p.add(skillId);
    const res = await this.pool.query(
      `SELECT COUNT(*) AS n FROM ${this.s}.skills WHERE skill_id = ${sid}${this.teamCond(p, teamId)}`,
      p.values,
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  // ── TTL cleanup ──

  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    await this.use();
    const res = await this.pool.query(
      `SELECT skill_id, version, is_head, status, storage_dir, created_at_ms FROM ${this.s}.skills
       WHERE NOT is_head AND status = 'active' AND created_at_ms < $1 ORDER BY skill_id ASC, version ASC`,
      [cutoffMs],
    );
    return res.rows.map((r) => ({
      skill_id: r.skill_id,
      version: Number(r.version),
      is_head: r.is_head === true,
      status: r.status as SkillStatus,
      storage_dir: r.storage_dir,
      created_at_ms: Number(r.created_at_ms),
    }));
  }

  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    await this.use();
    const res = await this.pool.query(
      `DELETE FROM ${this.s}.skills WHERE skill_id = $1 AND version = $2 AND NOT is_head`,
      [skillId, version],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    await this.use();
    const p = new Params();
    const sid = p.add(skillId);
    const res = await this.pool.query(
      `DELETE FROM ${this.s}.skills WHERE skill_id = ${sid}${this.teamCond(p, teamId)}`,
      p.values,
    );
    return res.rowCount ?? 0;
  }
}
