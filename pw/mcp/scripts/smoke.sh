#!/usr/bin/env bash
# Local end-to-end smoke test for pw-memory: MemoryCore (standalone, SQLite) and MemoryKnowledge on free
# ports, LLM/embedding pointed at an unreachable endpoint, then the built server driven over stdio, the
# hook entry fed real payloads, and install/uninstall run against a throwaway HOME with a stub `claude`.
#
# Needs Node 22 and deps installed in MemoryCore, MemoryKnowledge and pw/mcp
# (`npx -y pnpm@9 install --ignore-workspace`, MemoryCore also `--config.auto-install-peers=false`).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pw-smoke.XXXXXX")"
KEY="sk-mem-smoke$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
STUB_LLM="http://127.0.0.1:9/v1"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 22 ? 0 : 1)' || fail "Node 22 required, got $(node -v)"
for dir in "$ROOT/MemoryCore" "$ROOT/MemoryKnowledge" "$HERE"; do
  [ -d "$dir/node_modules" ] || fail "no node_modules in $dir"
done

free_port() { node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
wait_health() {
  for _ in $(seq 1 60); do curl -sf "$1/health" >/dev/null && return 0; sleep 1; done
  fail "$1/health did not come up (logs in $WORK)"
}

echo "== build"
(cd "$HERE" && node build.mjs >/dev/null)

CORE_PORT="$(free_port)"
KN_PORT="$(free_port)"
CORE_URL="http://127.0.0.1:$CORE_PORT"
KN_URL="http://127.0.0.1:$KN_PORT"

echo "== start MemoryCore (sqlite) on :$CORE_PORT, MemoryKnowledge on :$KN_PORT"
(cd "$ROOT/MemoryCore" && \
  TDAI_GATEWAY_CONFIG="$PWD/tdai-gateway.standalone.yaml" TDAI_GATEWAY_PORT="$CORE_PORT" TDAI_DATA_DIR="$WORK/core" \
  TDAI_LLM_BASE_URL="$STUB_LLM" TDAI_LLM_API_KEY=stub TDAI_GATEWAY_API_KEY="$KEY" \
  exec node --import tsx src/gateway/server.ts >"$WORK/core.log" 2>&1) &
PIDS+=($!)
(cd "$ROOT/MemoryKnowledge" && \
  PORT="$KN_PORT" KNOWLEDGE_DATA_DIR="$WORK/kn" KNOWLEDGE_DB_PATH="$WORK/kn/knowledge.db" KNOWLEDGE_SERVICE_KEY="$KEY" \
  LLM_MODE=custom LLM_BASE_URL="$STUB_LLM" LLM_API_KEY=stub LOG_LEVEL=warn \
  exec ./node_modules/.bin/tsx src/server.ts >"$WORK/kn.log" 2>&1) &
PIDS+=($!)
wait_health "$CORE_URL"
wait_health "$KN_URL"

KNOWLEDGE_TOOLS="code_search,code_explore,code_callers,code_callees,code_impact,code_node,code_status,code_files,wiki_search,wiki_read,wiki_list,wiki_graph"
MEMORY_TOOLS="tdai_memory_search,tdai_conversation_search,tdai_scenario_read,tdai_memory_capture"

# Clean env: nothing from the caller's shell or real config file leaks in.
run_env() {
  env -i PATH="$PATH" HOME="$WORK/home" PW_MEMORY_CONFIG="$WORK/home/none.json" \
    TDAI_CLAUDE_CODE_STATE_DIR="$WORK/state" TDAI_USER_KEY="$KEY" TDAI_USER_ID=smoke "$@"
}
mcp_case() {
  local label="$1"; shift
  echo "== mcp: $label"
  run_env SMOKE_SERVER="$HERE/dist/server.js" "$@" node "$HERE/scripts/smoke-client.mjs" | tee "$WORK/mcp.json" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);for(const x of r.steps)console.log(`  ${x.pass?"PASS":"FAIL"} ${x.name} — ${x.detail.replace(/\s+/g," ").slice(0,160)}`)})'
  node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).ok?0:1)' "$WORK/mcp.json" || fail "mcp case: $label"
}

mcp_case "both halves" TDAI_URL="$CORE_URL" KNOWLEDGE_URL="$KN_URL" SMOKE_EXPECT_TOOLS="$KNOWLEDGE_TOOLS,$MEMORY_TOOLS,tdai_wiki_list,tdai_wiki_write"
mcp_case "memory only" TDAI_URL="$CORE_URL" SMOKE_EXPECT_TOOLS="$MEMORY_TOOLS"
mcp_case "knowledge only" KNOWLEDGE_URL="$KN_URL" SMOKE_EXPECT_TOOLS="$KNOWLEDGE_TOOLS"
mcp_case "nothing configured" SMOKE_EXPECT_TOOLS=""

