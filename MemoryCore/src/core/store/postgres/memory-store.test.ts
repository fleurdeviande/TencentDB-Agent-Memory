/**
 * PostgresMemoryStore lifecycle and safety tests (beyond the shared contract).
 * Needs a reachable Postgres with pgvector (POSTGRES_TEST_URL); skipped otherwise.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { MemoryRecord } from "../../record/l1-writer.js";
import { buildFtsQuery } from "../tokenize.js";
import { closeSharedPostgresPools } from "./client.js";
import { schemaForInstance } from "./config.js";
import { PostgresMemoryStore } from "./memory-store.js";
import { dropTestSchema, postgresReachable, testPool, uniqueTestSchema } from "./test-support.js";

const reachable = await postgresReachable();
const schemas: string[] = [];

function newStore(dimensions = 4, schema = uniqueTestSchema()): PostgresMemoryStore {
  if (!schemas.includes(schema)) schemas.push(schema);
  return new PostgresMemoryStore({ pool: testPool(), schema, dimensions });
}

function l1(id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord {
  const ts = new Date().toISOString();
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

describe("schemaForInstance", () => {
  it("maps default to the base schema and others to a bounded, distinct identifier", () => {
    expect(schemaForInstance("tdai", "default")).toBe("tdai");
    const a = schemaForInstance("tdai", "Team-A/1");
    const b = schemaForInstance("tdai", "team_a_1");
    expect(a).toMatch(/^tdai_i_team_a_1_[0-9a-f]{10}$/);
    expect(a).not.toBe(b);
    expect(schemaForInstance("tdai", "x".repeat(300)).length).toBeLessThanOrEqual(63);
    expect(() => schemaForInstance("Bad-Schema", "x")).toThrow();
  });
});

describe.skipIf(!reachable)("PostgresMemoryStore lifecycle", () => {
  afterEach(async () => {
    await Promise.all(schemas.splice(0).map((s) => dropTestSchema(s)));
  });
  afterAll(async () => {
    await closeSharedPostgresPools();
  });

  it("init is idempotent: a second store on the same schema keeps the data", async () => {
    const a = newStore();
    expect(await a.init({ provider: "openai", model: "m" })).toEqual({ needsReindex: false });
    expect(await a.upsertL1(l1("keep", "persisted across inits"))).toBe(true);
    a.close();

    const b = newStore(4, a.getSchema());
    expect(await b.init({ provider: "openai", model: "m" })).toEqual({ needsReindex: false });
    expect(await b.countL1()).toBe(1);
    const migrations = await testPool().query(`SELECT version FROM "${a.getSchema()}".schema_migrations`);
    expect(migrations.rows.map((r) => r.version)).toEqual([1]);
  });

  it("an unreachable database leaves the store degraded instead of throwing", async () => {
    const store = new PostgresMemoryStore({
      url: "postgres://nobody:nothing@127.0.0.1:1/none",
      schema: uniqueTestSchema(),
      dimensions: 0,
    });
    const res = await store.init();
    expect(store.isDegraded()).toBe(true);
    expect(res.reason).toMatch(/postgres init failed/);
    expect(await store.countL1()).toBe(0);
  });

  it("values are bound, never spliced: quotes and SQL fragments round-trip verbatim", async () => {
    const store = newStore();
    await store.init();
    const nasty = `'); DROP TABLE l1_records; -- "quoted" \\ back`;
    expect(await store.upsertL1(l1("q1", nasty, { teamId: "t'1", agentId: 'a"1' }))).toBe(true);
    const [row] = await store.queryL1Records({ teamId: "t'1", agentId: 'a"1' });
    expect(row.content).toBe(nasty);
    const hits = await store.searchL1Fts(`"DROP" OR "'); --"`, 5, { teamId: "t'1" });
    expect(hits.map((h) => h.record_id)).toEqual(["q1"]);
    expect(await store.countL1()).toBe(1);
  });

  it("keyword search works on jieba-segmented Chinese", async () => {
    const store = newStore(0);
    await store.init();
    await store.upsertL1(l1("zh", "用户喜欢编程和TypeScript，住在上海"));
    await store.upsertL1(l1("en", "User drinks tea every morning"));
    const hits = await store.searchL1Fts(buildFtsQuery("住在上海的程序员")!, 5);
    expect(hits[0]?.record_id).toBe("zh");
    expect(hits.every((h) => h.score > 0 && h.score < 1)).toBe(true);
  });
});
