/**
 * IStateBackend behaviour shared by LocalStateBackend (the reference) and
 * PostgresStateBackend, plus what only Postgres promises: state, queued tasks
 * and timers survive a new backend instance (a restart), pending tasks of a
 * dead worker are reclaimable, and claims never hand one task to two workers.
 * The Postgres half skips when POSTGRES_TEST_URL does not answer.
 */
import { afterAll, describe, expect, it } from "vitest";
import { LocalStateBackend } from "./local-backend.js";
import { PostgresStateBackend } from "./postgres-backend.js";
import type { IStateBackend, TaskPayload } from "./types.js";
import { closeSharedPostgresPools } from "../store/postgres/client.js";
import { dropTestSchema, postgresReachable, testPool, uniqueTestSchema } from "../store/postgres/test-support.js";

const reachable = await postgresReachable();

function task(id: string, priority = 0, createdAt = Date.now(), instanceId = "inst"): TaskPayload {
  return { id, type: "L1", instanceId, sessionId: `s-${id}`, priority, createdAt, data: { instanceId } };
}

interface Harness {
  name: string;
  available: boolean;
  make: () => Promise<IStateBackend>;
}

const schemas: string[] = [];
const harnesses: Harness[] = [
  { name: "local", available: true, make: async () => new LocalStateBackend() },
  {
    name: "postgres",
    available: reachable,
    async make() {
      const schema = uniqueTestSchema();
      schemas.push(schema);
      const b = new PostgresStateBackend({ pool: testPool(), schema, pollIntervalMs: 20 });
      await b.initialize();
      return b;
    },
  },
];

afterAll(async () => {
  if (!reachable) return;
  for (const s of schemas) await dropTestSchema(s);
  await closeSharedPostgresPools();
});

