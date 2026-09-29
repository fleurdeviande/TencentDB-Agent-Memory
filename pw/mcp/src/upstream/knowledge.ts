// MemoryKnowledge's MCP tool definitions, compiled in from source.
// Not imported: its server.ts (the import.meta.url main-guard is true for every module of a bundle, so it
// would start a second stdio server) and its http-client.ts (callApi sends neither x-tdai-service-id nor
// team_id, which every multi-tenant /v3 route requires — it answers 400 against the current service).
export { MCP_TOOLS, type McpToolDef } from "../../../../MemoryKnowledge/src/mcp/tools.js";
