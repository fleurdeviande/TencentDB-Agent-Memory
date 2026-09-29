/**
 * SqliteKnowledgeStore — Drizzle implementation of IKnowledgeStore (SQLite or Postgres; the name is upstream's).
 *
 * Responsibilities:
 *   - code-graph / wiki asset CRUD (hard delete; soft-delete markers via deleted_at)
 *   - Multi-tenant isolation (001, phase 5): EVERY read/write is scoped by
 *     `service_id` (first parameter), then `team_id` where applicable. id-only
 *     accessors also filter service_id so a foreign tenant can never read/mutate
 *     another tenant's row (returns null/false → 404).
 *   - Global ID generation (wiki-/cg-) + idempotency: same
 *     (service_id, team_id, repo_url, branch) or (service_id, team_id, name)
 *     duplicate create returns existing.
 *   - Status state machine + restart recovery.
 */

import { eq, and, isNull, desc, sql, type SQL } from "drizzle-orm";
import {
  affectedRows,
  asKnowledgeDb,
  isUniqueViolation,
  type Db,
  type KnowledgeDb,
  type KnowledgeTables,
} from "../db/client.js";
import {
  CODE_DATA_VERSION,
  WIKI_DATA_VERSION,
  type KnowledgeCodeGraph,
  type KnowledgeWiki,
} from "../db/schema.js";
import { genCodeGraphId, genWikiId } from "./ids.js";
import type {
  IKnowledgeStore,
  SyncStatus,
  CodeGraphRow,
  CreateCodeGraphInput,
  CodeGraphStatusPatch,
  CodeGraphMetaPatch,
  WikiRow,
  CreateWikiInput,
  WikiStatusPatch,
  WikiMetaPatch,
  AuditLogInput,
  AuditLogRow,
  CreateResult,
  ListOpts,
  CountOpts,
  SyncedCodeGraphRef,
  SyncedWikiRef,
} from "./types.js";

const ID_RETRY = 5;

function nowIso(): string {
  return new Date().toISOString();
}

// ───────────────────────── Store ─────────────────────────

export class SqliteKnowledgeStore implements IKnowledgeStore {
  private readonly db: Db;
  private readonly t: KnowledgeTables;

  /** Upstream passes the SQLite `Db`; a `KnowledgeDb` selects the dialect (SQLite or Postgres). */
  constructor(db: Db | KnowledgeDb) {
    const kdb = asKnowledgeDb(db);
    this.db = kdb.orm;
    this.t = kdb.tables;
  }

  // ═══════════════════════ Code-Graph ═══════════════════════

