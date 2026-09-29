/**
 * One configuration for the MCP server and the hooks.
 *
 * Sources, highest first: the process environment, then the JSON file written by `pw-memory install`
 * (`~/.config/pw-memory/config.json`, 0600, override with `PW_MEMORY_CONFIG`). Claude Code starts the
 * MCP server and every hook with its own environment, so the file is what makes "configure once" work
 * without putting the key into `~/.claude.json` or the `env` block of `settings.json` (the latter leaks
 * it into every Bash tool call the model makes).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPersonalKey } from "./identity.js";
import { describeUrl } from "./log.js";

/** Keys read from env and persisted by `install`. Everything else in env passes through untouched. */
export const CONFIG_KEYS = [
  "TDAI_URL",
  "KNOWLEDGE_URL",
  "TDAI_USER_KEY",
  "KNOWLEDGE_API_TOKEN",
  "TDAI_SERVICE_ID",
  "TDAI_TEAM_ID",
  "TDAI_AGENT_ID",
  "TDAI_USER_ID",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type ConfigValues = Partial<Record<ConfigKey, string>>;

export interface PwConfig {
  /** Memory half (MemoryCore gateway); undefined = disabled. */
  memory?: { url: string };
  /** Knowledge half (MemoryKnowledge); undefined = disabled. */
  knowledge?: { url: string; token?: string };
  userKey?: string;
  /** Config file actually read, if any. */
  configFile?: string;
  /** Environment handed to the #1268 plugin's own `loadConfig`. */
  pluginEnv: NodeJS.ProcessEnv;
  /** Startup notes for stderr: disabled halves, weak settings. Never contains secrets. */
  notes: string[];
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PW_MEMORY_CONFIG) return env.PW_MEMORY_CONFIG;
  const base = env.XDG_CONFIG_HOME ?? path.join(env.HOME ?? env.USERPROFILE ?? os.homedir(), ".config");
  return path.join(base, "pw-memory", "config.json");
}

/** Missing file → `{}`; unreadable or malformed file → `{}` plus a note, never a throw. */
export function readConfigFile(file: string, notes: string[] = []): ConfigValues {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") notes.push(`config file ${file} unreadable, ignored`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    notes.push(`config file ${file} is not valid JSON, ignored`);
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    notes.push(`config file ${file} is not a JSON object, ignored`);
    return {};
  }
  const values: ConfigValues = {};
  for (const key of CONFIG_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) values[key] = value.trim();
  }
  return values;
}

/** Env wins over the file; empty strings count as unset. */
export function mergeValues(env: NodeJS.ProcessEnv, file: ConfigValues): ConfigValues {
  const merged: ConfigValues = {};
  for (const key of CONFIG_KEYS) {
    const fromEnv = env[key]?.trim();
    const value = fromEnv || file[key];
    if (value) merged[key] = value;
  }
  return merged;
}

function httpUrl(name: string, value: string | undefined, notes: string[]): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return value.replace(/\/+$/, "");
  } catch {
    // fall through
  }
  notes.push(`${name} is not an http(s) URL, treated as unset`);
  return undefined;
}

export interface LoadOptions {
  /** Skip the config file (tests, `install --dry-run` previews). */
  ignoreFile?: boolean;
}

export function loadPwConfig(env: NodeJS.ProcessEnv = process.env, options: LoadOptions = {}): PwConfig {
  const notes: string[] = [];
  const file = defaultConfigPath(env);
  const fileValues = options.ignoreFile ? {} : readConfigFile(file, notes);
  const values = mergeValues(env, fileValues);

  const memoryUrl = httpUrl("TDAI_URL", values.TDAI_URL, notes);
  const knowledgeUrl = httpUrl("KNOWLEDGE_URL", values.KNOWLEDGE_URL, notes);
  const userKey = values.TDAI_USER_KEY;
  const knowledgeToken = values.KNOWLEDGE_API_TOKEN ?? userKey;

  if (!memoryUrl) notes.push("memory tools and hooks disabled: TDAI_URL is unset");
  else notes.push(`memory tools enabled: ${describeUrl(memoryUrl)}`);
  if (!knowledgeUrl) notes.push("knowledge tools (code_*, wiki_*) disabled: KNOWLEDGE_URL is unset");
  else notes.push(`knowledge tools enabled: ${describeUrl(knowledgeUrl)}`);
  if ((memoryUrl || knowledgeUrl) && !userKey) notes.push("TDAI_USER_KEY is unset: requests carry no credential");
  // With a personal key the user id is derived from the gateway (identity.ts), which adds its own note.
  if (memoryUrl && !values.TDAI_USER_ID && !isPersonalKey(userKey)) {
    notes.push("TDAI_USER_ID is unset: memory is read and written as user \"default\"");
  }

  // The plugin reads its own variable names; map ours onto them and drop stale plugin-only settings.
  const pluginEnv: NodeJS.ProcessEnv = { ...env };
  delete pluginEnv.TDAI_API_KEY;
  delete pluginEnv.TDAI_KNOWLEDGE_URL;
  delete pluginEnv.TDAI_KNOWLEDGE_API_KEY;
  if (memoryUrl) pluginEnv.TDAI_GATEWAY_URL = memoryUrl;
  pluginEnv.TDAI_GATEWAY_API_KEY = userKey ?? "local";
  if (knowledgeUrl) pluginEnv.TDAI_KNOWLEDGE_URL = knowledgeUrl;
  if (knowledgeToken) pluginEnv.TDAI_KNOWLEDGE_API_KEY = knowledgeToken;
  for (const key of ["TDAI_SERVICE_ID", "TDAI_TEAM_ID", "TDAI_AGENT_ID", "TDAI_USER_ID"] as const) {
    if (values[key]) pluginEnv[key] = values[key];
  }

  return {
    memory: memoryUrl ? { url: memoryUrl } : undefined,
    knowledge: knowledgeUrl ? { url: knowledgeUrl, token: knowledgeToken } : undefined,
    userKey,
    configFile: Object.keys(fileValues).length > 0 ? file : undefined,
    pluginEnv,
    notes,
  };
}
