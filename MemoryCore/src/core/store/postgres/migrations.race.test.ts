import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { isTransientNamespaceRace, runMigrations } from "./migrations.js";

const race = Object.assign(new Error('duplicate key value violates unique constraint "pg_namespace_nspname_index"'), {
  code: "23505",
  constraint: "pg_namespace_nspname_index",
});

// A pool whose transactions fail with `failures` in order, then succeed with no migrations pending.
function fakePool(failures: unknown[]): { pool: Pool; connects: () => number } {
  let n = 0;
  const client = {
    query: vi.fn(async (sql: string) => {
      if (/^SELECT version FROM/.test(sql.trim())) return { rows: [{ version: 1 }] };
      if (/CREATE SCHEMA/.test(sql) && failures.length > 0) throw failures.shift();
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => (n++, client)) } as unknown as Pool;
  return { pool, connects: () => n };
}

const one = [{ version: 1, name: "init", sql: () => "SELECT 1" }];

describe("runMigrations namespace race", () => {
  it("recognises only the pg_namespace unique violation", () => {
    expect(isTransientNamespaceRace(race)).toBe(true);
    expect(isTransientNamespaceRace({ code: "23505", constraint: "memories_pkey" })).toBe(false);
    expect(isTransientNamespaceRace(new Error("boom"))).toBe(false);
  });

  it("retries the migration transaction after the race and succeeds", async () => {
    const { pool, connects } = fakePool([race]);
    await expect(runMigrations(pool, "tdai", "memory", one)).resolves.toEqual([]);
    expect(connects()).toBe(2);
  });

  it("gives up after three races", async () => {
    const { pool } = fakePool([race, race, race]);
    await expect(runMigrations(pool, "tdai", "memory", one)).rejects.toThrow(/pg_namespace_nspname_index/);
  });

  it("does not retry other errors", async () => {
    const boom = new Error("permission denied for database");
    const { pool, connects } = fakePool([boom]);
    await expect(runMigrations(pool, "tdai", "memory", one)).rejects.toThrow("permission denied");
    expect(connects()).toBe(1);
  });
});
