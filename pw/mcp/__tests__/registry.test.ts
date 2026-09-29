import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadPwConfig } from "../src/config.js";
import { buildRegistry, type ToolBackend } from "../src/registry.js";
import { combinedInstructions, createPwServer, type BackendFactory } from "../src/server.js";
import { connectClient, text } from "./helpers.js";

function tool(name: string): Tool {
  return { name, inputSchema: { type: "object", properties: {} } };
}

function backend(name: string, tools: string[], extra: Partial<ToolBackend> = {}): ToolBackend {
  return {
    name,
    listTools: async () => tools.map(tool),
    callTool: async (toolName) => ({ content: [{ type: "text", text: `${name}:${toolName}` }] }),
    ...extra,
  };
}

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { HOME: "/nonexistent", PW_MEMORY_CONFIG: "/nonexistent/config.json", ...values };
}

describe("buildRegistry", () => {
  it("routes calls to the backend that owns the tool", async () => {
    const registry = await buildRegistry([backend("a", ["x"]), backend("b", ["y"])], () => {});
    expect(registry.tools.map((t) => t.name)).toEqual(["x", "y"]);
    expect(text(await registry.call("y", {}))).toBe("b:y");
    expect(await registry.call("nope", {})).toMatchObject({ isError: true });
  });

  it("keeps the first owner on a collision and reports it", async () => {
    const log = vi.fn();
    const registry = await buildRegistry([backend("a", ["x", "same"]), backend("b", ["same", "y"])], log);
    expect(registry.tools.map((t) => t.name)).toEqual(["x", "same", "y"]);
    expect(registry.collisions).toEqual([{ tool: "same", kept: "a", dropped: "b" }]);
    expect(registry.ownerOf("same")).toBe("a");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("collision: same"));
  });

  it("skips a backend whose listing fails and turns thrown calls into tool errors", async () => {
    const log = vi.fn();
    const broken = backend("broken", [], { listTools: async () => { throw new Error("down"); } });
    const throwing = backend("t", ["boom"], { callTool: async () => { throw new Error("kaput"); } });
    const registry = await buildRegistry([broken, throwing], log);
    expect(registry.tools.map((t) => t.name)).toEqual(["boom"]);
    expect(log).toHaveBeenCalledWith("broken tools unavailable: down");
    const result = await registry.call("boom", {});
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("Error: kaput");
  });
});

describe("createPwServer", () => {
  it("still starts when a backend factory throws", async () => {
    const log = vi.fn();
    const failing: BackendFactory = async () => { throw new Error("bad config"); };
    const ok: BackendFactory = async () => backend("ok", ["t1"]);
    const { server } = await createPwServer(loadPwConfig(env({})), [failing, ok], log);
    const { client, close } = await connectClient(server);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["t1"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("bad config"));
    await close();
  });

  it("combines instructions statically", () => {
    expect(combinedInstructions([backend("a", [], { instructions: () => "A" }), backend("b", [], { instructions: () => "B" })])).toBe("A\n\nB");
    expect(combinedInstructions([])).toMatch(/no backend configured/);
  });
});
