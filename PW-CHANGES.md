# pw/main — what this fork adds on top of upstream

Base: `TencentCloud/TencentDB-Agent-Memory` branch `feat/server_team` at `8b86874` (2026-09-29).
Goal: team memory for Claude Code **without the proxy** — native hooks + MCP, private GitLab
repositories in Code-Graph, deployed self-hosted.

Every upstream PR is merged as its own merge commit (`merge upstream PR #N: …`), so when upstream
merges one, `git merge upstream/feat/server_team` resolves it and the commit can be dropped on the
next rebuild.

## Merged upstream PRs

| PR | what | notes |
|---|---|---|
| #1437 | StorePool does not cache a failed init | clean |
| #1172 | store init cache self-heals after failure / closed store | clean |
| #1173 | `recordIds` filter honoured in sqlite `queryL1Records` | clean |
| #1491 | `idx_l0_user_agent_ts` for L0 pagination | clean |
| #1184 | remote embeddings token-aware, bounded retries | its tests were written before `sqlite.ts` moved to `sqlite/memory-store.ts`; moved them in the #1185 merge |
| #1554 | security hardening: gateway errors, callbacks, Git sources, proxy forwarding | clean |
| #1268 | **native Claude Code plugin (hooks + MCP, no proxy)** — `MemoryCore/claude-code-plugin/` | clean; tsc + 17 tests green |
| #1185 | non-destructive embedding reindex, shadow migration | conflicts with #1184 resolved by keeping both: `/health` reports embedding health, vector coverage and migration state |
| #1344 | `sendDimensions` forwarded to the sqlite embedding service | its new `store-pool.test.ts` collided with #1437's → kept as `store-pool.send-dimensions.test.ts`; mock gained `init()`/`isDegraded()` |
| #1502 | **private repos for Code-Graph via managed git credentials** (HTTPS token / SSH key, AES-256-GCM, `KNOWLEDGE_GIT_ALLOWED_HOSTS`) | conflict with #1554 in `git-fetcher.ts`: took #1502's `git-url.ts` validation, kept the old SSRF cases as `git-fetcher.ssrf.test.ts` — all 79 source-fetcher tests pass |

## Deliberately not merged (yet)

- **#1518** (Code-Graph keeps the last-good index on refresh failure, +7.8k lines): extracts the build
  worker into `code-graph-worker.ts`, while #1502 adds credential resolution into the old inline
  worker — a semantic conflict across 8 files, and #1518 has no approval. Re-evaluate once upstream
  merges either PR. The attempted combination lives on the local branch `pw/attempt-with-1518`.
