/**
 * Postgres-specific behaviour beyond the shared contract: vector search,
 * dimension changes / reindex, isolation pushdown on every path, profiles'
 * optimistic lock, and the entity surface the gateway uses.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "../../record/l1-writer.js";
import type { L0Record } from "../types.js";
import { buildFtsQuery } from "../tokenize.js";
import { closeSharedPostgresPools } from "./client.js";
import { PostgresMemoryStore } from "./memory-store.js";
import { dropTestSchema, postgresReachable, testPool, uniqueTestSchema } from "./test-support.js";

const reachable = await postgresReachable();
const schemas: string[] = [];

async function open(dimensions = 3, schema = uniqueTestSchema(), model = "m1"): Promise<PostgresMemoryStore> {
  if (!schemas.includes(schema)) schemas.push(schema);
  const store = new PostgresMemoryStore({ pool: testPool(), schema, dimensions });
  await store.init({ provider: "openai", model });
  return store;
}

const vec = (...v: number[]) => new Float32Array(v);

function l1(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  const ts = over.updatedAt ?? new Date().toISOString();
  return {
    id,
    content,
    type: "persona",
    priority: 50,
    scene_name: "",
    source_message_ids: [],
    metadata: {},
    timestamps: [ts],
    createdAt: ts,
    updatedAt: ts,
    sessionKey: "sk",
    sessionId: "sid",
    ...over,
  };
}

function l0(id: string, text: string, over: Partial<L0Record> = {}): L0Record {
  return {
    id,
    sessionKey: "sk",
    sessionId: "sid",
    role: "user",
    messageText: text,
    recordedAt: new Date().toISOString(),
    timestamp: Date.now(),
    ...over,
  };
}

describe.skipIf(!reachable)("PostgresMemoryStore backend specifics", () => {
  afterEach(async () => {
    await Promise.all(schemas.splice(0).map((s) => dropTestSchema(s)));
  });
  afterAll(async () => {
    await closeSharedPostgresPools();
  });

  describe("vector search", () => {
    it("ranks L1/L0 by cosine similarity and honours topK", async () => {
      const s = await open();
      await s.upsertL1(l1("x", "points at x"), vec(1, 0, 0));
      await s.upsertL1(l1("y", "points at y"), vec(0, 1, 0));
      await s.upsertL1(l1("xy", "between x and y"), vec(1, 1, 0));
      const hits = await s.searchL1Vector(vec(1, 0.1, 0), 2);
      expect(hits.map((h) => h.record_id)).toEqual(["x", "xy"]);
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
      expect(hits[0].score).toBeCloseTo(0.995, 2);

      await s.upsertL0(l0("m-x", "x"), vec(1, 0, 0));
      await s.upsertL0(l0("m-z", "z"), vec(0, 0, 1));
      const l0Hits = await s.searchL0Vector(vec(0, 0.1, 1), 1);
      expect(l0Hits.map((h) => h.record_id)).toEqual(["m-z"]);
    });

    it("keeps metadata but skips zero, wrong-sized and absent vectors", async () => {
      const s = await open();
      expect(await s.upsertL1(l1("zero", "zero"), vec(0, 0, 0))).toBe(true);
      expect(await s.upsertL1(l1("short", "short"), vec(1, 0))).toBe(true);
      expect(await s.upsertL1(l1("none", "none"))).toBe(true);
      expect(await s.countL1()).toBe(3);
      expect(await s.searchL1Vector(vec(1, 0, 0), 10)).toEqual([]);
      expect(await s.searchL1Vector(vec(1, 0), 10)).toEqual([]);
    });

    it("an upsert without an embedding keeps the stored vector; updateL0Embedding fills a deferred one", async () => {
      const s = await open();
      await s.upsertL1(l1("a", "v1"), vec(1, 0, 0));
      await s.upsertL1(l1("a", "v2 content"));
      const [hit] = await s.searchL1Vector(vec(1, 0, 0), 1);
      expect(hit.content).toBe("v2 content");

      await s.upsertL0(l0("deferred", "embedded later"));
      expect(await s.searchL0Vector(vec(0, 1, 0), 5)).toEqual([]);
      expect(await s.updateL0Embedding("deferred", vec(0, 1, 0))).toBe(true);
      expect(await s.updateL0Embedding("missing", vec(0, 1, 0))).toBe(false);
      expect((await s.searchL0Vector(vec(0, 1, 0), 5)).map((h) => h.record_id)).toEqual(["deferred"]);
    });

    it("pushes isolation into the KNN query: a filtered search is not starved by closer foreign rows", async () => {
      const s = await open();
      // 200 near-identical team-b rows sit closer to the query than the 3 team-a rows.
      for (let i = 0; i < 200; i++) {
        await s.upsertL1(l1(`b-${i}`, "decoy", { teamId: "team-b" }), vec(1, 0.001 * i, 0));
      }
      for (let i = 0; i < 3; i++) {
        await s.upsertL1(l1(`a-${i}`, "target", { teamId: "team-a" }), vec(0.2, 1, 0.1 * i));
      }
      const hits = await s.searchL1Vector(vec(1, 0, 0), 3, undefined, { teamId: "team-a" });
      expect(hits.map((h) => h.record_id).sort()).toEqual(["a-0", "a-1", "a-2"]);
      expect(hits.every((h) => h.team_id === "team-a")).toBe(true);
    });
  });

  describe("embedding dimension / contract changes", () => {
    it("empty store: a new dimension rebuilds the columns without a reindex", async () => {
      const schema = uniqueTestSchema();
      (await open(3, schema)).close();
      const s = await open(5, schema);
      expect(s.getCapabilities().vectorSearch).toBe(true);
      expect(await s.upsertL1(l1("five", "five dims"), vec(1, 0, 0, 0, 0))).toBe(true);
      expect((await s.searchL1Vector(vec(1, 0, 0, 0, 0), 1)).map((h) => h.record_id)).toEqual(["five"]);
    });

    it("stored vectors + new dimension: vectors preserved, vector I/O blocked, reindex swaps them in", async () => {
      const schema = uniqueTestSchema();
      const old = await open(3, schema);
      await old.upsertL1(l1("keep", "TypeScript notes"), vec(1, 0, 0));
      await old.upsertL0(l0("msg", "TypeScript question"), vec(0, 1, 0));
      old.close();

      const s = new PostgresMemoryStore({ pool: testPool(), schema, dimensions: 4 });
      const res = await s.init({ provider: "openai", model: "m2" });
      expect(res.needsReindex).toBe(true);
      expect(res.reason).toMatch(/dimensions: 3 → 4/);
      expect(s.isDegraded()).toBe(false);
      expect(s.getCapabilities().vectorSearch).toBe(false);
      // Keyword search keeps working while vectors are blocked; old-dimension queries still answer.
      expect((await s.searchL1Fts(buildFtsQuery("TypeScript")!, 5)).map((h) => h.record_id)).toEqual(["keep"]);
      expect((await s.searchL1Vector(vec(1, 0, 0), 1)).map((h) => h.record_id)).toEqual(["keep"]);
      expect(await s.upsertL1(l1("new", "written while blocked"), vec(1, 0, 0, 0))).toBe(true);

      const counts = await s.reindexAll(async (text) =>
        text.includes("TypeScript") ? vec(0, 0, 0, 1) : vec(1, 0, 0, 0),
      );
      expect(counts).toEqual({ l1Count: 2, l0Count: 1 });
      expect(s.getCapabilities().vectorSearch).toBe(true);
      expect((await s.searchL1Vector(vec(0, 0, 0, 1), 1)).map((h) => h.record_id)).toEqual(["keep"]);
      expect((await s.searchL0Vector(vec(0, 0, 0, 1), 1)).map((h) => h.record_id)).toEqual(["msg"]);
      s.close();

      // The committed contract persists: reopening with the same config needs nothing.
      const again = new PostgresMemoryStore({ pool: testPool(), schema, dimensions: 4 });
      expect(await again.init({ provider: "openai", model: "m2" })).toEqual({ needsReindex: false });
    });

    it("a failed shadow reindex keeps the active vectors", async () => {
      const schema = uniqueTestSchema();
      const old = await open(3, schema);
      await old.upsertL1(l1("a", "a"), vec(1, 0, 0));
      await old.upsertL1(l1("b", "b"), vec(0, 1, 0));
      old.close();

      const s = new PostgresMemoryStore({ pool: testPool(), schema, dimensions: 4 });
      await s.init({ provider: "openai", model: "m1" });
      await s.reindexAll(async (text) => {
        if (text === "b") throw new Error("embedder down");
        return vec(1, 0, 0, 0);
      });
      expect(s.getCapabilities().vectorSearch).toBe(false);
      expect((await s.searchL1Vector(vec(0, 1, 0), 1)).map((h) => h.record_id)).toEqual(["b"]);
    });

    it("same dimension, different model with stored vectors: reindex required", async () => {
      const schema = uniqueTestSchema();
      const old = await open(3, schema, "model-a");
      await old.upsertL1(l1("a", "a"), vec(1, 0, 0));
      old.close();
      const s = new PostgresMemoryStore({ pool: testPool(), schema, dimensions: 3 });
      const res = await s.init({ provider: "openai", model: "model-b" });
      expect(res.needsReindex).toBe(true);
      expect(s.getCapabilities().vectorSearch).toBe(false);
    });

    it("dimensions=0 is keyword-only and adds no vector columns", async () => {
      const s = await open(0);
      expect(s.getCapabilities()).toMatchObject({ vectorSearch: false, ftsSearch: true });
      expect(await s.upsertL1(l1("k", "keyword only"), vec(1, 0, 0))).toBe(true);
      const cols = await testPool().query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'embedding'`,
        [s.getSchema()],
      );
      expect(cols.rowCount).toBe(0);
    });
  });

  describe("isolation pushdown", () => {
    it("deletes honour the filter and never cross tenants", async () => {
      const s = await open();
      await s.upsertL1(l1("t1", "x", { teamId: "a", agentId: "g" }));
      await s.upsertL1(l1("t2", "x", { teamId: "b", agentId: "g" }));
      expect(await s.deleteL1("t1", { teamId: "b" })).toBe(false);
      expect(await s.deleteL1("t1", { teamId: "a" })).toBe(true);
      await s.deleteL1Batch(["t2"], { teamId: "a" });
      expect(await s.countL1()).toBe(1);

      await s.upsertL0(l0("m1", "x", { sessionId: "s1", teamId: "a" }));
      await s.upsertL0(l0("m2", "x", { sessionId: "s1", teamId: "b" }));
      expect(await s.deleteL0BySession("s1", { teamId: "a" })).toBe(1);
      expect(await s.countL0()).toBe(1);
      await expect(s.deleteL0BySession("  ")).rejects.toThrow(/non-empty sessionId/);
    });

    it("queries, pagination and FTS on L0 filter by user/agent/task", async () => {
      const s = await open();
      await s.upsertL1(l1("u1", "alpha", { userId: "u1", agentId: "g", taskId: "t" }));
      await s.upsertL1(l1("u2", "alpha", { userId: "u2", agentId: "g" }));
      expect((await s.queryL1Records({ userId: "u1" })).map((r) => r.record_id)).toEqual(["u1"]);
      expect((await s.queryL1Records({ taskId: "t", recordIds: ["u1", "u2"] })).map((r) => r.record_id)).toEqual([
        "u1",
      ]);
      expect(await s.countL1({ userId: "u2", agentId: "g" })).toBe(1);
      const page = await s.queryL1Paginated({ agentId: "g", limit: 1, offset: 0 });
      expect(page.total).toBe(2);
      expect(page.rows).toHaveLength(1);

      await s.upsertL0(l0("m1", "beta gamma", { userId: "u1", timestamp: 1000 }));
      await s.upsertL0(l0("m2", "beta", { userId: "u2", timestamp: 2000 }));
      const hits = await s.searchL0Fts(buildFtsQuery("beta")!, 10, { userId: "u2" });
      expect(hits.map((h) => h.record_id)).toEqual(["m2"]);
      const l0Page = await s.queryL0Paginated({ timeStartMs: 1500, limit: 10, offset: 0 });
      expect(l0Page.rows.map((r) => r.record_id)).toEqual(["m2"]);
    });

    it("clearMemoryContent narrows to a user when given", async () => {
      const s = await open();
      await s.upsertL0(l0("m1", "x", { teamId: "t", agentId: "g", userId: "u1" }));
      await s.upsertL0(l0("m2", "x", { teamId: "t", agentId: "g", userId: "u2" }));
      const res = await s.clearMemoryContent({ teamId: "t", agentId: "g", userId: "u1" });
      expect(res).toEqual({ l0Deleted: 1, l1Deleted: 0, profilesDeleted: 0 });
      expect(await s.countL0()).toBe(1);
    });
  });

  describe("L0 → L1 cursor", () => {
    it("returns oldest-first rows after the recorded_at cursor, grouped per tenant + session", async () => {
      const s = await open();
      const at = (ms: number) => new Date(ms).toISOString();
      await s.upsertL0(l0("r1", "one", { recordedAt: at(1000), timestamp: 1, userId: "u1" }));
      await s.upsertL0(l0("r2", "two", { recordedAt: at(2000), timestamp: 2, userId: "u2" }));
      await s.upsertL0(l0("r3", "three", { recordedAt: at(3000), timestamp: 3, userId: "u1" }));
      expect((await s.queryL0ForL1("sk", 1000, 1)).map((r) => r.record_id)).toEqual(["r2"]);
      const groups = await s.queryL0GroupedBySessionId("sk");
      expect(groups.map((g) => [g.userId, g.messages.map((m) => m.id)])).toEqual([
        ["u1", ["r1", "r3"]],
        ["u2", ["r2"]],
      ]);
      expect(groups[0].messages[0].recordedAtMs).toBe(1000);
    });

    it("insertL0Batch inserts all rows and rejects duplicates", async () => {
      const s = await open();
      expect(await s.insertL0Batch([l0("b1", "a"), l0("b2", "b")])).toBe(2);
      await expect(s.insertL0Batch([l0("b3", "c"), l0("b1", "dup")])).rejects.toThrow();
      expect(await s.countL0()).toBe(2);
    });
  });

  describe("profiles", () => {
    const row = (version: number, content: string, baselineVersion?: number) => ({
      id: "p1",
      type: "l3" as const,
      filename: "persona.md",
      content,
      contentMd5: `md5-${content}`,
      teamId: "t",
      agentId: "g",
      version,
      createdAtMs: 1,
      updatedAtMs: 2,
      ...(baselineVersion !== undefined ? { baselineVersion } : {}),
    });

    it("optimistic lock: stale baseline throws, unchanged content is a no-op, versions move forward", async () => {
      const s = await open();
      await s.syncProfiles([row(1, "v1")]);
      await s.syncProfiles([row(2, "v2", 1)]);
      expect((await s.queryProfilesByIds(["p1"]))[0]).toMatchObject({ version: 2, content: "v2" });
      await expect(s.syncProfiles([row(2, "v2-stale", 1)])).rejects.toThrow(/optimistic-lock/);
      await s.syncProfiles([row(9, "v2", 0)]); // same md5 → untouched
      expect((await s.queryProfilesByIds(["p1"]))[0].version).toBe(2);
      await s.syncProfiles([row(0, "v3")]); // no baseline → overwrite, version still advances
      expect((await s.queryProfilesByIds(["p1"]))[0]).toMatchObject({ version: 3, content: "v3" });
    });

    it("pathPrefix is a literal prefix, not a LIKE pattern", async () => {
      const s = await open();
      await s.syncProfiles([
        { ...row(1, "a"), id: "a", filename: "scene_blocks/a_b.md" },
        { ...row(1, "b"), id: "b", filename: "scene_blocks/axb.md" },
      ]);
      expect((await s.queryProfiles({ pathPrefix: "scene_blocks/a_" })).map((p) => p.id)).toEqual(["a"]);
    });
  });

  describe("entities", () => {
    it("teams, users, agents and tasks derive their references like sqlite", async () => {
      const s = await open();
      const team = await s.createTeam({ team_id: "team-1", name: "Core", owner_user_id: "owner" });
      expect(team.user_ids).toEqual(["owner"]);
      await s.createUser({ user_id: "u1", name: "Ann" });
      await s.updateTeam("team-1", { user_ids: ["u1"] });
      const agent = await s.createAgent({ agent_id: "ag-1", team_id: "team-1", name: "Bot", owner_user_id: "u1" });
      expect(agent.visibility).toBe("team");
      await s.createTask({ task_id: "task-1", team_id: "team-1", creator_user_id: "u1", agent_ids: ["ag-1"] });

      expect(await s.getTeam("team-1")).toMatchObject({
        user_ids: ["owner", "u1"],
        agent_ids: ["ag-1"],
        task_ids: ["task-1"],
      });
      expect(await s.getUser("u1")).toMatchObject({
        team_ids: ["team-1"],
        task_ids: ["task-1"],
        task_agent_ids: ["ag-1"],
        owned_agent_ids: ["ag-1"],
      });
      expect((await s.getAgent("ag-1"))?.task_ids).toEqual(["task-1"]);

      expect(await s.deleteTeams(["team-1", "nope"])).toEqual({
        deleted_ids: ["team-1"],
        failed: [{ id: "nope", reason: "not_found" }],
      });
      expect((await s.getTeam("team-1"))?.status).toBe("archived");
      expect((await s.deleteTasks(["task-1"])).deleted_ids).toEqual(["task-1"]);
      expect(await s.getTask("task-1")).toBeNull();
      expect(await s.updateUser("ghost", { name: "x" })).toBeNull();
    });

    it("knowledge refs upsert by id and list per team", async () => {
      const s = await open();
      const base = { type: "wiki" as const, service_url: "http://k", summary: null, user_id: null };
      await s.createKnowledge({ ...base, knowledge_id: "k1", name: "one", team_id: "t" });
      await s.createKnowledge({ ...base, knowledge_id: "k2", name: "two", team_id: "t" });
      await s.createKnowledge({ ...base, knowledge_id: "k1", name: "one-renamed", team_id: "t" });
      const list = await s.listKnowledge({ team_id: "t", knowledge_ids: ["k1"] });
      expect(list).toMatchObject({ total: 1, items: [{ knowledge_id: "k1", name: "one-renamed" }] });
      expect((await s.listKnowledge({ team_id: "t" })).total).toBe(2);
      expect((await s.deleteKnowledge(["k2"], "other")).failed).toEqual([{ id: "k2", reason: "team_mismatch" }]);
      expect(await s.updateKnowledge("k2", { branch: "main" })).toMatchObject({ branch: "main" });
    });

    it("audit entries filter and page newest-first", async () => {
      const s = await open();
      for (let i = 0; i < 3; i++) {
        await s.appendAudit({
          audit_id: `au-${i}`,
          record_id: "r",
          layer: "L1",
          action: "update",
          team_id: "t",
          version: i,
          updated_at_ms: 1000 + i,
        });
      }
      const rows = await s.queryAudit({ record_id: "r", since_ms: 1001, limit: 1 });
      expect(rows.map((r) => r.audit_id)).toEqual(["au-2"]);
      expect(rows[0].agent_id).toBeUndefined();
    });

    it("memory prompts: create, update bumps version, delete clears settings", async () => {
      const s = await open();
      const now = Date.now();
      await s.createMemoryPrompt({
        memory_prompt_id: "mp1",
        name: "n",
        layer: "l1",
        prompt: "p",
        version: 1,
        status: "active",
        created_at_ms: now,
        updated_at_ms: now,
      });
      expect((await s.updateMemoryPrompt("mp1", { prompt: "p2", updated_at_ms: now + 1 }))?.version).toBe(2);
      await s.upsertMemoryPromptSettings(
        [
          {
            setting_id: "set1",
            target_type: "team",
            team_id: "t",
            layer: "l1",
            memory_prompt_id: "mp1",
            updated_at_ms: now,
          },
        ],
        [],
      );
      const res = await s.deleteMemoryPrompts(["mp1"], "op");
      expect(res.cleared_settings.team).toBe(1);
      expect(await s.countMemoryPrompts()).toBe(0);
      const logs = await s.queryMemoryPromptSettingLogs({ memoryPromptId: "mp1" });
      expect(logs.map((l) => l.action)).toEqual(["clear"]);
      expect(typeof logs[0].operated_at_ms).toBe("number");
    });
  });
});
