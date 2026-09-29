/**
 * personal-key-auth: config parsing, identity pinning and key/membership resolution
 * against a real (in-memory SQLite) metadata store.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteMetadataStore } from "../metadata/store/sqlite-adapter.js";
import {
  bearerToken,
  enforcePersonalIdentity,
  looksLikePersonalKey,
  PersonalKeyResolver,
  readPersonalKeyConfig,
  type IdentitySource,
} from "./personal-key-auth.js";

const ALICE = { instanceId: "default", userId: "usr-alice" };

describe("readPersonalKeyConfig", () => {
  it("defaults keep upstream behaviour for the shared key", () => {
    expect(readPersonalKeyConfig({})).toEqual({ enabled: true, sharedKeyMode: "trusted", cacheTtlMs: 30_000 });
  });

  it("parses explicit values and rejects bad ones", () => {
    expect(readPersonalKeyConfig({ TDAI_GATEWAY_SHARED_KEY_MODE: "OFF", TDAI_GATEWAY_PERSONAL_KEY_CACHE_MS: "0" })).toEqual(
      { enabled: true, sharedKeyMode: "off", cacheTtlMs: 0 },
    );
    expect(readPersonalKeyConfig({ TDAI_GATEWAY_PERSONAL_KEYS: "off" }).enabled).toBe(false);
    expect(() => readPersonalKeyConfig({ TDAI_GATEWAY_SHARED_KEY_MODE: "maybe" })).toThrow(/SHARED_KEY_MODE/);
    expect(() =>
      readPersonalKeyConfig({ TDAI_GATEWAY_SHARED_KEY_MODE: "off", TDAI_GATEWAY_PERSONAL_KEYS: "false" }),
    ).toThrow(/needs personal keys/);
  });

  it("recognises bearer tokens and key shape", () => {
    expect(bearerToken("Bearer sk-mem-abc ")).toBe("sk-mem-abc");
    expect(bearerToken("Basic x")).toBe("");
    expect(bearerToken(undefined)).toBe("");
    expect(looksLikePersonalKey("sk-mem-abc")).toBe(true);
    expect(looksLikePersonalKey("sk-mem-")).toBe(false);
    expect(looksLikePersonalKey("shared-secret")).toBe(false);
  });
});

describe("enforcePersonalIdentity", () => {
  const member = async (team: string) => team === "team-a";

  it("fills a missing user_id from the key and pins headers", async () => {
    const headers: Record<string, string | string[] | undefined> = {};
    const res = await enforcePersonalIdentity({ team_id: "team-a", agent_id: "x" }, headers, ALICE, member);
    expect(res).toEqual({ ok: true, body: { team_id: "team-a", agent_id: "x", user_id: "usr-alice" } });
    expect(headers).toMatchObject({ "x-tdai-user-id": "usr-alice", "x-tdai-team-id": "team-a" });
  });

  it("accepts the key's own user_id", async () => {
    const res = await enforcePersonalIdentity({ team_id: "team-a", user_id: "usr-alice" }, {}, ALICE, member);
    expect(res.ok).toBe(true);
  });

  it("rejects a spoofed user_id in the body or in x-tdai-user-id with 403", async () => {
    const spoofBody = await enforcePersonalIdentity({ team_id: "team-a", user_id: "usr-bob" }, {}, ALICE, member);
    expect(spoofBody).toMatchObject({ ok: false, status: 403 });
    const spoofHeader = await enforcePersonalIdentity(
      { team_id: "team-a" },
      { "x-tdai-user-id": "usr-bob" },
      ALICE,
      member,
    );
    expect(spoofHeader).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects a foreign team with 403 and a missing team with 422", async () => {
    expect(await enforcePersonalIdentity({ team_id: "team-b" }, {}, ALICE, member)).toMatchObject({ ok: false, status: 403 });
    expect(await enforcePersonalIdentity({}, { "x-tdai-team-id": "team-b" }, ALICE, member)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await enforcePersonalIdentity({}, {}, ALICE, member)).toMatchObject({ ok: false, status: 422 });
  });

  it("rejects ambiguous or malformed identity fields with 400", async () => {
    expect(
      await enforcePersonalIdentity({ team_id: "team-a" }, { "x-tdai-team-id": "team-b" }, ALICE, member),
    ).toMatchObject({ ok: false, status: 400 });
    expect(await enforcePersonalIdentity({ team_id: 7 }, {}, ALICE, member)).toMatchObject({ ok: false, status: 400 });
    expect(await enforcePersonalIdentity([1], {}, ALICE, member)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("PersonalKeyResolver (sqlite metadata store)", () => {
  let store: SqliteMetadataStore;
  let source: IdentitySource;
  let calls = 0;

  beforeEach(() => {
    store = new SqliteMetadataStore(":memory:");
    store.init();
    calls = 0;
    source = {
      verifyAuth: async (key) => {
        calls += 1;
        return store.getUserByKey(key);
      },
      isConfiguredMemorySystemUserKey: (key) => key === "sk-mem-system",
      rawStore: store,
    };
  });

  afterEach(() => store.close());

  it("resolves an active key to its user, caches it, and checks active membership", async () => {
    const alice = store.createUser({ auth_provider: "local", external_id: "a", username: "alice", default_key_value: "sk-mem-alice" });
    const bob = store.createUser({ auth_provider: "local", external_id: "b", username: "bob" });
    const teamA = store.createTeam({ name: "A", owner_user_id: alice.user_id });
    const teamB = store.createTeam({ name: "B", owner_user_id: bob.user_id });
    const resolver = new PersonalKeyResolver(async () => source, 60_000);

    const id = await resolver.resolve("default", "sk-mem-alice");
    expect(id).toEqual({ instanceId: "default", userId: alice.user_id });
    await resolver.resolve("default", "sk-mem-alice");
    expect(calls).toBe(1);

    expect(await resolver.isActiveMember(id!, teamA.team_id)).toBe(true);
    expect(await resolver.isActiveMember(id!, teamB.team_id)).toBe(false);
    expect(await resolver.isActiveMember(id!, "team-missing")).toBe(false);
  });

  it("refuses unknown, revoked, inactive-user and system keys", async () => {
    const carol = store.createUser({ auth_provider: "local", external_id: "c", username: "carol", default_key_value: "sk-mem-carol" });
    const resolver = new PersonalKeyResolver(async () => source, 0);
    expect(await resolver.resolve("default", "sk-mem-unknown")).toBeNull();
    expect(await resolver.resolve("default", "sk-mem-system")).toBeNull();
    expect(await resolver.resolve("default", "not-a-personal-key")).toBeNull();

    store.updateUser(carol.user_id, { status: "inactive" });
    expect(await resolver.resolve("default", "sk-mem-carol")).toBeNull();
    store.updateUser(carol.user_id, { status: "active" });
    expect(await resolver.resolve("default", "sk-mem-carol")).not.toBeNull();
    store.revokeAllUserKeysForUser(carol.user_id);
    expect(await resolver.resolve("default", "sk-mem-carol")).toBeNull();
  });

  it("a removed membership is not membership", async () => {
    const dave = store.createUser({ auth_provider: "local", external_id: "d", username: "dave", default_key_value: "sk-mem-dave" });
    const owner = store.createUser({ auth_provider: "local", external_id: "o", username: "owner" });
    const team = store.createTeam({ name: "T", owner_user_id: owner.user_id });
    store.addTeamMember({ team_id: team.team_id, user_id: dave.user_id, status: "removed" });
    const resolver = new PersonalKeyResolver(async () => source, 0);
    const id = await resolver.resolve("default", "sk-mem-dave");
    expect(await resolver.isActiveMember(id!, team.team_id)).toBe(false);
  });
});
