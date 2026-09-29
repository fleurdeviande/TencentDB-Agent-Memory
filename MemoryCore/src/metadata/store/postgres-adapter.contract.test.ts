/**
 * Runs the backend-neutral IMetadataStore contract against PostgreSQL. Every test gets its
 * own throw-away `tdai_test_*` schema. Skipped when nothing answers at POSTGRES_TEST_URL.
 */
import { afterAll, describe, it } from "vitest";
import { runMetadataStoreContract } from "./metadata-store.contract.js";
import { PostgresMetadataStore } from "./postgres-adapter.js";
import { closeSharedPostgresPools } from "../../core/store/postgres/client.js";
import {
  dropTestSchema,
  postgresReachable,
  testPool,
  uniqueTestSchema,
} from "../../core/store/postgres/test-support.js";

const reachable = await postgresReachable();

if (!reachable) {
  describe.skip("IMetadataStore contract [postgres] (no database)", () => {
    it("skipped", () => undefined);
  });
} else {
  afterAll(async () => {
    await closeSharedPostgresPools();
  });

  runMetadataStoreContract(
    "postgres",
    async () => new PostgresMetadataStore({ pool: testPool(), schema: uniqueTestSchema() }),
    async (store) => {
      await store.close();
      await dropTestSchema((store as PostgresMetadataStore).schemaName);
    },
  );
}
