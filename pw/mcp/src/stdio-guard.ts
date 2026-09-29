/**
 * Import first in every entry point. MemoryKnowledge's logger writes debug/info with console.log,
 * i.e. to stdout, which would corrupt the JSON-RPC stream (MCP) or the hook's JSON reply.
 */

process.env.LOG_LEVEL ??= "warn";

const toStderr = (...args: unknown[]): void => console.error(...args);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

export {};
