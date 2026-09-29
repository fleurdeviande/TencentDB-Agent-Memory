# pw-memory 🧠 — one MCP server for team memory + code knowledge

One stdio MCP server for Claude Code that gives you **both**:

- the memory tools and lifecycle hooks of the native Claude Code plugin (upstream PR #1268,
  `MemoryCore/claude-code-plugin/`): recall before every prompt, capture after every turn;
- the 12 `code_*` / `wiki_*` tools of MemoryKnowledge (`MemoryKnowledge/src/mcp/tools.ts`).

Configured once, installed with one command. The upstream code is compiled in from source (esbuild bundle),
not copied, so an upstream fix lands here with the next build.

## Installation 🚀

Node 22 is required, like everywhere else in this repo.

```bash
cd TencentDB-Agent-Memory/pw/mcp && npx -y pnpm@9 install --ignore-workspace && npm run build
export TDAI_URL=https://memory.example.corp KNOWLEDGE_URL=https://knowledge.example.corp TDAI_USER_KEY=sk-mem-... TDAI_USER_ID=$USER
node dist/cli.js install          # add --dry-run first if you like to look before you leap
```

That is it. Restart Claude Code, run `/mcp` (expect `pw-memory` with 18 tools) and `/hooks`
(expect `UserPromptSubmit`, `Stop`, `SessionEnd`).

What `install` does, all at user scope:

| step | where | note |
|---|---|---|
| config file | `~/.config/pw-memory/config.json`, mode 0600 | env values merged over what the file already holds; the only place the key is stored |
| MCP registration | `claude mcp add --scope user pw-memory -- <node> dist/server.js` | no `-e`, so the key stays out of `~/.claude.json` |
| hooks | `~/.claude/settings.json` | `<node> dist/cli.js pw-memory-hook` on UserPromptSubmit (5 s), Stop (15 s), SessionEnd (30 s); foreign hooks untouched, backup in `settings.json.pw-memory.bak` |

`<node>` is the absolute path of the node that ran `install` (so an nvm `PATH` change does not break
hooks); pass `--node /path/to/node` to choose another. If you remove that Node version later, re-run install.

Remove everything again:

```bash
node dist/cli.js uninstall --purge   # --purge also deletes the config file; --dry-run works here too
```

## Configuration ⚙️

Environment wins over the config file, key by key, so a shell (or direnv) can override anything.

| variable | required | meaning |
|---|---|---|
| `TDAI_URL` | for memory | MemoryCore gateway. Unset → memory tools and hooks are off |
| `KNOWLEDGE_URL` | for knowledge | MemoryKnowledge. Unset → `code_*` / `wiki_*` are off |
| `TDAI_USER_KEY` | yes, in practice | Bearer for the gateway; also for MemoryKnowledge unless `KNOWLEDGE_API_TOKEN` is set |
| `KNOWLEDGE_API_TOKEN` | no | MemoryKnowledge service key, when it differs from the user key |
| `TDAI_USER_ID` | recommended | your user id in the isolation triple; unset means `default` (shared with everyone else who left it unset) |
| `TDAI_TEAM_ID` / `TDAI_AGENT_ID` / `TDAI_SERVICE_ID` | no | rest of the isolation triple and the instance id, default `default` |
| `PW_MEMORY_CONFIG` | no | alternative config file path |

The #1268 tuning knobs (`TDAI_RECALL_MAX_RESULTS`, `TDAI_CAPTURE`, `TDAI_STOP_BUDGET_MS`, …) pass through
unchanged; see `MemoryCore/claude-code-plugin/README.md`.

Either half may be missing: the server still starts, logs which half is disabled to stderr, and lists only the
tools it has. With nothing configured it starts with zero tools rather than breaking Claude Code's startup.

## Usage 🛠️

Once installed there is nothing to call by hand: recall happens before each prompt, capture after each turn,
and the model picks the tools itself. Handy checks:

