/**
 * Runs the backend-neutral IMetadataStore contract against SQLite (in-memory db per test).
 */
import { runMetadataStoreContract } from "./metadata-store.contract.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";

runMetadataStoreContract(
  "sqlite",
  async () => new SqliteMetadataStore(":memory:"),
  async (store) => {
    await store.close();
  },
);
