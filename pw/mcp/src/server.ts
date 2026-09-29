/**
 * The pw-memory MCP server: one stdio server, two optional halves.
 * A half whose URL is unset is not built; a half that fails to build is logged and skipped.
 * Startup never throws — a broken config must not break Claude Code's startup.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PwConfig } from "./config.js";
import type { Log } from "./log.js";
import { buildRegistry, type ToolBackend, type ToolRegistry } from "./registry.js";

export const SERVER_NAME = "pw-memory";
export const SERVER_VERSION = "0.1.0";

export type BackendFactory = (config: PwConfig) => Promise<ToolBackend | undefined>;

export async function buildBackends(config: PwConfig, factories: BackendFactory[], log: Log): Promise<ToolBackend[]> {
  const backends: ToolBackend[] = [];
  for (const factory of factories) {
    try {
      const backend = await factory(config);
      if (backend) backends.push(backend);
    } catch (error) {
      log(`backend failed to start, skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return backends;
}

/** Static per process: computed once from the backends, so the system prompt never changes mid-session. */
export function combinedInstructions(backends: ToolBackend[]): string {
  const parts = backends.map((backend) => backend.instructions?.()).filter((text): text is string => Boolean(text));
  return parts.length > 0 ? parts.join("\n\n") : "pw-memory: no backend configured (set TDAI_URL and/or KNOWLEDGE_URL).";
}

export interface PwServer {
  server: Server;
  registry: ToolRegistry;
}

export async function createPwServer(config: PwConfig, factories: BackendFactory[], log: Log): Promise<PwServer> {
  const backends = await buildBackends(config, factories, log);
  const registry = await buildRegistry(backends, log);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: combinedInstructions(backends) },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    registry.call(request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>));
  server.onclose = () => void registry.close();
  return { server, registry };
}
