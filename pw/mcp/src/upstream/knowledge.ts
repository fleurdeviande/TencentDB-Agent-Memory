// MemoryKnowledge's MCP tool definitions and HTTP client, compiled in from source.
// Its server.ts is not imported: its "run when main" guard compares import.meta.url with argv[1],
// which is true for every module of a bundle, so importing it would start a second stdio server.
export { MCP_TOOLS, type McpToolDef } from "../../../../MemoryKnowledge/src/mcp/tools.js";
export { callApi, type HttpClientOptions } from "../../../../MemoryKnowledge/src/mcp/http-client.js";
