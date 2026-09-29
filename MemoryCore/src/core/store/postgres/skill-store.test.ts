/**
 * PostgresSkillStore: the shared ISkillStore contract plus postgres specifics
 * (duplicate names, races, isolation filters, TTL cleanup, wiring through StorePool).
 * Needs a reachable Postgres (POSTGRES_TEST_URL); skipped otherwise.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runSkillStoreContract } from "../../skill/__contract__/skill-store.contract.js";
import { SkillStoreError } from "../../skill/skill-store.interface.js";
import type { AppendVersionInput } from "../../skill/types.js";
import { parseConfig } from "../../../config.js";
import { StorePool } from "../store-pool.js";
import { closeSharedPostgresPools } from "./client.js";
import { schemaForInstance } from "./config.js";
import { PostgresSkillStore } from "./skill-store.js";
import { TEST_POSTGRES_URL, dropTestSchema, postgresReachable, testPool, uniqueTestSchema } from "./test-support.js";

const reachable = await postgresReachable();
const schemas: string[] = [];

async function open(schema = uniqueTestSchema(), now?: () => number): Promise<PostgresSkillStore> {
  if (!schemas.includes(schema)) schemas.push(schema);
  const store = new PostgresSkillStore({ pool: testPool(), schema, now });
  store.init();
  expect(await store.ready()).toBe(true);
  return store;
}

function input(over: Partial<AppendVersionInput> = {}): AppendVersionInput {
  return {
    skill_id: "sk-1",
    team_id: "team-a",
    owner_agent_id: "agent-a",
    user_id: "user-a",
    task_id: "task-a",
    name: "deploy",
    description: "Deploy services",
    content: "# Deploy\nkubectl apply",
    content_hash: "h1",
    manifest: [],
    storage_dir: "skills/sk-1/v1",
    ...over,
  };
}

if (!reachable) {
  describe.skip("ISkillStore contract [postgres] (no database)", () => {
    it("skipped", () => undefined);
  });
} else {
  afterAll(async () => {
    await closeSharedPostgresPools();
  });

  runSkillStoreContract({
    backend: "postgres",
    async createStore() {
      const store = new PostgresSkillStore({ pool: testPool(), schema: uniqueTestSchema() });
      store.init();
      await store.ready();
      return store;
    },
    async disposeStore(store) {
      store.close();
      await dropTestSchema((store as PostgresSkillStore).getSchema());
    },
  });
}

describe.skipIf(!reachable)("PostgresSkillStore specifics", () => {
  afterEach(async () => {
    await Promise.all(schemas.splice(0).map((s) => dropTestSchema(s)));
  });

  it("rejects duplicate names per team+agent and renames across versions", async () => {
    const s = await open();
    await s.appendVersion(input());
    await expect(s.appendVersion(input({ skill_id: "sk-2" }))).rejects.toMatchObject({ code: "SKILL_NAME_DUPLICATE" });
    await expect(s.appendVersion(input({ name: "renamed" }))).rejects.toBeInstanceOf(SkillStoreError);
    // Same name is fine for another agent or another team.
    expect((await s.appendVersion(input({ skill_id: "sk-3", owner_agent_id: "agent-b" }))).version).toBe(1);
    expect((await s.appendVersion(input({ skill_id: "sk-4", team_id: "team-b" }))).version).toBe(1);
  });

  it("concurrent appends never produce two heads or duplicate versions", async () => {
    const s = await open();
    await s.appendVersion(input());
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => s.appendVersion(input({ content_hash: `h${i + 2}` }))),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    for (const f of failed) expect(f.reason).toMatchObject({ code: "SKILL_VERSION_STALE" });
    const versions = await s.listVersions("sk-1", "team-a");
    expect(versions.length).toBe(1 + ok.length);
    expect(versions.filter((v) => v.is_head)).toHaveLength(1);
    expect(new Set(versions.map((v) => v.version)).size).toBe(versions.length);
  });

  it("owner is inherited from the head; user_id records the latest writer", async () => {
    const s = await open();
    await s.appendVersion(input());
    const v2 = await s.appendVersion(input({ owner_agent_id: "someone-else", user_id: "user-b", content_hash: "h2" }));
    expect(v2).toMatchObject({ version: 2, owner_agent_id: "agent-a", user_id: "user-b" });
  });

  it("team scoping hides other teams' skills from every read", async () => {
    const s = await open();
    await s.appendVersion(input());
    expect(await s.getHead("sk-1", "team-b")).toBeNull();
    expect(await s.getByVersion("sk-1", 1, "team-b")).toBeNull();
    expect(await s.countVersions("sk-1", "team-b")).toBe(0);
    expect(await s.deleteAllVersions("sk-1", "team-b")).toBe(0);
    expect((await s.archiveHead("sk-1", "team-b")).archived).toBe(false);
    expect(await s.getHead("sk-1")).not.toBeNull();
  });

  it("search filters by team/agent/user/task, hides archived heads and returns a snippet", async () => {
    const s = await open();
    await s.appendVersion(input({ description: "Deploy services to kubernetes" }));
    await s.appendVersion(
      input({ skill_id: "sk-b", owner_agent_id: "agent-b", name: "kube-b", description: "kubernetes too" }),
    );
    const all = await s.searchSkills({ team_id: "team-a", query: "kubernetes" });
    expect(all.map((h) => h.skill.skill_id).sort()).toEqual(["sk-1", "sk-b"]);
    expect(all.every((h) => h.score > 0 && h.score < 1)).toBe(true);
    const byAgent = await s.searchSkills({ team_id: "team-a", query: "kubernetes", agent_id: "agent-b" });
    expect(byAgent.map((h) => h.skill.skill_id)).toEqual(["sk-b"]);
    expect(await s.searchSkills({ team_id: "team-b", query: "kubernetes" })).toEqual([]);
    const withSnippet = await s.searchSkills({ team_id: "team-a", query: "kubectl" });
    expect(withSnippet[0].snippet).toContain("<mark>kubectl</mark>");

    await s.archiveHead("sk-b", "team-a");
    expect((await s.searchSkills({ team_id: "team-a", query: "kubernetes" })).map((h) => h.skill.skill_id)).toEqual([
      "sk-1",
    ]);
  });

  it("listSkills filters, pages and matches name prefixes literally", async () => {
    const s = await open();
    await s.appendVersion(input({ skill_id: "a", name: "Deploy_app" }));
    await s.appendVersion(input({ skill_id: "b", name: "deployXapp" }));
    await s.appendVersion(input({ skill_id: "c", name: "other" }));
    const pref = await s.listSkills({ team_id: "team-a", name_prefix: "deploy_" });
    expect(pref.items.map((i) => i.skill_id)).toEqual(["a"]);
    const page = await s.listSkills({ team_id: "team-a", limit: 2 });
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    await s.archiveHead("c", "team-a");
    expect((await s.listSkills({ team_id: "team-a", status: ["archived"] })).items.map((i) => i.skill_id)).toEqual([
      "c",
    ]);
  });

  it("TTL cleanup only touches old non-head versions", async () => {
    let t = 1000;
    const s = await open(uniqueTestSchema(), () => t);
    await s.appendVersion(input());
    t = 2000;
    await s.appendVersion(input({ content_hash: "h2" }));
    t = 3000;
    await s.appendVersion(input({ content_hash: "h3" }));
    const expired = await s.findExpiredVersions(2500);
    expect(expired.map((e) => e.version)).toEqual([1, 2]);
    expect(expired.every((e) => !e.is_head)).toBe(true);
    expect(await s.deleteVersion("sk-1", 3)).toBe(false); // head is protected
    expect(await s.deleteVersion("sk-1", 1)).toBe(true);
    expect(await s.countVersions("sk-1")).toBe(2);
  });

  it("an unreachable database degrades the store and fails calls loudly", async () => {
    const s = new PostgresSkillStore({ url: "postgres://nobody:nothing@127.0.0.1:1/none", schema: uniqueTestSchema() });
    s.init();
    expect(await s.ready()).toBe(false);
    expect(s.isDegraded()).toBe(true);
    await expect(s.getHead("x")).rejects.toThrow(/degraded/);
  });

  it("StorePool in postgres mode hands out a skill store in the instance's schema", async () => {
    const base = uniqueTestSchema();
    schemas.push(base, schemaForInstance(base, "inst-s"));
    vi.stubEnv("POSTGRES_URL", TEST_POSTGRES_URL);
    vi.stubEnv("POSTGRES_SCHEMA", base);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const pool = new StorePool({ mode: "postgres", memoryCfg: parseConfig({ storeBackend: "postgres" }), logger });
    const skills = (await pool.getSkillStore("inst-s", null, null)) as PostgresSkillStore;
    expect(skills).toBeInstanceOf(PostgresSkillStore);
    expect(skills.getSchema()).toBe(schemaForInstance(base, "inst-s"));
    expect(await skills.ready()).toBe(true);
    expect(await pool.getSkillStore("inst-s", null, null)).toBe(skills);
  });
});
