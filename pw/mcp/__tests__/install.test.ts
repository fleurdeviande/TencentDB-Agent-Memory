import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addOurHooks,
  HOOK_SUBCOMMAND,
  install,
  removeOurHooks,
  uninstall,
  type InstallContext,
  type RunResult,
} from "../src/install.js";

let dir: string;
let calls: string[][];
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-install-"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.writeFileSync(path.join(dir, "dist", "server.js"), "");
  fs.writeFileSync(path.join(dir, "dist", "cli.js"), "");
  calls = [];
  lines = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SECRET = "sk-mem-0123456789abcdefghijklmnopqrstuv";

function ctx(overrides: Partial<InstallContext> = {}, exitCode = 0): InstallContext {
  return {
    env: { TDAI_URL: "http://gw:8420", KNOWLEDGE_URL: "http://kn:8424", TDAI_USER_KEY: SECRET, TDAI_USER_ID: "u1" },
    dryRun: false,
    distDir: path.join(dir, "dist"),
    nodeBin: "/opt/node/bin/node",
    settingsPath: path.join(dir, ".claude", "settings.json"),
    configPath: path.join(dir, ".config", "pw-memory", "config.json"),
    claudeBin: "claude",
    run: async (command, args): Promise<RunResult> => {
      calls.push([command, ...args]);
      return { code: args[1] === "add" ? exitCode : 0, stdout: "", stderr: exitCode ? "boom" : "" };
    },
    out: (line) => lines.push(line),
    ...overrides,
  };
}

function readSettings(c: InstallContext) {
  return JSON.parse(fs.readFileSync(c.settingsPath, "utf-8")) as Record<string, any>;
}

const FOREIGN = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done", timeout: 2 }] }], PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard" }] }] }, model: "opus" };

describe("install", () => {
  it("dry run changes nothing and never prints the key", async () => {
    const c = ctx({ dryRun: true });
    const report = await install(c);
    expect(calls).toEqual([]);
    expect(fs.existsSync(c.settingsPath)).toBe(false);
    expect(fs.existsSync(c.configPath)).toBe(false);
    const printed = JSON.stringify(report);
    expect(printed).not.toContain(SECRET);
    expect(printed).toContain("sk-m****uv");
    expect(report.actions.at(-1)).toBe("dry run: nothing was changed");
    expect(printed).toContain(`mcp add --transport stdio --scope user pw-memory -- /opt/node/bin/node ${path.join(dir, "dist", "server.js")}`);
  });

  it("writes a 0600 config, registers the server without -e, merges hooks next to foreign ones", async () => {
    const c = ctx();
    fs.mkdirSync(path.dirname(c.settingsPath), { recursive: true });
    fs.writeFileSync(c.settingsPath, JSON.stringify(FOREIGN));

    const report = await install(c);
    expect(report.ok).toBe(true);

    expect(fs.statSync(c.configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(c.configPath, "utf-8"))).toEqual({
      TDAI_URL: "http://gw:8420", KNOWLEDGE_URL: "http://kn:8424", TDAI_USER_KEY: SECRET, TDAI_USER_ID: "u1",
    });

    expect(calls).toEqual([
      ["claude", "mcp", "remove", "--scope", "user", "pw-memory"],
      ["claude", "mcp", "add", "--transport", "stdio", "--scope", "user", "pw-memory", "--", "/opt/node/bin/node", path.join(dir, "dist", "server.js")],
    ]);
    expect(calls.flat().join(" ")).not.toContain(SECRET);

    const settings = readSettings(c);
    const command = `/opt/node/bin/node ${path.join(dir, "dist", "cli.js")} ${HOOK_SUBCOMMAND}`;
    expect(settings.model).toBe("opus");
    expect(settings.hooks.PreToolUse).toEqual(FOREIGN.hooks.PreToolUse);
    expect(settings.hooks.Stop).toEqual([...FOREIGN.hooks.Stop, { hooks: [{ type: "command", command, timeout: 15 }] }]);
    expect(settings.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command, timeout: 5 }] }]);
    expect(settings.hooks.SessionEnd).toEqual([{ hooks: [{ type: "command", command, timeout: 30 }] }]);
    expect(JSON.stringify(settings)).not.toContain(SECRET);
    expect(fs.existsSync(`${c.settingsPath}.pw-memory.bak`)).toBe(true);
  });

  it("is idempotent", async () => {
    const c = ctx();
    await install(c);
    const once = readSettings(c);
    await install(c);
    expect(readSettings(c)).toEqual(once);
  });

  it("keeps values already in the config file when env lacks them", async () => {
    const c = ctx();
    await install(c);
    await install(ctx({ env: { TDAI_URL: "http://gw2:8420" } }));
    expect(JSON.parse(fs.readFileSync(c.configPath, "utf-8"))).toMatchObject({ TDAI_URL: "http://gw2:8420", TDAI_USER_KEY: SECRET });
  });

  it("warns about the #1268 plugin's own hooks and reports a failed registration", async () => {
    const c = ctx({}, 1);
    fs.mkdirSync(path.dirname(c.settingsPath), { recursive: true });
    fs.writeFileSync(c.settingsPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "node", args: ["/x/claude-code-plugin/dist/hooks/cli.js"] }] }] } }));
    const report = await install(c);
    expect(report.ok).toBe(false);
    expect(report.warnings.join("\n")).toMatch(/twice/);
    expect(report.warnings.join("\n")).toMatch(/failed \(exit 1\): boom/);
  });

  it("refuses to overwrite a settings file it cannot parse", async () => {
    const c = ctx();
    fs.mkdirSync(path.dirname(c.settingsPath), { recursive: true });
    fs.writeFileSync(c.settingsPath, "{ broken");
    await expect(install(c)).rejects.toThrow();
    expect(fs.readFileSync(c.settingsPath, "utf-8")).toBe("{ broken");
  });
});

describe("uninstall", () => {
  it("removes only pw-memory hooks and the registration; --purge deletes the config", async () => {
    const c = ctx();
    fs.mkdirSync(path.dirname(c.settingsPath), { recursive: true });
    fs.writeFileSync(c.settingsPath, JSON.stringify(FOREIGN));
    await install(c);
    calls = [];

    const dry = await uninstall(ctx({ dryRun: true }), { purge: true });
    expect(calls).toEqual([]);
    expect(dry.actions.join("\n")).toContain("remove pw-memory hooks");
    expect(fs.existsSync(c.configPath)).toBe(true);

    await uninstall(c, { purge: false });
    expect(calls).toEqual([["claude", "mcp", "remove", "--scope", "user", "pw-memory"]]);
    expect(readSettings(c)).toEqual(FOREIGN);
    expect(fs.existsSync(c.configPath)).toBe(true);

    await uninstall(c, { purge: true });
    expect(fs.existsSync(c.configPath)).toBe(false);
  });
});

describe("hook merging", () => {
  it("drops empty groups and the hooks key when nothing else is left", () => {
    const merged = addOurHooks({}, `node /x/cli.js ${HOOK_SUBCOMMAND}`);
    expect(Object.keys(merged.hooks ?? {})).toEqual(["UserPromptSubmit", "Stop", "SessionEnd"]);
    expect(removeOurHooks(merged)).toEqual({});
  });
});
