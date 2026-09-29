/**
 * PostgreSQL implementation of IMetadataStore (`meta_*` tables).
 *
 * A port of sqlite-adapter.ts that keeps its SQL almost verbatim: statements are
 * written with `?` placeholders and bare `meta_*` table names, and `prep()`
 * rewrites them to `$n` and to schema-qualified names. All values are bound; the
 * only interpolated identifier is the schema, validated by `qi()`.
 *
 * Compound writes (createUser + default key, createTeam + admin member, createTask +
 * links, setAgentFixedAssets, deleteAssets) run in one transaction. Tables come from
 * versioned migrations (postgres-migrations.ts) applied at init under an advisory lock.
 * The pg.Pool is shared per URL (core/store/postgres/client.ts); close() never ends it.
 */

import type { Pool, PoolClient } from "pg";
import { getSharedPostgresPool, qi, withTransaction } from "../../core/store/postgres/client.js";
import { runMigrations } from "../../core/store/postgres/migrations.js";
import { assertSchemaName } from "../../core/store/postgres/config.js";
import { METADATA_COMPONENT, METADATA_MIGRATIONS, METADATA_TABLES } from "./postgres-migrations.js";
import { mapTeamMemberWithProfile } from "./team-member-view.js";
import { generateId, generateRelationId, ID_PREFIX } from "../utils/id-generator.js";
import { RELATION_ID_RETRY_LIMIT } from "./relation-id-insert.js";
import { generateUserKey } from "../utils/crypto.js";
import { isUserKeyExpired } from "../utils/user-key.js";
import type {
  UserEntity,
  UserKeyEntity,
  TeamEntity,
  TeamMemberEntity,
  TeamMemberView,
  AgentEntity,
  TaskEntity,
  TaskAgentEntity,
  ParticipationLogEntity,
  AppendParticipationLogInput,
  ParticipationLogFilter,
  AssetEntity,
  FixedAssetBindingEntity,
  AclEntity,
  CreateUserInput,
  CreateUserKeyInput,
  CreateTeamInput,
  AddTeamMemberInput,
  CreateAgentInput,
  CreateTaskInput,
  CreateAssetInput,
  FixedAssetBindingInput,
  GrantAclInput,
  AgentFilter,
  TaskFilter,
  AssetFilter,
  BatchDeleteResult,
  ListPage,
  PaginationParams,
  InstanceUserListFilter,
  AgentFixedAssetCountRow,
  AssetType,
  ConfigParamEntity,
  UpsertConfigParamInput,
  ListConfigParamsFilter,
  InstanceUpstreamConfigEntity,
  UpsertInstanceUpstreamConfigInput,
  InstanceUpstreamConfigFilter,
  UpstreamConfigType,
} from "../types.js";
import { DEFAULT_PAGINATION } from "../pagination.js";
import { buildChatMemoryAssetId } from "../utils/chat-memory-asset.js";
import { DuplicateUserKeyError, type IMetadataStore } from "./interface.js";

export interface PostgresMetadataStoreOptions {
  /** Connection URL; the shared pool for it is used. Ignored when `pool` is given. */
  url?: string;
  pool?: Pool;
  schema: string;
  poolMax?: number;
}

type Row = Record<string, unknown>;
type Queryable = Pool | PoolClient;

const PK_RETRY_LIMIT = 3;
const TABLE_RE = new RegExp(`\\b(${[...METADATA_TABLES].sort((a, b) => b.length - a.length).join("|")})\\b`, "g");
const UPDATED_AT_TABLES = ["meta_users", "meta_teams", "meta_agents", "meta_tasks", "meta_assets"];

function nowIso(): string {
  return new Date().toISOString();
}

function pgConstraint(err: unknown): string | null {
  const e = err as { code?: string; constraint?: string } | null;
  return e && e.code === "23505" ? (e.constraint ?? "") : null;
}

/** Unique violation on a table's primary key (generated user_id/team_id/…/relation id). */
function isPkCollision(err: unknown): boolean {
  const c = pgConstraint(err);
  return c !== null && c.endsWith("_pkey");
}

