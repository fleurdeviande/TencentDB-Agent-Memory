/**
 * Derive the memory identity from a personal key (`TDAI_USER_KEY=sk-mem-…`).
 *
 * The gateway pins every /v3 L0–L3 request made with a personal key to the key's user and refuses
 * a different user_id (403) or a team the user is not in (403). So the user id is asked from the
 * gateway (`/v3/meta/auth/verify`) instead of configured, and the team defaults to the user's only
 * team (`/v3/meta/team/list`). TDAI_USER_ID stays readable but is overridden by the derived id;
 * TDAI_TEAM_ID still picks the team when the user is in several.
 *
 * Hooks run as fresh processes, so the answer is cached in the plugin state dir (0600) for
 * IDENTITY_TTL_MS, keyed by a hash of URL + instance + key. A gateway that does not know personal
 * keys (older build, shared key) leaves the configured identity in place, as before.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PwConfig } from "./config.js";
import { loadPluginConfig } from "./upstream/memory.js";

export const PERSONAL_KEY_PREFIX = "sk-mem-";
export const IDENTITY_TTL_MS = 10 * 60_000;
const UNSUPPORTED_TTL_MS = 60_000;
const CACHE_FILE = "pw-identity.json";

interface CacheEntry {
  at: number;
  userId?: string;
  teams?: string[];
  /** The gateway answered but did not resolve the key (old build or not a personal key there). */
  unsupported?: string;
}

export interface IdentityOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export function isPersonalKey(key: string | undefined): key is string {
  return !!key && key.startsWith(PERSONAL_KEY_PREFIX) && key.length > PERSONAL_KEY_PREFIX.length;
}

type Envelope = { code?: number; message?: string; data?: unknown };

class GatewayAnswer extends Error {}

async function call(
  url: string,
  route: string,
  key: string,
  serviceId: string,
  body: Record<string, unknown>,
  options: IdentityOptions,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "x-tdai-service-id": serviceId, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
  });
  const env = (await res.json().catch(() => ({}))) as Envelope;
  if (env.code !== 0) throw new GatewayAnswer(`${route} answered ${env.code ?? res.status}: ${env.message ?? res.statusText}`);
  return env.data;
}

async function fetchIdentity(url: string, key: string, serviceId: string, options: IdentityOptions): Promise<CacheEntry> {
  const now = (options.now ?? Date.now)();
  try {
    const verify = (await call(url, "/v3/meta/auth/verify", key, serviceId, { user_key: key }, options)) as {
      valid?: boolean;
      user?: { user_id?: string };
    };
    const userId = verify?.valid ? verify.user?.user_id : undefined;
    if (!userId) return { at: now, unsupported: "key not recognised by the gateway" };
    const list = (await call(url, "/v3/meta/team/list", key, serviceId, { user_key: key, limit: 100 }, options)) as {
      items?: Array<{ team_id?: string; status?: string }>;
    };
    const teams = (list?.items ?? [])
      .filter((t) => t.team_id && (t.status ?? "active") === "active")
      .map((t) => t.team_id as string);
    return { at: now, userId, teams };
  } catch (error) {
    if (error instanceof GatewayAnswer) return { at: now, unsupported: error.message };
    throw error;
  }
}

function readCache(file: string): Record<string, CacheEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

function writeCache(file: string, cache: Record<string, CacheEntry>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* a cache miss next time is fine */
  }
}

/**
 * Returns a copy of `config` whose plugin env carries the key's user id (and team, when it can be
 * chosen). Never throws: an unreachable gateway keeps the configured identity with a note.
 */
export async function applyKeyIdentity(config: PwConfig, options: IdentityOptions = {}): Promise<PwConfig> {
  const key = config.userKey;
  if (!config.memory || !isPersonalKey(key)) return config;

  const env = config.pluginEnv;
  const serviceId = env.TDAI_SERVICE_ID?.trim() || "default";
  const now = (options.now ?? Date.now)();
  const cacheFile = path.join(loadPluginConfig(env).stateDir, CACHE_FILE);
  const cacheKey = createHash("sha256").update(`${config.memory.url}\u0000${serviceId}\u0000${key}`).digest("hex");
  const cache = readCache(cacheFile);
  let entry = cache[cacheKey];
  const ttl = entry?.unsupported ? UNSUPPORTED_TTL_MS : IDENTITY_TTL_MS;
  if (!entry || now - entry.at > ttl || now < entry.at) {
    try {
      entry = await fetchIdentity(config.memory.url, key, serviceId, options);
      cache[cacheKey] = entry;
      writeCache(cacheFile, cache);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return withFallbackNote(config, `identity not derived from TDAI_USER_KEY (gateway unreachable: ${reason})`);
    }
  }

  if (!entry.userId) {
    return withFallbackNote(config, `identity not derived from TDAI_USER_KEY (${entry.unsupported ?? "unknown"})`);
  }

  const notes = [...config.notes];
  const pluginEnv: NodeJS.ProcessEnv = { ...env, TDAI_USER_ID: entry.userId };
  const configuredUser = env.TDAI_USER_ID?.trim();
  if (configuredUser && configuredUser !== entry.userId) {
    notes.push(`TDAI_USER_ID=${configuredUser} ignored: the gateway pins this key to user ${entry.userId}`);
  }

  const teams = entry.teams ?? [];
  const configuredTeam = env.TDAI_TEAM_ID?.trim();
  let memory: PwConfig["memory"] = config.memory;
  if (configuredTeam) {
    if (!teams.includes(configuredTeam)) {
      notes.push(`TDAI_TEAM_ID=${configuredTeam}: user ${entry.userId} is not an active member, the gateway will refuse it`);
    }
  } else if (teams.length === 1) {
    pluginEnv.TDAI_TEAM_ID = teams[0];
  } else {
    memory = undefined;
    notes.push(
      teams.length === 0
        ? `memory tools and hooks disabled: user ${entry.userId} is in no team`
        : `memory tools and hooks disabled: user ${entry.userId} is in ${teams.length} teams, set TDAI_TEAM_ID to one of ${teams.join(", ")}`,
    );
  }
  notes.push(`identity from TDAI_USER_KEY: user ${entry.userId}, team ${pluginEnv.TDAI_TEAM_ID ?? configuredTeam ?? "(none)"}`);
  return { ...config, memory, pluginEnv, notes };
}

function withFallbackNote(config: PwConfig, note: string): PwConfig {
  const notes = [...config.notes, note];
  if (!config.pluginEnv.TDAI_USER_ID?.trim()) notes.push('TDAI_USER_ID is unset: memory is read and written as user "default"');
  return { ...config, notes };
}