for (const h of harnesses) {
  describe.skipIf(!h.available)(`IStateBackend [${h.name}]`, () => {
    it("session state: default on first patch, merge on later ones, scoped by team/agent", async () => {
      const b = await h.make();
      expect(await b.getSessionState("inst", "s1", "t", "a")).toBeNull();
      await b.updateSessionState("inst", "s1", { conversation_count: 3 }, "t", "a");
      await b.updateSessionState("inst", "s1", { warmup_threshold: 4 }, "t", "a");
      const st = await b.getSessionState("inst", "s1", "t", "a");
      expect(st).toMatchObject({ conversation_count: 3, warmup_threshold: 4, l2_pending_l1_count: 0 });
      expect(await b.getSessionState("inst", "s1", "t", "other")).toBeNull();
      expect(await b.listActiveSessions("inst")).toEqual(["s1"]);
      await b.deleteSessionState("inst", "s1", "t", "a");
      expect(await b.getSessionState("inst", "s1", "t", "a")).toBeNull();
      await b.destroy?.();
    });

    it("buffers append in order and drain once", async () => {
      const b = await h.make();
      await b.appendBuffer("inst", "s", "m1");
      await b.appendBuffer("inst", "s", "m2");
      expect(await b.getBufferLength("inst", "s")).toBe(2);
      expect(await b.drainBuffer("inst", "s")).toEqual(["m1", "m2"]);
      expect(await b.drainBuffer("inst", "s")).toEqual([]);
      await b.destroy?.();
    });

    it("queue: priority then age order, pending until ACK, ownership-checked ACK/replace", async () => {
      const b = await h.make();
      const t0 = Date.now();
      await b.enqueueTask(task("low", 2, t0));
      await b.enqueueTask(task("high-late", 0, t0 + 5));
      await b.enqueueTask(task("high-early", 0, t0));
      expect(await b.getQueueDepth()).toEqual({ high: 2, low: 1 });
      expect((await b.listQueuedTasks!()).map((t) => t.id)).toEqual(["high-early", "high-late", "low"]);

      const first = await b.consumeTask("w1");
      expect(first?.id).toBe("high-early");
      expect(first?._ownerId).toBe("w1");
      expect(await b.ackTaskIfOwned!(first!._msgId!, "w2")).toBe(false);
      expect(await b.refreshTaskClaim!(first!._msgId!, "w1")).toBe(true);
      expect(await b.ackTaskIfOwned!(first!._msgId!, "w1")).toBe(true);

      const second = await b.consumeTask("w1");
      expect(await b.replacePendingTask!(second!._msgId!, "w2", task("nope"))).toBe(false);
      expect(await b.replacePendingTask!(second!._msgId!, "w1", task("retry", 0, t0 - 1))).toBe(true);
      expect((await b.consumeTask("w1"))?.id).toBe("retry");
      expect((await b.consumeTask("w1"))?.id).toBe("low");
      expect(await b.consumeTask("w1")).toBeNull();
      await b.destroy?.();
    });

    it("a blocking consume wakes up on enqueue", async () => {
      const b = await h.make();
      const pending = b.consumeTask("w", 5_000);
      await new Promise((r) => setTimeout(r, 50));
      const started = Date.now();
      await b.enqueueTask(task("late"));
      expect((await pending)?.id).toBe("late");
      expect(Date.now() - started).toBeLessThan(1_000);
      await b.destroy?.();
    });

    it("stale pending tasks are reclaimed by another worker", async () => {
      const b = await h.make();
      await b.enqueueTask(task("orphan"));
      const claimed = await b.consumeTask("dead-worker");
      expect(claimed?.id).toBe("orphan");
      expect(await b.claimStaleTasks!("live", 60_000, 10)).toEqual([]);
      await b.refreshTaskClaim!(claimed!._msgId!, "dead-worker", 120_000);
      const stolen = await b.claimStaleTasks!("live", 60_000, 10);
      expect(stolen.map((t) => [t.id, t._ownerId])).toEqual([["orphan", "live"]]);
      expect(await b.ackTaskIfOwned!(claimed!._msgId!, "dead-worker")).toBe(false);
      await b.destroy?.();
    });

    it("locks: exclusive while live, owner-only renew/release", async () => {
      const b = await h.make();
      expect(await b.acquireLock("k", "a", 60_000)).toBe(true);
      expect(await b.acquireLock("k", "b", 60_000)).toBe(false);
      expect(await b.renewLock("k", "b", 60_000)).toBe(false);
      await b.releaseLock("k", "b");
      expect(await b.acquireLock("k", "b", 60_000)).toBe(false);
      await b.releaseLock("k", "a");
      expect(await b.acquireLock("k", "b", 1)).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      expect(await b.acquireLock("k", "c", 60_000)).toBe(true);
      await b.destroy?.();
    });

    it("captureAtomic counts rounds, arms the idle timer, enqueues at the threshold", async () => {
      const b = await h.make();
      const now = Date.now();
      const params = {
        instanceId: "inst",
        sessionId: "s",
        teamId: "t",
        agentId: "a",
        threshold: 3,
        fireAtMs: now + 60_000,
        timerMember: "s:L1_idle",
        taskPayload: task("cap"),
        nowMs: now,
        rounds: 2,
      };
      expect(await b.captureAtomic(params)).toEqual({ triggered: false, conversationCount: 2 });
      expect(await b.setTimerIfEarlier("inst", "s:L1_idle", now + 120_000)).toBe(false);
      expect(await b.captureAtomic({ ...params, rounds: 1 })).toEqual({ triggered: true, conversationCount: 0 });
      expect((await b.consumeTask("w"))?.id).toBe("cap");
      // The trigger removed the idle timer, so a later one is accepted again.
      expect(await b.setTimerIfEarlier("inst", "s:L1_idle", now + 120_000)).toBe(true);
      await b.destroy?.();
    });

    it("purgeInstance removes sessions, buffers, timers and tasks of that instance only", async () => {
      const b = await h.make();
      await b.updateSessionState("gone", "s", { conversation_count: 1 });
      await b.appendBuffer("gone", "s", "m");
      await b.setTimer("gone", "s:L1_idle", Date.now() + 60_000);
      await b.enqueueTask(task("g", 0, Date.now(), "gone"));
      await b.enqueueTask(task("k", 0, Date.now(), "kept"));
      const res = await b.purgeInstance!("gone");
      expect(res.sessions).toBe(1);
      expect(res.timers).toBe(1);
      expect(await b.listActiveSessions("gone")).toEqual([]);
      expect((await b.listQueuedTasks!()).map((t) => t.id)).toEqual(["k"]);
      await b.destroy?.();
    });
  });
}

