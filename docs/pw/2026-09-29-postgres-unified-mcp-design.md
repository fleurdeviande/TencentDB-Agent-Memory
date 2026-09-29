# pw: PostgreSQL (+pgvector) for the whole stack, one MCP for Claude Code — design

Agreed in chat on 2026-09-29. Scope of the `pw/main` fork on top of upstream `feat/server_team`.

## Decisions

- **One database for everything: PostgreSQL with pgvector**, not Postgres + Qdrant. Rows, full-text
  search and vectors live in one transactional store, so L0/L1 rows and their vectors cannot drift.
- Postgres runs **in a container** (`pgvector/pgvector:pg17`) next to the services — dev compose now,
  the `devops` namespace in NUE later.
- **Embeddings from the existing Ollama** through the upstream OpenAI-compatible provider
  (`/v1/embeddings`); model and endpoint are configuration, filled in later.
- **One MCP server** for Claude Code: memory tools (from upstream PR #1268's plugin) and the
  Wiki/Code-Graph tools (`knowledge-mcp`) behind a single `claude mcp add`. Hooks stay as in #1268.
- Private GitLab repos in Code-Graph (upstream #1502, already merged): tested later.
- The proxy (MemoryProxy) is not used; its own SQLite stays untouched.

## Architecture

```
Claude Code ──hooks──▶ pw-mcp (stdio) ──HTTP──▶ MemoryCore :8420 ──▶ Postgres (memory, skills, users/teams, audit, pgvector)
            ──MCP────▶        │         ──HTTP──▶ MemoryKnowledge :8424 ──▶ Postgres (wiki + code-graph metadata)
                              │                                        └──▶ volume (code-graph index files)
                              └─ embeddings / LLM are server-side: Ollama /v1/embeddings, GLM via litellm
```

### MemoryCore: a `postgres` store backend

A new `DbKind` value `postgres`, selected by `MEMORY_CORE_STORE_MODE=postgres`, alongside
`sqlite`/`tcvdb`/`mongodb`. Implemented under `MemoryCore/src/core/store/postgres/`:

| file | implements | modelled on |
|---|---|---|
| `client.ts` | `pg.Pool` from `POSTGRES_URL`, migrations run at init | `mongodb/client-pool.ts` |
| `schema.sql` / `migrations/` | tables for L0, L1, L2/L3 profiles, teams, users, agents, tasks, knowledge refs, audit; `tsvector` + GIN for FTS; `vector(N)` + HNSW for embeddings | `sqlite/memory-store.ts` DDL |
| `memory-store.ts` | `IMemoryStore` | `sqlite/memory-store.ts` |
| `skill-store.ts` | `ISkillStore` | `sqlite/skill-store.ts` |

- **FTS**: upstream builds keyword queries with jieba tokenisation (`buildFtsQuery`). Postgres stores
  the same pre-tokenised text in a `tsvector` with the `simple` config, so Chinese and English
  both work without a Postgres dictionary; ranking with `ts_rank_cd`.
- **Vectors**: `vector(dimensions)` from the embedding config; the dimension is fixed per install and
  checked at init (mismatch → degraded, the same contract the sqlite store uses).
- **Isolation** (team/agent/user) is pushed down into `WHERE` clauses, as the contract requires.
- **Correctness bar**: the upstream contract suite `__contract__/memory-store.contract.ts` must pass
  for `postgres` (and, as a baseline, for `sqlite` — no backend runs it today).

### MemoryKnowledge: drizzle on Postgres

Metadata is drizzle ORM on better-sqlite3 today. Add a Postgres dialect selected by
`KNOWLEDGE_DB_URL=postgres://…`; SQLite stays the default so upstream behaviour does not change.
Code-Graph index files stay on a volume.

### pw-mcp: the single MCP server

New package `pw/mcp` (TypeScript, stdio):

- memory tools — re-exported from `MemoryCore/claude-code-plugin` (#1268);
- knowledge tools — the 12 `code_*` / `wiki_*` tools from `MemoryKnowledge/src/mcp/tools.ts`, called
  over HTTP;
- one config: `TDAI_URL`, `KNOWLEDGE_URL`, one user key;
- hooks (`UserPromptSubmit`, `Stop`) unchanged from #1268, installed by the same `install` script.

## Delivery order

1. Dev compose: Postgres+pgvector, MemoryCore, MemoryKnowledge (Ollama endpoint via env).
2. Contract harness for sqlite (baseline) → Postgres `IMemoryStore` until the contract is green.
3. Postgres `ISkillStore`.
4. MemoryKnowledge Postgres dialect.
5. pw-mcp, wired to a local stack, used from Claude Code.
6. Chart for the `devops` namespace (separate repo), then GitLab private-repo test.

Each step is its own commit on `pw/main`; backend work is shaped so it can be offered upstream as PRs.

## Out of scope

MemoryProxy, TCVDB/COS/Shark, multi-replica Redis mode, Qdrant.
