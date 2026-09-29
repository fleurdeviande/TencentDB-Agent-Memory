/**
 * Postgres implementation of the non-memory entity surface of IMemoryStore:
 * teams / users / agents / tasks, knowledge refs, audit, custom memory
 * prompts and generation provenance refs. Semantics follow sqlite/memory-store.ts.
 *
 * Unlike the L0/L1 paths these methods throw on database errors (as sqlite does).
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  AgentEntity,
  AuditEntry,
  AuditQueryFilter,
  BatchDeleteResult,
  KnowledgeEntity,
  KnowledgeListResult,
  KnowledgeType,
  TaskEntity,
  TeamEntity,
  UserEntity,
} from "../types.js";
import type {
  MemoryPromptDeleteResult,
  MemoryPromptListFilter,
  MemoryPromptRecord,
  MemoryPromptSettingListFilter,
  MemoryPromptSettingLogFilter,
  MemoryPromptSettingLogRecord,
  MemoryPromptSettingRecord,
  MemoryPromptTargetType,
} from "../../memory-prompt/types.js";
import {
  buildMemoryGenerationRefId,
  type MemoryGenerationLayer,
  type MemoryGenerationRefRecord,
} from "../../memory-generation-log/types.js";
import { Params, withTransaction } from "./client.js";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

type CreateTeamInput = Omit<
  TeamEntity,
  "created_at" | "updated_at" | "status" | "user_ids" | "agent_ids" | "task_ids"
> & { team_id?: string; status?: TeamEntity["status"] };
type TeamPatch = Partial<
  Pick<TeamEntity, "name" | "description" | "owner_user_id" | "user_ids" | "agent_ids" | "status">
>;
type CreateUserInput = Pick<UserEntity, "name"> &
  Partial<Pick<UserEntity, "job_description" | "status">> & { user_id?: string };
type UserPatch = Partial<Pick<UserEntity, "name" | "job_description" | "status">>;
type CreateAgentInput = Omit<AgentEntity, "created_at" | "updated_at" | "status" | "visibility"> & {
  agent_id?: string;
  status?: AgentEntity["status"];
  visibility?: AgentEntity["visibility"];
};
type AgentPatch = Partial<
  Pick<AgentEntity, "name" | "description" | "prompt" | "owner_user_id" | "visibility" | "status">
>;
type CreateTaskInput = Omit<TaskEntity, "created_at" | "updated_at" | "source_type" | "agent_ids" | "user_ids"> & {
  task_id?: string;
  source_type?: TaskEntity["source_type"];
  agent_ids?: string[];
  user_ids?: string[];
};
type TaskPatch = Partial<
  Pick<TaskEntity, "title" | "description" | "source_type" | "source_url" | "agent_ids" | "user_ids">
>;
type KnowledgePatch = Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>;

function entityId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function cleanIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

const sortedUnique = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

export class PostgresEntityRepo {
  constructor(
    private readonly pool: Pool,
    private readonly s: string,
  ) {}

  private async one(sql: string, params: unknown[]): Promise<Row | null> {
    const res = await this.pool.query(sql, params);
    return res.rows[0] ?? null;
  }

  private async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.pool.query(sql, params)).rows;
  }

  // ── Teams ──

  private async teamFromRow(row: Row): Promise<TeamEntity> {
    const teamId = String(row.team_id);
    const owner = String(row.owner_user_id ?? "");
    const agents = await this.all(
      `SELECT agent_id FROM ${this.s}.entity_agents WHERE team_id = $1 AND status = 'active'`,
      [teamId],
    );
    const tasks = await this.all(`SELECT task_id FROM ${this.s}.entity_tasks WHERE team_id = $1 ORDER BY task_id`, [
      teamId,
    ]);
    return {
      team_id: teamId,
      name: String(row.name ?? ""),
      description: String(row.description ?? "") || undefined,
      owner_user_id: owner,
      status: row.status || "active",
      user_ids: sortedUnique([...cleanIds(row.user_ids), ...(owner ? [owner] : [])]),
      agent_ids: sortedUnique([...cleanIds(row.agent_ids), ...agents.map((a) => String(a.agent_id))]),
      task_ids: tasks.map((t) => String(t.task_id)),
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  async createTeam(input: CreateTeamInput): Promise<TeamEntity> {
    const now = new Date().toISOString();
    const id = input.team_id || entityId("team");
    await this.pool.query(
      `INSERT INTO ${this.s}.entity_teams (team_id, name, description, owner_user_id, user_ids, agent_ids, status,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, '{}', $6, $7, $7)`,
      [
        id,
        input.name,
        input.description ?? "",
        input.owner_user_id,
        cleanIds([input.owner_user_id]),
        input.status ?? "active",
        now,
      ],
    );
    return (await this.getTeam(id))!;
  }

  async getTeam(teamId: string): Promise<TeamEntity | null> {
    const row = await this.one(`SELECT * FROM ${this.s}.entity_teams WHERE team_id = $1`, [teamId]);
    return row ? this.teamFromRow(row) : null;
  }

  async updateTeam(teamId: string, patch: TeamPatch): Promise<TeamEntity | null> {
    const row = await this.one(`SELECT * FROM ${this.s}.entity_teams WHERE team_id = $1`, [teamId]);
    if (!row) return null;
    const owner = patch.owner_user_id ?? String(row.owner_user_id ?? "");
    const userIds = patch.user_ids !== undefined ? cleanIds(patch.user_ids) : cleanIds(row.user_ids);
    if (owner && !userIds.includes(owner)) userIds.push(owner);
    const agentIds = patch.agent_ids !== undefined ? cleanIds(patch.agent_ids) : cleanIds(row.agent_ids);
    await this.pool.query(
      `UPDATE ${this.s}.entity_teams SET name = $1, description = $2, owner_user_id = $3, user_ids = $4,
         agent_ids = $5, status = $6, updated_at = $7 WHERE team_id = $8`,
      [
        patch.name ?? row.name,
        patch.description ?? row.description ?? "",
        owner,
        sortedUnique(userIds),
        agentIds,
        patch.status ?? row.status,
        new Date().toISOString(),
        teamId,
      ],
    );
    return this.getTeam(teamId);
  }

  async deleteTeams(teamIds: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of teamIds) {
      if (!(await this.updateTeam(id, { status: "archived" }))) result.failed.push({ id, reason: "not_found" });
      else result.deleted_ids.push(id);
    }
    return result;
  }

  // ── Users ──

  private async userFromRow(row: Row): Promise<UserEntity> {
    const userId = String(row.user_id);
    const teams = await this.all(
      `SELECT team_id FROM ${this.s}.entity_teams
       WHERE status = 'active' AND (owner_user_id = $1 OR $1 = ANY(user_ids)) ORDER BY team_id`,
      [userId],
    );
    const tasks = await this.all(
      `SELECT task_id, agent_ids FROM ${this.s}.entity_tasks
       WHERE creator_user_id = $1 OR $1 = ANY(user_ids) ORDER BY task_id`,
      [userId],
    );
    const owned = await this.all(
      `SELECT agent_id FROM ${this.s}.entity_agents WHERE owner_user_id = $1 AND status = 'active' ORDER BY agent_id`,
      [userId],
    );
    return {
      user_id: userId,
      name: String(row.name ?? ""),
      job_description: String(row.job_description ?? "") || undefined,
      team_ids: teams.map((t) => String(t.team_id)),
      task_ids: tasks.map((t) => String(t.task_id)),
      task_agent_ids: sortedUnique(tasks.flatMap((t) => cleanIds(t.agent_ids))),
      owned_agent_ids: owned.map((a) => String(a.agent_id)),
      status: row.status || "active",
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  async createUser(input: CreateUserInput): Promise<UserEntity> {
    const now = new Date().toISOString();
    const id = input.user_id || entityId("user");
    await this.pool.query(
      `INSERT INTO ${this.s}.entity_users (user_id, name, job_description, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, input.name, input.job_description ?? "", input.status ?? "active", now],
    );
    return (await this.getUser(id))!;
  }

  async getUser(userId: string): Promise<UserEntity | null> {
    const row = await this.one(`SELECT * FROM ${this.s}.entity_users WHERE user_id = $1`, [userId]);
    return row ? this.userFromRow(row) : null;
  }

  async updateUser(userId: string, patch: UserPatch): Promise<UserEntity | null> {
    const res = await this.pool.query(
      `UPDATE ${this.s}.entity_users SET name = COALESCE($1, name), job_description = COALESCE($2, job_description),
         status = COALESCE($3, status), updated_at = $4 WHERE user_id = $5`,
      [patch.name ?? null, patch.job_description ?? null, patch.status ?? null, new Date().toISOString(), userId],
    );
    return (res.rowCount ?? 0) > 0 ? this.getUser(userId) : null;
  }

  async deleteUsers(userIds: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of userIds) {
      if (!(await this.updateUser(id, { status: "inactive" }))) result.failed.push({ id, reason: "not_found" });
      else result.deleted_ids.push(id);
    }
    return result;
  }

  // ── Agents ──

  private async agentFromRow(row: Row): Promise<AgentEntity> {
    const agentId = String(row.agent_id);
    const tasks = await this.all(
      `SELECT task_id FROM ${this.s}.entity_tasks WHERE $1 = ANY(agent_ids) ORDER BY task_id`,
      [agentId],
    );
    return {
      agent_id: agentId,
      team_id: String(row.team_id ?? ""),
      name: String(row.name ?? ""),
      description: String(row.description ?? "") || undefined,
      prompt: String(row.prompt ?? "") || undefined,
      owner_user_id: String(row.owner_user_id ?? "") || undefined,
      visibility: row.visibility || "team",
      status: row.status || "active",
      task_ids: tasks.map((t) => String(t.task_id)),
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  async createAgent(input: CreateAgentInput): Promise<AgentEntity> {
    const now = new Date().toISOString();
    const id = input.agent_id || entityId("agent");
    await withTransaction(this.pool, async (c) => {
      await c.query(
        `INSERT INTO ${this.s}.entity_agents (agent_id, team_id, name, description, prompt, owner_user_id,
           visibility, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          id,
          input.team_id,
          input.name,
          input.description ?? "",
          input.prompt ?? "",
          input.owner_user_id ?? "",
          input.visibility ?? "team",
          input.status ?? "active",
          now,
        ],
      );
      await c.query(
        `UPDATE ${this.s}.entity_teams SET agent_ids = array_append(agent_ids, $1), updated_at = $2
         WHERE team_id = $3 AND NOT ($1 = ANY(agent_ids))`,
        [id, now, input.team_id],
      );
    });
    return (await this.getAgent(id))!;
  }

  async getAgent(agentId: string): Promise<AgentEntity | null> {
    const row = await this.one(`SELECT * FROM ${this.s}.entity_agents WHERE agent_id = $1`, [agentId]);
    return row ? this.agentFromRow(row) : null;
  }

  async updateAgent(agentId: string, patch: AgentPatch): Promise<AgentEntity | null> {
    const res = await this.pool.query(
      `UPDATE ${this.s}.entity_agents SET name = COALESCE($1, name), description = COALESCE($2, description),
         prompt = COALESCE($3, prompt), owner_user_id = COALESCE($4, owner_user_id),
         visibility = COALESCE($5, visibility), status = COALESCE($6, status), updated_at = $7
       WHERE agent_id = $8`,
      [
        patch.name ?? null,
        patch.description ?? null,
        patch.prompt ?? null,
        patch.owner_user_id ?? null,
        patch.visibility ?? null,
        patch.status ?? null,
        new Date().toISOString(),
        agentId,
      ],
    );
    return (res.rowCount ?? 0) > 0 ? this.getAgent(agentId) : null;
  }

  async deleteAgents(agentIds: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of agentIds) {
      if (!(await this.updateAgent(id, { status: "inactive" }))) result.failed.push({ id, reason: "not_found" });
      else result.deleted_ids.push(id);
    }
    return result;
  }

  // ── Tasks ──

  private taskFromRow(row: Row): TaskEntity {
    return {
      task_id: String(row.task_id ?? ""),
      team_id: String(row.team_id ?? ""),
      creator_user_id: String(row.creator_user_id ?? ""),
      title: String(row.title ?? "") || undefined,
      description: String(row.description ?? "") || undefined,
      source_type: row.source_type || "manual",
      source_url: String(row.source_url ?? "") || undefined,
      agent_ids: cleanIds(row.agent_ids),
      user_ids: cleanIds(row.user_ids),
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  async createTask(input: CreateTaskInput): Promise<TaskEntity> {
    const now = new Date().toISOString();
    const id = input.task_id || entityId("task");
    await this.pool.query(
      `INSERT INTO ${this.s}.entity_tasks (task_id, team_id, creator_user_id, title, description, source_type,
         source_url,
         agent_ids, user_ids, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        id,
        input.team_id,
        input.creator_user_id,
        input.title ?? "",
        input.description ?? "",
        input.source_type ?? "manual",
        input.source_url ?? "",
        cleanIds(input.agent_ids),
        cleanIds(input.user_ids),
        now,
      ],
    );
    return (await this.getTask(id))!;
  }

  async getTask(taskId: string): Promise<TaskEntity | null> {
    const row = await this.one(`SELECT * FROM ${this.s}.entity_tasks WHERE task_id = $1`, [taskId]);
    return row ? this.taskFromRow(row) : null;
  }

  async updateTask(taskId: string, patch: TaskPatch): Promise<TaskEntity | null> {
    const res = await this.pool.query(
      `UPDATE ${this.s}.entity_tasks SET title = COALESCE($1, title), description = COALESCE($2, description),
         source_type = COALESCE($3, source_type), source_url = COALESCE($4, source_url),
         agent_ids = COALESCE($5, agent_ids), user_ids = COALESCE($6, user_ids), updated_at = $7
       WHERE task_id = $8`,
      [
        patch.title ?? null,
        patch.description ?? null,
        patch.source_type ?? null,
        patch.source_url ?? null,
        patch.agent_ids !== undefined ? cleanIds(patch.agent_ids) : null,
        patch.user_ids !== undefined ? cleanIds(patch.user_ids) : null,
        new Date().toISOString(),
        taskId,
      ],
    );
    return (res.rowCount ?? 0) > 0 ? this.getTask(taskId) : null;
  }

  async deleteTasks(taskIds: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of taskIds) {
      const res = await this.pool.query(`DELETE FROM ${this.s}.entity_tasks WHERE task_id = $1`, [id]);
      if ((res.rowCount ?? 0) > 0) result.deleted_ids.push(id);
      else result.failed.push({ id, reason: "not_found" });
    }
    return result;
  }

  // ── Knowledge ──

  private knowledgeFromRow(row: Row): KnowledgeEntity {
    return {
      knowledge_id: String(row.knowledge_id ?? ""),
      type: (row.type as KnowledgeType) ?? "wiki",
      service_url: String(row.service_url ?? ""),
      name: String(row.name ?? ""),
      summary: row.summary ?? null,
      team_id: String(row.team_id ?? ""),
      agent_id: String(row.agent_id ?? ""),
      user_id: row.user_id ?? null,
      repo_url: row.repo_url ?? undefined,
      branch: row.branch ?? undefined,
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  /** Upsert by knowledge_id (same as sqlite): created_at survives re-registration. */
  async createKnowledge(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): Promise<KnowledgeEntity> {
    const now = new Date().toISOString();
    const row = await this.one(
      `INSERT INTO ${this.s}.entity_knowledge (knowledge_id, type, service_url, name, summary, team_id, agent_id,
         user_id,
         repo_url, branch, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
       ON CONFLICT (knowledge_id) DO UPDATE SET type = EXCLUDED.type, service_url = EXCLUDED.service_url,
         name = EXCLUDED.name, summary = EXCLUDED.summary, team_id = EXCLUDED.team_id, agent_id = EXCLUDED.agent_id,
         user_id = EXCLUDED.user_id, repo_url = EXCLUDED.repo_url, branch = EXCLUDED.branch,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.knowledge_id,
        input.type,
        input.service_url,
        input.name,
        input.summary ?? null,
        input.team_id,
        input.agent_id ?? "",
        input.user_id ?? null,
        input.repo_url ?? null,
        input.branch ?? null,
        now,
      ],
    );
    return this.knowledgeFromRow(row!);
  }

  async getKnowledge(knowledgeId: string): Promise<KnowledgeEntity | null> {
    const row = await this.one(`SELECT * FROM ${this.s}.entity_knowledge WHERE knowledge_id = $1`, [knowledgeId]);
    return row ? this.knowledgeFromRow(row) : null;
  }

  async updateKnowledge(knowledgeId: string, patch: KnowledgePatch): Promise<KnowledgeEntity | null> {
    const p = new Params();
    const sets = [`updated_at = ${p.add(new Date().toISOString())}`];
    if (patch.name !== undefined) sets.push(`name = ${p.add(patch.name)}`);
    if (patch.summary !== undefined) sets.push(`summary = ${p.add(patch.summary)}`);
    if (patch.service_url !== undefined) sets.push(`service_url = ${p.add(patch.service_url)}`);
    if (patch.repo_url !== undefined) sets.push(`repo_url = ${p.add(patch.repo_url)}`);
    if (patch.branch !== undefined) sets.push(`branch = ${p.add(patch.branch)}`);
    const row = await this.one(
      `UPDATE ${this.s}.entity_knowledge SET ${sets.join(", ")} WHERE knowledge_id = ${p.add(knowledgeId)} RETURNING *`,
      p.values,
    );
    return row ? this.knowledgeFromRow(row) : null;
  }

  async deleteKnowledge(knowledgeIds: string[], teamId?: string): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of knowledgeIds) {
      const row = await this.getKnowledge(id);
      if (!row) {
        result.failed.push({ id, reason: "not_found" });
        continue;
      }
      if (teamId && row.team_id !== teamId) {
        result.failed.push({ id, reason: "team_mismatch" });
        continue;
      }
      await this.pool.query(`DELETE FROM ${this.s}.entity_knowledge WHERE knowledge_id = $1`, [id]);
      result.deleted_ids.push(id);
    }
    return result;
  }

  async listKnowledge(input: {
    team_id: string;
    type?: KnowledgeType;
    knowledge_ids?: string[];
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeListResult> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 1000);
    const offset = Math.max(input.offset ?? 0, 0);
    if (input.knowledge_ids && input.knowledge_ids.length === 0) return { items: [], total: 0 };
    const p = new Params();
    const conds = [`team_id = ${p.add(input.team_id)}`];
    if (input.type) conds.push(`type = ${p.add(input.type)}`);
    if (input.knowledge_ids) conds.push(`knowledge_id = ANY(${p.add(input.knowledge_ids)}::text[])`);
    const where = conds.join(" AND ");
    const total = await this.one(`SELECT COUNT(*) AS total FROM ${this.s}.entity_knowledge WHERE ${where}`, p.values);
    const rows = await this.all(
      `SELECT * FROM ${this.s}.entity_knowledge WHERE ${where} ORDER BY updated_at DESC
       LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
      p.values,
    );
    return { items: rows.map((r) => this.knowledgeFromRow(r)), total: Number(total?.total ?? 0) };
  }

  // ── Audit ──

  async appendAudit(e: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.s}.memory_audit (audit_id, record_id, layer, action, team_id, agent_id, user_id, task_id,
         version, updated_at_ms, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (audit_id) DO UPDATE SET record_id = EXCLUDED.record_id, layer = EXCLUDED.layer,
         action = EXCLUDED.action, team_id = EXCLUDED.team_id, agent_id = EXCLUDED.agent_id,
         user_id = EXCLUDED.user_id, task_id = EXCLUDED.task_id, version = EXCLUDED.version,
         updated_at_ms = EXCLUDED.updated_at_ms, request_id = EXCLUDED.request_id`,
      [
        e.audit_id,
        e.record_id,
        e.layer,
        e.action,
        e.team_id ?? null,
        e.agent_id ?? null,
        e.user_id ?? null,
        e.task_id ?? null,
        e.version,
        e.updated_at_ms,
        e.request_id ?? null,
      ],
    );
  }

  async queryAudit(filter: AuditQueryFilter): Promise<AuditEntry[]> {
    const p = new Params();
    const conds: string[] = [];
    const eq = (col: string, v: unknown) => {
      if (v !== undefined) conds.push(`${col} = ${p.add(v)}`);
    };
    eq("record_id", filter.record_id);
    eq("layer", filter.layer);
    eq("action", filter.action);
    eq("team_id", filter.team_id);
    eq("agent_id", filter.agent_id);
    eq("user_id", filter.user_id);
    eq("task_id", filter.task_id);
    if (filter.since_ms !== undefined) conds.push(`updated_at_ms >= ${p.add(filter.since_ms)}`);
    if (filter.until_ms !== undefined) conds.push(`updated_at_ms <= ${p.add(filter.until_ms)}`);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const offset = Math.max(filter.offset ?? 0, 0);
    const rows = await this.all(
      `SELECT * FROM ${this.s}.memory_audit ${where} ORDER BY updated_at_ms DESC, audit_id DESC
       LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
      p.values,
    );
    return rows.map((r) => ({
      audit_id: r.audit_id,
      record_id: r.record_id,
      layer: r.layer,
      action: r.action,
      team_id: r.team_id ?? undefined,
      agent_id: r.agent_id ?? undefined,
      user_id: r.user_id ?? undefined,
      task_id: r.task_id ?? undefined,
      version: Number(r.version),
      updated_at_ms: Number(r.updated_at_ms),
      request_id: r.request_id ?? undefined,
    }));
  }

  // ── Generation provenance refs ──

  async upsertMemoryGenerationRefs(records: MemoryGenerationRefRecord[]): Promise<void> {
    if (records.length === 0) return;
    await withTransaction(this.pool, async (c) => {
      for (const r of records) {
        await c.query(
          `INSERT INTO ${this.s}.memory_generation_refs (generation_ref_id, layer, memory_id, generation_id,
             generation_log_id, generation_log_key, memory_prompt_id, memory_prompt_version, memory_prompt_source,
             created_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (generation_ref_id) DO UPDATE SET memory_id = EXCLUDED.memory_id,
             generation_id = EXCLUDED.generation_id, generation_log_id = EXCLUDED.generation_log_id,
             generation_log_key = EXCLUDED.generation_log_key, memory_prompt_id = EXCLUDED.memory_prompt_id,
             memory_prompt_version = EXCLUDED.memory_prompt_version,
             memory_prompt_source = EXCLUDED.memory_prompt_source, created_at_ms = EXCLUDED.created_at_ms`,
          [
            r.generation_ref_id,
            r.layer,
            r.memory_id,
            r.generation_id,
            r.generation_log_id,
            r.generation_log_key,
            r.memory_prompt_id,
            r.memory_prompt_version,
            r.memory_prompt_source,
            r.created_at_ms,
          ],
        );
      }
    });
  }

  async getMemoryGenerationRef(
    layer: MemoryGenerationLayer,
    memoryId: string,
  ): Promise<MemoryGenerationRefRecord | null> {
    const row = await this.one(
      `SELECT * FROM ${this.s}.memory_generation_refs WHERE generation_ref_id = $1 AND layer = $2 AND memory_id = $3`,
      [buildMemoryGenerationRefId(layer, memoryId), layer, memoryId],
    );
    return row as MemoryGenerationRefRecord | null;
  }

  // ── Custom memory prompts ──

  async countMemoryPrompts(): Promise<number> {
    const row = await this.one(`SELECT COUNT(*) AS total FROM ${this.s}.memory_prompts`, []);
    return Number(row?.total ?? 0);
  }

  async createMemoryPrompt(r: MemoryPromptRecord): Promise<MemoryPromptRecord> {
    await this.pool.query(
      `INSERT INTO ${this.s}.memory_prompts (memory_prompt_id, name, layer, prompt, version, status,
         created_by, updated_by, created_at_ms, updated_at_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        r.memory_prompt_id,
        r.name,
        r.layer,
        r.prompt,
        r.version,
        r.status,
        r.created_by ?? null,
        r.updated_by ?? null,
        r.created_at_ms,
        r.updated_at_ms,
      ],
    );
    return r;
  }

  async getMemoryPrompts(ids: string[]): Promise<MemoryPromptRecord[]> {
    if (ids.length === 0) return [];
    return (await this.all(`SELECT * FROM ${this.s}.memory_prompts WHERE memory_prompt_id = ANY($1::text[])`, [
      ids,
    ])) as MemoryPromptRecord[];
  }

  async listMemoryPrompts(filter: MemoryPromptListFilter): Promise<MemoryPromptRecord[]> {
    const p = new Params();
    const conds = ["status = 'active'"];
    if (filter.layer) conds.push(`layer = ${p.add(filter.layer)}`);
    const order = filter.timeOrder === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    return (await this.all(
      `SELECT * FROM ${this.s}.memory_prompts WHERE ${conds.join(" AND ")}
       ORDER BY updated_at_ms ${order}, memory_prompt_id ${order} LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
      p.values,
    )) as MemoryPromptRecord[];
  }

  async updateMemoryPrompt(
    id: string,
    patch: { name?: string; prompt?: string; updated_by?: string; updated_at_ms: number },
  ): Promise<MemoryPromptRecord | null> {
    const [current] = await this.getMemoryPrompts([id]);
    if (!current || current.status !== "active") return null;
    const sameName = patch.name === undefined || patch.name === current.name;
    const samePrompt = patch.prompt === undefined || patch.prompt === current.prompt;
    if (sameName && samePrompt) return current;
    const row = await this.one(
      `UPDATE ${this.s}.memory_prompts SET version = version + 1, updated_at_ms = $1, updated_by = $2,
         name = COALESCE($3, name), prompt = COALESCE($4, prompt)
       WHERE memory_prompt_id = $5 AND status = 'active' RETURNING *`,
      [patch.updated_at_ms, patch.updated_by ?? null, patch.name ?? null, patch.prompt ?? null, id],
    );
    return (row as MemoryPromptRecord | null) ?? null;
  }

  async getMemoryPromptSettings(ids: string[]): Promise<MemoryPromptSettingRecord[]> {
    if (ids.length === 0) return [];
    return (await this.all(`SELECT * FROM ${this.s}.memory_prompt_settings WHERE setting_id = ANY($1::text[])`, [
      ids,
    ])) as MemoryPromptSettingRecord[];
  }

  async listMemoryPromptSettings(filter: MemoryPromptSettingListFilter): Promise<MemoryPromptSettingRecord[]> {
    const p = new Params();
    const conds: string[] = [];
    if (filter.memoryPromptId) conds.push(`memory_prompt_id = ${p.add(filter.memoryPromptId)}`);
    if (filter.targetType) conds.push(`target_type = ${p.add(filter.targetType)}`);
    if (filter.teamId) conds.push(`team_id = ${p.add(filter.teamId)}`);
    if (filter.agentId) conds.push(`agent_id = ${p.add(filter.agentId)}`);
    if (filter.layer) conds.push(`layer = ${p.add(filter.layer)}`);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const order = filter.timeOrder === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    return (await this.all(
      `SELECT * FROM ${this.s}.memory_prompt_settings ${where}
       ORDER BY updated_at_ms ${order}, setting_id ${order} LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
      p.values,
    )) as MemoryPromptSettingRecord[];
  }

  async upsertMemoryPromptSettings(
    records: MemoryPromptSettingRecord[],
    logs: MemoryPromptSettingLogRecord[],
  ): Promise<void> {
    await withTransaction(this.pool, async (c) => {
      for (const r of records) {
        await c.query(
          `INSERT INTO ${this.s}.memory_prompt_settings (setting_id, target_type, team_id, agent_id, layer,
             memory_prompt_id, updated_by, updated_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (setting_id) DO UPDATE SET target_type = EXCLUDED.target_type, team_id = EXCLUDED.team_id,
             agent_id = EXCLUDED.agent_id, layer = EXCLUDED.layer, memory_prompt_id = EXCLUDED.memory_prompt_id,
             updated_by = EXCLUDED.updated_by, updated_at_ms = EXCLUDED.updated_at_ms`,
          [
            r.setting_id,
            r.target_type,
            r.team_id ?? null,
            r.agent_id ?? null,
            r.layer,
            r.memory_prompt_id,
            r.updated_by ?? null,
            r.updated_at_ms,
          ],
        );
      }
      await this.insertSettingLogs(c, logs);
    });
  }

  async clearMemoryPromptSettings(ids: string[], logs: MemoryPromptSettingLogRecord[]): Promise<void> {
    if (ids.length === 0) return;
    await withTransaction(this.pool, async (c) => {
      await c.query(`DELETE FROM ${this.s}.memory_prompt_settings WHERE setting_id = ANY($1::text[])`, [ids]);
      await this.insertSettingLogs(c, logs);
    });
  }

  private async insertSettingLogs(c: { query: Pool["query"] }, logs: MemoryPromptSettingLogRecord[]): Promise<void> {
    for (const l of logs) {
      await c.query(
        `INSERT INTO ${this.s}.memory_prompt_setting_logs (setting_log_id, target_type, team_id, agent_id, layer,
           action,
           reason, before_memory_prompt_id, after_memory_prompt_id, operator_id, operated_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (setting_log_id) DO NOTHING`,
        [
          l.setting_log_id,
          l.target_type,
          l.team_id ?? null,
          l.agent_id ?? null,
          l.layer,
          l.action,
          l.reason,
          l.before_memory_prompt_id ?? null,
          l.after_memory_prompt_id ?? null,
          l.operator_id ?? null,
          l.operated_at_ms,
        ],
      );
    }
  }

  async deleteMemoryPrompts(ids: string[], operatorId?: string): Promise<MemoryPromptDeleteResult> {
    const cleared: Record<MemoryPromptTargetType, number> = { instance: 0, team: 0, agent: 0 };
    const prompts = await this.getMemoryPrompts(ids);
    if (prompts.length !== ids.length) return { deleted_prompt_ids: [], cleared_settings: cleared };
    const settings = (await this.all(
      `SELECT * FROM ${this.s}.memory_prompt_settings WHERE memory_prompt_id = ANY($1::text[])`,
      [ids],
    )) as MemoryPromptSettingRecord[];
    const now = Date.now();
    const logs: MemoryPromptSettingLogRecord[] = settings.map((st) => {
      cleared[st.target_type] += 1;
      return {
        setting_log_id: `mpsl:delete:${st.setting_id}:${st.memory_prompt_id}`,
        target_type: st.target_type,
        team_id: st.team_id ?? undefined,
        agent_id: st.agent_id ?? undefined,
        layer: st.layer,
        action: "clear",
        reason: "prompt_deleted",
        before_memory_prompt_id: st.memory_prompt_id,
        operator_id: operatorId,
        operated_at_ms: now,
      };
    });
    await withTransaction(this.pool, async (c) => {
      await c.query(`DELETE FROM ${this.s}.memory_prompt_settings WHERE memory_prompt_id = ANY($1::text[])`, [ids]);
      await this.insertSettingLogs(c, logs);
      await c.query(`DELETE FROM ${this.s}.memory_prompts WHERE memory_prompt_id = ANY($1::text[])`, [ids]);
    });
    return { deleted_prompt_ids: ids, cleared_settings: cleared };
  }

  async queryMemoryPromptSettingLogs(filter: MemoryPromptSettingLogFilter): Promise<MemoryPromptSettingLogRecord[]> {
    const p = new Params();
    const conds: string[] = [];
    if (filter.memoryPromptId) {
      const ph = p.add(filter.memoryPromptId);
      conds.push(`(before_memory_prompt_id = ${ph} OR after_memory_prompt_id = ${ph})`);
    }
    if (filter.teamId) conds.push(`team_id = ${p.add(filter.teamId)}`);
    if (filter.agentId) conds.push(`agent_id = ${p.add(filter.agentId)}`);
    if (filter.action) conds.push(`action = ${p.add(filter.action)}`);
    if (filter.startTimeMs !== undefined) conds.push(`operated_at_ms >= ${p.add(filter.startTimeMs)}`);
    if (filter.endTimeMs !== undefined) conds.push(`operated_at_ms <= ${p.add(filter.endTimeMs)}`);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const order = filter.timeOrder === "asc" ? "ASC" : "DESC";
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    return (await this.all(
      `SELECT * FROM ${this.s}.memory_prompt_setting_logs ${where}
       ORDER BY operated_at_ms ${order}, setting_log_id ${order} LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
      p.values,
    )) as MemoryPromptSettingLogRecord[];
  }
}