describe.skipIf(!reachable)("PostgresStateBackend durability", () => {
  async function pair(): Promise<[PostgresStateBackend, () => Promise<PostgresStateBackend>]> {
    const schema = uniqueTestSchema();
    schemas.push(schema);
    const first = new PostgresStateBackend({ pool: testPool(), schema, pollIntervalMs: 20 });
    await first.initialize();
    const restart = async () => {
      await first.destroy();
      const next = new PostgresStateBackend({ pool: testPool(), schema, pollIntervalMs: 20 });
      await next.initialize();
      return next;
    };
    return [first, restart];
  }

  it("queued and in-flight tasks, counters and timers survive a restart", async () => {
    const [before, restart] = await pair();
    await before.updateSessionState("inst", "s", { conversation_count: 4, warmup_threshold: 2 }, "t", "a");
    await before.setTimer("inst", "scope:team:t|agent:a|session:s:L2_schedule", Date.now() + 60_000);
    await before.enqueueTask(task("queued"));
    await before.enqueueTask(task("in-flight"));
    const inFlight = await before.consumeTask("worker-before");
    expect(inFlight?.id).toBe("queued");

    const after = await restart();
    expect(await after.getSessionState("inst", "s", "t", "a")).toMatchObject({ conversation_count: 4, warmup_threshold: 2 });
    // What the old process had claimed comes back through pending recovery…
    const recovered = await after.claimStaleTasks("worker-after", 0, 10);
    expect(recovered.map((t) => t.id)).toEqual(["queued"]);
    // …and what was still queued is simply consumed.
    expect((await after.consumeTask("worker-after"))?.id).toBe("in-flight");
    const due = await after.claimExpiredFromShard(after.getTimerShardKeyByIndex(0), Date.now() + 120_000, 10);
    expect(due.map((d) => d.member)).toEqual(["inst\x00scope:team:t|agent:a|session:s:L2_schedule"]);
    await after.destroy();
  });

  it("concurrent consumers never receive the same task", async () => {
    const [b] = await pair();
    for (let i = 0; i < 30; i++) await b.enqueueTask(task(`t${i}`, 0, 1_000 + i));
    const results = await Promise.all(Array.from({ length: 6 }, async (_, w) => {
      const got: string[] = [];
      for (;;) {
        const t = await b.consumeTask(`w${w}`);
        if (!t) return got;
        got.push(t.id);
      }
    }));
    const all = results.flat();
    expect(all).toHaveLength(30);
    expect(new Set(all).size).toBe(30);
    await b.destroy();
  });

  it("timer claims fire each due timer once across scanners", async () => {
    const [b] = await pair();
    const now = Date.now();
    for (let i = 0; i < 20; i++) await b.setTimer("inst", `s${i}:L1_idle`, now - 1);
    await b.setTimer("inst", "future:L1_idle", now + 60_000);
    const claims = await Promise.all([0, 1, 2].map(() => b.claimExpiredFromShard("pipeline_timers", now, 50)));
    const members = claims.flat().map((c) => c.member);
    expect(members).toHaveLength(20);
    expect(new Set(members).size).toBe(20);
    expect(members.every((m) => m.startsWith("inst\x00s"))).toBe(true);
    await b.destroy();
  });
});
