/**
 * Postgres metadata backend specifics: backend selection (pure), migrations, pool wiring, purge.
 */
import { afterAll, describe, expect, it } from "vitest";
import { loadStoreConfig, MetadataStartupValidationError, MetadataStorePool, validateMetadataStartupConfig } from "./factory.js";
import { PostgresMetadataStore } from "./postgres-adapter.js";
import { closeSharedPostgresPools, qi } from "../../core/store/postgres/client.js";
import { schemaForInstance } from "../../core/store/postgres/config.js";
import {
  dropTestSchema,
  postgresReachable,
  TEST_POSTGRES_URL,
  testPool,
  uniqueTestSchema,
} from "../../core/store/postgres/test-support.js";

const PG = "postgres://u:p@db:5432/x";

describe("metadata backend selection", () => {
  it("defaults to sqlite (upstream behaviour)", () => {
    expect(loadStoreConfig({}, "/tmp/meta").backend).toBe("sqlite");
    expect(loadStoreConfig({ POSTGRES_URL: PG }, "/tmp/meta").backend).toBe("sqlite");
  });

  it("follows STORE_MODE=postgres, reusing POSTGRES_URL, schema tdai_metadata", () => {
    const cfg = loadStoreConfig({ STORE_MODE: "postgres", POSTGRES_URL: PG });
    expect(cfg).toMatchObject({ backend: "postgres", postgresUrl: PG, postgresSchema: "tdai_metadata" });
  });

  it("TDAI_METADATA_POSTGRES_URL / _SCHEMA override the data-plane settings", () => {
    const cfg = loadStoreConfig({
      STORE_MODE: "postgres",
      POSTGRES_URL: PG,
      TDAI_METADATA_POSTGRES_URL: "postgres://m@meta/db",
      TDAI_METADATA_POSTGRES_SCHEMA: "meta_x",
    });
    expect(cfg).toMatchObject({ postgresUrl: "postgres://m@meta/db", postgresSchema: "meta_x" });
  });

  it("an explicit TDAI_METADATA_STORE_BACKEND wins over STORE_MODE", () => {
    expect(loadStoreConfig({ STORE_MODE: "postgres", POSTGRES_URL: PG, TDAI_METADATA_STORE_BACKEND: "sqlite" }).backend).toBe(
      "sqlite",
    );
    expect(loadStoreConfig({ POSTGRES_URL: PG, TDAI_METADATA_STORE_BACKEND: "postgres" }).backend).toBe("postgres");
  });

  it("a Mongo URI or an explicit sqlite dir keeps precedence under auto", () => {
    expect(loadStoreConfig({ STORE_MODE: "postgres", POSTGRES_URL: PG, TDAI_METADATA_MONGO_URI: "mongodb://m" }).backend).toBe(
      "mongodb",
    );
    expect(
      loadStoreConfig({ STORE_MODE: "postgres", POSTGRES_URL: PG, TDAI_METADATA_SQLITE_BASE_DIR: "/data/m" }).backend,
    ).toBe("sqlite");
  });

  it("fails fast on a missing URL, an unknown backend or a bad schema", () => {
    expect(() => loadStoreConfig({ STORE_MODE: "postgres" })).toThrow(MetadataStartupValidationError);
    expect(() => loadStoreConfig({ TDAI_METADATA_STORE_BACKEND: "mysql8" })).toThrow(MetadataStartupValidationError);
    expect(() => loadStoreConfig({ TDAI_METADATA_STORE_BACKEND: "mongodb" })).toThrow(MetadataStartupValidationError);
    expect(() =>
      loadStoreConfig({ STORE_MODE: "postgres", POSTGRES_URL: PG, TDAI_METADATA_POSTGRES_SCHEMA: 'x"; drop' }),
    ).toThrow(/invalid schema name/);
  });

  it("service deploy mode accepts postgres as well as mongodb", () => {
    expect(validateMetadataStartupConfig("service", { STORE_MODE: "postgres", POSTGRES_URL: PG }).backend).toBe("postgres");
    expect(() => validateMetadataStartupConfig("service", {})).toThrow(MetadataStartupValidationError);
  });
});

const reachable = await postgresReachable();

describe.skipIf(!reachable)("PostgresMetadataStore on a live database", () => {
  afterAll(async () => {
    await closeSharedPostgresPools();
  });

  it("migrations are versioned and idempotent across stores and re-inits", async () => {
    const schema = uniqueTestSchema();
    try {
      const a = new PostgresMetadataStore({ pool: testPool(), schema });
      const b = new PostgresMetadataStore({ pool: testPool(), schema });
      await Promise.all([a.init(), b.init()]);
      await a.init();
      const rows = await testPool().query(`SELECT component, version FROM ${qi(schema)}.schema_migrations`);
      expect(rows.rows).toEqual([{ component: "metadata", version: 1 }]);
      const u = await a.createUser({ auth_provider: "local", external_id: "e1", username: "alice" });
      expect((await b.getUserById(u.user_id))?.username).toBe("alice");
    } finally {
      await dropTestSchema(schema);
    }
  });

  it("purge drops only metadata tables when the schema is shared", async () => {
    const schema = uniqueTestSchema();
    try {
      await testPool().query(`CREATE SCHEMA ${qi(schema)}`);
      await testPool().query(`CREATE TABLE ${qi(schema)}.l0_conversations (id TEXT)`);
      const store = new PostgresMetadataStore({ pool: testPool(), schema });
      await store.init();
      await store.purge();
      const left = await testPool().query("SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY 1", [schema]);
      expect(left.rows.map((r) => r.tablename)).toEqual(["l0_conversations", "schema_migrations"]);
    } finally {
      await dropTestSchema(schema);
    }
  });

  it("MetadataStorePool: one schema per instance, purge drops it", async () => {
    const base = uniqueTestSchema();
    const pool = new MetadataStorePool({ backend: "postgres", postgresUrl: TEST_POSTGRES_URL, postgresSchema: base });
    const other = schemaForInstance(base, "inst-2");
    try {
      const s1 = await pool.getStore("default");
      const s2 = await pool.getStore("inst-2");
      await s1.createUser({ auth_provider: "local", external_id: "e", username: "only-in-default" });
      expect(await s1.countUsers()).toBe(1);
      expect(await s2.countUsers()).toBe(0);

      const res = await pool.purgeInstance("inst-2");
      expect(res).toEqual({ db_name: other, dropped: true });
      const gone = await testPool().query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [other]);
      expect(gone.rowCount).toBe(0);
      // A purged instance is recreated empty on next use.
      expect(await (await pool.getStore("inst-2")).countUsers()).toBe(0);
    } finally {
      await pool.closeAll();
      await dropTestSchema(other);
      await dropTestSchema(base);
    }
  });
});
