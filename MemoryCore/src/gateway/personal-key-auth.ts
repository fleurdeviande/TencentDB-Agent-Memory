/**
 * Personal keys (`sk-mem-…`) as the Bearer of the /v3 memory data plane (pw fork).
 *
 * Upstream authenticates /v3 L0–L3 routes with one shared Bearer (TDAI_GATEWAY_API_KEY) and
 * takes team_id / user_id from the request. With a personal key the gateway resolves the key to
 * its user server-side and pins the request to that identity:
 *
 *   - user_id (body or x-tdai-user-id) absent → set to the key's user; different → 403.
 *     Rejected rather than overwritten, so a misconfigured client fails loudly instead of
 *     silently reading or writing under an identity it did not ask for.
 *   - team_id (body or x-tdai-team-id) absent → 422; not an active team the user is an
 *     active member of → 403.
 *
 * The shared key keeps upstream behaviour while TDAI_GATEWAY_SHARED_KEY_MODE=trusted (default);
 * `off` requires a personal key on every /v3 L0–L3 request. Shared Bearer + x-tdai-user-key (the
 * panel's service-to-service pattern) is the shared-key path: the panel runs its own ACL.
 */

import { createHash } from "node:crypto";
import { USER_KEY_PREFIX } from "../metadata/utils/user-key.js";
import type { UserEntity, TeamEntity, TeamMemberEntity } from "../metadata/types.js";

export type SharedKeyMode = "trusted" | "off";

export interface PersonalKeyConfig {
  /** Resolve `Bearer sk-mem-…` on /v3 L0–L3 and /v3/meta/*. Env TDAI_GATEWAY_PERSONAL_KEYS (default on). */
  enabled: boolean;
  /** Env TDAI_GATEWAY_SHARED_KEY_MODE: trusted (default, upstream) | off. */
  sharedKeyMode: SharedKeyMode;
  /** Key → user and membership cache TTL; revocations take effect within it. Env TDAI_GATEWAY_PERSONAL_KEY_CACHE_MS. */
  cacheTtlMs: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 2_000;

function isOff(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "off" || s === "false" || s === "0" || s === "no";
}

export function readPersonalKeyConfig(env: NodeJS.ProcessEnv = process.env): PersonalKeyConfig {
  const rawMode = (env.TDAI_GATEWAY_SHARED_KEY_MODE ?? "").trim().toLowerCase() || "trusted";
  if (rawMode !== "trusted" && rawMode !== "off") {
    throw new Error(`invalid TDAI_GATEWAY_SHARED_KEY_MODE=${JSON.stringify(rawMode)} (expected "trusted" | "off")`);
  }
  const ttl = Number(env.TDAI_GATEWAY_PERSONAL_KEY_CACHE_MS);
  const enabled = !isOff(env.TDAI_GATEWAY_PERSONAL_KEYS);
  if (rawMode === "off" && !enabled) {
    throw new Error("TDAI_GATEWAY_SHARED_KEY_MODE=off needs personal keys (TDAI_GATEWAY_PERSONAL_KEYS is off)");
  }
  return {
    enabled,
    sharedKeyMode: rawMode,
    cacheTtlMs: Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_CACHE_TTL_MS,
  };
}

export function looksLikePersonalKey(token: string): boolean {
  return token.startsWith(USER_KEY_PREFIX) && token.length > USER_KEY_PREFIX.length;
}

export function bearerToken(header: string | string[] | undefined): string {
  const h = Array.isArray(header) ? header[0] : header;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return "";
  return h.slice("Bearer ".length).trim();
}

/** The slice of MetadataService this module needs (keeps it testable without a gateway). */
export interface IdentitySource {
  verifyAuth(userKey: string): Promise<UserEntity | null>;
  isConfiguredMemorySystemUserKey(userKey: string): boolean;
  rawStore: {
    getTeamMember(teamId: string, userId: string): Promise<TeamMemberEntity | null> | TeamMemberEntity | null;
    getTeamById(teamId: string): Promise<TeamEntity | null> | TeamEntity | null;
  };
}

export interface PersonalIdentity {
  instanceId: string;
  userId: string;
}

interface Cached<T> {
  value: T;
  expires: number;
}

class TtlCache<T> {
  private readonly map = new Map<string, Cached<T>>();
  constructor(private readonly ttlMs: number) {}

