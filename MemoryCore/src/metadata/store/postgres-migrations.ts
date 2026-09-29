/**
 * Versioned DDL of the Postgres metadata store (`meta_*` tables), applied by
 * `runMigrations(pool, schema, "metadata", METADATA_MIGRATIONS)` from core/store/postgres.
 *
 * Mirrors sqlite-adapter.ts#createSchema column for column. Every TEXT column is
 * COLLATE "C" so equality and ORDER BY behave like SQLite's BINARY collation
 * (ISO timestamps sort as bytes), whatever the database locale.
 */

import type { Migration } from "../../core/store/postgres/migrations.js";

export const METADATA_COMPONENT = "metadata";

/** Tables owned by the metadata component; purge drops exactly these. */
export const METADATA_TABLES = [
  "meta_users",
  "meta_user_keys",
  "meta_teams",
  "meta_team_members",
  "meta_agents",
  "meta_tasks",
  "meta_task_agents",
  "meta_participation_logs",
  "meta_assets",
  "meta_agent_fixed_assets",
  "meta_asset_acl",
  "meta_config_params",
  "meta_instance_upstream_config",
] as const;

const T = `TEXT COLLATE "C"`;

export const METADATA_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "metadata tables",
    sql: (s) => `
      CREATE TABLE IF NOT EXISTS ${s}.meta_users (
        user_id ${T} PRIMARY KEY,
        password ${T},
        auth_provider ${T} NOT NULL,
        external_id ${T} NOT NULL,
        username ${T} NOT NULL,
        display_name ${T},
        email ${T},
        raw_profile_json ${T} NOT NULL DEFAULT '{}',
        status ${T} NOT NULL DEFAULT 'active',
        user_type ${T} NOT NULL DEFAULT 'normal',
        created_at ${T} NOT NULL,
        updated_at ${T} NOT NULL,
        metadata_json ${T} NOT NULL DEFAULT '{}'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_users_system_admin ON ${s}.meta_users (user_type) WHERE user_type = 'system_admin';
      CREATE INDEX IF NOT EXISTS idx_meta_users_auth_username ON ${s}.meta_users (auth_provider, username);
      CREATE INDEX IF NOT EXISTS idx_meta_users_auth_external ON ${s}.meta_users (auth_provider, external_id);
      CREATE INDEX IF NOT EXISTS idx_meta_users_email ON ${s}.meta_users (email) WHERE email IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_meta_users_created ON ${s}.meta_users (created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_user_keys (
        key_id ${T} PRIMARY KEY,
        user_id ${T} NOT NULL,
        key_value ${T} NOT NULL,
        name ${T},
        status ${T} NOT NULL DEFAULT 'active',
        is_default INTEGER NOT NULL DEFAULT 0,
        last_used_at ${T},
        expires_at ${T},
        created_at ${T} NOT NULL,
        revoked_at ${T},
        metadata_json ${T} NOT NULL DEFAULT '{}',
        CONSTRAINT meta_user_keys_key_value_key UNIQUE (key_value)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_user_keys_user ON ${s}.meta_user_keys (user_id, status);
      CREATE INDEX IF NOT EXISTS idx_meta_user_keys_user_created ON ${s}.meta_user_keys (user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_teams (
        team_id ${T} PRIMARY KEY,
        name ${T} NOT NULL,
        description ${T},
        owner_user_id ${T} NOT NULL,
        status ${T} NOT NULL DEFAULT 'active',
        created_at ${T} NOT NULL,
        updated_at ${T} NOT NULL,
        metadata_json ${T} NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_meta_teams_created ON ${s}.meta_teams (created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_team_members (
        id ${T} PRIMARY KEY,
        team_id ${T} NOT NULL,
        user_id ${T} NOT NULL,
        role ${T} NOT NULL DEFAULT 'member',
        joined_at ${T} NOT NULL,
        status ${T} NOT NULL DEFAULT 'active',
        UNIQUE (team_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_members_user_status ON ${s}.meta_team_members (user_id, status);
      CREATE INDEX IF NOT EXISTS idx_meta_members_team_status_joined ON ${s}.meta_team_members (team_id, status, joined_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_agents (
        agent_id ${T} PRIMARY KEY,
        team_id ${T} NOT NULL,
        owner_user_id ${T} NOT NULL,
        name ${T} NOT NULL,
        description ${T},
        prompt ${T},
        visibility ${T} NOT NULL DEFAULT 'team',
        status ${T} NOT NULL DEFAULT 'active',
        created_at ${T} NOT NULL,
        updated_at ${T} NOT NULL,
        metadata_json ${T} NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_meta_agents_team_status ON ${s}.meta_agents (team_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_agents_owner_status_created ON ${s}.meta_agents (owner_user_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_tasks (
        task_id ${T} PRIMARY KEY,
        team_id ${T} NOT NULL,
        creator_user_id ${T} NOT NULL,
        title ${T} NOT NULL,
        description ${T},
        source_type ${T} NOT NULL DEFAULT 'manual',
        source_url ${T},
        status ${T} NOT NULL DEFAULT 'running',
        auto_assign_floating_assets INTEGER NOT NULL DEFAULT 0,
        risk_level ${T},
        created_at ${T} NOT NULL,
        updated_at ${T} NOT NULL,
        metadata_json ${T} NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_meta_tasks_team_status ON ${s}.meta_tasks (team_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_tasks_creator_status_created ON ${s}.meta_tasks (creator_user_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_task_agents (
        id ${T} PRIMARY KEY,
        task_id ${T} NOT NULL,
        agent_id ${T} NOT NULL,
        role_in_task ${T},
        status ${T} NOT NULL DEFAULT 'active',
        created_at ${T} NOT NULL,
        UNIQUE (task_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_task_agents_task_status_created ON ${s}.meta_task_agents (task_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_participation_logs (
        id ${T} PRIMARY KEY,
        team_id ${T} NOT NULL,
        task_id ${T} NOT NULL,
        agent_id ${T} NOT NULL,
        user_id ${T} NOT NULL,
        source ${T} NOT NULL DEFAULT 'unknown',
        metadata_json ${T} NOT NULL DEFAULT '{}',
        created_at ${T} NOT NULL,
        updated_at ${T} NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_meta_pl_team_created ON ${s}.meta_participation_logs (team_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_pl_team_task_agent_created ON ${s}.meta_participation_logs (team_id, task_id, agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_pl_team_user_created ON ${s}.meta_participation_logs (team_id, user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_pl_team_dims_created ON ${s}.meta_participation_logs (team_id, task_id, agent_id, user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_assets (
        asset_id ${T} PRIMARY KEY,
        team_id ${T} NOT NULL,
        asset_type ${T} NOT NULL,
        name ${T} NOT NULL,
        description ${T},
        owner_user_id ${T} NOT NULL,
        source_type ${T} NOT NULL,
        source_ref ${T},
        version INTEGER NOT NULL DEFAULT 1,
        visibility ${T} NOT NULL DEFAULT 'team',
        status ${T} NOT NULL DEFAULT 'draft',
        confidence DOUBLE PRECISION,
        expires_at ${T},
        last_used_at ${T},
        usage_count INTEGER NOT NULL DEFAULT 0,
        content_ref ${T},
        created_at ${T} NOT NULL,
        updated_at ${T} NOT NULL,
        metadata_json ${T} NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_meta_assets_team_status ON ${s}.meta_assets (team_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_agent_fixed_assets (
        id ${T} PRIMARY KEY,
        agent_id ${T} NOT NULL,
        asset_id ${T} NOT NULL,
        asset_type ${T} NOT NULL,
        injection_mode ${T} NOT NULL DEFAULT 'summary',
        priority INTEGER NOT NULL DEFAULT 50,
        created_by ${T} NOT NULL,
        created_at ${T} NOT NULL,
        UNIQUE (agent_id, asset_id)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_fixed_agent_prio_created ON ${s}.meta_agent_fixed_assets (agent_id, priority DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_asset_acl (
        id ${T} PRIMARY KEY,
        asset_id ${T} NOT NULL,
        subject_type ${T} NOT NULL,
        subject_id ${T} NOT NULL,
        permission ${T} NOT NULL,
        effect ${T} NOT NULL DEFAULT 'allow',
        granted_by ${T} NOT NULL,
        created_at ${T} NOT NULL,
        updated_at ${T} NOT NULL,
        UNIQUE (asset_id, subject_type, subject_id, permission)
      );
      CREATE INDEX IF NOT EXISTS idx_meta_acl_asset_created ON ${s}.meta_asset_acl (asset_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meta_acl_subject_created ON ${s}.meta_asset_acl (subject_type, subject_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ${s}.meta_config_params (
        id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        scope ${T} NOT NULL CHECK (scope IN ('global', 'user')),
        user_id ${T},
        module ${T} NOT NULL,
        param_name ${T} NOT NULL,
        param_value ${T} NOT NULL,
        description ${T} NOT NULL,
        created_at ${T} NOT NULL,
        updated_at ${T} NOT NULL,
        CHECK (
          (scope = 'global' AND user_id IS NULL) OR
          (scope = 'user' AND user_id IS NOT NULL)
        )
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_config_params_global
        ON ${s}.meta_config_params (module, param_name) WHERE scope = 'global';
      CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_config_params_user
        ON ${s}.meta_config_params (user_id, module, param_name) WHERE scope = 'user';
      CREATE INDEX IF NOT EXISTS idx_meta_config_params_module ON ${s}.meta_config_params (module);

      CREATE TABLE IF NOT EXISTS ${s}.meta_instance_upstream_config (
        id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        agent_source ${T} NOT NULL DEFAULT 'default',
        type ${T} NOT NULL DEFAULT 'conversation' CHECK (type IN ('conversation', 'extraction')),
        mode ${T} NOT NULL DEFAULT 'official' CHECK (mode IN ('official', 'custom_unified', 'custom_passthrough')),
        base_url ${T} NOT NULL DEFAULT '',
        api_key ${T} NOT NULL DEFAULT '',
        model_id ${T} NOT NULL DEFAULT '',
        description ${T} NOT NULL DEFAULT '',
        created_at ${T} NOT NULL,
        updated_at ${T} NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_meta_iuc_agent_type
        ON ${s}.meta_instance_upstream_config (agent_source, type);
    `,
  },
];
