/**
 * Memory half: the #1268 plugin's own McpServer, run in-process behind an in-memory transport.
 * Proxying through an MCP client keeps the plugin's tool schemas, validation and result formatting
 * exactly as upstream ships them, with no copy of its tool code here.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolBackend } from "./registry.js";
import { createClaudeCodeMcpServer, createKnowledge, createMemoryClient, type PluginConfig } from "./upstream/memory.js";

/**
 * Plugin wiki tools that duplicate a MemoryKnowledge tool, mapped to the tool that replaces them.
 * Kept from the plugin: tdai_wiki_list (lists wikis — Knowledge has no tool for that) and
 * tdai_wiki_write (Knowledge exposes no write tool).
 */
export const SUPERSEDED_PLUGIN_TOOLS: Readonly<Record<string, string>> = {
  tdai_wiki_search: "wiki_search",
  tdai_wiki_pages: "wiki_list",
  tdai_wiki_read: "wiki_read",
};

export interface MemoryBackendOptions {
  /** Register the plugin's tdai_wiki_* tools (needs `config.knowledgeUrl`). */
  includeWiki: boolean;
  /** Drop the plugin wiki tools that MemoryKnowledge's tools replace. */
  dropSuperseded: boolean;
}

export async function createMemoryBackend(config: PluginConfig, options: MemoryBackendOptions): Promise<ToolBackend> {
  const server = createClaudeCodeMcpServer({
    memory: createMemoryClient(config, config.captureTimeoutMs),
    knowledge: options.includeWiki ? createKnowledge(config) : undefined,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "pw-memory-inproc", version: "0.1.0" });
  await client.connect(clientSide);

  let cached: Tool[] | undefined;
  return {
    name: "memory",
    async listTools() {
      if (!cached) {
        const { tools } = await client.listTools();
        cached = options.dropSuperseded ? tools.filter((tool) => !(tool.name in SUPERSEDED_PLUGIN_TOOLS)) : tools;
      }
      return cached;
    },
    async callTool(name, args) {
      return await client.callTool({ name, arguments: args }) as CallToolResult;
    },
    instructions: () => client.getInstructions(),
    async close() {
      await client.close();
      await server.close();
    },
  };
}
