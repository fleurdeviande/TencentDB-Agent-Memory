import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

export interface FakeService {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** JSON-over-POST service answering `{code: 0, data}` from a per-path table; unknown paths get code 404. */
export async function fakeService(routes: Record<string, unknown>): Promise<FakeService> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const path = req.url ?? "";
      requests.push({ path, headers: req.headers, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
      const known = path in routes;
      res.writeHead(known ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(known ? { code: 0, message: "ok", data: routes[path] } : { code: 404, message: `no route ${path}`, data: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function connectClient(server: Server): Promise<{ client: Client; close(): Promise<void> }> {
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

export function text(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}