function isUserKeyValueCollision(err: unknown): boolean {
  return pgConstraint(err) === "meta_user_keys_key_value_key";
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

export class PostgresMetadataStore implements IMetadataStore {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly s: string;
  private readonly prepared = new Map<string, string>();
  private initPromise: Promise<void> | null = null;

  constructor(opts: PostgresMetadataStoreOptions) {
    this.schema = assertSchemaName(opts.schema);
    this.s = qi(this.schema);
    this.pool = opts.pool ?? getSharedPostgresPool(opts.url ?? "", opts.poolMax ?? 10);
  }

  get schemaName(): string {
    return this.schema;
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = runMigrations(this.pool, this.schema, METADATA_COMPONENT, METADATA_MIGRATIONS).then(
        () => undefined,
      );
      this.initPromise.catch(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  /** The pool is shared per URL; ending it is closeSharedPostgresPools()'s job. */
  async close(): Promise<void> {
    this.initPromise = null;
  }

  /**
   * Drop this store's tables and migration rows; drop the schema too when nothing
   * else lives in it (the schema may be shared with other components).
   */
  async purge(): Promise<void> {
    await withTransaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tdai:migrate:${this.schema}`]);
      const exists = await c.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [this.schema]);
      if ((exists.rowCount ?? 0) === 0) return;
      for (const t of METADATA_TABLES) {
        await c.query(`DROP TABLE IF EXISTS ${this.s}.${t} CASCADE`);
      }
      const hasMig = await c.query(
        "SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = 'schema_migrations'",
        [this.schema],
      );
      if ((hasMig.rowCount ?? 0) > 0) {
        await c.query(`DELETE FROM ${this.s}.schema_migrations WHERE component = $1`, [METADATA_COMPONENT]);
      }
      const others = await c.query<{ n: number }>(
        `SELECT
           (SELECT count(*) FROM pg_class WHERE relnamespace = $1::regnamespace AND relname <> 'schema_migrations'
              AND relkind IN ('r','p','v','m','f','S'))
         + (SELECT count(*) FROM pg_proc WHERE pronamespace = $1::regnamespace) AS n`,
        [this.schema],
      );
      let empty = Number(others.rows[0]?.n ?? 0) === 0;
      if (empty && (hasMig.rowCount ?? 0) > 0) {
        const left = await c.query(`SELECT 1 FROM ${this.s}.schema_migrations LIMIT 1`);
        empty = (left.rowCount ?? 0) === 0;
      }
      if (empty) await c.query(`DROP SCHEMA ${this.s} CASCADE`);
    });
    this.initPromise = null;
  }

  // ============================================================
  // SQL helpers
  // ============================================================

  /** `?` → `$n`, `meta_x` → `"schema".meta_x`. */
  private prep(sql: string): string {
    let out = this.prepared.get(sql);
    if (out === undefined) {
      let n = 0;
      out = sql.replace(TABLE_RE, (t) => `${this.s}.${t}`).replace(/\?/g, () => `$${++n}`);
      this.prepared.set(sql, out);
    }
    return out;
  }

  private async get<T = Row>(sql: string, params: unknown[] = [], c: Queryable = this.pool): Promise<T | null> {
    const res = await c.query(this.prep(sql), params);
    return (res.rows[0] as T | undefined) ?? null;
  }

  private async all<T = Row>(sql: string, params: unknown[] = [], c: Queryable = this.pool): Promise<T[]> {
    const res = await c.query(this.prep(sql), params);
    return res.rows as T[];
  }

  private async run(sql: string, params: unknown[] = [], c: Queryable = this.pool): Promise<number> {
    const res = await c.query(this.prep(sql), params);
    return res.rowCount ?? 0;
  }

  private tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, fn);
  }

  private async selectList<T>(
    countSql: string,
    countParams: unknown[],
    dataSql: string,
    dataParams: unknown[],
    pagination: PaginationParams | null | undefined,
    mapper: (row: Row) => T | null,
  ): Promise<ListPage<T>> {
    const totalRow = await this.get<{ c: number }>(countSql, countParams);
    const total = Number(totalRow?.c ?? 0);
    const p = pagination ?? DEFAULT_PAGINATION;
    const rows = await this.all(`${dataSql} LIMIT ? OFFSET ?`, [...dataParams, p.limit, p.offset]);
    const items: T[] = [];
    for (const r of rows) {
      const mapped = mapper(r);
      if (mapped) items.push(mapped);
    }
    return { items, total };
  }

  /** Insert with a generated relation id, retrying on an id collision (not on other conflicts). */
  private async withRelationId(fixedId: string | undefined, insert: (id: string) => Promise<unknown>): Promise<void> {
    if (fixedId) {
      await insert(fixedId);
      return;
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < RELATION_ID_RETRY_LIMIT; attempt++) {
      try {
        await insert(generateRelationId());
        return;
      } catch (err) {
        if (!isPkCollision(err)) throw err;
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("relation id collision after max retries");
  }

  private async insertUserKeyRow(
    input: {
      user_id: string;
      key_value: string;
      name?: string | null;
      is_default?: boolean;
      expires_at?: string | null;
      created_at?: string;
      metadata_json?: string;
    },
    c?: PoolClient,
  ): Promise<UserKeyEntity> {
    const now = input.created_at ?? nowIso();
    // Inside a transaction a failed INSERT aborts it, so only retry when running standalone.
    const attempts = c ? 1 : PK_RETRY_LIMIT;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const keyId = generateId(ID_PREFIX.userKey);
      try {
        await this.run(
          `INSERT INTO meta_user_keys
            (key_id, user_id, key_value, name, status, is_default, last_used_at, expires_at, created_at, revoked_at, metadata_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            keyId,
            input.user_id,
            input.key_value,
            input.name ?? null,
            "active",
            input.is_default ? 1 : 0,
            null,
            input.expires_at ?? null,
            now,
            null,
            input.metadata_json ?? "{}",
          ],
          c,
        );
        return (await this.getUserKeyByIdOn(keyId, c))!;
      } catch (err) {
        if (isPkCollision(err) && attempt + 1 < attempts) continue;
        throw err;
      }
    }
    throw new Error("user key PK collision after max retries");
  }

  private mapUserKey(row: Row | null | undefined): UserKeyEntity | null {
    if (!row) return null;
    return {
      key_id: String(row.key_id),
      user_id: String(row.user_id),
      key_value: String(row.key_value),
      name: row.name != null ? String(row.name) : null,
      status: String(row.status) as UserKeyEntity["status"],
      is_default: Number(row.is_default) === 1,
      last_used_at: row.last_used_at != null ? String(row.last_used_at) : null,
      expires_at: row.expires_at != null ? String(row.expires_at) : null,
      created_at: String(row.created_at),
      revoked_at: row.revoked_at != null ? String(row.revoked_at) : null,
      metadata_json: String(row.metadata_json ?? "{}"),
    };
  }

  // ============================================================
  // User
  // ============================================================
  async createUser(input: CreateUserInput): Promise<UserEntity> {
    const now = nowIso();
    const defaultKeyValue = input.default_key_value ?? generateUserKey();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const userId = input.user_id ?? generateId(ID_PREFIX.user);
      try {
        return await this.tx(async (c) => {
          await this.run(
            `INSERT INTO meta_users
              (user_id, password, auth_provider, external_id, username,
               display_name, email, raw_profile_json, status, user_type, created_at, updated_at, metadata_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              userId,
              input.password ?? null,
              input.auth_provider as string,
              input.external_id as string,
              input.username as string,
              input.display_name ?? null,
              input.email ?? null,
              input.raw_profile_json ?? "{}",
              input.status ?? "active",
              input.user_type ?? "normal",
              now,
              now,
              input.metadata_json ?? "{}",
            ],
            c,
          );
          await this.insertUserKeyRow({ user_id: userId, key_value: defaultKeyValue, is_default: true, created_at: now }, c);
          return this.mapUser(await this.get("SELECT * FROM meta_users WHERE user_id = ?", [userId], c))!;
        });
      } catch (err) {
        if (isUserKeyValueCollision(err)) throw new DuplicateUserKeyError(defaultKeyValue);
        if (isPkCollision(err) && !input.user_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getUserById(userId: string): Promise<UserEntity | null> {
    return this.mapUser(await this.get("SELECT * FROM meta_users WHERE user_id = ?", [userId]));
  }

  async getUserByKey(userKey: string): Promise<UserEntity | null> {
    const keyRow = this.mapUserKey(
      await this.get("SELECT * FROM meta_user_keys WHERE key_value = ? AND status = 'active'", [userKey]),
    );
    if (!keyRow || isUserKeyExpired(keyRow.expires_at)) return null;
    await this.touchUserKeyUsage(keyRow.key_id);
    return this.getUserById(keyRow.user_id);
  }

  async getDefaultUserKey(userId: string): Promise<UserKeyEntity | null> {
    return this.mapUserKey(
      await this.get(
        "SELECT * FROM meta_user_keys WHERE user_id = ? AND is_default = 1 AND status = 'active' LIMIT 1",
        [userId],
      ),
    );
  }

  async getUserByUsername(authProvider: string, username: string): Promise<UserEntity | null> {
    return this.mapUser(
      await this.get("SELECT * FROM meta_users WHERE auth_provider = ? AND username = ?", [authProvider, username]),
    );
  }

  async getUserByEmail(email: string): Promise<UserEntity | null> {
    return this.mapUser(await this.get("SELECT * FROM meta_users WHERE email = ?", [email]));
  }

  async getUserByExternalId(authProvider: string, externalId: string): Promise<UserEntity | null> {
    return this.mapUser(
      await this.get("SELECT * FROM meta_users WHERE auth_provider = ? AND external_id = ?", [authProvider, externalId]),
    );
  }

  async updateUser(userId: string, patch: Partial<UserEntity>): Promise<UserEntity | null> {
    // Same whitelist as sqlite: external_id/auth_provider are written when binding external auth.
    const allowed = [
      "password",
      "display_name",
      "email",
      "raw_profile_json",
      "status",
      "metadata_json",
      "username",
      "external_id",
      "auth_provider",
    ] as const;
    await this.applyUpdate("meta_users", "user_id", userId, allowed, patch);
    return this.getUserById(userId);
  }

  async deleteUsers(userIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_users", "user_id", userIds);
    if (result.deleted_ids.length > 0) {
      const ph = placeholders(result.deleted_ids.length);
      await this.run(`DELETE FROM meta_user_keys WHERE user_id IN (${ph})`, result.deleted_ids);
      await this.run(`DELETE FROM meta_team_members WHERE user_id IN (${ph})`, result.deleted_ids);
      await this.run(
        `DELETE FROM meta_asset_acl WHERE subject_type = 'user' AND subject_id IN (${ph})`,
        result.deleted_ids,
      );
    }
    return result;
  }

  async listUsersByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): Promise<ListPage<UserEntity>> {
    let base =
      "FROM meta_users u JOIN meta_team_members m ON m.user_id = u.user_id WHERE m.team_id = ? AND m.status = 'active'";
    const params: unknown[] = [teamId];
    if (filter?.user_ids?.length) {
      base += ` AND u.user_id IN (${placeholders(filter.user_ids.length)})`;
      params.push(...filter.user_ids);
    }
    if (filter?.username) {
      base += " AND u.username = ?";
      params.push(filter.username);
    }
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      params,
      `SELECT u.* ${base} ORDER BY u.created_at DESC`,
      params,
      pagination,
      (r) => this.mapUser(r),
    );
  }

  async listUsers(pagination?: PaginationParams | null, filter?: InstanceUserListFilter): Promise<ListPage<UserEntity>> {
    let where = "WHERE 1=1";
    const params: unknown[] = [];
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.user_type) {
      where += " AND user_type = ?";
      params.push(filter.user_type);
    }
    if (filter?.user_ids?.length) {
      where += ` AND user_id IN (${placeholders(filter.user_ids.length)})`;
      params.push(...filter.user_ids);
    }
    if (filter?.username) {
      where += " AND username = ?";
      params.push(filter.username);
    }
    return this.selectList(
      `SELECT COUNT(*) AS c FROM meta_users ${where}`,
      params,
      `SELECT * FROM meta_users ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapUser(r),
    );
  }

  async countUsers(): Promise<number> {
    return Number((await this.get<{ c: number }>("SELECT COUNT(*) AS c FROM meta_users"))?.c ?? 0);
  }

  async countSystemAdmins(): Promise<number> {
    const row = await this.get<{ c: number }>("SELECT COUNT(*) AS c FROM meta_users WHERE user_type = 'system_admin'");
    return Number(row?.c ?? 0);
  }

  async countTeams(): Promise<number> {
    return Number((await this.get<{ c: number }>("SELECT COUNT(*) AS c FROM meta_teams"))?.c ?? 0);
  }

  // ============================================================
  // UserKey
  // ============================================================
  async createUserKey(input: CreateUserKeyInput): Promise<UserKeyEntity> {
    if (input.is_default) {
      await this.run("UPDATE meta_user_keys SET is_default = 0 WHERE user_id = ? AND status = 'active'", [
        input.user_id,
      ]);
    }
    try {
      return await this.insertUserKeyRow({
        user_id: input.user_id,
        key_value: input.key_value ?? generateUserKey(),
        name: input.name,
        is_default: input.is_default ?? false,
        expires_at: input.expires_at,
        metadata_json: input.metadata_json,
      });
    } catch (err) {
      if (isUserKeyValueCollision(err) && input.key_value) throw new DuplicateUserKeyError(input.key_value);
      throw err;
    }
  }

  private async getUserKeyByIdOn(keyId: string, c?: Queryable): Promise<UserKeyEntity | null> {
    return this.mapUserKey(await this.get("SELECT * FROM meta_user_keys WHERE key_id = ?", [keyId], c));
  }

  async getUserKeyById(keyId: string): Promise<UserKeyEntity | null> {
    return this.getUserKeyByIdOn(keyId);
  }

  async listUserKeys(userId: string, pagination?: PaginationParams | null): Promise<ListPage<UserKeyEntity>> {
    const base = "FROM meta_user_keys WHERE user_id = ?";
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [userId],
      `SELECT * ${base} ORDER BY created_at DESC`,
      [userId],
      pagination,
      (r) => this.mapUserKey(r),
    );
  }

  async countActiveUserKeys(userId: string): Promise<number> {
    const row = await this.get("SELECT COUNT(*) AS c FROM meta_user_keys WHERE user_id = ? AND status = 'active'", [
      userId,
    ]);
    return Number(row?.c ?? 0);
  }

  async revokeUserKey(keyId: string, options?: { promoteNextDefault?: boolean }): Promise<UserKeyEntity | null> {
    const promoteNextDefault = options?.promoteNextDefault ?? true;
    const existing = await this.getUserKeyById(keyId);
    if (!existing) return null;
    await this.tx(async (c) => {
      if (existing.is_default && promoteNextDefault) {
        await this.run("UPDATE meta_user_keys SET is_default = 0 WHERE key_id = ?", [keyId], c);
        const next = await this.get(
          `SELECT * FROM meta_user_keys WHERE user_id = ? AND status = 'active' AND key_id != ? ORDER BY created_at ASC LIMIT 1`,
          [existing.user_id, keyId],
          c,
        );
        if (next) {
          await this.run("UPDATE meta_user_keys SET is_default = 1 WHERE key_id = ?", [String(next.key_id)], c);
        }
      }
      await this.run("DELETE FROM meta_user_keys WHERE key_id = ?", [keyId], c);
    });
    return existing;
  }

  async updateUserKey(
    keyId: string,
    patch: Partial<Pick<UserKeyEntity, "name" | "expires_at" | "is_default" | "metadata_json">>,
  ): Promise<UserKeyEntity | null> {
    const existing = await this.getUserKeyById(keyId);
    if (!existing) return null;
    if (patch.is_default === true) {
      await this.run("UPDATE meta_user_keys SET is_default = 0 WHERE user_id = ? AND status = 'active'", [
        existing.user_id,
      ]);
    }
    const allowed = ["name", "expires_at", "is_default", "metadata_json"] as const;
    await this.applyUpdate("meta_user_keys", "key_id", keyId, allowed, {
      ...patch,
      is_default: patch.is_default === undefined ? undefined : patch.is_default ? 1 : 0,
    } as Partial<UserKeyEntity>);
    return this.getUserKeyById(keyId);
  }

  async touchUserKeyUsage(keyId: string): Promise<void> {
    await this.run("UPDATE meta_user_keys SET last_used_at = ? WHERE key_id = ?", [nowIso(), keyId]);
  }

  async revokeAllUserKeysForUser(userId: string): Promise<void> {
    await this.run("DELETE FROM meta_user_keys WHERE user_id = ? AND status = 'active'", [userId]);
  }

  // ============================================================
  // Team (owner becomes admin member atomically)
  // ============================================================
  async createTeam(input: CreateTeamInput): Promise<TeamEntity> {
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const teamId = input.team_id ?? generateId(ID_PREFIX.team);
      try {
        return await this.tx(async (c) => {
          await this.run(
            `INSERT INTO meta_teams
              (team_id, name, description, owner_user_id, status, created_at, updated_at, metadata_json)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              teamId,
              input.name,
              input.description ?? null,
              input.owner_user_id,
              input.status ?? "active",
              now,
              now,
              input.metadata_json ?? "{}",
            ],
            c,
          );
          await this.run(
            `INSERT INTO meta_team_members (id, team_id, user_id, role, joined_at, status) VALUES (?,?,?,?,?,?)`,
            [generateRelationId(), teamId, input.owner_user_id, "admin", now, "active"],
            c,
          );
          return this.mapTeam(await this.get("SELECT * FROM meta_teams WHERE team_id = ?", [teamId], c))!;
        });
      } catch (err) {
        if (pgConstraint(err) === "meta_team_members_pkey") continue;
        if (isPkCollision(err) && !input.team_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getTeamById(teamId: string): Promise<TeamEntity | null> {
    return this.mapTeam(await this.get("SELECT * FROM meta_teams WHERE team_id = ?", [teamId]));
  }

  async updateTeam(teamId: string, patch: Partial<TeamEntity>): Promise<TeamEntity | null> {
    const allowed = ["name", "description", "status", "metadata_json"] as const;
    await this.applyUpdate("meta_teams", "team_id", teamId, allowed, patch);
    return this.getTeamById(teamId);
  }

  async deleteTeams(teamIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_teams", "team_id", teamIds);
    if (result.deleted_ids.length > 0) {
      const ph = placeholders(result.deleted_ids.length);
      await this.run(`DELETE FROM meta_team_members WHERE team_id IN (${ph})`, result.deleted_ids);
      await this.run(`DELETE FROM meta_agents WHERE team_id IN (${ph})`, result.deleted_ids);
      await this.run(`DELETE FROM meta_tasks WHERE team_id IN (${ph})`, result.deleted_ids);
      await this.run(`DELETE FROM meta_assets WHERE team_id IN (${ph})`, result.deleted_ids);
    }
    return result;
  }

  async listTeamsByUser(
    userId: string,
    pagination?: PaginationParams | null,
    filter?: { name?: string },
  ): Promise<ListPage<TeamEntity>> {
    let base =
      "FROM meta_teams t JOIN meta_team_members m ON m.team_id = t.team_id WHERE m.user_id = ? AND m.status = 'active'";
    const params: unknown[] = [userId];
    if (filter?.name) {
      base += " AND t.name = ?";
      params.push(filter.name);
    }
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      params,
      `SELECT t.* ${base} ORDER BY t.created_at DESC`,
      params,
      pagination,
      (r) => this.mapTeam(r),
    );
  }

  // ============================================================
  // TeamMember
  // ============================================================
  async addTeamMember(input: AddTeamMemberInput): Promise<TeamMemberEntity> {
    const now = nowIso();
    await this.withRelationId(input.id, (id) =>
      this.run(
        `INSERT INTO meta_team_members (id, team_id, user_id, role, joined_at, status)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role, status = excluded.status`,
        [id, input.team_id, input.user_id, input.role ?? "member", now, input.status ?? "active"],
      ),
    );
    return (await this.getTeamMember(input.team_id, input.user_id))!;
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.run("DELETE FROM meta_team_members WHERE team_id = ? AND user_id = ?", [teamId, userId]);
  }

  async listTeamMembers(teamId: string, pagination?: PaginationParams | null): Promise<ListPage<TeamMemberEntity>> {
    const base = "FROM meta_team_members WHERE team_id = ? AND status = 'active'";
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [teamId],
      `SELECT * ${base} ORDER BY joined_at DESC`,
      [teamId],
      pagination,
      (r) => r as unknown as TeamMemberEntity,
    );
  }

  async getTeamMember(teamId: string, userId: string): Promise<TeamMemberEntity | null> {
    return this.get<TeamMemberEntity>("SELECT * FROM meta_team_members WHERE team_id = ? AND user_id = ?", [
      teamId,
      userId,
    ]);
  }

  async listTeamMembersWithProfile(
    teamId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<TeamMemberView>> {
    const base =
      "FROM meta_team_members m LEFT JOIN meta_users u ON u.user_id = m.user_id WHERE m.team_id = ? AND m.status = 'active'";
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [teamId],
      `SELECT m.id, m.team_id, m.user_id, m.role, m.joined_at, m.status, COALESCE(u.username, '') AS username ${base} ORDER BY m.joined_at DESC`,
      [teamId],
      pagination,
      (r) => mapTeamMemberWithProfile(r as unknown as TeamMemberEntity & { username?: string }),
    );
  }

  async getTeamMemberWithProfile(teamId: string, userId: string): Promise<TeamMemberView | null> {
    const row = await this.get<TeamMemberEntity & { username?: string }>(
      `SELECT m.id, m.team_id, m.user_id, m.role, m.joined_at, m.status, COALESCE(u.username, '') AS username
       FROM meta_team_members m
       LEFT JOIN meta_users u ON u.user_id = m.user_id
       WHERE m.team_id = ? AND m.user_id = ?`,
      [teamId, userId],
    );
    return row ? mapTeamMemberWithProfile(row) : null;
  }

  // ============================================================
  // Agent
  // ============================================================
  async createAgent(input: CreateAgentInput): Promise<AgentEntity> {
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const agentId = input.agent_id ?? generateId(ID_PREFIX.agent);
      try {
        await this.run(
          `INSERT INTO meta_agents
            (agent_id, team_id, owner_user_id, name, description, prompt, visibility, status, created_at, updated_at, metadata_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            agentId,
            input.team_id,
            input.owner_user_id,
            input.name,
            input.description ?? null,
            input.prompt ?? null,
            input.visibility ?? "team",
            input.status ?? "active",
            now,
            now,
            input.metadata_json ?? "{}",
          ],
        );
        return (await this.getAgentById(agentId))!;
      } catch (err) {
        if (isPkCollision(err) && !input.agent_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getAgentById(agentId: string): Promise<AgentEntity | null> {
    return this.mapAgent(await this.get("SELECT * FROM meta_agents WHERE agent_id = ?", [agentId]));
  }

  async updateAgent(agentId: string, patch: Partial<AgentEntity>): Promise<AgentEntity | null> {
    const allowed = ["name", "description", "prompt", "visibility", "status", "metadata_json"] as const;
    await this.applyUpdate("meta_agents", "agent_id", agentId, allowed, patch);
    return this.getAgentById(agentId);
  }

  async deleteAgents(agentIds: string[]): Promise<BatchDeleteResult> {
    const selfMemoryByAgent = new Map<string, string>();
    for (const agentId of agentIds) {
      const agent = await this.getAgentById(agentId);
      if (agent) selfMemoryByAgent.set(agent.agent_id, buildChatMemoryAssetId(agent.team_id, agent.agent_id));
    }

    const result = await this.batchDelete("meta_agents", "agent_id", agentIds);
    if (result.deleted_ids.length > 0) {
      const ph = placeholders(result.deleted_ids.length);
      await this.run(`DELETE FROM meta_task_agents WHERE agent_id IN (${ph})`, result.deleted_ids);
      await this.run(`DELETE FROM meta_agent_fixed_assets WHERE agent_id IN (${ph})`, result.deleted_ids);
      const selfMemoryAssetIds: string[] = [];
      for (const agentId of result.deleted_ids) {
        const assetId = selfMemoryByAgent.get(agentId);
        if (assetId) selfMemoryAssetIds.push(assetId);
      }
      if (selfMemoryAssetIds.length > 0) await this.deleteAssets(selfMemoryAssetIds);
    }
    return result;
  }

  async listAgentsByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: AgentFilter,
  ): Promise<ListPage<AgentEntity>> {
    let where = "WHERE team_id = ?";
    const params: unknown[] = [teamId];
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.owner_user_id) {
      where += " AND owner_user_id = ?";
      params.push(filter.owner_user_id);
    }
    if (filter?.name) {
      where += " AND name = ?";
      params.push(filter.name);
    }
    return this.selectList(
      `SELECT COUNT(*) AS c FROM meta_agents ${where}`,
      params,
      `SELECT * FROM meta_agents ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapAgent(r),
    );
  }

  async listAgentsByOwner(
    userId: string,
    pagination?: PaginationParams | null,
    filter?: AgentFilter,
  ): Promise<ListPage<AgentEntity>> {
    let where = "WHERE owner_user_id = ?";
    const params: unknown[] = [userId];
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.name) {
      where += " AND name = ?";
      params.push(filter.name);
    }
    return this.selectList(
      `SELECT COUNT(*) AS c FROM meta_agents ${where}`,
      params,
      `SELECT * FROM meta_agents ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapAgent(r),
    );
  }

  // ============================================================
  // Task (+ linked agents atomically)
  // ============================================================
  async createTask(input: CreateTaskInput): Promise<TaskEntity> {
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const taskId = input.task_id ?? generateId(ID_PREFIX.task);
      try {
        return await this.tx(async (c) => {
          await this.run(
            `INSERT INTO meta_tasks
              (task_id, team_id, creator_user_id, title, description, source_type, source_url,
               status, auto_assign_floating_assets, risk_level, created_at, updated_at, metadata_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              taskId,
              input.team_id,
              input.creator_user_id,
              input.title,
              input.description ?? null,
              input.source_type ?? "manual",
              input.source_url ?? null,
              input.status ?? "running",
              input.auto_assign_floating_assets ? 1 : 0,
              input.risk_level ?? null,
              now,
              now,
              input.metadata_json ?? "{}",
            ],
            c,
          );
          for (const link of input.linked_agents ?? []) {
            await this.run(
              `INSERT INTO meta_task_agents (id, task_id, agent_id, role_in_task, status, created_at)
               VALUES (?,?,?,?,?,?)`,
              [generateRelationId(), taskId, link.agent_id, link.role_in_task ?? null, "active", now],
              c,
            );
          }
          return this.mapTask(await this.get("SELECT * FROM meta_tasks WHERE task_id = ?", [taskId], c))!;
        });
      } catch (err) {
        if (pgConstraint(err) === "meta_task_agents_pkey") continue;
        if (isPkCollision(err) && !input.task_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getTaskById(taskId: string): Promise<TaskEntity | null> {
    return this.mapTask(await this.get("SELECT * FROM meta_tasks WHERE task_id = ?", [taskId]));
  }

  async updateTask(taskId: string, patch: Partial<TaskEntity>): Promise<TaskEntity | null> {
    const allowed = [
      "title",
      "description",
      "source_type",
      "source_url",
      "status",
      "auto_assign_floating_assets",
      "risk_level",
      "metadata_json",
    ] as const;
    const normalized: Record<string, unknown> = {};
    for (const k of allowed) {
      const v = (patch as Record<string, unknown>)[k];
      if (k in patch && v !== undefined) {
        normalized[k] = k === "auto_assign_floating_assets" ? (v ? 1 : 0) : v;
      }
    }
    await this.applyUpdateRaw("meta_tasks", "task_id", taskId, normalized);
    return this.getTaskById(taskId);
  }

  async deleteTasks(taskIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_tasks", "task_id", taskIds);
    if (result.deleted_ids.length > 0) {
      const ph = placeholders(result.deleted_ids.length);
      await this.run(`DELETE FROM meta_task_agents WHERE task_id IN (${ph})`, result.deleted_ids);
    }
    return result;
  }

  async listTasksByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: TaskFilter,
  ): Promise<ListPage<TaskEntity>> {
    let where = "WHERE team_id = ?";
    const params: unknown[] = [teamId];
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.creator_user_id) {
      where += " AND creator_user_id = ?";
      params.push(filter.creator_user_id);
    }
    if (filter?.title) {
      where += " AND title = ?";
      params.push(filter.title);
    }
    return this.selectList(
      `SELECT COUNT(*) AS c FROM meta_tasks ${where}`,
      params,
      `SELECT * FROM meta_tasks ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapTask(r),
    );
  }

  async listTasks(filter: TaskFilter, pagination?: PaginationParams | null): Promise<ListPage<TaskEntity>> {
    let where = "WHERE 1=1";
    const params: unknown[] = [];
    if (filter.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter.creator_user_id) {
      where += " AND creator_user_id = ?";
      params.push(filter.creator_user_id);
    }
    if (filter.title) {
      where += " AND title = ?";
      params.push(filter.title);
    }
    return this.selectList(
      `SELECT COUNT(*) AS c FROM meta_tasks ${where}`,
      params,
      `SELECT * FROM meta_tasks ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapTask(r),
    );
  }

  // ============================================================
  // TaskAgent
  // ============================================================
  async linkTaskAgent(taskId: string, agentId: string, roleInTask?: string): Promise<TaskAgentEntity> {
    const now = nowIso();
    await this.withRelationId(undefined, (id) =>
      this.run(
        `INSERT INTO meta_task_agents (id, task_id, agent_id, role_in_task, status, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT (task_id, agent_id) DO UPDATE SET role_in_task = excluded.role_in_task, status = 'active'`,
        [id, taskId, agentId, roleInTask ?? null, "active", now],
      ),
    );
    return (await this.get<TaskAgentEntity>("SELECT * FROM meta_task_agents WHERE task_id = ? AND agent_id = ?", [
      taskId,
      agentId,
    ]))!;
  }

  async unlinkTaskAgent(taskId: string, agentId: string): Promise<void> {
    await this.run("DELETE FROM meta_task_agents WHERE task_id = ? AND agent_id = ?", [taskId, agentId]);
  }

  async listTaskAgents(taskId: string, pagination?: PaginationParams | null): Promise<ListPage<TaskAgentEntity>> {
    const base = "FROM meta_task_agents WHERE task_id = ? AND status = 'active'";
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [taskId],
      `SELECT * ${base} ORDER BY created_at DESC`,
      [taskId],
      pagination,
      (r) => r as unknown as TaskAgentEntity,
    );
  }

  // ============================================================
  // ParticipationLog
  // ============================================================
  async appendParticipationLog(input: AppendParticipationLogInput): Promise<ParticipationLogEntity> {
    const createdAt = input.created_at ?? nowIso();
    const entity: ParticipationLogEntity = {
      id: generateRelationId(),
      team_id: input.team_id,
      task_id: input.task_id,
      agent_id: input.agent_id,
      user_id: input.user_id,
      source: input.source ?? "unknown",
      metadata_json: input.metadata_json ?? "{}",
      created_at: createdAt,
      updated_at: createdAt,
    };
    await this.run(
      `INSERT INTO meta_participation_logs
        (id, team_id, task_id, agent_id, user_id, source, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entity.id,
        entity.team_id,
        entity.task_id,
        entity.agent_id,
        entity.user_id,
        entity.source,
        entity.metadata_json,
        entity.created_at,
        entity.updated_at,
      ],
    );
    return entity;
  }

  async listParticipationLogs(
    filter: ParticipationLogFilter,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<ParticipationLogEntity>> {
    const { sql, params } = this.buildParticipationLogWhere(filter);
    if (filter.dedupe) {
      const dedupeIds = `
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC, id DESC) AS rn
          FROM meta_participation_logs
          WHERE ${sql}
        ) ranked WHERE rn = 1
      `;
      return this.selectList(
        `SELECT COUNT(*) AS c FROM (${dedupeIds}) latest`,
        params,
        `SELECT * FROM meta_participation_logs WHERE id IN (${dedupeIds}) ORDER BY created_at DESC, id DESC`,
        params,
        pagination,
        (r) => this.mapParticipationLog(r),
      );
    }
    const base = `FROM meta_participation_logs WHERE ${sql}`;
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      params,
      `SELECT * ${base} ORDER BY created_at DESC, id DESC`,
      params,
      pagination,
      (r) => this.mapParticipationLog(r),
    );
  }

  private buildParticipationLogWhere(filter: ParticipationLogFilter): { sql: string; params: unknown[] } {
    const conditions = ["team_id = ?"];
    const params: unknown[] = [filter.team_id];
    if (filter.task_id) {
      conditions.push("task_id = ?");
      params.push(filter.task_id);
    }
    if (filter.agent_id) {
      conditions.push("agent_id = ?");
      params.push(filter.agent_id);
    }
    if (filter.user_id) {
      conditions.push("user_id = ?");
      params.push(filter.user_id);
    }
    if (filter.created_after) {
      conditions.push("created_at >= ?");
      params.push(filter.created_after);
    }
    if (filter.created_before) {
      conditions.push("created_at <= ?");
      params.push(filter.created_before);
    }
    return { sql: conditions.join(" AND "), params };
  }

  private mapParticipationLog(r: Row | null): ParticipationLogEntity | null {
    if (!r) return null;
    return {
      id: String(r.id),
      team_id: String(r.team_id),
      task_id: String(r.task_id),
      agent_id: String(r.agent_id),
      user_id: String(r.user_id),
      source: String(r.source),
      metadata_json: String(r.metadata_json),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  // ============================================================
  // Asset
  // ============================================================
  async createAsset(input: CreateAssetInput): Promise<AssetEntity> {
    const now = nowIso();
    await this.run(
      `INSERT INTO meta_assets
        (asset_id, team_id, asset_type, name, description, owner_user_id, source_type, source_ref,
         version, visibility, status, confidence, expires_at, last_used_at, usage_count, content_ref,
         created_at, updated_at, metadata_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.asset_id,
        input.team_id,
        input.asset_type,
        input.name,
        input.description ?? null,
        input.owner_user_id,
        input.source_type,
        input.source_ref ?? null,
        1,
        input.visibility ?? "team",
        input.status ?? "draft",
        input.confidence ?? null,
        input.expires_at ?? null,
        null,
        0,
        input.content_ref ?? null,
        now,
        now,
        input.metadata_json ?? "{}",
      ],
    );
    return (await this.getAssetById(input.asset_id))!;
  }

  async getAssetById(assetId: string): Promise<AssetEntity | null> {
    return this.mapAsset(await this.get("SELECT * FROM meta_assets WHERE asset_id = ?", [assetId]));
  }

  async updateAsset(assetId: string, patch: Partial<AssetEntity>): Promise<AssetEntity | null> {
    const allowed = [
      "name",
      "description",
      "visibility",
      "status",
      "confidence",
      "expires_at",
      "content_ref",
      "version",
      "source_ref",
      "metadata_json",
    ] as const;
    await this.applyUpdate("meta_assets", "asset_id", assetId, allowed, patch);
    return this.getAssetById(assetId);
  }

  async deleteAssets(assetIds: string[]): Promise<BatchDeleteResult> {
    // Physical delete + bindings + ACL; a missing asset counts as deleted (idempotent, as in sqlite).
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of assetIds) {
      if (await this.getAssetById(id)) {
        await this.tx(async (c) => {
          await this.run("DELETE FROM meta_agent_fixed_assets WHERE asset_id = ?", [id], c);
          await this.run("DELETE FROM meta_asset_acl WHERE asset_id = ?", [id], c);
          await this.run("DELETE FROM meta_assets WHERE asset_id = ?", [id], c);
        });
      }
      result.deleted_ids.push(id);
    }
    return result;
  }

  async listAssetsByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: AssetFilter,
  ): Promise<ListPage<AssetEntity>> {
    let where = "WHERE team_id = ?";
    const params: unknown[] = [teamId];
    if (filter?.asset_type) {
      where += " AND asset_type = ?";
      params.push(filter.asset_type);
    }
    if (filter?.status) {
      where += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.owner_user_id) {
      where += " AND owner_user_id = ?";
      params.push(filter.owner_user_id);
    }
    if (filter?.visibility) {
      where += " AND visibility = ?";
      params.push(filter.visibility);
    }
    return this.selectList(
      `SELECT COUNT(*) AS c FROM meta_assets ${where}`,
      params,
      `SELECT * FROM meta_assets ${where} ORDER BY created_at DESC`,
      params,
      pagination,
      (r) => this.mapAsset(r),
    );
  }

  async touchAssetUsage(assetId: string): Promise<void> {
    await this.run("UPDATE meta_assets SET usage_count = usage_count + 1, last_used_at = ? WHERE asset_id = ?", [
      nowIso(),
      assetId,
    ]);
  }

  // ============================================================
  // AgentFixedAsset (full replace)
  // ============================================================
  async setAgentFixedAssets(agentId: string, bindings: FixedAssetBindingInput[]): Promise<void> {
    const now = nowIso();
    for (let attempt = 0; attempt < RELATION_ID_RETRY_LIMIT; attempt++) {
      try {
        await this.tx(async (c) => {
          await this.run("DELETE FROM meta_agent_fixed_assets WHERE agent_id = ?", [agentId], c);
          for (const b of bindings) {
            await this.run(
              `INSERT INTO meta_agent_fixed_assets
                (id, agent_id, asset_id, asset_type, injection_mode, priority, created_by, created_at)
               VALUES (?,?,?,?,?,?,?,?)`,
              [
                generateRelationId(),
                agentId,
                b.asset_id,
                b.asset_type,
                b.injection_mode ?? "summary",
                b.priority ?? 50,
                b.created_by,
                now,
              ],
              c,
            );
          }
        });
        return;
      } catch (err) {
        if (pgConstraint(err) === "meta_agent_fixed_assets_pkey") continue;
        throw err;
      }
    }
    throw new Error("relation id collision after max retries");
  }

  async addAgentFixedAsset(agentId: string, b: FixedAssetBindingInput): Promise<void> {
    // UNIQUE(agent_id, asset_id): an existing binding is a no-op.
    await this.withRelationId(undefined, (id) =>
      this.run(
        `INSERT INTO meta_agent_fixed_assets
          (id, agent_id, asset_id, asset_type, injection_mode, priority, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT (agent_id, asset_id) DO NOTHING`,
        [id, agentId, b.asset_id, b.asset_type, b.injection_mode ?? "summary", b.priority ?? 50, b.created_by, nowIso()],
      ),
    );
  }

  async listAgentFixedAssets(
    agentId: string,
    pagination?: PaginationParams | null,
    filter?: { assetTypes?: readonly string[] },
  ): Promise<ListPage<FixedAssetBindingEntity>> {
    const types = filter?.assetTypes ?? [];
    if (types.length > 0) {
      const base = `FROM meta_agent_fixed_assets b
        INNER JOIN meta_assets a ON a.asset_id = b.asset_id
        WHERE b.agent_id = ? AND a.asset_type IN (${placeholders(types.length)})`;
      const params: unknown[] = [agentId, ...types];
      return this.selectList(
        `SELECT COUNT(*) AS c ${base}`,
        params,
        `SELECT b.* ${base} ORDER BY b.priority DESC, b.created_at DESC`,
        params,
        pagination,
        (r) => r as unknown as FixedAssetBindingEntity,
      );
    }
    const base = "FROM meta_agent_fixed_assets WHERE agent_id = ?";
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [agentId],
      `SELECT * ${base} ORDER BY priority DESC, created_at DESC`,
      [agentId],
      pagination,
      (r) => r as unknown as FixedAssetBindingEntity,
    );
  }

  async getAgentFixedAsset(agentId: string, assetId: string): Promise<FixedAssetBindingEntity | null> {
    return this.get<FixedAssetBindingEntity>(
      "SELECT * FROM meta_agent_fixed_assets WHERE agent_id = ? AND asset_id = ?",
      [agentId, assetId],
    );
  }

  async summarizeAgentFixedAssetsByAgents(
    agentIds: string[],
    options?: { assetId?: string },
  ): Promise<AgentFixedAssetCountRow[]> {
    if (agentIds.length === 0) return [];
    const params: unknown[] = [...agentIds];
    let sql = `SELECT agent_id, asset_type, COUNT(DISTINCT asset_id) AS cnt
       FROM meta_agent_fixed_assets
       WHERE agent_id IN (${placeholders(agentIds.length)})`;
    if (options?.assetId) {
      sql += ` AND asset_id = ?`;
      params.push(options.assetId);
    }
    sql += ` GROUP BY agent_id, asset_type`;
    const rows = await this.all<{ agent_id: string; asset_type: string; cnt: number | string }>(sql, params);
    return rows.map((r) => ({ agent_id: r.agent_id, asset_type: r.asset_type as AssetType, cnt: Number(r.cnt) }));
  }

  // ============================================================
  // ACL
  // ============================================================
  async grantAcl(input: GrantAclInput): Promise<AclEntity> {
    const now = nowIso();
    await this.withRelationId(input.id, (id) =>
      this.run(
        `INSERT INTO meta_asset_acl
          (id, asset_id, subject_type, subject_id, permission, effect, granted_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT (asset_id, subject_type, subject_id, permission)
         DO UPDATE SET effect = excluded.effect, granted_by = excluded.granted_by, updated_at = excluded.updated_at`,
        [
          id,
          input.asset_id,
          input.subject_type,
          input.subject_id,
          input.permission,
          input.effect ?? "allow",
          input.granted_by,
          now,
          now,
        ],
      ),
    );
    return (await this.get<AclEntity>(
      "SELECT * FROM meta_asset_acl WHERE asset_id = ? AND subject_type = ? AND subject_id = ? AND permission = ?",
      [input.asset_id, input.subject_type, input.subject_id, input.permission],
    ))!;
  }

  async getAclById(id: string): Promise<AclEntity | null> {
    return this.get<AclEntity>("SELECT * FROM meta_asset_acl WHERE id = ?", [id]);
  }

  async revokeAcl(id: string): Promise<void> {
    await this.run("DELETE FROM meta_asset_acl WHERE id = ?", [id]);
  }

  async listAclByAsset(assetId: string, pagination?: PaginationParams | null): Promise<ListPage<AclEntity>> {
    const base = "FROM meta_asset_acl WHERE asset_id = ?";
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [assetId],
      `SELECT * ${base} ORDER BY created_at DESC`,
      [assetId],
      pagination,
      (r) => r as unknown as AclEntity,
    );
  }

  async listAclBySubject(
    subjectType: string,
    subjectId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<AclEntity>> {
    const base = "FROM meta_asset_acl WHERE subject_type = ? AND subject_id = ?";
    return this.selectList(
      `SELECT COUNT(*) AS c ${base}`,
      [subjectType, subjectId],
      `SELECT * ${base} ORDER BY created_at DESC`,
      [subjectType, subjectId],
      pagination,
      (r) => r as unknown as AclEntity,
    );
  }

  // ============================================================
  // Helpers
  // ============================================================
  private async applyUpdate<T>(
    table: string,
    pkCol: string,
    pkVal: string,
    allowed: readonly string[],
    patch: Partial<T>,
  ): Promise<void> {
    const fields: Record<string, unknown> = {};
    for (const k of allowed) {
      const v = (patch as Record<string, unknown>)[k];
      if (k in (patch as object) && v !== undefined) fields[k] = v;
    }
    await this.applyUpdateRaw(table, pkCol, pkVal, fields);
  }

  /** `table`, `pkCol` and field names come from the whitelists above, never from callers. */
  private async applyUpdateRaw(table: string, pkCol: string, pkVal: string, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    const hasUpdatedAt = UPDATED_AT_TABLES.includes(table);
    if (keys.length === 0 && !hasUpdatedAt) return;
    const sets = keys.map((k) => `${k} = ?`);
    const params: unknown[] = keys.map((k) => fields[k]);
    if (hasUpdatedAt) {
      sets.push("updated_at = ?");
      params.push(nowIso());
    }
    params.push(pkVal);
    await this.run(`UPDATE ${table} SET ${sets.join(", ")} WHERE ${pkCol} = ?`, params);
  }

  private async batchDelete(table: string, pkCol: string, ids: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of ids) {
      const n = await this.run(`DELETE FROM ${table} WHERE ${pkCol} = ?`, [id]);
      if (n === 0) {
        result.failed.push({ id, reason: "not_found" });
        continue;
      }
      result.deleted_ids.push(id);
    }
    return result;
  }

  // ── Row mappers ──
  private mapUser(r: Row | null): UserEntity | null {
    if (!r) return null;
    return {
      user_id: String(r.user_id),
      password: r.password != null ? String(r.password) : null,
      auth_provider: String(r.auth_provider),
      external_id: String(r.external_id),
      username: String(r.username),
      display_name: r.display_name != null ? String(r.display_name) : null,
      email: r.email != null ? String(r.email) : null,
      raw_profile_json: String(r.raw_profile_json ?? "{}"),
      status: String(r.status) as UserEntity["status"],
      user_type: String(r.user_type ?? "normal") as UserEntity["user_type"],
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }

  private mapTeam(r: Row | null): TeamEntity | null {
    if (!r) return null;
    return {
      team_id: String(r.team_id),
      name: String(r.name),
      description: r.description != null ? String(r.description) : null,
      owner_user_id: String(r.owner_user_id),
      status: String(r.status) as TeamEntity["status"],
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }

  private mapAgent(r: Row | null): AgentEntity | null {
    if (!r) return null;
    return {
      agent_id: String(r.agent_id),
      team_id: String(r.team_id),
      owner_user_id: String(r.owner_user_id),
      name: String(r.name),
      description: r.description != null ? String(r.description) : null,
      prompt: r.prompt != null ? String(r.prompt) : null,
      visibility: String(r.visibility ?? "team") as AgentEntity["visibility"],
      status: String(r.status) as AgentEntity["status"],
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }

  private mapTask(r: Row | null): TaskEntity | null {
    if (!r) return null;
    return {
      task_id: String(r.task_id),
      team_id: String(r.team_id),
      creator_user_id: String(r.creator_user_id),
      title: String(r.title),
      description: r.description != null ? String(r.description) : null,
      source_type: String(r.source_type) as TaskEntity["source_type"],
      source_url: r.source_url != null ? String(r.source_url) : null,
      status: String(r.status) as TaskEntity["status"],
      auto_assign_floating_assets: Boolean(Number(r.auto_assign_floating_assets)),
      risk_level: r.risk_level != null ? String(r.risk_level) : null,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }

  private mapAsset(r: Row | null): AssetEntity | null {
    if (!r) return null;
    return {
      asset_id: String(r.asset_id),
      team_id: String(r.team_id),
      asset_type: String(r.asset_type) as AssetEntity["asset_type"],
      name: String(r.name),
      description: r.description != null ? String(r.description) : null,
      owner_user_id: String(r.owner_user_id),
      source_type: String(r.source_type),
      source_ref: r.source_ref != null ? String(r.source_ref) : null,
      version: Number(r.version ?? 1),
      visibility: String(r.visibility) as AssetEntity["visibility"],
      status: String(r.status) as AssetEntity["status"],
      confidence: r.confidence != null ? Number(r.confidence) : null,
      expires_at: r.expires_at != null ? String(r.expires_at) : null,
      last_used_at: r.last_used_at != null ? String(r.last_used_at) : null,
      usage_count: Number(r.usage_count ?? 0),
      content_ref: r.content_ref != null ? String(r.content_ref) : null,
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
      metadata_json: String(r.metadata_json ?? "{}"),
    };
  }

  // ============================================================
  // ConfigParam
  // ============================================================
  async getConfigParam(
    scope: "global" | "user",
    userId: string | null,
    module: string,
    paramName: string,
  ): Promise<ConfigParamEntity | null> {
    const row =
      scope === "global"
        ? await this.get(
            `SELECT * FROM meta_config_params WHERE scope = 'global' AND module = ? AND param_name = ?`,
            [module, paramName],
          )
        : await this.get(
            `SELECT * FROM meta_config_params WHERE scope = 'user' AND user_id = ? AND module = ? AND param_name = ?`,
            [userId, module, paramName],
          );
    return this.mapConfigParam(row);
  }

  async upsertConfigParam(input: UpsertConfigParamInput): Promise<ConfigParamEntity> {
    const now = nowIso();
    // Partial unique indexes make the upsert race-free (sqlite does select-then-write in a tx).
    if (input.scope === "global") {
      await this.run(
        `INSERT INTO meta_config_params (scope, user_id, module, param_name, param_value, description, created_at, updated_at)
         VALUES ('global', NULL, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (module, param_name) WHERE scope = 'global'
         DO UPDATE SET param_value = excluded.param_value, description = excluded.description, updated_at = excluded.updated_at`,
        [input.module, input.param_name, input.param_value, input.description, now, now],
      );
    } else {
      await this.run(
        `INSERT INTO meta_config_params (scope, user_id, module, param_name, param_value, description, created_at, updated_at)
         VALUES ('user', ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, module, param_name) WHERE scope = 'user'
         DO UPDATE SET param_value = excluded.param_value, description = excluded.description, updated_at = excluded.updated_at`,
        [input.user_id, input.module, input.param_name, input.param_value, input.description, now, now],
      );
    }
    return (await this.getConfigParam(
      input.scope,
      input.scope === "user" ? input.user_id! : null,
      input.module,
      input.param_name,
    ))!;
  }

  async listConfigParams(filter: ListConfigParamsFilter): Promise<ConfigParamEntity[]> {
    const conditions: string[] = [`module = ?`];
    const params: unknown[] = [filter.module];
    if (filter.scope) {
      conditions.push(`scope = ?`);
      params.push(filter.scope);
    }
    if (filter.userId) {
      conditions.push(`(scope = 'global' OR (scope = 'user' AND user_id = ?))`);
      params.push(filter.userId);
    }
    if (filter.paramNames && filter.paramNames.length > 0) {
      conditions.push(`param_name IN (${placeholders(filter.paramNames.length)})`);
      params.push(...filter.paramNames);
    }
    const rows = await this.all(
      `SELECT * FROM meta_config_params WHERE ${conditions.join(" AND ")} ORDER BY scope ASC, param_name ASC`,
      params,
    );
    return rows.map((r) => this.mapConfigParam(r)!);
  }

  private mapConfigParam(r: Row | null): ConfigParamEntity | null {
    if (!r) return null;
    return {
      id: Number(r.id),
      scope: String(r.scope) as ConfigParamEntity["scope"],
      user_id: r.user_id != null ? String(r.user_id) : null,
      module: String(r.module),
      param_name: String(r.param_name),
      param_value: String(r.param_value),
      description: String(r.description),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }

  // ── InstanceUpstreamConfig ──
  async getInstanceUpstreamConfig(
    agentSource: string,
    type: UpstreamConfigType,
  ): Promise<InstanceUpstreamConfigEntity | null> {
    return this.mapInstanceUpstreamConfig(
      await this.get("SELECT * FROM meta_instance_upstream_config WHERE agent_source = ? AND type = ?", [
        agentSource,
        type,
      ]),
    );
  }

  async upsertInstanceUpstreamConfig(input: UpsertInstanceUpstreamConfigInput): Promise<InstanceUpstreamConfigEntity> {
    const now = nowIso();
    const agentSource = input.agent_source ?? "default";
    const type = input.type ?? "conversation";
    await this.run(
      `INSERT INTO meta_instance_upstream_config
        (agent_source, type, mode, base_url, api_key, model_id, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_source, type) DO UPDATE SET
        mode = excluded.mode,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        model_id = excluded.model_id,
        description = excluded.description,
        updated_at = excluded.updated_at`,
      [
        agentSource,
        type,
        input.mode,
        input.base_url ?? "",
        input.api_key ?? "",
        input.model_id ?? "",
        input.description ?? "",
        now,
        now,
      ],
    );
    return (await this.getInstanceUpstreamConfig(agentSource, type))!;
  }

  async listInstanceUpstreamConfigs(filter?: InstanceUpstreamConfigFilter): Promise<InstanceUpstreamConfigEntity[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.agent_source) {
      conditions.push("agent_source = ?");
      params.push(filter.agent_source);
    }
    if (filter?.type) {
      conditions.push("type = ?");
      params.push(filter.type);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.all(`SELECT * FROM meta_instance_upstream_config${where} ORDER BY agent_source, type`, params);
    return rows.map((r) => this.mapInstanceUpstreamConfig(r)!);
  }

  async deleteInstanceUpstreamConfig(agentSource: string, type: UpstreamConfigType): Promise<boolean> {
    const n = await this.run("DELETE FROM meta_instance_upstream_config WHERE agent_source = ? AND type = ?", [
      agentSource,
      type,
    ]);
    return n > 0;
  }

  private mapInstanceUpstreamConfig(r: Row | null): InstanceUpstreamConfigEntity | null {
    if (!r) return null;
    return {
      id: Number(r.id),
      agent_source: String(r.agent_source),
      type: String(r.type) as UpstreamConfigType,
      mode: String(r.mode) as InstanceUpstreamConfigEntity["mode"],
      base_url: String(r.base_url),
      api_key: String(r.api_key),
      model_id: String(r.model_id),
      description: String(r.description),
      created_at: String(r.created_at),
      updated_at: String(r.updated_at),
    };
  }
}
