/**
 * Knowledge half: MemoryKnowledge's 12 tool definitions and its `callApi` HTTP client, imported from
 * source. The result mapping below mirrors MemoryKnowledge/src/mcp/server.ts, which cannot be imported
 * (see upstream/knowledge.ts).
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { errorResult, type ToolBackend } from "./registry.js";
import { callApi, MCP_TOOLS, type McpToolDef } from "./upstream/knowledge.js";

export interface KnowledgeBackendOptions {
  url: string;
  token?: string;
  /** `callApi` has no timeout of its own; a hung service must not hang the tool call. */
  timeoutMs?: number;
}

export const KNOWLEDGE_TOOL_NAMES: readonly string[] = MCP_TOOLS.map((tool) => tool.name);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const timeoutMs = options.timeoutMs ?? 30_000;
  const http = { baseUrl: options.url, token: options.token };

  return {
    name: "knowledge",
    listTools: async () => tools,
    async callTool(name, args) {
      const tool = byName.get(name);
      if (!tool) return errorResult(`Unknown tool: ${name}`);
      try {
        return toCallToolResult(await withTimeout(callApi(http, tool.endpoint, args), timeoutMs, name));
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    instructions: () =>
      "Knowledge tools: code_* query the indexed code graphs (ids cg-...), wiki_* the team wikis (ids wiki-...). " +
      "Use them before searching the filesystem for architecture, contracts and cross-repo call chains.",
  };
}
