/**
 * IKnowledgeStore + LlmBindingStore + CodeGraphService on the DB selected by the test setup
 * (SQLite by default, Postgres with KNOWLEDGE_TEST_DB_URL). Upstream had no store-level tests;
 * these pin the behaviours that differ between drivers: partial unique indexes, count(*) typing,
 * affected-row counts, identity ids and ordering.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDb, type TestDb } from "../test-utils/db.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { createLlmBindingStore } from "./llm-binding-store.js";
import { CodeGraphService } from "./code-graph-service.js";

const SVC = "svc-A";
const TEAM = "team-1";
const REPO = "https://git.example.com/group/repo.git";

let db: TestDb;
let store: SqliteKnowledgeStore;

beforeEach(async () => {
  db = await createTestDb();
  store = new SqliteKnowledgeStore(db);
});

afterEach(async () => {
  await db.dispose();
});

describe("code-graph rows", () => {
  it("create is idempotent per (service, team, repo, branch) and scoped by tenant", async () => {
    const a = await store.createCodeGraph({ service_id: SVC, team_id: TEAM, repo_url: REPO, branch: "main" });
    const b = await store.createCodeGraph({ service_id: SVC, team_id: TEAM, repo_url: REPO, branch: "main" });
    expect(a.existed).toBe(false);
    expect(b).toEqual({ row: a.row, existed: true });
    expect(a.row.status).toBe("pending");
    expect(a.row.version).toBe(0);

    expect(await store.getCodeGraphById(SVC, a.row.code_graph_id)).toEqual(a.row);
    expect(await store.getCodeGraphById("svc-B", a.row.code_graph_id)).toBeNull();
    expect(await store.getCodeGraph(SVC, "team-2", a.row.code_graph_id)).toBeNull();
  });

  it("list / count honour status filter, paging and updated_at order", async () => {
    const ids: string[] = [];
    for (const branch of ["a", "b", "c"]) {
      const { row } = await store.createCodeGraph({ service_id: SVC, team_id: TEAM, repo_url: REPO, branch });
      ids.push(row.code_graph_id);
    }
    await new Promise((r) => setTimeout(r, 5));
    await store.updateCodeGraphStatus(SVC, ids[0], { status: "ready", stats_json: "{}" });

    expect(await store.countCodeGraphs(SVC, TEAM)).toBe(3);
    expect(typeof (await store.countCodeGraphs(SVC, TEAM))).toBe("number");
    expect(await store.countCodeGraphs(SVC, TEAM, { syncStatus: "ready" })).toBe(1);
    const listed = await store.listCodeGraphs(SVC, TEAM, { limit: 2 });
    expect(listed).toHaveLength(2);
    expect(listed[0].code_graph_id).toBe(ids[0]);
    expect((await store.listCodeGraphs(SVC, TEAM, { limit: 2, offset: 2 })).length).toBe(1);
  });

  it("meta update, hard delete and affected-row results", async () => {
    const { row } = await store.createCodeGraph({ service_id: SVC, team_id: TEAM, repo_url: REPO, branch: "main" });
    const updated = await store.updateCodeGraphMeta(SVC, row.code_graph_id, { summary: "s", credential_id: "gc-1" });
    expect(updated?.summary).toBe("s");
    expect(updated?.credential_id).toBe("gc-1");
    expect(await store.updateCodeGraphMeta("svc-B", row.code_graph_id, { summary: "x" })).toBeNull();

    expect(await store.deleteCodeGraph(SVC, "team-2", row.code_graph_id)).toBe(false);
    expect(await store.deleteCodeGraph(SVC, TEAM, row.code_graph_id)).toBe(true);
    expect(await store.deleteCodeGraph(SVC, TEAM, row.code_graph_id)).toBe(false);
  });
});

describe("wiki rows", () => {
  it("unique name among live rows; a deleted name can be reused", async () => {
    const first = await store.createWiki({ service_id: SVC, team_id: TEAM, name: "docs" });
    expect(first.row.status).toBe("draft");
    await store.updateWikiStatus(SVC, first.row.wiki_id, { page_count: 7 });
    expect((await store.getWiki(SVC, TEAM, first.row.wiki_id))?.page_count).toBe(7);
    expect((await store.createWiki({ service_id: SVC, team_id: TEAM, name: "docs" })).existed).toBe(true);

    expect(await store.deleteWiki(SVC, TEAM, first.row.wiki_id)).toBe(true);
    const again = await store.createWiki({ service_id: SVC, team_id: TEAM, name: "docs" });
    expect(again.existed).toBe(false);
    expect(again.row.wiki_id).not.toBe(first.row.wiki_id);
    expect(await store.countWikis(SVC, TEAM)).toBe(1);
  });
});

describe("audit + restart recovery", () => {
  it("audit ids are generated and ordered by version then id, per service", async () => {
    for (const [version, action] of [[0, "create"], [1, "ingest"], [1, "ready"]] as const) {
      await store.appendWikiAudit({ service_id: SVC, asset_id: "wiki-1", version, action });
    }
    await store.appendWikiAudit({ service_id: "svc-B", asset_id: "wiki-1", version: 9, action: "delete" });
    const rows = await store.listWikiAudit(SVC, "wiki-1");
    expect(rows.map((r) => r.action)).toEqual(["ready", "ingest", "create"]);
    expect(rows.every((r) => typeof r.id === "number" && r.id > 0)).toBe(true);
    expect(await store.listWikiAudit(SVC, "wiki-1", 1, 1)).toHaveLength(1);

    await store.appendCodeGraphAudit({ service_id: SVC, asset_id: "cg-1", version: 0, action: "create" });
    expect((await store.listCodeGraphAudit(SVC, "cg-1"))[0].action).toBe("create");
  });

  it("markInterruptedAsFailed sweeps pending/processing across tenants; listSynced* sees ready rows", async () => {
    const cg = await store.createCodeGraph({ service_id: SVC, team_id: TEAM, repo_url: REPO, branch: "main" });
    const cg2 = await store.createCodeGraph({ service_id: "svc-B", team_id: TEAM, repo_url: REPO, branch: "main" });
    await store.updateCodeGraphStatus("svc-B", cg2.row.code_graph_id, { status: "ready" });
    const wiki = await store.createWiki({ service_id: SVC, team_id: TEAM, name: "w" });
    await store.updateWikiStatus(SVC, wiki.row.wiki_id, { status: "processing" });

    expect(await store.markInterruptedAsFailed("restart")).toBe(2);
    expect((await store.getCodeGraphById(SVC, cg.row.code_graph_id))?.sync_error).toBe("restart");
    expect(await store.listSyncedCodeGraphs()).toEqual([
      { code_graph_id: cg2.row.code_graph_id, service_id: "svc-B", team_id: TEAM },
    ]);
    expect(await store.listSyncedWikis()).toEqual([]);
  });
});

describe("llm binding store", () => {
  it("upsert keeps api_key when omitted, clears it on null, maps enabled", async () => {
    const bindings = createLlmBindingStore(db);
    expect(await bindings.status(SVC)).toEqual({ bound: false, mode: null, enabled: false });
    await bindings.upsert(SVC, { mode: "proxy", proxy_base_url: "http://p", api_key: "k1" });
    const kept = await bindings.upsert(SVC, { mode: "proxy", proxy_base_url: "http://p2" });
    expect(kept.api_key).toBe("k1");
    expect(kept.proxy_base_url).toBe("http://p2");
    const off = await bindings.upsert(SVC, { mode: "byo", base_url: "http://b", api_key: null, enabled: false });
    expect(off).toMatchObject({ mode: "byo", api_key: null, enabled: false });
    expect(await bindings.listAll()).toHaveLength(1);
  });
});

describe("CodeGraphService on this DB", () => {
  it("runs a build to ready with ordered internal status writes, then deletes", async () => {
    const seen: string[] = [];
    const svc = new CodeGraphService({
      store,
      dataRoot: mkdtempSync(join(tmpdir(), "kg-store-")),
      worker: async (ctx) => {
        ctx.setInternalStatus("cloning");
        ctx.setInternalStatus("indexing");
        seen.push(ctx.codeGraphId);
        return { commitHash: "abc", stats: { files: 1, nodes: 2, edges: 3 } };
      },
    });
    const { row } = await svc.create({ service_id: SVC, team_id: TEAM, repo_url: REPO, branch: "main" });
    await svc.onIdle(row.code_graph_id);

    const ready = await svc.getById(SVC, row.code_graph_id);
    expect(ready).toMatchObject({ status: "ready", internal_status: null, commit_hash: "abc" });
    expect(JSON.parse(ready!.stats_json!)).toEqual({ files: 1, nodes: 2, edges: 3 });
    expect(seen).toEqual([row.code_graph_id]);

    const sync = await svc.sync(SVC, TEAM, row.code_graph_id);
    expect(sync.kind).toBe("ok");
    await svc.onIdle(row.code_graph_id);
    expect((await svc.getById(SVC, row.code_graph_id))?.version).toBe(1);

    expect(await svc.delete(SVC, TEAM, row.code_graph_id)).toBe(true);
    expect(await svc.getById(SVC, row.code_graph_id)).toBeNull();
    const actions = (await store.listCodeGraphAudit(SVC, row.code_graph_id)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["create", "ready", "ingest", "delete"]));
  });
});
