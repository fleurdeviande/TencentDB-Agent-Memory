import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PW_TOOLS_GUIDE, runHook } from "../src/hook.js";
import { MEMORY_TOOLS_GUIDE } from "../src/upstream/memory.js";
import { fakeService, type FakeService } from "./helpers.js";

let dir: string;
let gateway: FakeService;
const logs: string[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-hook-"));
  logs.length = 0;
  gateway = await fakeService({
    "/v3/atomic/search": { items: [{ id: "m1", type: "episodic", content: "Deployed GLM on r4", score: 0.9 }] },
    "/v3/core/read": { path: "core.md", content: "Prefers Ansible over kubectl edit." },
    "/v3/scenario/ls": { entries: [{ path: "scene/deploy.md", summary: "deploys" }] },
    "/v3/conversation/add": { accepted_ids: ["c1", "c2"], total_count: 2 },
  });
});
afterEach(async () => {
  await gateway.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function env(values: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: dir,
    PW_MEMORY_CONFIG: path.join(dir, "config.json"),
    TDAI_CLAUDE_CODE_STATE_DIR: path.join(dir, "state"),
    TDAI_URL: gateway.url,
    KNOWLEDGE_URL: "http://127.0.0.1:9",
    TDAI_USER_KEY: "sk-mem-hooktest",
    ...values,
  };
}

async function hook(payload: Record<string, unknown>, values?: Record<string, string>) {
  const out = await runHook(JSON.stringify(payload), { env: env(values), log: (m) => logs.push(m), claudeConfigDir: path.join(dir, "claude") });
  return JSON.parse(out) as { hookSpecificOutput?: { hookEventName: string; additionalContext: string } };
}

function prompt(sessionId: string, promptId: string, text: string) {
  return { hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt_id: promptId, cwd: dir, prompt: text };
}

describe("runHook", () => {
  it("answers {} and calls nothing when the memory half is disabled", async () => {
    const out = await runHook(JSON.stringify(prompt("s", "p", "hi")), { env: env({ TDAI_URL: "" }), log: () => {} });
    expect(out).toBe("{}");
    expect(gateway.requests).toHaveLength(0);
  });

  it("fails open on garbage input", async () => {
    expect(await runHook("not json", { env: env(), log: (m) => logs.push(m) })).toBe("{}");
    expect(logs[0]).toMatch(/hook failed open/);
  });

  it("sends the stable block once per session, then only the per-prompt memories", async () => {
    const first = await hook(prompt("s1", "p1", "how do we deploy?"));
    const context1 = first.hookSpecificOutput?.additionalContext ?? "";
    expect(first.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
    expect(context1).toContain("<user-persona>");
    expect(context1).toContain("scene/deploy.md");
    expect(context1).toContain(PW_TOOLS_GUIDE);
    expect(context1).toContain("<relevant-memories>");

    const second = await hook(prompt("s1", "p2", "and rollback?"));
    const context2 = second.hookSpecificOutput?.additionalContext ?? "";
    expect(context2).not.toContain("<user-persona>");
    expect(context2).not.toContain("<memory-tools-guide>");
    expect(context2).toBe("<relevant-memories>\n- [episodic] Deployed GLM on r4\n</relevant-memories>");

    // Persona and scenes are fetched on the first prompt only.
    expect(gateway.requests.filter((r) => r.path === "/v3/core/read")).toHaveLength(1);
    expect(gateway.requests[0].headers.authorization).toBe("Bearer sk-mem-hooktest");

    // A new session gets a byte-identical stable block when the memory has not changed.
    const other = await hook(prompt("s2", "p1", "how do we deploy?"));
    expect(other.hookSpecificOutput?.additionalContext).toBe(context1);
  });

  it("names MemoryKnowledge's wiki tools in the guide only when the knowledge half is on", async () => {
    expect(PW_TOOLS_GUIDE).not.toBe(MEMORY_TOOLS_GUIDE);
    expect(PW_TOOLS_GUIDE).toContain("wiki_search / wiki_read");
    expect(PW_TOOLS_GUIDE).not.toContain("tdai_wiki_search");
    const withoutKnowledge = await hook(prompt("s3", "p1", "q"), { KNOWLEDGE_URL: "" });
    expect(withoutKnowledge.hookSpecificOutput?.additionalContext).toContain(MEMORY_TOOLS_GUIDE);
  });

  it("captures the turn at Stop", async () => {
    await hook(prompt("s4", "p1", "ship it"));
    await hook({ hook_event_name: "Stop", session_id: "s4", prompt_id: "p1", cwd: dir, last_assistant_message: "Shipped." });
    const add = gateway.requests.find((r) => r.path === "/v3/conversation/add");
    expect(add?.body).toMatchObject({ session_id: "s4" });
    expect(JSON.stringify(add?.body)).toContain("Shipped.");
  });
});