```bash
# what the server would expose, without Claude Code
node dist/server.js </dev/null            # stderr: enabled halves and the tool list

# a hook by hand
printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"demo","prompt_id":"p1","cwd":"/tmp","prompt":"how do we deploy?"}' \
  | node dist/cli.js pw-memory-hook       # {} or {"hookSpecificOutput":{"additionalContext":...}}

# everything end to end against local MemoryCore + MemoryKnowledge (needs their node_modules)
npm run smoke                             # prints SMOKE OK
```

## Tools (API) 📚

18 tools with both halves on. Names do not collide; MemoryKnowledge keeps its upstream names, the plugin's are
already namespaced `tdai_`.

| tool | from | what |
|---|---|---|
| `code_search`, `code_explore`, `code_callers`, `code_callees`, `code_impact`, `code_node`, `code_status`, `code_files` | MemoryKnowledge | code-graph queries (`cg-...` ids) |
| `wiki_search`, `wiki_read`, `wiki_list`, `wiki_graph` | MemoryKnowledge | wiki search, pages, page list, link graph (`wiki-...` ids) |
| `tdai_memory_search` | #1268 | L1 structured memories |
| `tdai_conversation_search` | #1268 | L0 raw conversation, including captured tool traffic |
| `tdai_scenario_read` | #1268 | one L2 scene block |
| `tdai_memory_capture` | #1268 | write a milestone into L0 |
| `tdai_wiki_list` | #1268 | list wikis (needs both halves; MemoryKnowledge has no such tool) |
| `tdai_wiki_write` | #1268 | create/update wiki pages (needs both halves) |

Dropped on purpose when MemoryKnowledge is on: `tdai_wiki_search`, `tdai_wiki_pages`, `tdai_wiki_read` — exact
duplicates of `wiki_search`, `wiki_list`, `wiki_read`. Two tools doing one job only teach the model to hesitate.

Errors come back as MCP tool errors (`isError: true`), never as a crashed server: an unknown code graph is
`Knowledge /v3/code-graph/status returned HTTP 404`, a down gateway is `fetch failed`.

## Prompt caching 💸

Nothing here edits the system prompt between turns:

- the tool list and the server `instructions` are computed once at startup and never change (no
  `list_changed`), so the tool block of the prompt is byte-identical for the whole session;
- recall is returned as `hookSpecificOutput.additionalContext`, which Claude Code attaches to **that turn's
  user message**; earlier turns stay a stable, cacheable prefix.

How often the injected block changes:

| block | sent | changes |
|---|---|---|
| `<user-persona>`, `<scene-navigation>`, `<memory-tools-guide>` | first prompt of a session only (retried on the next prompt if every recall call failed) | only when the L3 persona or L2 scene index changes server-side; byte-identical across sessions otherwise (tested) |
| `<relevant-memories>` | every prompt with L1 hits | per prompt — it is the search result for that prompt; nothing when there are no hits |

The guide's wiki line is rewritten to MemoryKnowledge's tool names by a fixed string substitution, so it stays
deterministic.

## How it is built 🔩

```text
src/entry/server.ts ─ serve ─┬─ knowledge backend: MemoryKnowledge MCP_TOOLS + plugin KnowledgeServiceClient
                             └─ memory backend: plugin createClaudeCodeMcpServer via InMemoryTransport
src/entry/cli.ts ── install | uninstall | pw-memory-hook (plugin handleHook) | serve
```

- Shared deps (MCP SDK, memory SDK, zod) resolve from `pw/mcp/node_modules` only (tsc `paths`, vite `dedupe`,
  an esbuild plugin), so the upstream packages need no install of their own and the bundle holds one copy.
- `stdio-guard.ts` sends `console.log/info/debug` to stderr: stdout carries JSON-RPC (server) or the hook reply.

```bash
npm run typecheck && npm test && npm run build
```

No secrets in logs: URLs are logged without userinfo or query, keys never; `install --dry-run` masks the key.
