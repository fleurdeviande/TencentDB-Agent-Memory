// Packages imported both by pw/mcp and by the upstream sources it compiles in.
// Build and tests resolve them from pw/mcp/node_modules only, so the bundle holds one copy each
// and the upstream packages need no node_modules of their own.
export const SHARED_DEPS = ["@modelcontextprotocol/sdk", "@tencentdb-agent-memory/memory-sdk-ts-v2", "zod"];
