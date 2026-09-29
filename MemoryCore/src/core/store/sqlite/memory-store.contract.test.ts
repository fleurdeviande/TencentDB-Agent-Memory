/**
 * Runs the shared IMemoryStore contract against the SQLite store (baseline).
 * Each case gets a fresh vectors.db in its own temp dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMemoryStoreContract } from "../__contract__/memory-store.contract.js";
import type { IMemoryStore } from "../types.js";
import { VectorStore } from "./memory-store.js";

const dirs = new WeakMap<IMemoryStore, string>();

runMemoryStoreContract({
  backend: "sqlite",
  async createStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdai-contract-sqlite-"));
    const store = new VectorStore(path.join(dir, "vectors.db"), 4);
    await store.init({ provider: "openai", model: "contract-test" });
    dirs.set(store, dir);
    return store;
  },
  async disposeStore(store) {
    store.close();
    const dir = dirs.get(store);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  },
});