  get(key: string): T | undefined {
    if (this.ttlMs <= 0) return undefined;
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.ttlMs <= 0) return;
    if (this.map.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + this.ttlMs });
  }
}

export class PersonalKeyResolver {
  private readonly users: TtlCache<string>;
  private readonly members: TtlCache<boolean>;

  constructor(
    private readonly source: (instanceId: string) => Promise<IdentitySource>,
    ttlMs: number = DEFAULT_CACHE_TTL_MS,
  ) {
    this.users = new TtlCache(ttlMs);
    this.members = new TtlCache(ttlMs);
  }

  /** Active user of an active, non-system personal key; null otherwise. Only positive results are cached. */
  async resolve(instanceId: string, key: string): Promise<PersonalIdentity | null> {
    if (!looksLikePersonalKey(key)) return null;
    const cacheKey = `${instanceId}\u0000${createHash("sha256").update(key).digest("hex")}`;
    const cached = this.users.get(cacheKey);
    if (cached) return { instanceId, userId: cached };
    const svc = await this.source(instanceId);
    if (svc.isConfiguredMemorySystemUserKey(key)) return null;
    const user = await svc.verifyAuth(key);
    if (!user || user.status !== "active") return null;
    this.users.set(cacheKey, user.user_id);
    return { instanceId, userId: user.user_id };
  }

  async isActiveMember(identity: PersonalIdentity, teamId: string): Promise<boolean> {
    const cacheKey = `${identity.instanceId}\u0000${identity.userId}\u0000${teamId}`;
    const cached = this.members.get(cacheKey);
    if (cached !== undefined) return cached;
    const svc = await this.source(identity.instanceId);
    const [member, team] = await Promise.all([
      svc.rawStore.getTeamMember(teamId, identity.userId),
      svc.rawStore.getTeamById(teamId),
    ]);
    const ok = !!member && member.status === "active" && !!team && team.status === "active";
    this.members.set(cacheKey, ok);
    return ok;
  }
}

export type EnforceResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 422; message: string };

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const raw = headers[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Distinct non-empty values of one identity field from body + header; non-strings are an error. */
function presentValues(
  body: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  field: string,
  header: string,
): string[] | null {
  const out = new Set<string>();
  const b = body[field];
  if (b !== undefined && b !== null && b !== "") {
    if (typeof b !== "string") return null;
    if (b.trim()) out.add(b.trim());
  }
  const h = headerValue(headers, header);
  if (h) out.add(h);
  return [...out];
}

/**
 * Pin a parsed /v3 L0–L3 body (and the x-tdai-* identity headers, which handlers also read)
 * to the personal key's identity. Mutates `headers` only on success.
 */
export async function enforcePersonalIdentity(
  rawBody: unknown,
  headers: Record<string, string | string[] | undefined>,
  identity: PersonalIdentity,
  isMember: (teamId: string) => Promise<boolean>,
): Promise<EnforceResult> {
  if (rawBody !== undefined && (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody))) {
    return { ok: false, status: 400, message: "request body must be a JSON object" };
  }
  const body = { ...((rawBody as Record<string, unknown> | undefined) ?? {}) };

  const users = presentValues(body, headers, "user_id", "x-tdai-user-id");
  if (users === null) return { ok: false, status: 400, message: "user_id must be a string" };
  const foreignUser = users.find((u) => u !== identity.userId);
  if (foreignUser !== undefined) {
    return { ok: false, status: 403, message: "user_id does not match the personal key" };
  }

  const teams = presentValues(body, headers, "team_id", "x-tdai-team-id");
  if (teams === null) return { ok: false, status: 400, message: "team_id must be a string" };
  if (teams.length === 0) return { ok: false, status: 422, message: "team_id is required with a personal key" };
  if (teams.length > 1) return { ok: false, status: 400, message: "team_id in body and x-tdai-team-id differ" };
  const teamId = teams[0]!;
  if (!(await isMember(teamId))) {
    return { ok: false, status: 403, message: `not an active member of team ${teamId}` };
  }

  body.user_id = identity.userId;
  body.team_id = teamId;
  headers["x-tdai-user-id"] = identity.userId;
  headers["x-tdai-team-id"] = teamId;
  return { ok: true, body };
}
