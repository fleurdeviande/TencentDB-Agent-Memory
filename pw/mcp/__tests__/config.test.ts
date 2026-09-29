import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfigPath, loadPwConfig, mergeValues, readConfigFile } from "../src/config.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-config-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { HOME: dir, PW_MEMORY_CONFIG: path.join(dir, "config.json"), ...values };
}

describe("loadPwConfig", () => {
  it("disables both halves when nothing is set, with a note for each", () => {
    const config = loadPwConfig(env({}));
    expect(config.memory).toBeUndefined();
    expect(config.knowledge).toBeUndefined();
    expect(config.notes.join("\n")).toMatch(/memory tools and hooks disabled: TDAI_URL is unset/);
    expect(config.notes.join("\n")).toMatch(/knowledge tools .* disabled: KNOWLEDGE_URL is unset/);
  });

  it("enables each half independently", () => {
    expect(loadPwConfig(env({ TDAI_URL: "http://gw:8420/" }))).toMatchObject({ memory: { url: "http://gw:8420" }, knowledge: undefined });
    expect(loadPwConfig(env({ KNOWLEDGE_URL: "http://kn:8424" }))).toMatchObject({ memory: undefined, knowledge: { url: "http://kn:8424" } });
  });

  it("maps pw names onto the plugin's names and drops stale plugin-only settings", () => {
    const config = loadPwConfig(env({
      TDAI_URL: "http://gw:8420",
      KNOWLEDGE_URL: "http://kn:8424",
      TDAI_USER_KEY: "sk-mem-aaaaaaaaaaaaaaaa",
      TDAI_USER_ID: "u1",
      TDAI_API_KEY: "stale",
      TDAI_RECALL_MAX_RESULTS: "7",
    }));
    expect(config.pluginEnv).toMatchObject({
      TDAI_GATEWAY_URL: "http://gw:8420",
      TDAI_GATEWAY_API_KEY: "sk-mem-aaaaaaaaaaaaaaaa",
      TDAI_KNOWLEDGE_URL: "http://kn:8424",
      TDAI_KNOWLEDGE_API_KEY: "sk-mem-aaaaaaaaaaaaaaaa",
      TDAI_USER_ID: "u1",
      TDAI_RECALL_MAX_RESULTS: "7",
    });
    expect(config.pluginEnv.TDAI_API_KEY).toBeUndefined();
    expect(config.knowledge?.token).toBe("sk-mem-aaaaaaaaaaaaaaaa");
  });

  it("prefers KNOWLEDGE_API_TOKEN for the knowledge half", () => {
    const config = loadPwConfig(env({ KNOWLEDGE_URL: "http://kn", TDAI_USER_KEY: "user", KNOWLEDGE_API_TOKEN: "service" }));
    expect(config.knowledge?.token).toBe("service");
  });

  it("treats non-http URLs as unset instead of failing", () => {
    const config = loadPwConfig(env({ TDAI_URL: "gw:8420", KNOWLEDGE_URL: "file:///etc/passwd" }));
    expect(config.memory).toBeUndefined();
    expect(config.knowledge).toBeUndefined();
    expect(config.notes.filter((note) => note.includes("not an http(s) URL"))).toHaveLength(2);
  });

  it("reads the config file, env winning key by key", () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ TDAI_URL: "http://file-gw", KNOWLEDGE_URL: "http://file-kn", TDAI_USER_KEY: "file-key", OTHER: "x" }));
    const config = loadPwConfig(env({ TDAI_URL: "http://env-gw" }));
    expect(config.memory?.url).toBe("http://env-gw");
    expect(config.knowledge?.url).toBe("http://file-kn");
    expect(config.userKey).toBe("file-key");
    expect(config.configFile).toBe(path.join(dir, "config.json"));
  });

  it("never puts secrets into notes", () => {
    const config = loadPwConfig(env({ TDAI_URL: "http://user:pw@gw:8420/?token=abc", TDAI_USER_KEY: "sk-mem-SECRET" }));
    const notes = config.notes.join("\n");
    expect(notes).not.toMatch(/SECRET|pw@|token=abc/);
    expect(notes).toContain("http://gw:8420");
  });
});

describe("config file", () => {
  it("ignores malformed files with a note", () => {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{ nope");
    const notes: string[] = [];
    expect(readConfigFile(file, notes)).toEqual({});
    expect(notes[0]).toMatch(/not valid JSON/);
    expect(readConfigFile(path.join(dir, "missing.json"), notes)).toEqual({});
    expect(notes).toHaveLength(1);
  });

  it("treats empty env values as unset", () => {
    expect(mergeValues({ TDAI_URL: " " }, { TDAI_URL: "http://file" })).toEqual({ TDAI_URL: "http://file" });
  });

  it("defaults to XDG config dir", () => {
    expect(defaultConfigPath({ HOME: "/h" })).toBe("/h/.config/pw-memory/config.json");
    expect(defaultConfigPath({ HOME: "/h", XDG_CONFIG_HOME: "/x" })).toBe("/x/pw-memory/config.json");
  });
});
