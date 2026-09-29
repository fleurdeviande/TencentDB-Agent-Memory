import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_FACTORIES } from "./backends.js";
import { loadPwConfig } from "./config.js";
import { stderrLog } from "./log.js";
import { createPwServer } from "./server.js";

/** stdio MCP entry. Errors are logged; the process only exits when the transport closes. */
export async function serve(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const log = stderrLog();
  const config = loadPwConfig(env);
  if (config.configFile) log(`config file: ${config.configFile}`);
  for (const note of config.notes) log(note);
  const { server, registry } = await createPwServer(config, DEFAULT_FACTORIES, log);
  log(`${registry.tools.length} tools: ${registry.tools.map((tool) => tool.name).join(", ") || "(none)"}`);
  await server.connect(new StdioServerTransport());
}
