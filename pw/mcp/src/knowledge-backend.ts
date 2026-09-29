/**
 * Knowledge half: MemoryKnowledge's 12 tool definitions, sent over the #1268 plugin's
 * KnowledgeServiceClient (Bearer, `x-tdai-service-id`, team/user/agent in the body, envelope unwrap,
 * timeout). MemoryKnowledge's own callApi cannot be used, see upstream/knowledge.ts. The result mapping
 * mirrors MemoryKnowledge/src/mcp/server.ts.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { errorResult, type ToolBackend } from "./registry.js";
import { MCP_TOOLS, type McpToolDef } from "./upstream/knowledge.js";
import { KnowledgeServiceClient, type PluginConfig } from "./upstream/memory.js";

export const KNOWLEDGE_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((tool) => tool.name);

export interface KnowledgeBackendOptions {
  url: string;
  token?: string;
  /** Tenant identity, shared with the memory half. */
  identity: Pick<PluginConfig, "serviceId" | "teamId" | "userId" | "agentId">;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export function toCallToolResult(data: unknown): CallToolResult {
  // Code-graph query endpoints answer {text, isError}; pass that through as the upstream server does.
  if (data && typeof data === "object" && "text" in data && "isError" in data) {
    const result = data as { text: string; isError: boolean };
    return { content: [{ type: "text", text: result.text || "(empty result)" }], isError: result.isError };
  }
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
}

export function createKnowledgeBackend(options: KnowledgeBackendOptions): ToolBackend {
  const byName = new Map<string, McpToolDef>(MCP_TOOLS.map((tool) => [tool.name, tool]));
  // Upstream types properties as Record<string, unknown>; every value is a JSON Schema object.
  const tools = MCP_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) as Tool[];
  const client = new KnowledgeServiceClient({
    baseUrl: options.url,
    apiKey: options.token,
    ...options.identity,
    timeoutMs: options.timeoutMs ?? 30_000,
    fetch: options.fetch,
  });

  return {
    name: "knowledge",
    listTools: async () => tools,
    async callTool(name, args) {
      const tool = byName.get(name);
      if (!tool) return errorResult(`Unknown tool: ${name}`);
      try {
        return toCallToolResult(await client.post(`/v3${tool.endpoint}`, args));
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    instructions: () =>
      "Knowledge tools: code_* query the indexed code graphs (ids cg-...), wiki_* the team wikis (ids wiki-..., " +
      "listed by tdai_wiki_list when memory is enabled). Use them before searching the filesystem for architecture, " +
      "contracts and cross-repo call chains.",
  };
}
