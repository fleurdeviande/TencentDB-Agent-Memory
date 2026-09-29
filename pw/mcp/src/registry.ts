/**
 * Combined tool registry: each half of the server is a backend that lists tools and answers calls.
 * The registry is built once at startup and never changes afterwards, so the tool list Claude Code puts
 * into its prompt stays byte-identical for the whole session (no list_changed, no prompt-cache misses).
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Log } from "./log.js";

export interface ToolBackend {
  /** Short label for logs: "memory", "knowledge". */
  readonly name: string;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Server instructions contributed by this backend. */
  instructions?(): string | undefined;
  close?(): Promise<void>;
}

export interface Collision {
  tool: string;
  kept: string;
  dropped: string;
}

export interface ToolRegistry {
  readonly tools: Tool[];
  readonly collisions: Collision[];
  ownerOf(tool: string): string | undefined;
  call(tool: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * First backend wins on a name collision; the loser's tool is dropped and logged. A backend whose
 * listing fails is skipped, so one bad half never takes the other down.
 */
export async function buildRegistry(backends: ToolBackend[], log: Log): Promise<ToolRegistry> {
  const owners = new Map<string, ToolBackend>();
  const tools: Tool[] = [];
  const collisions: Collision[] = [];
  const live: ToolBackend[] = [];

  for (const backend of backends) {
    let listed: Tool[];
    try {
      listed = await backend.listTools();
    } catch (error) {
      log(`${backend.name} tools unavailable: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    live.push(backend);
    for (const tool of listed) {
      const owner = owners.get(tool.name);
      if (owner) {
        collisions.push({ tool: tool.name, kept: owner.name, dropped: backend.name });
        log(`tool name collision: ${tool.name} from ${backend.name} dropped, ${owner.name} keeps it`);
        continue;
      }
      owners.set(tool.name, backend);
      tools.push(tool);
    }
  }

  return {
    tools,
    collisions,
    ownerOf: (tool) => owners.get(tool)?.name,
    async call(tool, args) {
      const backend = owners.get(tool);
      if (!backend) return errorResult(`Unknown tool: ${tool}`);
      try {
        return await backend.callTool(tool, args);
      } catch (error) {
        return errorResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async close() {
      await Promise.allSettled(live.map((backend) => backend.close?.()));
    },
  };
}
