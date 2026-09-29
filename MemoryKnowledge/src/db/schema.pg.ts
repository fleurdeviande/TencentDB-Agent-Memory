/**
 * Drizzle ORM schema — Postgres twin of `schema.ts`.
 *
 * Same tables, same JS property names, same column types as seen by JS (TEXT ISO timestamps,
 * integer flags), so rows inferred from either schema are interchangeable and the stores run one
 * code path on both dialects. Keep the two files in lockstep; the DDL lives in `migrate-pg.ts`.
 */

import { pgTable, text, integer, bigint, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const knowledgeCodeGraph = pgTable(
  "knowledge_code_graph",
  {
    codeGraphId: text("code_graph_id").primaryKey(),
    serviceId: text("service_id").notNull(),
    teamId: text("team_id").notNull(),
    repoName: text("repo_name").notNull().default(""),
    repoUrl: text("repo_url").notNull(),
    branch: text("branch").notNull(),
    commitHash: text("commit_hash"),
    ownerUserId: text("owner_user_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    taskId: text("task_id"),
    visibility: text("visibility").notNull().default("team"),
    status: text("status").notNull().default("pending"),
    internalStatus: text("internal_status"),
    syncError: text("sync_error"),
    statsJson: text("stats_json"),
    serviceUrl: text("service_url"),
    summary: text("summary"),
    credentialId: text("credential_id"),
    version: integer("version").notNull().default(0),
    lastSyncAt: text("last_sync_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("idx_kcg_team_repo_branch")
      .on(table.serviceId, table.teamId, table.repoUrl, table.branch)
      .where(sql`deleted_at IS NULL`),
    index("idx_kcg_team_status").on(table.serviceId, table.teamId, table.status),
  ],
);

export const knowledgeWiki = pgTable(
  "knowledge_wiki",
  {
    wikiId: text("wiki_id").primaryKey(),
    serviceId: text("service_id").notNull(),
    teamId: text("team_id").notNull(),
    name: text("name").notNull(),
    sourceType: text("source_type"),
    sourceUrl: text("source_url"),
    ownerUserId: text("owner_user_id"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    taskId: text("task_id"),
    visibility: text("visibility").notNull().default("team"),
    status: text("status").notNull().default("draft"),
    internalStatus: text("internal_status"),
    syncError: text("sync_error"),
    pageCount: integer("page_count"),
    serviceUrl: text("service_url"),
    summary: text("summary"),
    version: integer("version").notNull().default(0),
    lastSyncAt: text("last_sync_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("idx_kwiki_team_name")
      .on(table.serviceId, table.teamId, table.name)
      .where(sql`deleted_at IS NULL`),
    index("idx_kwiki_team_status").on(table.serviceId, table.teamId, table.status),
  ],
);

export const knowledgeWikiAudit = pgTable(
  "knowledge_wiki_audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    wikiId: text("wiki_id").notNull(),
    serviceId: text("service_id"),
    version: integer("version").notNull().default(0),
    action: text("action").notNull(),
    userId: text("user_id"),
    agentId: text("agent_id"),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_kwa_wiki_version").on(table.wikiId, table.version)],
);

export const knowledgeCodeGraphAudit = pgTable(
  "knowledge_code_graph_audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    codeGraphId: text("code_graph_id").notNull(),
    serviceId: text("service_id"),
    version: integer("version").notNull().default(0),
    action: text("action").notNull(),
    userId: text("user_id"),
    agentId: text("agent_id"),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_kcga_cg_version").on(table.codeGraphId, table.version)],
);

export const knowledgeGitCredential = pgTable(
  "knowledge_git_credential",
  {
    credentialId: text("credential_id").primaryKey(),
    serviceId: text("service_id").notNull(),
    teamId: text("team_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    host: text("host").notNull(),
    username: text("username"),
    secretEnc: text("secret_enc").notNull(),
    fingerprint: text("fingerprint").notNull(),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    uniqueIndex("idx_kgcred_team_name")
      .on(table.serviceId, table.teamId, table.name)
      .where(sql`deleted_at IS NULL`),
    index("idx_kgcred_team_host").on(table.serviceId, table.teamId, table.host),
  ],
);

export const knowledgeGitCredentialAudit = pgTable(
  "knowledge_git_credential_audit",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    credentialId: text("credential_id").notNull(),
    serviceId: text("service_id"),
    action: text("action").notNull(),
    userId: text("user_id"),
    detail: text("detail"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_kgca_cred").on(table.credentialId, table.id)],
);

export const llmBinding = pgTable("llm_binding", {
  serviceId: text("service_id").primaryKey(),
  mode: text("mode").notNull().default("proxy"),
  proxyBaseUrl: text("proxy_base_url"),
  apiKey: text("api_key"),
  baseUrl: text("base_url"),
  enabled: integer("enabled").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});
