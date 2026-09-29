import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPwConfig } from "../src/config.js";
import { runHook } from "../src/hook.js";
import { applyKeyIdentity, isPersonalKey } from "../src/identity.js";
import { fakeService, type FakeService } from "./helpers.js";

const KEY = "sk-mem-identitytest";
let dir: string;
let gateway: FakeService;

function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: dir,
    PW_MEMORY_CONFIG: path.join(dir, "none.json"),
    TDAI_CLAUDE_CODE_STATE_DIR: path.join(dir, "state"),
    TDAI_URL: gateway.url,
    TDAI_USER_KEY: KEY,
    ...values,
  };
}

async function withGateway(teams: Array<{ team_id: string; status?: string }>): Promise<void> {
  gateway = await fakeService({
    "/v3/meta/auth/verify": { valid: true, user: { user_id: "usr-me" } },
    "/v3/meta/team/list": { items: teams, total: teams.length },
    "/v3/atomic/search": { items: [] },
    "/v3/core/read": { path: "core.md", content: "" },
    "/v3/scenario/ls": { entries: [] },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-identity-"));
});
afterEach(async () => {
  await gateway?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("applyKeyIdentity", () => {
  it("derives the user and the only team from the personal key; TDAI_USER_ID is overridden", async () => {
    await withGateway([{ team_id: "team-1", status: "active" }]);
    const config = await applyKeyIdentity(loadPwConfig(env({ TDAI_USER_ID: "someone-else" }), { ignoreFile: true }));
    expect(config.memory).toBeDefined();
    expect(config.pluginEnv.TDAI_USER_ID).toBe("usr-me");
    expect(config.pluginEnv.TDAI_TEAM_ID).toBe("team-1");
    expect(config.notes.join("\n")).toMatch(/TDAI_USER_ID=someone-else ignored/);
    const verify = gateway.requests.find((r) => r.path === "/v3/meta/auth/verify");
    expect(verify?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(verify?.body).toEqual({ user_key: KEY });
  });

  it("caches the answer in the state dir (0600), so hooks do not ask every time", async () => {
    await withGateway([{ team_id: "team-1" }]);
    await applyKeyIdentity(loadPwConfig(env(), { ignoreFile: true }));
    const asked = gateway.requests.length;
    const again = await applyKeyIdentity(loadPwConfig(env(), { ignoreFile: true }));
    expect(gateway.requests.length).toBe(asked);
    expect(again.pluginEnv.TDAI_USER_ID).toBe("usr-me");
    const file = path.join(dir, "state", "pw-identity.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8")).not.toContain(KEY);
  });

  it("several teams: TDAI_TEAM_ID picks one, without it the memory half is disabled", async () => {
    await withGateway([{ team_id: "team-1" }, { team_id: "team-2" }, { team_id: "team-3", status: "archived" }]);
    const unset = await applyKeyIdentity(loadPwConfig(env(), { ignoreFile: true }));
    expect(unset.memory).toBeUndefined();
    expect(unset.notes.join("\n")).toMatch(/in 2 teams, set TDAI_TEAM_ID to one of team-1, team-2/);

    const picked = await applyKeyIdentity(loadPwConfig(env({ TDAI_TEAM_ID: "team-2" }), { ignoreFile: true }));
    expect(picked.memory).toBeDefined();
    expect(picked.pluginEnv).toMatchObject({ TDAI_USER_ID: "usr-me", TDAI_TEAM_ID: "team-2" });

    const foreign = await applyKeyIdentity(loadPwConfig(env({ TDAI_TEAM_ID: "team-9" }), { ignoreFile: true }));
    expect(foreign.notes.join("\n")).toMatch(/TDAI_TEAM_ID=team-9: user usr-me is not an active member/);
  });

  it("a gateway without personal keys, or a non-personal key, keeps the configured identity", async () => {
    gateway = await fakeService({});
    const old = await applyKeyIdentity(loadPwConfig(env({ TDAI_USER_ID: "u1" }), { ignoreFile: true }));
    expect(old.pluginEnv.TDAI_USER_ID).toBe("u1");
    expect(old.notes.join("\n")).toMatch(/identity not derived from TDAI_USER_KEY/);

    const before = gateway.requests.length;
    const shared = await applyKeyIdentity(loadPwConfig(env({ TDAI_USER_KEY: "shared-gateway-key" }), { ignoreFile: true }));
    expect(gateway.requests.length).toBe(before);
    expect(shared.notes.join("\n")).toMatch(/TDAI_USER_ID is unset/);
    expect(isPersonalKey("sk-mem-")).toBe(false);
  });

  it("an unreachable gateway is a note, not a failure", async () => {
    gateway = await fakeService({});
    const config = await applyKeyIdentity(loadPwConfig(env({ TDAI_URL: "http://127.0.0.1:9" }), { ignoreFile: true }), {
      timeoutMs: 500,
    });
    expect(config.memory).toBeDefined();
    expect(config.notes.join("\n")).toMatch(/gateway unreachable/);
  });
});

describe("hooks with a personal key", () => {
  it("recall carries the derived user and team, not the configured TDAI_USER_ID", async () => {
    await withGateway([{ team_id: "team-1" }]);
    const payload = { hook_event_name: "UserPromptSubmit", session_id: "s", prompt_id: "p", cwd: dir, prompt: "hi" };
    await runHook(JSON.stringify(payload), {
      env: env({ TDAI_USER_ID: "spoof" }),
      log: () => {},
      claudeConfigDir: path.join(dir, "claude"),
    });
    const search = gateway.requests.find((r) => r.path === "/v3/atomic/search");
    expect(search?.body).toMatchObject({ user_id: "usr-me", team_id: "team-1" });
  });
});
