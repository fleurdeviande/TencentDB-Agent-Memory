import { defineConfig } from "vitest/config";
import { SHARED_DEPS } from "./deps.mjs";

export default defineConfig({
  resolve: { dedupe: SHARED_DEPS },
  test: {
    include: ["__tests__/**/*.test.ts"],
    environment: "node",
    // MemoryKnowledge's logger defaults to debug on stdout.
    env: { LOG_LEVEL: "warn" },
  },
});
