/**
 * Gateway config for the diskless Postgres form: STORE_MODE=postgres selects
 * rowfs + pgfs, moves the core's own store to postgres, turns the L0 JSONL
 * mirror off; each stays overridable. Other store modes keep upstream defaults.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGatewayConfig, resolveL0JsonlMirror, usesLocalDataDir } from "./config.js";

const dirs: string[] = [];

function load(env: Record<string, string>, yaml = "deployMode: standalone\nmemory:\n  storeBackend: sqlite\n") {
  const dir = mkdtempSync(path.join(tmpdir(), "gw-cfg-"));
  dirs.push(dir);
  const file = path.join(dir, "gw.yaml");
  writeFileSync(file, yaml);
  vi.stubEnv("TDAI_GATEWAY_CONFIG", file);
  vi.stubEnv("TDAI_DATA_DIR", dir);
  for (const k of ["STORE_MODE", "FILE_STORE_MODE", "FILE_STORE_OTHERS", "TDAI_L0_JSONL_MIRROR"]) vi.stubEnv(k, "");
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  // vi.stubEnv("", …) leaves an empty string; the config treats unset only as undefined.
  for (const k of ["STORE_MODE", "FILE_STORE_MODE", "FILE_STORE_OTHERS", "TDAI_L0_JSONL_MIRROR"]) {
    if (process.env[k] === "") delete process.env[k];
  }
  return loadGatewayConfig();
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("diskless postgres gateway config", () => {
  it("STORE_MODE=postgres: rowfs + pgfs, postgres core store, no L0 mirror, no local data dir", () => {
    const cfg = load({ STORE_MODE: "postgres" });
    expect(cfg.data).toMatchObject({ fileStore: "rowfs", fileStoreOthers: "pgfs", l0JsonlMirror: false });
    expect(cfg.memory.storeBackend).toBe("postgres");
    expect(cfg.memory.capture.l0JsonlMirror).toBe(false);
    expect(usesLocalDataDir(cfg.data, "postgres")).toBe(false);
  });

  it("each part stays overridable", () => {
    const cfg = load({ STORE_MODE: "postgres", FILE_STORE_MODE: "local", TDAI_L0_JSONL_MIRROR: "on" });
    expect(cfg.data).toMatchObject({ fileStore: "local", l0JsonlMirror: true });
    expect(usesLocalDataDir(cfg.data, "postgres")).toBe(true);

    const yamlMirror = load(
      { STORE_MODE: "postgres" },
      "deployMode: standalone\ndata:\n  l0JsonlMirror: true\n  fileStoreOthers: local\n",
    );
    expect(yamlMirror.data).toMatchObject({ fileStore: "rowfs", fileStoreOthers: "local", l0JsonlMirror: true });
    expect(usesLocalDataDir(yamlMirror.data, "postgres")).toBe(true);
  });

  it("other store modes keep the upstream defaults", () => {
    const cfg = load({});
    expect(cfg.data).toMatchObject({ fileStore: "local", fileStoreOthers: "local", l0JsonlMirror: true });
    expect(cfg.memory.storeBackend).toBe("sqlite");
    expect(usesLocalDataDir(cfg.data, undefined)).toBe(true);
  });

  it("resolveL0JsonlMirror parses on/off and rejects anything else", () => {
    expect(resolveL0JsonlMirror(undefined, "postgres")).toBe(false);
    expect(resolveL0JsonlMirror(undefined, "mongodb")).toBe(true);
    expect(resolveL0JsonlMirror("ON", "postgres")).toBe(true);
    expect(resolveL0JsonlMirror("0")).toBe(false);
    expect(resolveL0JsonlMirror(false)).toBe(false);
    expect(() => resolveL0JsonlMirror("sometimes")).toThrow(/TDAI_L0_JSONL_MIRROR/);
  });
});
