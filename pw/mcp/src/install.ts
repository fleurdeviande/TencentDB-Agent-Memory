/**
 * `pw-memory install` / `uninstall` for Claude Code, user scope:
 *   1. config file (0600) from the current env — the one place the key lives;
 *   2. MCP registration via `claude mcp add` (no `-e`: the server reads the config file);
 *   3. UserPromptSubmit / Stop / SessionEnd hooks merged into ~/.claude/settings.json.
 * `--dry-run` prints every step and touches nothing.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_KEYS, defaultConfigPath, mergeValues, readConfigFile, type ConfigValues } from "./config.js";
import { describeUrl, maskSecret } from "./log.js";

export const MCP_NAME = "pw-memory";
export const HOOK_SUBCOMMAND = "pw-memory-hook";
/** Timeouts (s) from #1268's integrations/hooks.json: they must cover one capture batch in flight. */
export const HOOK_EVENTS = [
  { event: "UserPromptSubmit", timeout: 5 },
  { event: "Stop", timeout: 15 },
  { event: "SessionEnd", timeout: 30 },
] as const;
const PLUGIN_HOOK_MARKER = "claude-code-plugin/dist/hooks/cli.js";
const SECRET_KEYS = new Set<string>(["TDAI_USER_KEY", "KNOWLEDGE_API_TOKEN"]);

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Runner = (command: string, args: string[]) => Promise<RunResult>;

export interface InstallContext {
  env: NodeJS.ProcessEnv;
  dryRun: boolean;
  /** Absolute dir holding the built server.js and cli.js. */
  distDir: string;
  /** Node binary the MCP server and hooks run with; absolute so nvm PATH changes do not matter. */
  nodeBin: string;
  settingsPath: string;
  configPath: string;
  claudeBin: string;
  run: Runner;
  out: (line: string) => void;
}

export interface InstallReport {
  ok: boolean;
  actions: string[];
  warnings: string[];
}

interface HookCommand {
  type?: string;
  command?: string;
  args?: unknown;
  timeout?: number;
  [key: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
  [key: string]: unknown;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

export const defaultRunner: Runner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: error && !stderr ? error.message : String(stderr) });
    });
  });

export function defaultContext(overrides: Partial<InstallContext> & Pick<InstallContext, "distDir">): InstallContext {
  const env = overrides.env ?? process.env;
  const home = env.HOME ?? os.homedir();
  return {
    env,
    dryRun: false,
    nodeBin: process.execPath,
    settingsPath: path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "settings.json"),
    configPath: defaultConfigPath(env),
    claudeBin: "claude",
    run: defaultRunner,
    out: (line) => process.stdout.write(`${line}\n`),
    ...overrides,
  };
}

function quote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function hookCommand(ctx: Pick<InstallContext, "nodeBin" | "distDir">): string {
  return `${quote(ctx.nodeBin)} ${quote(path.join(ctx.distDir, "cli.js"))} ${HOOK_SUBCOMMAND}`;
}

export function isOurHook(hook: HookCommand): boolean {
  return typeof hook.command === "string" && hook.command.trimEnd().endsWith(` ${HOOK_SUBCOMMAND}`);
}

function mentionsPluginHook(hook: HookCommand): boolean {
  return JSON.stringify([hook.command, hook.args]).includes(PLUGIN_HOOK_MARKER);
}

/** Settings without any pw-memory hook; empty groups, events and the hooks key itself are dropped. */
export function removeOurHooks(settings: Settings): Settings {
  if (!settings.hooks || typeof settings.hooks !== "object") return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept: HookGroup[] = [];
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) {
        kept.push(group);
        continue;
      }
      const remaining = group.hooks.filter((hook) => !isOurHook(hook));
      if (remaining.length > 0) kept.push({ ...group, hooks: remaining });
    }
    if (kept.length > 0) hooks[event] = kept;
  }
  const next: Settings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

/** Idempotent: previous pw-memory hooks are replaced, everything else is kept in place. */
export function addOurHooks(settings: Settings, command: string): Settings {
  const next = removeOurHooks(settings);
  const hooks: Record<string, HookGroup[]> = { ...(next.hooks ?? {}) };
  for (const { event, timeout } of HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command, timeout }] }];
  }
  return { ...next, hooks };
}

export function findPluginHooks(settings: Settings): string[] {
  const events: string[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    if (groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some(mentionsPluginHook))) events.push(event);
  }
  return events;
}

function readSettings(file: string): Settings {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Settings;
}

function writeFileAtomic(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
}

function writeSettings(file: string, settings: Settings): void {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.pw-memory.bak`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`, mode);
}

