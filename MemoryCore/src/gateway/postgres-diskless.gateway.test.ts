/**
 * STORE_MODE=postgres end to end: nothing durable of MemoryCore lands in the data dir.
 *
 * A real gateway process (standalone, shared key) runs against Postgres with a stub
 * OpenAI-compatible LLM that answers L1 extraction with a memory, L2 with a `write`
 * tool call creating a scene block and L3 with one creating persona.md. The test
 *   1. writes L0 and waits for L1 rows, an L2 scene row and an L3 persona row;
 *   2. asserts the data dir is still empty while the file plane (checkpoints,
 *      generation logs, L1 JSONL shards) sits in pgfs and pipeline state in Postgres;
 *   3. writes a second conversation whose L1 call never returns, kills the process
 *      (SIGKILL) while that task is claimed, starts a new one and sees the task
 *      recovered and finished — the queue lived in Postgres, not in the process;
 *   4. reads L0–L3 back through /v3 after the restart, stops gracefully and checks
 *      the data dir once more.
 * Skipped when POSTGRES_TEST_URL does not answer.
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSharedPostgresPools } from "../core/store/postgres/client.js";
import {
  dropTestSchema,
  postgresReachable,
  TEST_POSTGRES_URL,
  testPool,
  uniqueTestSchema,
} from "../core/store/postgres/test-support.js";

const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KEY = "diskless-test-key";
const TEAM = "team-pg";
const AGENT = "agent-pg";
const USER = "user-pg";

const pgUp = await postgresReachable();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Every path under `dir`, relative, directories with a trailing slash. */
function listTree(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = path.relative(base, p);
    if (statSync(p).isDirectory()) out.push(`${rel}/`, ...listTree(p, base));
    else out.push(rel);
  }
  return out.sort();
}

// ── Stub LLM ────────────────────────────────────────────────────────────────

interface StubLlm {
  url: string;
  /** While true, an L1 request for the "HANG" conversation is never answered. */
  hang: boolean;
  hangSeen: boolean;
  close: () => Promise<void>;
}

const SCENE = [
  "-----META-START-----",
  "created: 2026-09-29T10:00:00.000Z",
  "updated: 2026-09-29T10:00:00.000Z",
  "summary: database preferences",
  "heat: 1",
  "-----META-END-----",
  "",
  "## Database",
  "The user prefers PostgreSQL over MongoDB.",
].join("\n");

