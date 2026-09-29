import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_DEPS } from "./deps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function isShared(specifier) {
  return SHARED_DEPS.some((dep) => specifier === dep || specifier.startsWith(`${dep}/`));
}

/** Resolve shared deps from pw/mcp even when imported from MemoryCore/ or MemoryKnowledge/ sources. */
const dedupeShared = {
  name: "dedupe-shared",
  setup(b) {
    b.onResolve({ filter: /^[@a-z]/ }, async (args) => {
      if (!isShared(args.path) || args.pluginData === "dedupe") return undefined;
      const result = await b.resolve(args.path, { kind: args.kind, resolveDir: here, pluginData: "dedupe" });
      return result.errors.length > 0 ? { errors: result.errors } : { path: result.path };
    });
  },
};

await build({
  entryPoints: { server: "src/entry/server.ts", cli: "src/entry/cli.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // ESM output has no `require`; some deps (the memory SDK's optional undici) call it.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __pwCreateRequire } from 'node:module';\nconst require = __pwCreateRequire(import.meta.url);" },
  plugins: [dedupeShared],
  logLevel: "info",
});
