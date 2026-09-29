import "../stdio-guard.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, runHook } from "../hook.js";
import { defaultContext, HOOK_SUBCOMMAND, install, printReport, uninstall } from "../install.js";
import { stderrLog } from "../log.js";
import { serve } from "../serve.js";

const USAGE = `usage: pw-memory <command> [options]

commands:
  serve                 run the stdio MCP server (same as dist/server.js)
  install               write the config file, register the MCP server, add the hooks
  uninstall             remove the MCP registration and the hooks (--purge also deletes the config file)
  ${HOOK_SUBCOMMAND}        hook entry used by Claude Code (reads the hook payload on stdin)

options:
  --dry-run             print what install/uninstall would do, change nothing
  --node <path>         node binary for the server and hooks (default: the one running this command)
  --settings <path>     Claude Code settings file (default: ~/.claude/settings.json)
  --purge               uninstall: also delete the config file

config (env, persisted by install): TDAI_URL, KNOWLEDGE_URL, TDAI_USER_KEY
  optional: KNOWLEDGE_API_TOKEN, TDAI_SERVICE_ID, TDAI_TEAM_ID, TDAI_AGENT_ID, TDAI_USER_ID, PW_MEMORY_CONFIG`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [command = "serve", ...rest] = argv;
  if (command === HOOK_SUBCOMMAND || command === "hook") {
    process.stdout.write(`${await runHook(await readStdin(), { log: stderrLog("pw-memory][hook") })}\n`);
    return 0;
  }
  if (command === "serve") {
    await serve();
    return 0;
  }
  if (command !== "install" && command !== "uninstall") {
    process.stderr.write(`${USAGE}\n`);
    return command === "help" || command === "--help" || command === "-h" ? 0 : 2;
  }
  const settings = option(rest, "--settings");
  const ctx = defaultContext({
    distDir: path.dirname(fileURLToPath(import.meta.url)),
    dryRun: rest.includes("--dry-run"),
    ...(option(rest, "--node") ? { nodeBin: path.resolve(option(rest, "--node") as string) } : {}),
    ...(settings ? { settingsPath: path.resolve(settings) } : {}),
  });
  const report = command === "install" ? await install(ctx) : await uninstall(ctx, { purge: rest.includes("--purge") });
  printReport(report, ctx.out);
  return report.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`[pw-memory] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
