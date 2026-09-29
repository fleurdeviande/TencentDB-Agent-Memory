/**
 * PostgresStateBackend — IStateBackend on Postgres (STATE_BACKEND=postgres).
 *
 * LocalStateBackend keeps buffers, session counters, timers, the task queue and
 * locks in process memory, so a restart drops queued L1/L2/L3 work and every
 * armed timer. This backend keeps the same state in tables, which makes it
 * survive restarts and lets several gateway processes share one queue:
 *
 *   pipeline_sessions  per (instance, team, agent, session) counters, JSONB
 *   pipeline_buffers   captured-message buffer rows
 *   pipeline_timers    (instance, member) → fire_at_ms; claimed by TimerScanner
 *   pipeline_tasks     queue: owner_id NULL = queued, else pending (claimed)
 *   pipeline_locks     lease locks with expiry
 *
 * Every read-modify-write is a single statement or one transaction, where the
 * local backend relied on the event loop: claims use FOR UPDATE SKIP LOCKED, so
 * concurrent consumers never get the same task; captureAtomic locks the session
 * row, so the count/threshold/enqueue step cannot interleave.
 *
 * Delivery follows the Redis-stream contract the worker expects: a consumed task
 * stays pending until ACKed; claimStaleTasks hands pending tasks of a dead worker
 * to a live one once their claim is older than minIdleMs, which is what
 * recovers in-flight work after a crash. Timers fire through TimerScanner
 * (`claimExpiredFromShard`), not setTimeout.
 */

import type { Pool } from "pg";
import { getSharedPostgresPool, qi, withTransaction } from "../store/postgres/client.js";
import { assertSchemaName } from "../store/postgres/config.js";
import { type Migration, runMigrations } from "../store/postgres/migrations.js";
import type {
  CaptureAtomicParams,
  CaptureAtomicResult,
  IStateBackend,
  PipelineSessionState,
  TaskPayload,
  TimerEntry,
} from "./types.js";
import { DEFAULT_PIPELINE_STATE } from "./types.js";

export const STATE_COMPONENT = "state";

const iso = `TEXT COLLATE "C" NOT NULL`;

export const STATE_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "pipeline state, timers, task queue, locks",
    sql: (s) => `
      CREATE TABLE IF NOT EXISTS ${s}.pipeline_sessions (
        state_key ${iso} PRIMARY KEY,
        instance_id ${iso},
        session_id ${iso},
        state JSONB NOT NULL,
        updated_at_ms BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_sessions_instance ON ${s}.pipeline_sessions (instance_id);

      CREATE TABLE IF NOT EXISTS ${s}.pipeline_buffers (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        state_key ${iso},
        instance_id ${iso},
        message TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_buffers_key ON ${s}.pipeline_buffers (state_key, id);
      CREATE INDEX IF NOT EXISTS idx_pipeline_buffers_instance ON ${s}.pipeline_buffers (instance_id);

      CREATE TABLE IF NOT EXISTS ${s}.pipeline_timers (
        instance_id ${iso},
        member ${iso},
        fire_at_ms BIGINT NOT NULL,
        PRIMARY KEY (instance_id, member)
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_timers_fire ON ${s}.pipeline_timers (fire_at_ms);

      CREATE TABLE IF NOT EXISTS ${s}.pipeline_tasks (
        msg_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        instance_id ${iso},
        priority INTEGER NOT NULL,
        created_at_ms BIGINT NOT NULL,
        payload JSONB NOT NULL,
        owner_id TEXT,
        claimed_at_ms BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_queued
        ON ${s}.pipeline_tasks (priority, created_at_ms, msg_id) WHERE owner_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_pending
        ON ${s}.pipeline_tasks (claimed_at_ms) WHERE owner_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_pipeline_tasks_instance ON ${s}.pipeline_tasks (instance_id);

      CREATE TABLE IF NOT EXISTS ${s}.pipeline_locks (
        lock_key ${iso} PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expire_at_ms BIGINT NOT NULL
      );`,
  },
];

export interface PostgresStateBackendOptions {
  /** Schema for the pipeline_* tables (one per deployment, shared by all instances). */
  schema: string;
  /** Connection URL; the shared pool per URL is used. Ignored when `pool` is given. */
  url?: string;
  pool?: Pool;
  /** Upper bound for one poll sleep while consumeTask blocks. Default 200 ms. */
  pollIntervalMs?: number;
}

/** Only numeric message ids are ours; anything else (a foreign `_msgId`) matches nothing. */
function msgIdParam(taskId: string): string | null {
  return /^\d+$/.test(taskId) ? taskId : null;
}

