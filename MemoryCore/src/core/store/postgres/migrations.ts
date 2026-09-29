/**
 * Versioned, idempotent schema migrations for the Postgres backend.
 *
 * Each component (memory, skill) keeps its own version sequence in
 * `<schema>.schema_migrations`. Migrations run inside one transaction under an
 * advisory lock, so concurrent inits of the same schema serialise.
 *
 * Vector columns are NOT versioned here: their dimension comes from runtime
 * config and is reconciled by the store at init (see memory-store.ts).
 *
 * Timestamps stay ISO-8601 TEXT (as in sqlite) with COLLATE "C", so string
 * comparisons match sqlite byte order regardless of the database locale.
 */

import type { Pool } from "pg";
import { qi, withTransaction } from "./client.js";

export interface Migration {
  version: number;
  name: string;
  sql: (s: string) => string;
}

const iso = `TEXT COLLATE "C" NOT NULL DEFAULT ''`;

export const MEMORY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "memory core tables",
    sql: (s) => `
      CREATE TABLE IF NOT EXISTS ${s}.embedding_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${s}.l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        tokens TEXT NOT NULL DEFAULT '',
        fts TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, tokens)) STORED,
        type TEXT NOT NULL DEFAULT '',
        priority INTEGER NOT NULL DEFAULT 50,
        scene_name TEXT NOT NULL DEFAULT '',
        session_key TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT 'default',
        team_id TEXT NOT NULL DEFAULT 'default',
        task_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default',
        version INTEGER NOT NULL DEFAULT 0,
        timestamp_str TEXT NOT NULL DEFAULT '',
        timestamp_start TEXT NOT NULL DEFAULT '',
        timestamp_end TEXT NOT NULL DEFAULT '',
        created_time ${iso},
        updated_time ${iso},
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_l1_fts ON ${s}.l1_records USING GIN (fts);
      CREATE INDEX IF NOT EXISTS idx_l1_updated ON ${s}.l1_records (updated_time);
      CREATE INDEX IF NOT EXISTS idx_l1_type ON ${s}.l1_records (type);
      CREATE INDEX IF NOT EXISTS idx_l1_session_updated ON ${s}.l1_records (session_id, updated_time);
      CREATE INDEX IF NOT EXISTS idx_l1_sessionkey_updated ON ${s}.l1_records (session_key, updated_time);
      CREATE INDEX IF NOT EXISTS idx_l1_task_updated ON ${s}.l1_records (task_id, updated_time);
      CREATE INDEX IF NOT EXISTS idx_l1_team_agent_updated ON ${s}.l1_records (team_id, agent_id, updated_time);
      CREATE INDEX IF NOT EXISTS idx_l1_user_agent_session ON ${s}.l1_records (user_id, agent_id, session_id);

      CREATE TABLE IF NOT EXISTS ${s}.l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        session_id TEXT NOT NULL DEFAULT 'default',
        team_id TEXT NOT NULL DEFAULT 'default',
        task_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT 'default',
        agent_id TEXT NOT NULL DEFAULT 'default',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        tokens TEXT NOT NULL DEFAULT '',
        fts TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, tokens)) STORED,
        recorded_at ${iso},
        timestamp BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_l0_fts ON ${s}.l0_conversations USING GIN (fts);
      CREATE INDEX IF NOT EXISTS idx_l0_session_recorded ON ${s}.l0_conversations (session_key, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_l0_session_id ON ${s}.l0_conversations (session_id);
      CREATE INDEX IF NOT EXISTS idx_l0_team_agent ON ${s}.l0_conversations (team_id, agent_id);
      CREATE INDEX IF NOT EXISTS idx_l0_user_agent_ts ON ${s}.l0_conversations (user_id, agent_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_l0_recorded ON ${s}.l0_conversations (recorded_at);
      CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON ${s}.l0_conversations (timestamp);

      CREATE TABLE IF NOT EXISTS ${s}.profiles (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('l2','l3')),
        filename TEXT COLLATE "C" NOT NULL,
        content TEXT NOT NULL,
        content_md5 TEXT NOT NULL DEFAULT '',
        team_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 0,
        created_at_ms BIGINT NOT NULL DEFAULT 0,
        updated_at_ms BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_scope ON ${s}.profiles (type, team_id, agent_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_profiles_filename ON ${s}.profiles (filename);

      CREATE TABLE IF NOT EXISTS ${s}.entity_teams (
        team_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        owner_user_id TEXT NOT NULL,
        user_ids TEXT[] NOT NULL DEFAULT '{}',
        agent_ids TEXT[] NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_teams_name ON ${s}.entity_teams (name);

      CREATE TABLE IF NOT EXISTS ${s}.entity_users (
        user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        job_description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_users_status ON ${s}.entity_users (status);

      CREATE TABLE IF NOT EXISTS ${s}.entity_agents (
        agent_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        owner_user_id TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'team',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_agents_team_status ON ${s}.entity_agents (team_id, status);
      CREATE INDEX IF NOT EXISTS idx_entity_agents_owner ON ${s}.entity_agents (owner_user_id);

      CREATE TABLE IF NOT EXISTS ${s}.entity_tasks (
        task_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        creator_user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        source_type TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT NOT NULL DEFAULT '',
        agent_ids TEXT[] NOT NULL DEFAULT '{}',
        user_ids TEXT[] NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_tasks_team ON ${s}.entity_tasks (team_id);

      CREATE TABLE IF NOT EXISTS ${s}.entity_knowledge (
        knowledge_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        service_url TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT,
        team_id TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        user_id TEXT,
        repo_url TEXT,
        branch TEXT,
        created_at TEXT COLLATE "C" NOT NULL,
        updated_at TEXT COLLATE "C" NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_knowledge_team_type ON ${s}.entity_knowledge (team_id, type);

      CREATE TABLE IF NOT EXISTS ${s}.memory_audit (
        audit_id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        layer TEXT NOT NULL CHECK (layer IN ('L1','L2','L3')),
        action TEXT NOT NULL CHECK (action IN ('update','delete')),
        team_id TEXT,
        agent_id TEXT,
        user_id TEXT,
        task_id TEXT,
        version INTEGER NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        request_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memory_audit_record ON ${s}.memory_audit (record_id, updated_at_ms);
      CREATE INDEX IF NOT EXISTS idx_memory_audit_isolation ON ${s}.memory_audit (team_id, agent_id, user_id, task_id);
      CREATE INDEX IF NOT EXISTS idx_memory_audit_time ON ${s}.memory_audit (updated_at_ms);

      CREATE TABLE IF NOT EXISTS ${s}.memory_prompts (
        memory_prompt_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        layer TEXT NOT NULL CHECK (layer IN ('l1','l2','l3')),
        prompt TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','deleting')),
        created_by TEXT,
        updated_by TEXT,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_prompts_layer_updated ON ${s}.memory_prompts (layer, updated_at_ms);

      CREATE TABLE IF NOT EXISTS ${s}.memory_prompt_settings (
        setting_id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK (target_type IN ('instance','team','agent')),
        team_id TEXT,
        agent_id TEXT,
        layer TEXT NOT NULL CHECK (layer IN ('l1','l2','l3')),
        memory_prompt_id TEXT NOT NULL,
        updated_by TEXT,
        updated_at_ms BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_prompt_settings_prompt ON ${s}.memory_prompt_settings (memory_prompt_id);
      CREATE INDEX IF NOT EXISTS idx_memory_prompt_settings_target
        ON ${s}.memory_prompt_settings (team_id, agent_id, layer);

      CREATE TABLE IF NOT EXISTS ${s}.memory_prompt_setting_logs (
        setting_log_id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK (target_type IN ('instance','team','agent')),
        team_id TEXT,
        agent_id TEXT,
        layer TEXT NOT NULL CHECK (layer IN ('l1','l2','l3')),
        action TEXT NOT NULL CHECK (action IN ('apply','replace','clear')),
        reason TEXT NOT NULL CHECK (reason IN ('explicit','prompt_deleted')),
        before_memory_prompt_id TEXT,
        after_memory_prompt_id TEXT,
        operator_id TEXT,
        operated_at_ms BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_prompt_logs_target
        ON ${s}.memory_prompt_setting_logs (team_id, agent_id, operated_at_ms);

      CREATE TABLE IF NOT EXISTS ${s}.memory_generation_refs (
        generation_ref_id TEXT PRIMARY KEY,
        layer TEXT NOT NULL CHECK (layer IN ('l1','l2','l3')),
        memory_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        generation_log_id TEXT NOT NULL,
        generation_log_key TEXT NOT NULL,
        memory_prompt_id TEXT NOT NULL,
        memory_prompt_version INTEGER NOT NULL,
        memory_prompt_source TEXT NOT NULL,
        created_at_ms BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_generation_refs_memory ON ${s}.memory_generation_refs (layer, memory_id);
    `,
  },
];