export function maskedValues(values: ConfigValues): Record<string, string> {
  const shown: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    shown[key] = SECRET_KEYS.has(key) ? maskSecret(value) : key.endsWith("_URL") ? describeUrl(value) : value;
  }
  return shown;
}

function mcpAddArgs(ctx: InstallContext): string[] {
  return ["mcp", "add", "--transport", "stdio", "--scope", "user", MCP_NAME, "--", ctx.nodeBin, path.join(ctx.distDir, "server.js")];
}

async function runClaude(ctx: InstallContext, args: string[], report: InstallReport, allowFailure: boolean): Promise<void> {
  const shown = `${ctx.claudeBin} ${args.map(quote).join(" ")}`;
  report.actions.push(`run: ${shown}`);
  if (ctx.dryRun) return;
  const result = await ctx.run(ctx.claudeBin, args);
  if (result.code === 0 || allowFailure) return;
  report.ok = false;
  report.warnings.push(`\`${shown}\` failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}; run it by hand`);
}

export async function install(ctx: InstallContext): Promise<InstallReport> {
  const report: InstallReport = { ok: true, actions: [], warnings: [] };
  for (const bundle of ["server.js", "cli.js"]) {
    if (!fs.existsSync(path.join(ctx.distDir, bundle))) report.warnings.push(`${path.join(ctx.distDir, bundle)} missing: run the build first`);
  }

  // 1. Config file: current env over what the file already holds.
  const existing = readConfigFile(ctx.configPath, report.warnings);
  const values = mergeValues(ctx.env, existing);
  if (!values.TDAI_URL && !values.KNOWLEDGE_URL) {
    report.warnings.push("neither TDAI_URL nor KNOWLEDGE_URL is set: the server will start with no tools");
  }
  const ordered: ConfigValues = {};
  for (const key of CONFIG_KEYS) if (values[key]) ordered[key] = values[key];
  report.actions.push(`write ${ctx.configPath} (0600): ${JSON.stringify(maskedValues(ordered))}`);
  if (!ctx.dryRun) writeFileAtomic(ctx.configPath, `${JSON.stringify(ordered, null, 2)}\n`, 0o600);

  // 2. MCP registration; a stale entry would make `add` fail, so remove first.
  await runClaude(ctx, ["mcp", "remove", "--scope", "user", MCP_NAME], report, true);
  await runClaude(ctx, mcpAddArgs(ctx), report, false);

  // 3. Hooks.
  const settings = readSettings(ctx.settingsPath);
  const command = hookCommand(ctx);
  const plugin = findPluginHooks(settings);
  if (plugin.length > 0) {
    report.warnings.push(
      `${ctx.settingsPath} also runs the #1268 plugin's own hook on ${plugin.join(", ")}: every turn would be ` +
      "recalled and captured twice — remove those entries",
    );
  }
  report.actions.push(`update ${ctx.settingsPath}: ${HOOK_EVENTS.map((h) => `${h.event} (${h.timeout}s)`).join(", ")} → ${command}`);
  if (!ctx.dryRun) writeSettings(ctx.settingsPath, addOurHooks(settings, command));

  if (ctx.dryRun) report.actions.push("dry run: nothing was changed");
  return report;
}

export async function uninstall(ctx: InstallContext, options: { purge: boolean }): Promise<InstallReport> {
  const report: InstallReport = { ok: true, actions: [], warnings: [] };
  await runClaude(ctx, ["mcp", "remove", "--scope", "user", MCP_NAME], report, true);

  const settings = readSettings(ctx.settingsPath);
  const next = removeOurHooks(settings);
  if (JSON.stringify(next) !== JSON.stringify(settings)) {
    report.actions.push(`update ${ctx.settingsPath}: remove pw-memory hooks`);
    if (!ctx.dryRun) writeSettings(ctx.settingsPath, next);
  } else {
    report.actions.push(`${ctx.settingsPath}: no pw-memory hooks found`);
  }

  if (options.purge && fs.existsSync(ctx.configPath)) {
    report.actions.push(`delete ${ctx.configPath}`);
    if (!ctx.dryRun) fs.rmSync(ctx.configPath);
  } else if (fs.existsSync(ctx.configPath)) {
    report.actions.push(`keep ${ctx.configPath} (pass --purge to delete it)`);
  }
  if (ctx.dryRun) report.actions.push("dry run: nothing was changed");
  return report;
}

export function printReport(report: InstallReport, out: (line: string) => void): void {
  for (const action of report.actions) out(`- ${action}`);
  for (const warning of report.warnings) out(`! ${warning}`);
}