  /**
   * Idempotent create: hit (service_id, team_id, repo_url, branch) returns existing
   * (existed=true); otherwise generate cg- id and insert (PK conflict auto-retry).
   */
  async createCodeGraph(input: CreateCodeGraphInput): Promise<CreateResult<CodeGraphRow>> {
    const [existing] = await this.db
      .select()
      .from(this.t.knowledgeCodeGraph)
      .where(
        and(
          eq(this.t.knowledgeCodeGraph.serviceId, input.service_id),
          eq(this.t.knowledgeCodeGraph.teamId, input.team_id),
          eq(this.t.knowledgeCodeGraph.repoUrl, input.repo_url),
          eq(this.t.knowledgeCodeGraph.branch, input.branch),
          isNull(this.t.knowledgeCodeGraph.deletedAt),
        ),
      )
      .limit(1);
    if (existing) return { row: this.mapCgRow(existing), existed: true };

    const ts = nowIso();
    for (let attempt = 0; attempt < ID_RETRY; attempt++) {
      const id = genCodeGraphId();
      try {
        await this.db
          .insert(this.t.knowledgeCodeGraph)
          .values({
            codeGraphId: id,
            serviceId: input.service_id,
            teamId: input.team_id,
            repoName: input.repo_name ?? "",
            repoUrl: input.repo_url,
            branch: input.branch,
            ownerUserId: input.owner_user_id ?? null,
            userId: input.user_id ?? null,
            agentId: input.agent_id ?? null,
            taskId: input.task_id ?? null,
            visibility: input.visibility ?? "team",
            status: "pending",
            serviceUrl: input.service_url ?? null,
            credentialId: input.credential_id ?? null,
            version: CODE_DATA_VERSION,
            createdAt: ts,
            updatedAt: ts,
          });

        const [row] = await this.db
          .select()
          .from(this.t.knowledgeCodeGraph)
          .where(eq(this.t.knowledgeCodeGraph.codeGraphId, id))
          .limit(1);
        return { row: this.mapCgRow(row!), existed: false };
      } catch (err) {
        // PK conflict → retry with new id; unique(memory,team,repo,branch) conflict → race, return existing
        const [raced] = await this.db
          .select()
          .from(this.t.knowledgeCodeGraph)
          .where(
            and(
              eq(this.t.knowledgeCodeGraph.serviceId, input.service_id),
              eq(this.t.knowledgeCodeGraph.teamId, input.team_id),
              eq(this.t.knowledgeCodeGraph.repoUrl, input.repo_url),
              eq(this.t.knowledgeCodeGraph.branch, input.branch),
              isNull(this.t.knowledgeCodeGraph.deletedAt),
            ),
          )
          .limit(1);
        if (raced) return { row: this.mapCgRow(raced), existed: true };
        if (!isUniqueViolation(err) || attempt === ID_RETRY - 1) throw err;
      }
    }
    throw new Error("createCodeGraph: failed to allocate unique id");
  }

  async getCodeGraph(serviceId: string, teamId: string, codeGraphId: string): Promise<CodeGraphRow | null> {
    const [row] = await this.db
      .select()
      .from(this.t.knowledgeCodeGraph)
      .where(
        and(
          eq(this.t.knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(this.t.knowledgeCodeGraph.serviceId, serviceId),
          eq(this.t.knowledgeCodeGraph.teamId, teamId),
        ),
      )
      .limit(1);
    return row ? this.mapCgRow(row) : null;
  }

  /** id-only accessor — STILL scoped by service_id (cross-Memory leak guard, 001 §2.4). */
  async getCodeGraphById(serviceId: string, codeGraphId: string): Promise<CodeGraphRow | null> {
    const [row] = await this.db
      .select()
      .from(this.t.knowledgeCodeGraph)
      .where(
        and(
          eq(this.t.knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(this.t.knowledgeCodeGraph.serviceId, serviceId),
        ),
      )
      .limit(1);
    return row ? this.mapCgRow(row) : null;
  }

  async listCodeGraphs(serviceId: string, teamId: string, opts?: ListOpts): Promise<CodeGraphRow[]> {
    const conditions: SQL[] = [
      eq(this.t.knowledgeCodeGraph.serviceId, serviceId),
      eq(this.t.knowledgeCodeGraph.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(this.t.knowledgeCodeGraph.status, opts.syncStatus));
    }
    const rows = await this.db
      .select()
      .from(this.t.knowledgeCodeGraph)
      .where(and(...conditions))
      .orderBy(desc(this.t.knowledgeCodeGraph.updatedAt))
      .limit(opts?.limit ?? 20)
      .offset(opts?.offset ?? 0);
    return rows.map((r) => this.mapCgRow(r));
  }

  async countCodeGraphs(serviceId: string, teamId: string, opts?: CountOpts): Promise<number> {
    const conditions: SQL[] = [
      eq(this.t.knowledgeCodeGraph.serviceId, serviceId),
      eq(this.t.knowledgeCodeGraph.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(this.t.knowledgeCodeGraph.status, opts.syncStatus));
    }
    const [result] = await this.db
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(this.t.knowledgeCodeGraph)
      .where(and(...conditions))
      .limit(1);
    return result?.total ?? 0;
  }

  /** id-only mutation — scoped by service_id so a foreign tenant cannot mutate. */
  async updateCodeGraphStatus(serviceId: string, codeGraphId: string, patch: CodeGraphStatusPatch): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.internal_status !== undefined) set.internalStatus = patch.internal_status;
    if (patch.sync_error !== undefined) set.syncError = patch.sync_error;
    if (patch.commit_hash !== undefined) set.commitHash = patch.commit_hash;
    if (patch.stats_json !== undefined) set.statsJson = patch.stats_json;
    if (patch.last_sync_at !== undefined) set.lastSyncAt = patch.last_sync_at;
    if (patch.service_url !== undefined) set.serviceUrl = patch.service_url;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.version !== undefined) set.version = patch.version;

