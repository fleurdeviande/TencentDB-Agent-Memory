/**
 * Personal keys against a real gateway process (standalone, stub LLM).
 *
 * Seeds users/teams straight into the metadata store, starts the gateway, and drives the /v3
 * data plane with personal keys and with the shared key. Runs with SQLite metadata always and
 * with Postgres metadata + data plane when a database answers at POSTGRES_TEST_URL.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IMetadataStore } from "../metadata/store/interface.js";
import { SqliteMetadataStore } from "../metadata/store/sqlite-adapter.js";
import { PostgresMetadataStore } from "../metadata/store/postgres-adapter.js";
import { resolveSqliteDbPath } from "../metadata/store/db-name.js";
import { closeSharedPostgresPools } from "../core/store/postgres/client.js";
import {
  dropTestSchema,
  postgresReachable,
  TEST_POSTGRES_URL,
  testPool,
  uniqueTestSchema,
} from "../core/store/postgres/test-support.js";

const CORE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHARED = "shared-gateway-key-for-tests";
const KEYS = { alice: "sk-mem-test-alice-0000000000", bob: "sk-mem-test-bob-00000000000", carol: "sk-mem-test-carol-0000000000" };

interface Seeded {
  alice: string;
  bob: string;
  carol: string;
  teamA: string;
  teamB: string;
}

async function seed(store: IMetadataStore): Promise<Seeded> {
  await store.init();
  const mk = (name: keyof typeof KEYS) =>
    store.createUser({ auth_provider: "local", external_id: name, username: name, default_key_value: KEYS[name] });
  const alice = await mk("alice");
  const bob = await mk("bob");
  const carol = await mk("carol");
  const teamA = await store.createTeam({ name: "A", owner_user_id: alice.user_id });
  const teamB = await store.createTeam({ name: "B", owner_user_id: bob.user_id });
  await store.addTeamMember({ team_id: teamA.team_id, user_id: carol.user_id });
  await store.close();
  return { alice: alice.user_id, bob: bob.user_id, carol: carol.user_id, teamA: teamA.team_id, teamB: teamB.team_id };
}

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

interface Gateway {
  url: string;
  log: () => string;
  stop: () => Promise<void>;
}

async function startGateway(env: Record<string, string>): Promise<Gateway> {
  const port = await freePort();
  let out = "";
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/gateway/server.ts"], {
    cwd: CORE_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TDAI_GATEWAY_CONFIG: path.join(CORE_DIR, "tdai-gateway.standalone.yaml"),
      TDAI_GATEWAY_PORT: String(port),
      TDAI_LLM_BASE_URL: "http://127.0.0.1:9/v1",
      TDAI_LLM_API_KEY: "stub",
      TDAI_GATEWAY_API_KEY: SHARED,
      ...env,
    },
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
  return {
    url,
    log: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      }),
  };
}

async function post(
  gw: Gateway,
  route: string,
  bearer: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: { code: number; message: string; data?: any } }> {
  const res = await fetch(`${gw.url}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "x-tdai-service-id": "default",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

const addMsg = (team: string, content: string, extra: Record<string, unknown> = {}) => ({
  team_id: team,
  agent_id: "agent-1",
  session_id: "s1",
  messages: [{ role: "user", content }],
  ...extra,
});

const query = (team: string, extra: Record<string, unknown> = {}) => ({ team_id: team, agent_id: "agent-1", ...extra });

interface Backend {
  name: string;
  available: boolean;
  setup: () => Promise<{ env: Record<string, string>; seeded: Seeded; cleanup: () => Promise<void> }>;
}

const pgUp = await postgresReachable();

const backends: Backend[] = [
  {
    name: "sqlite",
    available: true,
    async setup() {
      const dir = mkdtempSync(path.join(tmpdir(), "pk-gw-"));
      const dbPath = resolveSqliteDbPath(path.join(dir, "metadata"), "default");
      const seeded = await seed(new SqliteMetadataStore(dbPath));
      return { env: { TDAI_DATA_DIR: dir }, seeded, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
    },
  },
  {
    name: "postgres",
    available: pgUp,
    async setup() {
      const dir = mkdtempSync(path.join(tmpdir(), "pk-gw-"));
      const dataSchema = uniqueTestSchema();
      const metaSchema = uniqueTestSchema();
      const seeded = await seed(new PostgresMetadataStore({ pool: testPool(), schema: metaSchema }));
      return {
        env: {
          TDAI_DATA_DIR: dir,
          STORE_MODE: "postgres",
          POSTGRES_URL: TEST_POSTGRES_URL,
          POSTGRES_SCHEMA: dataSchema,
          TDAI_METADATA_POSTGRES_SCHEMA: metaSchema,
        },
        seeded,
        async cleanup() {
          await dropTestSchema(dataSchema);
          await dropTestSchema(metaSchema);
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  },
];

afterAll(async () => {
  await closeSharedPostgresPools();
});

for (const backend of backends) {
  describe.skipIf(!backend.available)(`gateway personal keys [${backend.name} metadata]`, () => {
    let gw: Gateway;
    let s: Seeded;
    let cleanup: () => Promise<void>;
    let env: Record<string, string>;

    beforeAll(async () => {
      const ctx = await backend.setup();
      s = ctx.seeded;
      cleanup = ctx.cleanup;
      env = ctx.env;
      gw = await startGateway(env);
      for (const [key, team, text] of [
        [KEYS.alice, s.teamA, "alice in A"],
        [KEYS.carol, s.teamA, "carol in A"],
        [KEYS.bob, s.teamB, "bob in B"],
      ] as const) {
        const r = await post(gw, "/v3/conversation/add", key, addMsg(team, text));
        expect(r.json.code, `${text}: ${r.json.message}`).toBe(0);
      }
    });

    afterAll(async () => {
      await gw?.stop();
      await cleanup?.();
    });

    it("a personal key reads its own rows only, user_id derived from the key", async () => {
      const r = await post(gw, "/v3/conversation/query", KEYS.alice, query(s.teamA));
      expect(r.json.code).toBe(0);
      const msgs = r.json.data.messages as Array<{ user_id: string; content: string; team_id: string }>;
      expect(msgs.map((m) => m.content)).toEqual(["alice in A"]);
      expect(msgs.every((m) => m.user_id === s.alice && m.team_id === s.teamA)).toBe(true);
    });

    it("a team the key's user is not a member of → 403", async () => {
      const r = await post(gw, "/v3/conversation/query", KEYS.alice, query(s.teamB));
      expect(r.status).toBe(403);
      const w = await post(gw, "/v3/conversation/add", KEYS.alice, addMsg(s.teamB, "alice sneaks into B"));
      expect(w.status).toBe(403);
    });

    it("a spoofed user_id (body or header) is rejected with 403 and writes nothing", async () => {
      const w = await post(gw, "/v3/conversation/add", KEYS.alice, addMsg(s.teamA, "as carol", { user_id: s.carol }));
      expect(w.status).toBe(403);
      const h = await post(gw, "/v3/conversation/query", KEYS.alice, query(s.teamA), { "x-tdai-user-id": s.carol });
      expect(h.status).toBe(403);
      const carol = await post(gw, "/v3/conversation/query", KEYS.carol, query(s.teamA));
      expect((carol.json.data.messages as Array<{ content: string }>).map((m) => m.content)).toEqual(["carol in A"]);
    });

    it("an unknown personal key → 401", async () => {
      const r = await post(gw, "/v3/conversation/query", "sk-mem-nobody-000000000000", query(s.teamA));
      expect(r.status).toBe(401);
    });

    it("the shared key keeps upstream behaviour (caller-asserted identity) in trusted mode", async () => {
      const r = await post(gw, "/v3/conversation/query", SHARED, query(s.teamA, { user_id: s.carol }));
      expect(r.json.code).toBe(0);
      expect((r.json.data.messages as Array<{ content: string }>).map((m) => m.content)).toEqual(["carol in A"]);
      expect(gw.log()).toContain("Shared gateway key is trusted on the /v3 memory data plane");
      expect(gw.log()).toContain("[auth] shared gateway key used on /v3/conversation/query");
    });

    it("/v3/meta accepts the personal key as Bearer (doubles as x-tdai-user-key)", async () => {
      const r = await post(gw, "/v3/meta/auth/verify", KEYS.bob, { user_key: KEYS.bob });
      expect(r.json.code).toBe(0);
      expect(r.json.data.user.user_id).toBe(s.bob);
      const mismatch = await post(gw, "/v3/meta/auth/verify", KEYS.bob, { user_key: KEYS.bob }, { "x-tdai-user-key": KEYS.alice });
      expect(mismatch.status).toBe(401);
    });

    it("TDAI_GATEWAY_SHARED_KEY_MODE=off: the shared key is refused on L0–L3, personal keys still work", async () => {
      await gw.stop();
      gw = await startGateway({ ...env, TDAI_GATEWAY_SHARED_KEY_MODE: "off" });
      const shared = await post(gw, "/v3/conversation/query", SHARED, query(s.teamA, { user_id: s.carol }));
      expect(shared.status).toBe(401);
      const personal = await post(gw, "/v3/conversation/query", KEYS.carol, query(s.teamA));
      expect(personal.json.code).toBe(0);
      // Management routes outside L0–L3 keep the shared key.
      const meta = await post(gw, "/v3/meta/auth/verify", SHARED, { user_key: KEYS.carol }, { "x-tdai-user-key": KEYS.carol });
      expect(meta.json.code).toBe(0);
    });
  });
}
