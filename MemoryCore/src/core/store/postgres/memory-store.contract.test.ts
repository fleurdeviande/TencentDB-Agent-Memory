/**
 * Runs the shared IMemoryStore contract against PostgresMemoryStore.
 * Needs a reachable Postgres with pgvector (POSTGRES_TEST_URL); skipped otherwise.
 */
import { afterAll, describe, it } from "vitest";
import { runMemoryStoreContract } from "../__contract__/memory-store.contract.js";
import { PostgresMemoryStore } from "./memory-store.js";
import { closeSharedPostgresPools } from "./client.js";
import { dropTestSchema, postgresReachable, testPool, uniqueTestSchema } from "./test-support.js";

const reachable = await postgresReachable();

if (!reachable) {
  describe.skip("IMemoryStore contract [postgres] (no database)", () => {
    it("skipped", () => undefined);
  });
} else {
  afterAll(async () => {
    await closeSharedPostgresPools();
  });

  runMemoryStoreContract({
    backend: "postgres",
    async createStore() {
      const store = new PostgresMemoryStore({ pool: testPool(), schema: uniqueTestSchema(), dimensions: 4 });
      await store.init({ provider: "openai", model: "contract-test" });
      return store;
    },
    async disposeStore(store) {
      store.close();
      await dropTestSchema((store as PostgresMemoryStore).getSchema());
    },
  });
}