echo "== hooks through dist/cli.js"
hook() { run_env TDAI_URL="$CORE_URL" KNOWLEDGE_URL="$KN_URL" node "$HERE/dist/cli.js" pw-memory-hook; }
FIRST="$(printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"smoke-s1","prompt_id":"p1","cwd":"/tmp","prompt":"how do we deploy?"}' | hook 2>"$WORK/hook.err")"
SECOND="$(printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"smoke-s1","prompt_id":"p2","cwd":"/tmp","prompt":"and rollback?"}' | hook 2>>"$WORK/hook.err")"
STOP="$(printf '%s' '{"hook_event_name":"Stop","session_id":"smoke-s1","prompt_id":"p2","cwd":"/tmp","last_assistant_message":"Rollback is docker start sglang-v516."}' | hook 2>>"$WORK/hook.err")"
node -e '
  const [first, second, stop] = process.argv.slice(1).map((s) => JSON.parse(s));
  const ctx = first.hookSpecificOutput?.additionalContext ?? "";
  const ok = ctx.includes("<memory-tools-guide>") && ctx.includes("wiki_search / wiki_read") && !ctx.includes("tdai_wiki_search")
    && !JSON.stringify(second).includes("<memory-tools-guide>") && JSON.stringify(stop) === "{}";
  console.log(`  ${ok ? "PASS" : "FAIL"} first prompt: stable block (${ctx.length} chars); second prompt: ${JSON.stringify(second).slice(0, 80)}; stop: ${JSON.stringify(stop)}`);
  process.exit(ok ? 0 : 1);
' "$FIRST" "$SECOND" "$STOP" || fail "hooks (stderr: $(cat "$WORK/hook.err"))"
grep -q "$KEY" "$WORK/hook.err" && fail "key leaked into hook stderr"
CAPTURED="$(curl -sf -X POST "$CORE_URL/v3/conversation/search" -H "Authorization: Bearer $KEY" -H "x-tdai-service-id: default" \
  -H "Content-Type: application/json" \
  -d '{"team_id":"default","agent_id":"default","user_id":"smoke","query":"sglang-v516","limit":5}')"
echo "$CAPTURED" | grep -q "sglang-v516" || fail "Stop capture not found in L0: $CAPTURED"
echo "  PASS Stop hook captured the turn (found in L0 via /v3/conversation/search)"

echo "== install / uninstall against a throwaway HOME with a stub claude"
mkdir -p "$WORK/home/.claude" "$WORK/bin"
echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done"}]}]}}' >"$WORK/home/.claude/settings.json"
printf '#!/bin/sh\necho "$@" >>"%s"\n' "$WORK/claude-calls.log" >"$WORK/bin/claude"
chmod +x "$WORK/bin/claude"
inst() {
  env -i PATH="$WORK/bin:$PATH" HOME="$WORK/home" TDAI_URL="$CORE_URL" KNOWLEDGE_URL="$KN_URL" TDAI_USER_KEY="$KEY" TDAI_USER_ID=smoke \
    node "$HERE/dist/cli.js" "$@"
}
inst install --dry-run >"$WORK/dry.txt"
[ ! -e "$WORK/claude-calls.log" ] && [ ! -e "$WORK/home/.config/pw-memory/config.json" ] || fail "dry run changed something"
grep -q "$KEY" "$WORK/dry.txt" && fail "dry run printed the key"
inst install >/dev/null
[ "$(stat -f '%Lp' "$WORK/home/.config/pw-memory/config.json" 2>/dev/null || stat -c '%a' "$WORK/home/.config/pw-memory/config.json")" = "600" ] || fail "config not 0600"
grep -q "mcp add --transport stdio --scope user pw-memory -- " "$WORK/claude-calls.log" || fail "claude mcp add not called"
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ours = ["UserPromptSubmit", "Stop", "SessionEnd"].every((e) => JSON.stringify(s.hooks[e] ?? []).includes("pw-memory-hook"));
  process.exit(ours && JSON.stringify(s.hooks.Stop).includes("say done") ? 0 : 1);
' "$WORK/home/.claude/settings.json" || fail "hooks not merged"
# The installed config alone (no URL env) must drive the hook.
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"smoke-s2","prompt_id":"p1","cwd":"/tmp","prompt":"x"}' \
  | env -i PATH="$PATH" HOME="$WORK/home" TDAI_CLAUDE_CODE_STATE_DIR="$WORK/state" node "$HERE/dist/cli.js" pw-memory-hook \
  | grep -q "memory-tools-guide" || fail "hook did not pick up the installed config file"
inst uninstall --purge >/dev/null
node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.exit(JSON.stringify(s) === JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }) ? 0 : 1);
' "$WORK/home/.claude/settings.json" || fail "uninstall left pw-memory hooks behind"
[ ! -e "$WORK/home/.config/pw-memory/config.json" ] || fail "--purge kept the config"
echo "  PASS dry run inert, config 0600, mcp add called, hooks merged and removed, config file drives hooks"

echo "SMOKE OK"
