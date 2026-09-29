/** stderr-only logging: stdout belongs to the MCP protocol and to hook output. */

export type Log = (message: string) => void;

export function stderrLog(tag = "pw-memory"): Log {
  return (message) => process.stderr.write(`[${tag}] ${message}\n`);
}

/** URL for logs: scheme, host, port and path, never userinfo or query. */
export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

export function maskSecret(value: string | undefined): string {
  if (!value) return "(unset)";
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}****${value.slice(-2)}`;
}