    await this.db
      .update(this.t.knowledgeCodeGraph)
      .set(set)
      .where(
        and(
          eq(this.t.knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(this.t.knowledgeCodeGraph.serviceId, serviceId),
        ),
      );
  }

  /** Hard delete; memory/team mismatch returns false. */
  async deleteCodeGraph(serviceId: string, teamId: string, codeGraphId: string): Promise<boolean> {
    const result = await this.db
      .delete(this.t.knowledgeCodeGraph)
      .where(
        and(
          eq(this.t.knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(this.t.knowledgeCodeGraph.serviceId, serviceId),
          eq(this.t.knowledgeCodeGraph.teamId, teamId),
        ),
      );
    return affectedRows(result) > 0;
  }

  /** Update code-graph metadata (repo_name, summary, credential_id). memory mismatch → null. */
  async updateCodeGraphMeta(
    serviceId: string,
    codeGraphId: string,
    patch: CodeGraphMetaPatch,
  ): Promise<CodeGraphRow | null> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.repo_name !== undefined) set.repoName = patch.repo_name;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.credential_id !== undefined) set.credentialId = patch.credential_id;
    await this.db
      .update(this.t.knowledgeCodeGraph)
      .set(set)
      .where(
        and(
          eq(this.t.knowledgeCodeGraph.codeGraphId, codeGraphId),
          eq(this.t.knowledgeCodeGraph.serviceId, serviceId),
        ),
      );
    return this.getCodeGraphById(serviceId, codeGraphId);
  }

  // ═══════════════════════ Wiki ═══════════════════════

  async createWiki(input: CreateWikiInput): Promise<CreateResult<WikiRow>> {
    const [existing] = await this.db
      .select()
      .from(this.t.knowledgeWiki)
      .where(
        and(
          eq(this.t.knowledgeWiki.serviceId, input.service_id),
          eq(this.t.knowledgeWiki.teamId, input.team_id),
          eq(this.t.knowledgeWiki.name, input.name),
          isNull(this.t.knowledgeWiki.deletedAt),
        ),
      )
      .limit(1);
    if (existing) return { row: this.mapWikiRow(existing), existed: true };

    const ts = nowIso();
    for (let attempt = 0; attempt < ID_RETRY; attempt++) {
      const id = genWikiId();
      try {
        await this.db
          .insert(this.t.knowledgeWiki)
          .values({
            wikiId: id,
            serviceId: input.service_id,
            teamId: input.team_id,
            name: input.name,
            sourceType: input.source_type ?? null,
            sourceUrl: input.source_url ?? null,
            ownerUserId: input.owner_user_id ?? null,
            userId: input.user_id ?? null,
            agentId: input.agent_id ?? null,
            taskId: input.task_id ?? null,
            visibility: input.visibility ?? "team",
            status: "draft",
            serviceUrl: input.service_url ?? null,
            version: WIKI_DATA_VERSION,
            createdAt: ts,
            updatedAt: ts,
          });

        const [row] = await this.db
          .select()
          .from(this.t.knowledgeWiki)
          .where(eq(this.t.knowledgeWiki.wikiId, id))
          .limit(1);
        return { row: this.mapWikiRow(row!), existed: false };
      } catch (err) {
        const [raced] = await this.db
          .select()
          .from(this.t.knowledgeWiki)
          .where(
            and(
              eq(this.t.knowledgeWiki.serviceId, input.service_id),
              eq(this.t.knowledgeWiki.teamId, input.team_id),
              eq(this.t.knowledgeWiki.name, input.name),
              isNull(this.t.knowledgeWiki.deletedAt),
            ),
          )
          .limit(1);
        if (raced) return { row: this.mapWikiRow(raced), existed: true };
        if (!isUniqueViolation(err) || attempt === ID_RETRY - 1) throw err;
      }
    }
    throw new Error("createWiki: failed to allocate unique id");
  }

  async getWiki(serviceId: string, teamId: string, wikiId: string): Promise<WikiRow | null> {
    const [row] = await this.db
      .select()
      .from(this.t.knowledgeWiki)
      .where(
        and(
          eq(this.t.knowledgeWiki.wikiId, wikiId),
          eq(this.t.knowledgeWiki.serviceId, serviceId),
          eq(this.t.knowledgeWiki.teamId, teamId),
        ),
      )
      .limit(1);
    return row ? this.mapWikiRow(row) : null;
  }

  /** id-only accessor — STILL scoped by service_id (cross-Memory leak guard, 001 §2.4). */
  async getWikiById(serviceId: string, wikiId: string): Promise<WikiRow | null> {
    const [row] = await this.db
      .select()
      .from(this.t.knowledgeWiki)
      .where(
        and(
          eq(this.t.knowledgeWiki.wikiId, wikiId),
          eq(this.t.knowledgeWiki.serviceId, serviceId),
        ),
      )
      .limit(1);
    return row ? this.mapWikiRow(row) : null;
  }

  async listWikis(serviceId: string, teamId: string, opts?: ListOpts): Promise<WikiRow[]> {
    const conditions: SQL[] = [
      eq(this.t.knowledgeWiki.serviceId, serviceId),
      eq(this.t.knowledgeWiki.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(this.t.knowledgeWiki.status, opts.syncStatus));
    }
    const rows = await this.db
      .select()
      .from(this.t.knowledgeWiki)
      .where(and(...conditions))
      .orderBy(desc(this.t.knowledgeWiki.updatedAt))
      .limit(opts?.limit ?? 20)
      .offset(opts?.offset ?? 0);
    return rows.map((r) => this.mapWikiRow(r));
  }

  async countWikis(serviceId: string, teamId: string, opts?: CountOpts): Promise<number> {
    const conditions: SQL[] = [
      eq(this.t.knowledgeWiki.serviceId, serviceId),
      eq(this.t.knowledgeWiki.teamId, teamId),
    ];
    if (opts?.syncStatus) {
      conditions.push(eq(this.t.knowledgeWiki.status, opts.syncStatus));
    }
    const [result] = await this.db
      .select({ total: sql<number>`count(*)`.mapWith(Number) })
      .from(this.t.knowledgeWiki)
      .where(and(...conditions))
      .limit(1);
    return result?.total ?? 0;
  }

  /** id-only mutation — scoped by service_id so a foreign tenant cannot mutate. */
  async updateWikiStatus(serviceId: string, wikiId: string, patch: WikiStatusPatch): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.internal_status !== undefined) set.internalStatus = patch.internal_status;
    if (patch.sync_error !== undefined) set.syncError = patch.sync_error;
    if (patch.page_count !== undefined) set.pageCount = patch.page_count;
    if (patch.last_sync_at !== undefined) set.lastSyncAt = patch.last_sync_at;
    if (patch.service_url !== undefined) set.serviceUrl = patch.service_url;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.version !== undefined) set.version = patch.version;

    await this.db
      .update(this.t.knowledgeWiki)
      .set(set)
      .where(
        and(
          eq(this.t.knowledgeWiki.wikiId, wikiId),
          eq(this.t.knowledgeWiki.serviceId, serviceId),
        ),
      );
  }

  async deleteWiki(serviceId: string, teamId: string, wikiId: string): Promise<boolean> {
    const result = await this.db
      .delete(this.t.knowledgeWiki)
      .where(
        and(
          eq(this.t.knowledgeWiki.wikiId, wikiId),
          eq(this.t.knowledgeWiki.serviceId, serviceId),
          eq(this.t.knowledgeWiki.teamId, teamId),
        ),
      );
    return affectedRows(result) > 0;
  }

  /** Update wiki metadata (name, summary). memory mismatch → null. */
  async updateWikiMeta(serviceId: string, wikiId: string, patch: WikiMetaPatch): Promise<WikiRow | null> {
    const set: Record<string, unknown> = { updatedAt: nowIso() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.summary !== undefined) set.summary = patch.summary;
    await this.db
      .update(this.t.knowledgeWiki)
      .set(set)
      .where(
        and(
          eq(this.t.knowledgeWiki.wikiId, wikiId),
          eq(this.t.knowledgeWiki.serviceId, serviceId),
        ),
      );
    return this.getWikiById(serviceId, wikiId);
  }

  // ═══════════════════════ Audit ═══════════════════════

  async appendWikiAudit(input: AuditLogInput): Promise<void> {
    await this.db
      .insert(this.t.knowledgeWikiAudit)
      .values({
        wikiId: input.asset_id,
        serviceId: input.service_id ?? null,
        version: input.version,
        action: input.action,
        userId: input.user_id ?? null,
        agentId: input.agent_id ?? null,
        detail: input.detail ?? null,
        createdAt: nowIso(),
      });
  }

  async appendCodeGraphAudit(input: AuditLogInput): Promise<void> {
    await this.db
      .insert(this.t.knowledgeCodeGraphAudit)
      .values({
        codeGraphId: input.asset_id,
        serviceId: input.service_id ?? null,
        version: input.version,
        action: input.action,
        userId: input.user_id ?? null,
        agentId: input.agent_id ?? null,
        detail: input.detail ?? null,
        createdAt: nowIso(),
      });
  }

  async listWikiAudit(serviceId: string, wikiId: string, limit = 20, offset = 0): Promise<AuditLogRow[]> {
    const rows = await this.db
      .select()
      .from(this.t.knowledgeWikiAudit)
      .where(
        and(
          eq(this.t.knowledgeWikiAudit.wikiId, wikiId),
          eq(this.t.knowledgeWikiAudit.serviceId, serviceId),
        ),
      )
      .orderBy(desc(this.t.knowledgeWikiAudit.version), desc(this.t.knowledgeWikiAudit.id))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.id,
      service_id: r.serviceId ?? null,
      asset_id: r.wikiId,
      version: r.version,
      action: r.action as AuditLogRow["action"],
      user_id: r.userId,
      agent_id: r.agentId,
      detail: r.detail,
      created_at: r.createdAt,
    }));
  }

  async listCodeGraphAudit(serviceId: string, codeGraphId: string, limit = 20, offset = 0): Promise<AuditLogRow[]> {
    const rows = await this.db
      .select()
      .from(this.t.knowledgeCodeGraphAudit)
      .where(
        and(
          eq(this.t.knowledgeCodeGraphAudit.codeGraphId, codeGraphId),
          eq(this.t.knowledgeCodeGraphAudit.serviceId, serviceId),
        ),
      )
      .orderBy(desc(this.t.knowledgeCodeGraphAudit.version), desc(this.t.knowledgeCodeGraphAudit.id))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.id,
      service_id: r.serviceId ?? null,
      asset_id: r.codeGraphId,
      version: r.version,
      action: r.action as AuditLogRow["action"],
      user_id: r.userId,
      agent_id: r.agentId,
      detail: r.detail,
      created_at: r.createdAt,
    }));
  }

  // ═══════════════════════ Restart Recovery ═══════════════════════

  /**
   * Sweep all non-terminal (pending/processing) assets to failed, across all tenants.
   * After restart, in-memory SerialQueue tasks are lost; this makes them visible to control plane.
   * @returns total affected rows (code + wiki combined).
   */
  async markInterruptedAsFailed(reason = "interrupted by restart"): Promise<number> {
    const ts = nowIso();
    const a = await this.db
      .update(this.t.knowledgeCodeGraph)
      .set({ status: "failed", syncError: reason, updatedAt: ts })
      .where(sql`status IN ('pending','processing')`);
    const b = await this.db
      .update(this.t.knowledgeWiki)
      .set({ status: "failed", syncError: reason, updatedAt: ts })
      .where(sql`status IN ('pending','processing')`);
    return affectedRows(a) + affectedRows(b);
  }

  /** All ready code-graphs (with service_id) so module.ts can rebuild per-tenant dirs. */
  async listSyncedCodeGraphs(): Promise<SyncedCodeGraphRef[]> {
    return await this.db
      .select({
        code_graph_id: this.t.knowledgeCodeGraph.codeGraphId,
        service_id: this.t.knowledgeCodeGraph.serviceId,
        team_id: this.t.knowledgeCodeGraph.teamId,
      })
      .from(this.t.knowledgeCodeGraph)
      .where(
        and(
          eq(this.t.knowledgeCodeGraph.status, "ready"),
          isNull(this.t.knowledgeCodeGraph.deletedAt),
        ),
      );
  }

  async listSyncedWikis(): Promise<SyncedWikiRef[]> {
    return await this.db
      .select({
        wiki_id: this.t.knowledgeWiki.wikiId,
        service_id: this.t.knowledgeWiki.serviceId,
        team_id: this.t.knowledgeWiki.teamId,
      })
      .from(this.t.knowledgeWiki)
      .where(
        and(eq(this.t.knowledgeWiki.status, "ready"), isNull(this.t.knowledgeWiki.deletedAt)),
      );
  }

  // ═══════════════════════ Mappers ═══════════════════════

  private mapCgRow(r: KnowledgeCodeGraph): CodeGraphRow {
    return {
      code_graph_id: r.codeGraphId,
      service_id: r.serviceId,
      team_id: r.teamId,
      repo_name: r.repoName,
      repo_url: r.repoUrl,
      branch: r.branch,
      commit_hash: r.commitHash,
      owner_user_id: r.ownerUserId,
      user_id: r.userId,
      agent_id: r.agentId,
      task_id: r.taskId,
      visibility: r.visibility,
      status: r.status as SyncStatus,
      internal_status: r.internalStatus,
      sync_error: r.syncError,
      stats_json: r.statsJson,
      service_url: r.serviceUrl ?? null,
      summary: r.summary ?? null,
      credential_id: r.credentialId ?? null,
      version: r.version,
      last_sync_at: r.lastSyncAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      deleted_at: r.deletedAt ?? null,
    };
  }

  private mapWikiRow(r: KnowledgeWiki): WikiRow {
    return {
      wiki_id: r.wikiId,
      service_id: r.serviceId,
      team_id: r.teamId,
      name: r.name,
      source_type: r.sourceType,
      source_url: r.sourceUrl,
      owner_user_id: r.ownerUserId,
      user_id: r.userId,
      agent_id: r.agentId,
      task_id: r.taskId,
      visibility: r.visibility,
      status: r.status as SyncStatus,
      internal_status: r.internalStatus,
      sync_error: r.syncError,
      page_count: r.pageCount,
      service_url: r.serviceUrl ?? null,
      summary: r.summary ?? null,
      version: r.version,
      last_sync_at: r.lastSyncAt,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      deleted_at: r.deletedAt ?? null,
    };
  }
}