/**
 * Ensure the pgvector extension exists. Returns whether it is available;
 * lacking CREATE privilege is not fatal when a DBA installed it already.
 */
export async function ensureVectorExtension(pool: Pool): Promise<boolean> {
  try {
    await withTransaction(pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('tdai:create-extension'))");
      await c.query("CREATE EXTENSION IF NOT EXISTS vector");
    });
  } catch {
    /* fall through to the existence check */
  }
  const res = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
  return (res.rowCount ?? 0) > 0;
}

/** Create the schema and apply pending migrations of one component. Returns applied versions. */
export async function runMigrations(
  pool: Pool,
  schema: string,
  component: string,
  migrations: Migration[],
): Promise<number[]> {
  const s = qi(schema);
  return withTransaction(pool, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tdai:migrate:${schema}`]);
    await c.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await c.query(`
      CREATE TABLE IF NOT EXISTS ${s}.schema_migrations (
        component TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (component, version)
      )`);
    const done = await c.query<{ version: number }>(`SELECT version FROM ${s}.schema_migrations WHERE component = $1`, [
      component,
    ]);
    const have = new Set(done.rows.map((r) => r.version));
    const applied: number[] = [];
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (have.has(m.version)) continue;
      await c.query(m.sql(s));
      await c.query(`INSERT INTO ${s}.schema_migrations (component, version, name) VALUES ($1, $2, $3)`, [
        component,
        m.version,
        m.name,
      ]);
      applied.push(m.version);
    }
    return applied;
  });
}