- **#1501**: competing private-repo implementation to #1502, unreviewed.
- **#1316, #1368**: alternative subscription hooks (Python / Codex, ZCode). #1268 targets Claude Code
  directly; borrow ideas (retry of failed writes from #1368) rather than merge.
- Everything proxy-, DSH-, WorkBuddy-, Pi- and Codex-specific: we do not run the proxy.

## Verification (Node 22)

| package | result |
|---|---|
| MemoryCore | vitest 27/27 |
| MemoryKnowledge | vitest 161/161 (upstream baseline; see the Postgres section for the current counts) |
| MemoryCore/claude-code-plugin | tsc clean, vitest 17/17 |

## Known issues inherited from upstream

- `MemoryKnowledge` `tsc --noEmit` fails in `src/middleware/response-envelope.ts:57`
  (`Promise<string>` vs `string` on `c.req.bodyCache.text`). The line is unchanged from upstream;
  the error comes from Hono 4.13 being pulled by the unpinned `^4.7.0` without a lockfile.
- Packages need **Node 22**: under Node 26 `better-sqlite3` has no prebuilt binary and `npm install`
  fails in node-gyp. `npm install` in MemoryKnowledge also trips on the workspace layout
  (`Cannot read properties of null (reading 'edgesOut')`); `pnpm install --ignore-workspace` works.

## MemoryKnowledge on Postgres (`pw/postgres-knowledge`)

### Inventory (before porting)

The metadata DB is one SQLite file (`KNOWLEDGE_DB_PATH`, default `./data/knowledge.db`) opened by
`src/db/client.ts#createDb` and wrapped in drizzle (`drizzle-orm/better-sqlite3`). Tables — all created
by the hand-written idempotent DDL in `migrate()`, mirrored in `src/db/schema.ts`:

| table | owner | notes |
|---|---|---|
| `knowledge_code_graph` | `SqliteKnowledgeStore` | partial unique `(service_id, team_id, repo_url, branch) WHERE deleted_at IS NULL` |
| `knowledge_wiki` | `SqliteKnowledgeStore` | partial unique `(service_id, team_id, name) WHERE deleted_at IS NULL` |
| `knowledge_wiki_audit`, `knowledge_code_graph_audit` | `SqliteKnowledgeStore` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| `knowledge_git_credential`, `knowledge_git_credential_audit` | `createGitCredentialStore` (#1502) | secrets AES-256-GCM in `secret_enc` |
| `llm_binding` | `createLlmBindingStore` | upsert via `onConflictDoUpdate`; DDL has an unused `model` column |

Column migrations: `addColumnIfMissing` (PRAGMA `table_info` + `ALTER TABLE ADD COLUMN`) for
`service_url`, `summary`, `credential_id` and the audit `service_id`s.

Call sites of the metadata DB — drizzle query builders only, no raw SQL besides the DDL:

- `src/store/sqlite-store.ts` — 23 methods, sync terminals `.get()` / `.all()` / `.run()` and
  `RunResult.changes`; two `sql` fragments (`count(*)`, `status IN ('pending','processing')`);
  unique-violation detection by SQLite error message.
- `src/store/git-credential-store.ts` — 10 methods, `.all()` / `.run()`, `count(*)`.
- `src/store/llm-binding-store.ts` — 4 methods, `.all()` / `.run()`, `onConflictDoUpdate`.
- No `raw.transaction`, `raw.prepare` or `raw.exec` outside `client.ts`; `server.ts` is the only
  place that opens the DB and keeps only `db`.

Consumers of those (all synchronous today): `WikiService`, `CodeGraphService`, `AutoSyncScheduler`,
`module.ts` (restart recovery), routes `wiki.ts`, `code-graph.ts`, `tools.ts`, `source-credential.ts`,
`llm-binding.ts`. The MCP server (`src/mcp/`) talks HTTP and never touches the DB.

Not part of the metadata DB and **not moved**: each wiki's own `index.db` (`src/engines/wiki/index-db.ts`:
FTS5 `wiki_fts`, `page_meta`, `graph_edge`, `source`) lives in the wiki's data directory next to its
`.md` files and is deleted with it — it is the wiki's search index, the same category as the
code-graph index files, and FTS5 has no drop-in Postgres equivalent.

### Abstraction

- **Async store interfaces.** `IKnowledgeStore`, `IGitCredentialStore`, `ILlmBindingStore` return
  promises; services and routes `await` them. node-postgres has no sync API, and a sync-over-async
  bridge (worker + `Atomics.wait`) would hide pool back-pressure. Service methods that touch the store
  become `async`; nothing else in them changes.
- **One store implementation per table group, two schemas.** `src/db/schema.ts` (sqlite-core, unchanged)
  and `src/db/schema.pg.ts` (pg-core) declare the same tables with the same JS property names and the
  same TEXT ISO timestamps, so row types are identical. `openKnowledgeDb()` returns
  `{ dialect, orm, tables, close }`; stores build queries against `tables` and `await` the builder
  instead of calling `.get()/.all()/.run()` — drizzle's builders are thenables on both drivers.
  Affected-row counts go through one helper (`RunResult.changes` vs `QueryResult.rowCount`),
  `count(*)` through `.mapWith(Number)` (pg returns bigint as string), unique violations are
  recognised by SQLSTATE `23505` as well as the SQLite message.
- **Client selection.** `KNOWLEDGE_DB_URL=postgres://…` → `drizzle-orm/node-postgres` on a `pg.Pool`;
  unset → exactly upstream's better-sqlite3 file at `KNOWLEDGE_DB_PATH`. `createDb()` keeps its sync
  SQLite signature for upstream compatibility.
- **Postgres migrations** are idempotent DDL run at startup inside one transaction under
  `pg_advisory_xact_lock`: `CREATE TABLE / INDEX IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`,
  audit ids as `BIGINT GENERATED BY DEFAULT AS IDENTITY`. Optional `KNOWLEDGE_DB_SCHEMA` puts the tables
  in their own schema (created if missing) so MemoryKnowledge can share a database with MemoryCore.

### Configuration

| key | default | meaning |
|---|---|---|
| `KNOWLEDGE_DB_URL` | empty | `postgres://…` / `postgresql://…` keeps all metadata in Postgres (drizzle node-postgres). Empty = upstream SQLite. Any other scheme fails at startup instead of silently falling back. |
| `KNOWLEDGE_DB_SCHEMA` | empty | Postgres schema for the tables, created if missing; empty = the connection's `search_path`. Must match `^[a-z_][a-z0-9_]{0,62}$`. |
| `KNOWLEDGE_DB_POOL_MAX` | `10` | `pg.Pool` size (1–100). |
| `KNOWLEDGE_DB_PATH` | `./data/knowledge.db` | unchanged; used only when `KNOWLEDGE_DB_URL` is empty. |
| `KNOWLEDGE_TEST_DB_URL` | empty | tests only: run the DB-backed suites on Postgres, one throw-away `kt_<pid>_<rand>` schema per test DB. |

Code-graph checkouts/indexes and each wiki's `index.db` stay under `KNOWLEDGE_DATA_DIR` on either dialect.

### What changed

- `src/db/schema.pg.ts`, `src/db/migrate-pg.ts`, `src/db/client-pg.ts` — Postgres twin schema, DDL, pool.
- `src/db/client.ts` — `openKnowledgeDb`, `KnowledgeDb`, `affectedRows`, `isUniqueViolation`; `createDb`/`migrate` untouched.
- Stores/services/routes/`module.ts`/`server.ts` — async (see Abstraction). `createApp()` and
  `createKnowledgeModule()` now return promises. Stores still accept upstream's `Db`, so
  `new SqliteKnowledgeStore(createDb(...).db)` keeps working. On shutdown the server stops the
  auto-sync scheduler and closes the DB.

### Results (Node 22)

| run | result |
|---|---|
| `npx vitest run` (SQLite) | 173 passed, 4 skipped (Postgres-only migration tests), exit 0 |
| `KNOWLEDGE_TEST_DB_URL=postgres://…/tdai_knowledge npx vitest run` | 177/177, exit 0; two runs in parallel also green |
| `tsc --noEmit` | only the known `response-envelope.ts:57` error |

173 = upstream's 161 + 4 dialect-selection tests + 8 new store tests (`knowledge-store.test.ts`, which
exercises `IKnowledgeStore`, the llm-binding store and a `CodeGraphService` build — upstream had no
store-level tests). The credential-store and route suites were switched to `createTestDb()`.

### Known gaps

- **Not moved:** each wiki's `index.db` (FTS5 search index, `page_meta`, `graph_edge`, `source`) — it
  is per-wiki derived data in the wiki directory; porting it means replacing FTS5 with `tsvector`.
- **No SQLite → Postgres data copy.** Switching an existing install starts with empty metadata.
- **Wider interleaving on Postgres.** On SQLite every store call resolves within a microtask, so the
  services behave exactly as before. On Postgres, requests can interleave between awaits: e.g. a
  credential rebind that lands between `CodeGraphService.runBuild`'s "credential changed?" check and
  its `ready` write is not re-queued. Same class of race as running several replicas; not addressed.
- `drizzle.config.ts` still targets SQLite only (drizzle-kit is not used at runtime).