async function startStubLlm(): Promise<StubLlm> {
  const stub: StubLlm = { url: "", hang: true, hangSeen: false, close: async () => undefined };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += String(c)));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model?: string; messages?: Array<{ role: string; content: unknown }>; tools?: unknown };
      const messages = body.messages ?? [];
      const system = messages.filter((m) => m.role === "system").map((m) => JSON.stringify(m.content)).join("\n");
      const all = JSON.stringify(messages);
      const reply = (message: Record<string, unknown>, finish = "stop") => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "stub",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? "stub",
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      };
      const writeCall = (p: string, content: string) =>
        reply({
          role: "assistant",
          content: null,
          tool_calls: [{ id: `call-${Date.now()}`, type: "function", function: { name: "write", arguments: JSON.stringify({ path: p, content }) } }],
        }, "tool_calls");

      if (system.includes("情境切分与")) {
        const second = all.includes("HANG-L1");
        if (second && stub.hang) {
          stub.hangSeen = true;
          return; // the L1 task stays claimed until the process dies
        }
        const memory = second ? "The user deploys everything with Ansible (second)" : "The user prefers PostgreSQL (first)";
        return reply({
          role: "assistant",
          content: JSON.stringify([{
            scene_name: "preferences",
            message_ids: [],
            memories: [{ content: memory, type: "persona", priority: 80, source_message_ids: [], metadata: {} }],
          }]),
        });
      }
      if (messages.some((m) => m.role === "tool")) return reply({ role: "assistant", content: "done" });
      if (system.includes("记忆整合架构师")) return writeCall("database.md", SCENE);
      if (body.tools) return writeCall("persona.md", "# Persona\n\nPrefers PostgreSQL; automates with Ansible.");
      return reply({ role: "assistant", content: "[]" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  stub.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

// ── Gateway process ─────────────────────────────────────────────────────────

interface Gateway {
  url: string;
  log: () => string;
  stop: () => Promise<void>;
  kill: () => Promise<void>;
}

async function startGateway(env: Record<string, string>): Promise<Gateway> {
  const port = await freePort();
  let out = "";
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/gateway/server.ts"], {
    cwd: CORE_DIR,
    env: { PATH: process.env.PATH ?? "", TDAI_GATEWAY_PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (out += String(d)));
  child.stderr?.on("data", (d) => (out += String(d)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`gateway exited early:\n${out}`);
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`gateway did not come up:\n${out}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const exited = () => new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve())));
  return {
    url,
    log: () => out,
    async stop() {
      const done = exited();
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 15_000);
      await done;
      clearTimeout(force);
    },
    async kill() {
      const done = exited();
      child.kill("SIGKILL");
      await done;
    },
  };
}

async function post(gw: Gateway, route: string, body: Record<string, unknown>): Promise<{ code: number; message: string; data?: any }> {
  const res = await fetch(`${gw.url}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "x-tdai-service-id": "default", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { code: number; message: string; data?: any };
}

const ids = { team_id: TEAM, agent_id: AGENT, user_id: USER };

async function waitFor<T>(what: string, probe: () => Promise<T | undefined | null | false>, gw: Gateway, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) {
      if (process.env.DISKLESS_TEST_LOG) writeFileSync(process.env.DISKLESS_TEST_LOG, gw.log());
      throw new Error(`timed out waiting for ${what}\n--- gateway log (tail) ---\n${gw.log().slice(-6000)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!pgUp)("gateway with STORE_MODE=postgres keeps nothing durable on disk", () => {
  const schema = uniqueTestSchema();
  const metaSchema = uniqueTestSchema();
  const q = (sql: string, params: unknown[] = []) => testPool().query(sql.replaceAll("$S", `"${schema}"`), params);
  let stub: StubLlm;
  let dataDir: string;
  let homeDir: string;
  let tmpDir: string;
  let cfgDir: string;
  let env: Record<string, string>;
  let gw: Gateway | undefined;

  beforeAll(async () => {
    stub = await startStubLlm();
    dataDir = mkdtempSync(path.join(tmpdir(), "pg-diskless-data-"));
    // A fresh HOME too, so nothing can hide in ~/.memory-tencentdb. TMPDIR is separate and
    // not asserted: it only receives tsx's transpile cache (the test runs sources, not dist).
    homeDir = mkdtempSync(path.join(tmpdir(), "pg-diskless-home-"));
    tmpDir = mkdtempSync(path.join(tmpdir(), "pg-diskless-tmp-"));
    cfgDir = mkdtempSync(path.join(tmpdir(), "pg-diskless-cfg-"));
    const cfgFile = path.join(cfgDir, "gateway.yaml");
    writeFileSync(cfgFile, [
      "deployMode: standalone",
      'stateBackend: "local"',
      "llm:",
      `  baseUrl: "${stub.url}"`,
      '  apiKey: "stub"',
      '  model: "stub-model"',
      "  timeoutMs: 120000",
      "memory:",
      '  storeBackend: "sqlite"',
      "  extraction:",
      "    enabled: true",
      "    enableDedup: false",
      "  persona:",
      "    triggerEveryN: 1",
      "  pipeline:",
      "    everyNConversations: 1",
      "    enableWarmup: true",
      "    l1IdleTimeoutSeconds: 600",
      "    l2DelayAfterL1Seconds: 1",
      "    l2MinIntervalSeconds: 1",
      "    l2MaxIntervalSeconds: 3600",
      "  embedding:",
      '    provider: "none"',
      "scanner:",
      "  intervalMs: 200",
      "worker:",
      "  pollMs: 100",
      // The worker renews locks every 30 s, so the TTL must exceed that and a claim
      // turns stale after TTL + 2 renewals (~91 s): the price of a real crash test.
      "  lockTtlMs: 31000",
      "  pendingStaleMs: 1000",
      "  pendingRecoveryIntervalMs: 500",
      "",
    ].join("\n"));
    env = {
      TDAI_GATEWAY_CONFIG: cfgFile,
      TDAI_GATEWAY_API_KEY: KEY,
      TDAI_DATA_DIR: dataDir,
      HOME: homeDir,
      TMPDIR: tmpDir,
      STORE_MODE: "postgres",
      POSTGRES_URL: TEST_POSTGRES_URL,
      POSTGRES_SCHEMA: schema,
      TDAI_METADATA_POSTGRES_SCHEMA: metaSchema,
    };
  });

  afterAll(async () => {
    await gw?.kill().catch(() => undefined);
    await stub?.close();
    await dropTestSchema(schema);
    await dropTestSchema(metaSchema);
    await closeSharedPostgresPools();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it("runs L0 → L1 → L2 → L3 with an empty data dir, survives a crash mid-task and reads everything back", async () => {
    gw = await startGateway(env);
    expect(gw.log()).toContain("state_backend=postgres");
    expect(gw.log()).toContain("fileStore=rowfs, others=pgfs");

    const add1 = await post(gw, "/v3/conversation/add", {
      ...ids,
      session_id: "s1",
      messages: [
        { role: "user", content: "For every new project I want PostgreSQL rather than MongoDB, please remember it." },
        { role: "assistant", content: "Noted: PostgreSQL by default." },
      ],
    });
    expect(add1.code, add1.message).toBe(0);

    const current = gw;
    await waitFor("L1 record", async () => (await q(`SELECT 1 FROM $S.l1_records WHERE content LIKE '%(first)%'`)).rowCount, current);
    await waitFor("L2 scene row", async () => (await q(`SELECT 1 FROM $S.profiles WHERE type = 'l2' AND filename = 'database.md'`)).rowCount, current);
    await waitFor("L3 persona row", async () => (await q(`SELECT 1 FROM $S.profiles WHERE type = 'l3'`)).rowCount, current);

    // Everything the file plane wrote went to pgfs; the data dir stayed empty.
    expect(listTree(dataDir)).toEqual([]);
    expect(listTree(homeDir)).toEqual([]);
    const objects = (await q(`SELECT key FROM $S.fs_objects ORDER BY key`)).rows.map((r) => r.key as string);
    const scope = `profiles/${encodeURIComponent(`team:${TEAM}|agent:${AGENT}`)}/`;
    expect(objects).toContain(`${scope}.metadata/checkpoint.json`);
    expect(objects.some((k) => k.startsWith("records/"))).toBe(true);
    expect(objects.some((k) => k.startsWith("conversations/"))).toBe(false); // L0 mirror off
    expect(objects.some((k) => k.startsWith("scene_blocks/") || k.endsWith("persona.md"))).toBe(false); // rows, not objects
    expect((await q(`SELECT count(*)::int AS n FROM $S.pipeline_sessions`)).rows[0].n).toBeGreaterThan(0);

    // A second conversation whose L1 call hangs: kill the process while the task is claimed.
    const add2 = await post(gw, "/v3/conversation/add", {
      ...ids,
      session_id: "s2",
      messages: [
        { role: "user", content: "HANG-L1: all of our servers are configured through Ansible playbooks." },
        { role: "assistant", content: "Understood, Ansible it is." },
      ],
    });
    expect(add2.code, add2.message).toBe(0);
    await waitFor("the hanging L1 call", async () => stub.hangSeen, current);
    const claimed = await q(`SELECT owner_id FROM $S.pipeline_tasks WHERE payload->>'sessionId' = 's2' AND payload->>'type' = 'L1'`);
    expect(claimed.rows.map((r) => r.owner_id !== null)).toEqual([true]);
    await gw.kill();
    gw = undefined;
    expect(listTree(dataDir)).toEqual([]);
    expect(listTree(homeDir)).toEqual([]);

    // Restart: the orphaned claim is recovered by the new worker and completes.
    stub.hang = false;
    gw = await startGateway(env);
    const restarted = gw;
    await waitFor(
      "recovered L1 record",
      async () => (await q(`SELECT 1 FROM $S.l1_records WHERE content LIKE '%(second)%'`)).rowCount,
      restarted,
      150_000,
    );
    await waitFor(
      "the recovered task to be acked",
      async () => (await q(`SELECT 1 FROM $S.pipeline_tasks WHERE payload->>'sessionId' = 's2' AND payload->>'type' = 'L1'`)).rowCount === 0,
      restarted,
    );

    // L0–L3 read back through the API of the new process.
    const l0 = await post(gw, "/v3/conversation/query", { ...ids, session_id: "s1" });
    expect(l0.code, l0.message).toBe(0);
    expect((l0.data.messages as Array<{ content: string }>).map((m) => m.content).join("\n")).toContain("PostgreSQL rather than MongoDB");
    const l1 = await post(gw, "/v3/atomic/query", { ...ids });
    expect(l1.code, l1.message).toBe(0);
    const l1Text = (l1.data.items as Array<{ content: string }>).map((i) => i.content).join("\n");
    expect(l1Text).toContain("(first)");
    expect(l1Text).toContain("(second)");
    const ls = await post(gw, "/v3/scenario/ls", { ...ids });
    expect(ls.code, ls.message).toBe(0);
    expect(JSON.stringify(ls.data)).toContain("database.md");
    const scene = await post(gw, "/v3/scenario/read", { ...ids, path: "database.md" });
    expect(scene.code, scene.message).toBe(0);
    expect(JSON.stringify(scene.data)).toContain("prefers PostgreSQL over MongoDB");
    const core = await post(gw, "/v3/core/read", { ...ids });
    expect(core.code, core.message).toBe(0);
    expect(JSON.stringify(core.data)).toContain("Prefers PostgreSQL");

    await gw.stop();
    gw = undefined;
    expect(listTree(dataDir)).toEqual([]);
    expect(listTree(homeDir)).toEqual([]);
  }, 300_000);
});