function stripDelivery(task: TaskPayload): TaskPayload {
  const payload = { ...task };
  delete payload._msgId;
  delete payload._stream;
  delete payload._ownerId;
  return payload;
}

export class PostgresStateBackend implements IStateBackend {
  /** TimerScanner claims from `timerShardCount` shards; Postgres needs one. */
  readonly timerShardCount = 1;

  private readonly pool: Pool;
  private readonly schema: string;
  private readonly s: string;
  private readonly pollIntervalMs: number;
  private initPromise: Promise<void> | null = null;
  private wakers = new Set<() => void>();
  private destroyed = false;

  constructor(opts: PostgresStateBackendOptions) {
    this.schema = assertSchemaName(opts.schema);
    this.s = qi(this.schema);
    this.pool = opts.pool ?? getSharedPostgresPool(opts.url ?? "");
    this.pollIntervalMs = Math.max(20, opts.pollIntervalMs ?? 200);
  }

  getSchema(): string {
    return this.schema;
  }

  /** Same key shape as LocalStateBackend / the Redis hash tags. */
  private k(instanceId: string, sessionId: string, teamId?: string, agentId?: string): string {
    return `${instanceId}:${teamId || "_"}:${agentId || "_"}:${sessionId}`;
  }

  // ═══ Lifecycle ═══

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = runMigrations(this.pool, this.schema, STATE_COMPONENT, STATE_MIGRATIONS).then(
        () => undefined,
        (err) => {
          this.initPromise = null;
          throw err;
        },
      );
    }
    return this.initPromise;
  }

  /** Stops blocking consumers. The shared pool stays open (closeSharedPostgresPools ends it). */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.wake();
  }

  private wake(): void {
    const all = [...this.wakers];
    this.wakers.clear();
    for (const w of all) w();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      this.wakers.add(done);
    });
  }

  // ═══ Buffer ═══

  async appendBuffer(instanceId: string, sessionId: string, message: string, teamId?: string, agentId?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.s}.pipeline_buffers (state_key, instance_id, message) VALUES ($1, $2, $3)`,
      [this.k(instanceId, sessionId, teamId, agentId), instanceId, message],
    );
  }

  async drainBuffer(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<string[]> {
    const res = await this.pool.query<{ id: number; message: string }>(
      `DELETE FROM ${this.s}.pipeline_buffers WHERE state_key = $1 RETURNING id, message`,
      [this.k(instanceId, sessionId, teamId, agentId)],
    );
    return res.rows.sort((a, b) => a.id - b.id).map((r) => r.message);
  }

  async getBufferLength(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<number> {
    const res = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${this.s}.pipeline_buffers WHERE state_key = $1`,
      [this.k(instanceId, sessionId, teamId, agentId)],
    );
    return res.rows[0]?.n ?? 0;
  }

  // ═══ Session State ═══

  async getSessionState(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<PipelineSessionState | null> {
    const res = await this.pool.query<{ state: PipelineSessionState }>(
      `SELECT state FROM ${this.s}.pipeline_sessions WHERE state_key = $1`,
      [this.k(instanceId, sessionId, teamId, agentId)],
    );
    return res.rows[0]?.state ?? null;
  }

  async updateSessionState(
    instanceId: string,
    sessionId: string,
    patch: Partial<PipelineSessionState>,
    teamId?: string,
    agentId?: string,
  ): Promise<void> {
    const now = Date.now();
    const initial = { ...DEFAULT_PIPELINE_STATE, last_active_time: now, ...patch };
    // JSONB `||` merges the patch server-side: concurrent patches of different fields both land.
    await this.pool.query(
      `INSERT INTO ${this.s}.pipeline_sessions (state_key, instance_id, session_id, state, updated_at_ms)
       VALUES ($1, $2, $3, $4::jsonb, $6)
       ON CONFLICT (state_key) DO UPDATE SET
         state = ${this.s}.pipeline_sessions.state || $5::jsonb,
         updated_at_ms = EXCLUDED.updated_at_ms`,
      [this.k(instanceId, sessionId, teamId, agentId), instanceId, sessionId, JSON.stringify(initial), JSON.stringify(patch), now],
    );
  }

  async deleteSessionState(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<void> {
    const key = this.k(instanceId, sessionId, teamId, agentId);
    await withTransaction(this.pool, async (c) => {
      await c.query(`DELETE FROM ${this.s}.pipeline_sessions WHERE state_key = $1`, [key]);
      await c.query(`DELETE FROM ${this.s}.pipeline_buffers WHERE state_key = $1`, [key]);
    });
  }

  async listActiveSessions(instanceId: string): Promise<string[]> {
    const res = await this.pool.query<{ session_id: string }>(
      `SELECT session_id FROM ${this.s}.pipeline_sessions WHERE instance_id = $1 ORDER BY state_key`,
      [instanceId],
    );
    return res.rows.map((r) => r.session_id);
  }

  // ═══ Timer ═══

  async setTimer(instanceId: string, member: string, fireAtMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.s}.pipeline_timers (instance_id, member, fire_at_ms) VALUES ($1, $2, $3)
       ON CONFLICT (instance_id, member) DO UPDATE SET fire_at_ms = EXCLUDED.fire_at_ms`,
      [instanceId, member, Math.floor(fireAtMs)],
    );
  }

  async setTimerIfEarlier(instanceId: string, member: string, fireAtMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO ${this.s}.pipeline_timers (instance_id, member, fire_at_ms) VALUES ($1, $2, $3)
       ON CONFLICT (instance_id, member) DO UPDATE SET fire_at_ms = EXCLUDED.fire_at_ms
       WHERE ${this.s}.pipeline_timers.fire_at_ms > EXCLUDED.fire_at_ms
       RETURNING 1`,
      [instanceId, member, Math.floor(fireAtMs)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async removeTimer(instanceId: string, member: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.s}.pipeline_timers WHERE instance_id = $1 AND member = $2`, [
      instanceId,
      member,
    ]);
  }

  async getExpiredTimers(instanceId: string, nowMs: number): Promise<TimerEntry[]> {
    const res = await this.pool.query<{ member: string; fire_at_ms: number }>(
      `DELETE FROM ${this.s}.pipeline_timers WHERE instance_id = $1 AND fire_at_ms <= $2 RETURNING member, fire_at_ms`,
      [instanceId, nowMs],
    );
    return res.rows.map((r) => ({ instanceId, member: r.member, fireAtMs: r.fire_at_ms }));
  }

  getTimerShardKeyByIndex(_shard: number): string {
    return "pipeline_timers";
  }

  /**
   * TimerScanner hook: atomically remove up to `limit` due timers of every
   * instance and return them as `{instanceId}\0{member}` (the scanner's member
   * format). SKIP LOCKED lets several processes scan without double-firing.
   */
  async claimExpiredFromShard(_shardKey: string, nowMs: number, limit: number): Promise<TimerEntry[]> {
    const res = await this.pool.query<{ instance_id: string; member: string; fire_at_ms: number }>(
      `DELETE FROM ${this.s}.pipeline_timers t
        USING (SELECT instance_id, member FROM ${this.s}.pipeline_timers
                WHERE fire_at_ms <= $1 ORDER BY fire_at_ms LIMIT $2 FOR UPDATE SKIP LOCKED) due
        WHERE t.instance_id = due.instance_id AND t.member = due.member
        RETURNING t.instance_id, t.member, t.fire_at_ms`,
      [nowMs, limit],
    );
    return res.rows
      .sort((a, b) => a.fire_at_ms - b.fire_at_ms)
      .map((r) => ({ instanceId: r.instance_id, member: `${r.instance_id}\x00${r.member}`, fireAtMs: r.fire_at_ms }));
  }

  // ═══ Task Queue ═══

  async enqueueTask(task: TaskPayload): Promise<void> {
    const payload = stripDelivery(task);
    await this.pool.query(
      `INSERT INTO ${this.s}.pipeline_tasks (instance_id, priority, created_at_ms, payload) VALUES ($1, $2, $3, $4::jsonb)`,
      [payload.instanceId ?? "", payload.priority, payload.createdAt, JSON.stringify(payload)],
    );
    this.wake();
  }

  private delivery(row: { msg_id: number; payload: TaskPayload; owner_id: string }): TaskPayload {
    return { ...row.payload, _msgId: String(row.msg_id), _stream: "postgres", _ownerId: row.owner_id };
  }

  private async claimNext(workerId: string): Promise<TaskPayload | null> {
    const res = await this.pool.query<{ msg_id: number; payload: TaskPayload; owner_id: string }>(
      `UPDATE ${this.s}.pipeline_tasks SET owner_id = $1, claimed_at_ms = $2
        WHERE msg_id = (SELECT msg_id FROM ${this.s}.pipeline_tasks WHERE owner_id IS NULL
                         ORDER BY priority, created_at_ms, msg_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING msg_id, payload, owner_id`,
      [workerId, Date.now()],
    );
    return res.rows[0] ? this.delivery(res.rows[0]) : null;
  }

  async consumeTask(workerId: string, blockMs?: number): Promise<TaskPayload | null> {
    const deadline = Date.now() + Math.max(0, blockMs ?? 0);
    for (;;) {
      if (this.destroyed) return null;
      const task = await this.claimNext(workerId);
      if (task) return task;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      // In-process enqueues wake us at once; other processes' are seen on the next poll.
      await this.sleep(Math.min(left, this.pollIntervalMs));
    }
  }

  async ackTask(taskId: string): Promise<void> {
    const id = msgIdParam(taskId);
    if (!id) return;
    await this.pool.query(`DELETE FROM ${this.s}.pipeline_tasks WHERE msg_id = $1::bigint`, [id]);
  }

  async refreshTaskClaim(taskId: string, ownerId: string, idleMs = 0): Promise<boolean> {
    const id = msgIdParam(taskId);
    if (!id) return false;
    const res = await this.pool.query(
      `UPDATE ${this.s}.pipeline_tasks SET claimed_at_ms = $3 WHERE msg_id = $1::bigint AND owner_id = $2`,
      [id, ownerId, Date.now() - Math.max(0, idleMs)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async ackTaskIfOwned(taskId: string, ownerId: string): Promise<boolean> {
    const id = msgIdParam(taskId);
    if (!id) return false;
    const res = await this.pool.query(`DELETE FROM ${this.s}.pipeline_tasks WHERE msg_id = $1::bigint AND owner_id = $2`, [
      id,
      ownerId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  async replacePendingTask(taskId: string, ownerId: string, replacement: TaskPayload): Promise<boolean> {
    const id = msgIdParam(taskId);
    if (!id) return false;
    const payload = stripDelivery(replacement);
    const replaced = await withTransaction(this.pool, async (c) => {
      const del = await c.query(`DELETE FROM ${this.s}.pipeline_tasks WHERE msg_id = $1::bigint AND owner_id = $2`, [
        id,
        ownerId,
      ]);
      if ((del.rowCount ?? 0) === 0) return false;
      await c.query(
        `INSERT INTO ${this.s}.pipeline_tasks (instance_id, priority, created_at_ms, payload) VALUES ($1, $2, $3, $4::jsonb)`,
        [payload.instanceId ?? "", payload.priority, payload.createdAt, JSON.stringify(payload)],
      );
      return true;
    });
    if (replaced) this.wake();
    return replaced;
  }

  async claimStaleTasks(workerId: string, minIdleMs: number, count: number): Promise<TaskPayload[]> {
    const now = Date.now();
    const res = await this.pool.query<{ msg_id: number; payload: TaskPayload; owner_id: string }>(
      `UPDATE ${this.s}.pipeline_tasks t SET owner_id = $1, claimed_at_ms = $2
         FROM (SELECT msg_id FROM ${this.s}.pipeline_tasks
                WHERE owner_id IS NOT NULL AND claimed_at_ms <= $3
                ORDER BY claimed_at_ms, msg_id LIMIT $4 FOR UPDATE SKIP LOCKED) stale
        WHERE t.msg_id = stale.msg_id
        RETURNING t.msg_id, t.payload, t.owner_id`,
      [workerId, now, now - Math.max(0, minIdleMs), count],
    );
    return res.rows.sort((a, b) => a.msg_id - b.msg_id).map((r) => this.delivery(r));
  }

  async getQueueDepth(): Promise<{ high: number; low: number }> {
    const res = await this.pool.query<{ high: number; low: number }>(
      `SELECT count(*) FILTER (WHERE priority = 0)::int AS high, count(*) FILTER (WHERE priority <> 0)::int AS low
         FROM ${this.s}.pipeline_tasks WHERE owner_id IS NULL`,
    );
    return { high: res.rows[0]?.high ?? 0, low: res.rows[0]?.low ?? 0 };
  }

  async listQueuedTasks(): Promise<TaskPayload[]> {
    const res = await this.pool.query<{ payload: TaskPayload }>(
      `SELECT payload FROM ${this.s}.pipeline_tasks WHERE owner_id IS NULL ORDER BY priority, created_at_ms, msg_id`,
    );
    return res.rows.map((r) => r.payload);
  }

  // ═══ Lock ═══

  async acquireLock(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    // Takes a free or expired lock only; a live lock (even our own) is not re-entered, as in Local.
    const res = await this.pool.query(
      `INSERT INTO ${this.s}.pipeline_locks (lock_key, owner_id, expire_at_ms) VALUES ($1, $2, $3)
       ON CONFLICT (lock_key) DO UPDATE SET owner_id = EXCLUDED.owner_id, expire_at_ms = EXCLUDED.expire_at_ms
       WHERE ${this.s}.pipeline_locks.expire_at_ms <= $4
       RETURNING 1`,
      [key, ownerId, now + ttlMs, now],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async renewLock(key: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE ${this.s}.pipeline_locks SET expire_at_ms = $3 WHERE lock_key = $1 AND owner_id = $2`,
      [key, ownerId, Date.now() + ttlMs],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async releaseLock(key: string, ownerId: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.s}.pipeline_locks WHERE lock_key = $1 AND owner_id = $2`, [key, ownerId]);
  }

  // ═══ Atomic Capture ═══

  async captureAtomic(params: CaptureAtomicParams): Promise<CaptureAtomicResult> {
    const { instanceId, sessionId, teamId, agentId, messageJson, threshold, fireAtMs, timerMember, taskPayload, nowMs, rounds } = params;
    const key = this.k(instanceId, sessionId, teamId, agentId);

    const result = await withTransaction(this.pool, async (c) => {
      if (messageJson) {
        await c.query(`INSERT INTO ${this.s}.pipeline_buffers (state_key, instance_id, message) VALUES ($1, $2, $3)`, [
          key,
          instanceId,
          messageJson,
        ]);
      }
      await c.query(
        `INSERT INTO ${this.s}.pipeline_sessions (state_key, instance_id, session_id, state, updated_at_ms)
         VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (state_key) DO NOTHING`,
        [key, instanceId, sessionId, JSON.stringify({ ...DEFAULT_PIPELINE_STATE, last_active_time: nowMs }), nowMs],
      );
      // The row lock serialises concurrent captures of one session until COMMIT.
      const cur = await c.query<{ state: PipelineSessionState }>(
        `SELECT state FROM ${this.s}.pipeline_sessions WHERE state_key = $1 FOR UPDATE`,
        [key],
      );
      const state: PipelineSessionState = { ...DEFAULT_PIPELINE_STATE, ...cur.rows[0].state };
      state.conversation_count += rounds;
      state.last_active_time = nowMs;

      const triggered = state.conversation_count >= threshold;
      if (triggered) {
        const payload = stripDelivery(taskPayload);
        await c.query(
          `INSERT INTO ${this.s}.pipeline_tasks (instance_id, priority, created_at_ms, payload) VALUES ($1, $2, $3, $4::jsonb)`,
          [payload.instanceId ?? "", payload.priority, payload.createdAt, JSON.stringify(payload)],
        );
        state.conversation_count = 0;
        await c.query(`DELETE FROM ${this.s}.pipeline_timers WHERE instance_id = $1 AND member = $2`, [instanceId, timerMember]);
      } else {
        await c.query(
          `INSERT INTO ${this.s}.pipeline_timers (instance_id, member, fire_at_ms) VALUES ($1, $2, $3)
           ON CONFLICT (instance_id, member) DO UPDATE SET fire_at_ms = EXCLUDED.fire_at_ms`,
          [instanceId, timerMember, Math.floor(fireAtMs)],
        );
      }
      await c.query(`UPDATE ${this.s}.pipeline_sessions SET state = $2::jsonb, updated_at_ms = $3 WHERE state_key = $1`, [
        key,
        JSON.stringify(state),
        nowMs,
      ]);
      return { triggered, conversationCount: state.conversation_count };
    });
    if (result.triggered) this.wake();
    return result;
  }

  // ═══ Instance Lifecycle ═══

  async purgeInstance(instanceId: string): Promise<{ sessions: number; timers: number; buffers: number }> {
    return withTransaction(this.pool, async (c) => {
      const sessions = await c.query(`DELETE FROM ${this.s}.pipeline_sessions WHERE instance_id = $1`, [instanceId]);
      const buffers = await c.query(`DELETE FROM ${this.s}.pipeline_buffers WHERE instance_id = $1`, [instanceId]);
      const timers = await c.query(`DELETE FROM ${this.s}.pipeline_timers WHERE instance_id = $1`, [instanceId]);
      await c.query(`DELETE FROM ${this.s}.pipeline_tasks WHERE instance_id = $1`, [instanceId]);
      return { sessions: sessions.rowCount ?? 0, timers: timers.rowCount ?? 0, buffers: buffers.rowCount ?? 0 };
    });
  }
}
