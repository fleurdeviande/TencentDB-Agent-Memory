// Drives dist/server.js over real stdio like Claude Code does, then prints one JSON summary.
// Env: SMOKE_SERVER (path to dist/server.js), SMOKE_EXPECT_TOOLS (comma list); the rest goes to the server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const stderr = [];
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.env.SMOKE_SERVER],
  env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
const client = new Client({ name: "pw-smoke", version: "0.0.0" });

function text(result) {
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

const summary = { ok: true, steps: [] };
function step(name, pass, detail) {
  summary.steps.push({ name, pass, detail });
  if (!pass) summary.ok = false;
}

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const expected = (process.env.SMOKE_EXPECT_TOOLS ?? "").split(",").filter(Boolean);
  const missing = expected.filter((name) => !tools.includes(name));
  step("tools/list", missing.length === 0 && new Set(tools).size === tools.length,
    `${tools.length} tools${missing.length ? `, missing ${missing.join(",")}` : ""}: ${tools.join(",")}`);

  if (tools.includes("tdai_memory_capture")) {
    const marker = `pwsmoke${Date.now()}`;
    const capture = await client.callTool({
      name: "tdai_memory_capture",
      arguments: { note: `Smoke milestone ${marker}: nothing was deployed.`, session_id: "pw-smoke" },
    });
    step("memory write: tdai_memory_capture", !capture.isError && /Captured \(1 message\)/.test(text(capture)), text(capture));
    const search = await client.callTool({ name: "tdai_conversation_search", arguments: { query: marker, session_id: "pw-smoke" } });
    step("memory read-back: tdai_conversation_search", !search.isError && text(search).includes(marker), text(search).slice(0, 240));
    const l1 = await client.callTool({ name: "tdai_memory_search", arguments: { query: "deploy" } });
    step("memory search: tdai_memory_search well-formed", !l1.isError, text(l1).slice(0, 240));
  }
  if (tools.includes("code_status")) {
    const status = await client.callTool({ name: "code_status", arguments: { code_graph_id: "cg-does-not-exist" } });
    // An unknown id must come back as "not found" — a 400/401 would mean tenancy or auth headers are wrong.
    const notFound = (result) => !result.isError || /HTTP 404|not found/i.test(text(result));
    step("knowledge: code_status answers (result or not-found)", notFound(status),
      `isError=${status.isError} ${text(status).slice(0, 240)}`);
    const wiki = await client.callTool({ name: "wiki_list", arguments: { wiki_id: "wiki-does-not-exist" } });
    step("knowledge: wiki_list answers (result or not-found)", notFound(wiki),
      `isError=${wiki.isError} ${text(wiki).slice(0, 240)}`);
  }
  if (tools.includes("tdai_wiki_list")) {
    const wikis = await client.callTool({ name: "tdai_wiki_list", arguments: {} });
    step("knowledge via plugin: tdai_wiki_list lists wikis", !wikis.isError && "items" in (wikis.structuredContent ?? {}), `isError=${wikis.isError ?? false} ${text(wikis).slice(0, 240)}`);
  }
} catch (error) {
  step("protocol (stdout must carry JSON-RPC only)", false, error instanceof Error ? error.message : String(error));
} finally {
  await client.close().catch(() => {});
}

const log = stderr.join("");
const secret = process.env.TDAI_USER_KEY;
step("no key in server stderr", !secret || !log.includes(secret), `${log.split("\n").filter(Boolean).length} stderr lines`);
summary.serverStderr = log.split("\n").filter(Boolean).slice(0, 12);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = summary.ok ? 0 : 1;
