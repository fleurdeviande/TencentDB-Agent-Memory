import { describe, expect, it } from "vitest";
import { DEFAULT_FACTORIES } from "../src/backends.js";
import { loadPwConfig } from "../src/config.js";
import { SUPERSEDED_PLUGIN_TOOLS } from "../src/memory-backend.js";
import { createPwServer } from "../src/server.js";
import { connectClient, fakeService, text } from "./helpers.js";

const KNOWLEDGE_TOOLS = [
  "code_search", "code_explore", "code_callers", "code_callees", "code_impact", "code_node", "code_status", "code_files",
  "wiki_search", "wiki_read", "wiki_list", "wiki_graph",
];
const MEMORY_TOOLS = ["tdai_memory_search", "tdai_conversation_search", "tdai_scenario_read", "tdai_memory_capture"];

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { HOME: "/nonexistent", PW_MEMORY_CONFIG: "/nonexistent/config.json", ...values };
}

async function open(values: Record<string, string>) {
  const { server, registry } = await createPwServer(loadPwConfig(env(values)), DEFAULT_FACTORIES, () => {});
  const { client, close } = await connectClient(server);
  return { client, registry, close };
}

describe("real tool listing", () => {
  async function list(values: Record<string, string>) {
    const { client, registry, close } = await open(values);
    const listed = (await client.listTools()).tools.map((t) => t.name);
    const instructions = client.getInstructions();
    await close();
    return { listed, registry, instructions };
  }

  it("exposes the 12 knowledge tools plus the memory tools, with no collisions and no superseded duplicates", async () => {
    const { listed, registry, instructions } = await list({ TDAI_URL: "http://127.0.0.1:9", KNOWLEDGE_URL: "http://127.0.0.1:9" });
    expect(listed).toEqual([...KNOWLEDGE_TOOLS, ...MEMORY_TOOLS, "tdai_wiki_list", "tdai_wiki_write"]);
    expect(new Set(listed).size).toBe(listed.length);
    expect(registry.collisions).toEqual([]);
    for (const superseded of Object.keys(SUPERSEDED_PLUGIN_TOOLS)) expect(listed).not.toContain(superseded);
    for (const replacement of Object.values(SUPERSEDED_PLUGIN_TOOLS)) expect(listed).toContain(replacement);
    expect(instructions).toMatch(/TencentDB Agent Memory/);
    expect(instructions).toMatch(/code_\*/);
  });

  it("memory only: 4 memory tools, no wiki tools", async () => {
    expect((await list({ TDAI_URL: "http://127.0.0.1:9" })).listed).toEqual(MEMORY_TOOLS);
  });

  it("knowledge only: the 12 upstream tools", async () => {
    expect((await list({ KNOWLEDGE_URL: "http://127.0.0.1:9" })).listed).toEqual(KNOWLEDGE_TOOLS);
  });

  it("nothing configured: starts with an empty list", async () => {
    expect((await list({})).listed).toEqual([]);
  });
});

describe("round trips over HTTP", () => {
  it("memory: tdai_memory_search and tdai_memory_capture reach the gateway with the user key and isolation", async () => {
    const gateway = await fakeService({
      "/v3/atomic/search": { items: [{ id: "m1", type: "episodic", content: "Deployed GLM on r4", score: 0.9 }] },
      "/v3/conversation/add": { accepted_ids: ["c1"], total_count: 1 },
    });
    const { client, close } = await open({ TDAI_URL: gateway.url, TDAI_USER_KEY: "sk-mem-test", TDAI_TEAM_ID: "t1", TDAI_USER_ID: "u1" });
    try {
      const search = await client.callTool({ name: "tdai_memory_search", arguments: { query: "deploy" } });
      expect(text(search)).toContain("Deployed GLM on r4");
      const capture = await client.callTool({ name: "tdai_memory_capture", arguments: { note: "decided X", session_id: "s1" } });
      expect(text(capture)).toContain("Captured (1 message)");
      const [first, second] = gateway.requests;
      expect(first.path).toBe("/v3/atomic/search");
      expect(first.headers.authorization).toBe("Bearer sk-mem-test");
      expect(first.body).toMatchObject({ team_id: "t1", user_id: "u1", query: "deploy" });
      expect(second).toMatchObject({ path: "/v3/conversation/add", body: { session_id: "s1" } });
    } finally {
      await close();
      await gateway.close();
    }
  });

  it("knowledge: code_status passes {text,isError} through; JSON answers are serialised; errors are tool errors", async () => {
    const knowledge = await fakeService({
      "/v3/code-graph/status": { text: "cg-1: ready, 420 files", isError: false },
      "/v3/wiki/page/ls": { pages: [{ ref: "arch", title: "Architecture" }] },
    });
    const { client, close } = await open({ KNOWLEDGE_URL: knowledge.url, TDAI_USER_KEY: "sk-mem-test" });
    try {
      const status = await client.callTool({ name: "code_status", arguments: { code_graph_id: "cg-1" } });
      expect(status).toMatchObject({ isError: false, content: [{ text: "cg-1: ready, 420 files" }] });
      const pages = await client.callTool({ name: "wiki_list", arguments: { wiki_id: "wiki-1" } });
      expect(JSON.parse(text(pages))).toEqual({ pages: [{ ref: "arch", title: "Architecture" }] });
      const missing = await client.callTool({ name: "code_impact", arguments: { code_graph_id: "cg-1", symbol: "x" } });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toContain("no route /v3/code-graph/impact");
      expect(knowledge.requests[0]).toMatchObject({ path: "/v3/code-graph/status", body: { code_graph_id: "cg-1" } });
      expect(knowledge.requests[0].headers.authorization).toBe("Bearer sk-mem-test");
    } finally {
      await close();
      await knowledge.close();
    }
  });

  it("unreachable services give clean tool errors, not crashes", async () => {
    const { client, close } = await open({ TDAI_URL: "http://127.0.0.1:9", KNOWLEDGE_URL: "http://127.0.0.1:9" });
    try {
      expect((await client.callTool({ name: "code_status", arguments: { code_graph_id: "cg-1" } })).isError).toBe(true);
      expect((await client.callTool({ name: "tdai_memory_search", arguments: { query: "x" } })).isError).toBe(true);
    } finally {
      await close();
    }
  });
});
