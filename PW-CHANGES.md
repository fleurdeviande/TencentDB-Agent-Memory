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

## PostgreSQL + pgvector store backend (`STORE_MODE=postgres`)

Design: `docs/pw/2026-09-29-postgres-unified-mcp-design.md`. Code: `MemoryCore/src/core/store/postgres/`.
SQLite stays the default; nothing changes unless the mode is selected.

- **Selection**: `STORE_MODE=postgres` (gateway; `MEMORY_CORE_STORE_MODE=postgres` in
  `deploy/global-images/start-memory-core.sh`), or `memory.storeBackend: postgres` for the core/plugin path.
- **Connection**: `POSTGRES_URL` (required; the gateway fails at boot without it) and `POSTGRES_SCHEMA`
  (default `tdai`). The config block `memory.postgres.{url,schema}` is the fallback; env wins. Logs and the
  data-dir manifest carry `host:port/db` only.
- **Layout**: one schema per memory instance — `default` → the base schema, any other instance →
  `<base>_i_<slug>_<hash>` (the sqlite analogue is one `vectors.db` per instance). Tables come from versioned,
  idempotent migrations run at init under an advisory lock (`<schema>.schema_migrations`).
- **FTS**: the same jieba-tokenised text sqlite feeds FTS5 goes into a generated `tsvector` (`simple` config,
  GIN). Queries OR the phrase terms of `buildFtsQuery`; rank is `ts_rank_cd` mapped to 0..1 with the
  `bm25RankToScore` transform, so the `scoreThreshold=0.3` gate keeps its meaning (no IDF, unlike BM25).
- **Vectors**: `vector(N)` columns + HNSW (cosine), N = `memory.embedding.dimensions`; filtered KNN runs with
  `hnsw.iterative_scan = strict_order` (pgvector ≥ 0.8), so isolation filters cannot starve topK.
- **Isolation**: team/agent/user/session/task filters are WHERE clauses on every read, search and delete.
- **Skills**: `PostgresSkillStore` in the same schema; the gateway uses the per-instance skill path for postgres
  (as for tcvdb/mongodb). Keyword search only, like sqlite.
- Everything is parameterised; the only interpolated identifier is the schema, validated as `[a-z_][a-z0-9_]*`.

Deviations and unsupported optional methods:

- A dimension or embedding-contract change with stored vectors does **not** mark the store degraded (that
  would make StorePool discard the instance). As in the sqlite store it keeps the old vectors, reports
  `needsReindex`, turns `vectorSearch` off and skips vector writes; keyword search keeps working.
  `reindexAll` builds a shadow column and swaps it in only when every row re-embedded. With no stored
  vectors the columns are simply rebuilt.
- Not implemented (optional and synchronous on `IMemoryStore`, which a network store cannot serve):
  `getVectorCoverage`, `getEmbeddingMigrationStatus`, `commitEmbeddingMigration`,
  `rollbackEmbeddingMigration` — the shadow reindex commits itself instead. `searchL1Hybrid`/`searchL0Hybrid`
  are absent (`nativeHybridSearch=false`, callers fuse client-side as with sqlite).
- The store serves profile rows (`profileRows=true`); since `pw/postgres-core-files` `FILE_STORE_MODE=rowfs` is
  legal on postgres and is its default, with the rest of the file plane in `pgfs` (see "Diskless
  `STORE_MODE=postgres`" below).
- The metadata service (`meta_*`) follows `STORE_MODE=postgres` since `pw/postgres-metadata`, see below;
  MemoryKnowledge has its own Postgres dialect (`KNOWLEDGE_DB_URL`).

Tests (Node 22, pgvector/pgvector:pg17 with pgvector 0.8.6 from `deploy/pw/docker-compose.dev.yml`; suites
create and drop their own `tdai_test_*` schema and skip when no database answers at `POSTGRES_TEST_URL`):

| suite | result |
|---|---|
| IMemoryStore contract, sqlite baseline (new runner) | 10/10 (the 2 profile-row cases return early: sqlite has no profile rows) |
| IMemoryStore contract, postgres | 10/10 |
| ISkillStore contract, postgres | 7/7 |
| postgres backend / lifecycle / wiring / skill specifics | 20 + 5 + 5 + 9 |
| MemoryCore full `vitest run` | 15 files, 93/93, exit 0 |

A gateway smoke run (`STORE_MODE=postgres`) wrote, queried and searched L0 through `/v3/conversation/*`, with
isolation holding across teams.

## Verification (Node 22)

| package | result |
|---|---|
| MemoryCore | vitest 27/27 upstream baseline; 93/93 with the postgres backend and contract runners; 244/244 with postgres metadata and personal keys; 316/316 with the diskless file plane and pipeline state |
| MemoryKnowledge | vitest 161/161 upstream baseline; 195 + 5 skipped on SQLite, 199 + 1 skipped on Postgres (wiki index and wiki files included) |
| MemoryCore/claude-code-plugin | tsc clean, vitest 17/17 |
| pw/mcp | tsc clean, vitest 41/41, smoke OK (incl. a personal-key pass) |

## pw-mcp: the single MCP server (`pw/mcp/`)

One stdio MCP server + hooks for Claude Code, configured by `TDAI_URL`, `KNOWLEDGE_URL`, `TDAI_USER_KEY`
(persisted by `pw-memory install` to `~/.config/pw-memory/config.json`, 0600). Usage in `pw/mcp/README.md`.

What is reused, and how — everything is imported from source and bundled with esbuild; nothing is copied:

| from | imported | not imported, and why |
|---|---|---|
| `MemoryCore/claude-code-plugin` (#1268) | `createClaudeCodeMcpServer` (run in-process behind an `InMemoryTransport`), `handleHook`, `PluginState`, `loadConfig`, `KnowledgeServiceClient`, `MEMORY_TOOLS_GUIDE` | `hooks/cli.ts`, `mcp/stdio.ts`: entry points that read the plugin's own env names; replaced by ~15 lines of glue that feed the same functions from the pw config |
| `MemoryKnowledge/src/mcp` | `tools.ts` (`MCP_TOOLS`, the 12 definitions) | `server.ts`: its `import.meta.url === argv[1]` main-guard is true for every module of a bundle, so importing it starts a second stdio server; its 12-line result mapping is mirrored in `knowledge-backend.ts`. `http-client.ts`: `callApi` sends neither `x-tdai-service-id` nor `team_id`, which every multi-tenant `/v3` route requires — against the current service **all 12 upstream knowledge MCP tools answer 400**. Calls go through the plugin's `KnowledgeServiceClient` instead |

Decisions:

- **Tool names**: MemoryKnowledge's 12 keep their upstream names, the plugin's are already `tdai_`-prefixed;
  no collisions (unit-tested; the registry would keep the first owner and log). With both halves on, the
  plugin's `tdai_wiki_search` / `tdai_wiki_pages` / `tdai_wiki_read` are dropped as duplicates of
  `wiki_search` / `wiki_list` / `wiki_read`; `tdai_wiki_list` and `tdai_wiki_write` stay (no equivalent).
  The hook rewrites the one guide line that names the dropped tools. 18 tools total.
- **Halves are optional**: unset URL → that half is not built, a stderr note says so; zero tools is a valid
  state. Hooks answer `{}` without touching the network when `TDAI_URL` is unset.
- **Prompt caching**: tool list and instructions fixed at startup; recall only via `additionalContext`.
  Stable block once per session, `<relevant-memories>` per prompt (table in the README).
- **stdout hygiene**: `stdio-guard.ts` routes `console.log/info/debug` to stderr (MemoryKnowledge's logger
  writes debug to stdout, which would corrupt JSON-RPC).
- **Hook commands** are `"<abs node>" "<abs dist/cli.js>" pw-memory-hook` with only `type`/`command`/`timeout`
  keys; the plugin's `integrations/hooks.json` uses `args` and `statusMessage`, which we did not rely on.
- `pnpm-lock.yaml` is not committed: the repo's `.gitignore` ignores it everywhere.

Caveats found on the way:

- ~~`TDAI_USER_KEY` is not per-person on the data plane yet.~~ Fixed in `pw/postgres-metadata`: a personal
  `sk-mem-…` key is resolved by the gateway and pins the request to its user (see "Personal keys" below);
  pw-mcp derives user and team from it. With the shared gateway key as `TDAI_USER_KEY` the old behaviour
  (identity from `TDAI_USER_ID`, default `default`) remains. MemoryKnowledge's `KNOWLEDGE_SERVICE_KEY` is
  still one service-wide key.
- The memory SDK's HTTP transport disables TLS verification by default (`rejectUnauthorized: false`).
- The plugin's `KnowledgeServiceClient` throws `HTTP 404` without the envelope message (`code graph not found`).
- In knowledge-only mode there is no tool to list wikis or code graphs (`tdai_wiki_list` comes with the memory
  half; neither side exposes `code-graph/list`).

Verification (Node 22.23.3): `pw/mcp` tsc clean, vitest 35/35; `scripts/smoke.sh` → `SMOKE OK` against
MemoryCore standalone (SQLite) + MemoryKnowledge with an unreachable LLM (memory write/read-back, 404-clean
knowledge errors, hooks incl. Stop capture found in L0, install/uninstall on a throwaway HOME).
MemoryCore's `pnpm install` needs `--config.auto-install-peers=false`, otherwise the optional peer `openclaw`
(Node ≥ 24) fails its preinstall.

## Known issues inherited from upstream

- `MemoryKnowledge` `tsc --noEmit` fails in `src/middleware/response-envelope.ts:57`
  (`Promise<string>` vs `string` on `c.req.bodyCache.text`). The line is unchanged from upstream;
  the error comes from Hono 4.13 being pulled by the unpinned `^4.7.0` without a lockfile.
- Packages need **Node 22**: under Node 26 `better-sqlite3` has no prebuilt binary and `npm install`
  fails in node-gyp. `npm install` in MemoryKnowledge also trips on the workspace layout
  (`Cannot read properties of null (reading 'edgesOut')`); `pnpm install --ignore-workspace` works. For MemoryCore add `--config.auto-install-peers=false`: the
  auto-installed optional peer `openclaw` now requires Node ≥ 24 and fails its preinstall under Node 22.

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

Not part of the metadata DB: each wiki's own `index.db` (`src/engines/wiki/index-db.ts`: FTS5 `wiki_fts`,
`page_meta`, `graph_edge`, `source`) in the wiki's data directory. It was left on disk in the first pass
and moved afterwards — see "Wiki index on Postgres" below. The Code-Graph index (`@colbymchenry/codegraph`)
stays on disk.

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
| `KNOWLEDGE_MAX_SOURCE_BYTES` | `52428800` (50 MiB) | largest wiki source the content store accepts, either dialect; over it → 413. A non-positive-integer value fails at startup. See "Wiki files on Postgres". |

Code-graph checkouts/indexes stay under `KNOWLEDGE_DATA_DIR` on either dialect. With `KNOWLEDGE_DB_URL` set,
the wiki index (below) and the wiki pages, sources and registry ("Wiki files on Postgres") live in Postgres.

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
| `npx vitest run` (SQLite) | 173 passed, 4 skipped (Postgres-only migration tests), exit 0 — 186 + 5 skipped after the wiki index port |
| `KNOWLEDGE_TEST_DB_URL=postgres://…/tdai_knowledge npx vitest run` | 177/177, exit 0; two runs in parallel also green — 190 + 1 skipped after the wiki index port |
| `tsc --noEmit` | only the known `response-envelope.ts:57` error |

173 = upstream's 161 + 4 dialect-selection tests + 8 new store tests (`knowledge-store.test.ts`, which
exercises `IKnowledgeStore`, the llm-binding store and a `CodeGraphService` build — upstream had no
store-level tests). The credential-store and route suites were switched to `createTestDb()`.

### Known gaps

- **No SQLite → Postgres data copy.** Switching an existing install starts with empty metadata (and empty
  wiki `source` rows; pages and edges are rebuilt from the `.md` files on registration).
- **Wider interleaving on Postgres.** On SQLite every store call resolves within a microtask, so the
  services behave exactly as before. On Postgres, requests can interleave between awaits: e.g. a
  credential rebind that lands between `CodeGraphService.runBuild`'s "credential changed?" check and
  its `ready` write is not re-queued. Same class of race as running several replicas; not addressed.
- `drizzle.config.ts` still targets SQLite only (drizzle-kit is not used at runtime).

### Wiki index on Postgres (`pw/postgres-wiki-index`)

With `KNOWLEDGE_DB_URL` set, the per-wiki index moves from one `index.db` per wiki into the metadata
database, keyed by `wiki_id`; without it upstream's SQLite files are used, with upstream's SQL unchanged.
The wiki `.md` pages and raw sources stayed on disk in this step (moved later — "Wiki files on Postgres").

- **Interface.** `src/engines/wiki/index-store.ts` — `WikiIndexStore`: `init`, `withWrite(fn)` (one
  transaction, serialised per wiki; writer: `replacePages`, `upsertSource`, `recordSourceIngestResult`,
  `deleteSources`), `search`, `loadPages`, `loadEdges`, `listSources`, `readSourceStates`, `release`, `drop`.
  SQLite adapter over `index-db.ts` (explicit `BEGIN/COMMIT` on the write connection plus an in-process
  per-wiki lock, so an async write never blocks the event loop on `busy_timeout`); Postgres in
  `index-store-pg.ts` on `KnowledgeDb.pgPool` — the pool `openKnowledgeDb()` opened, no second one.
  `createWikiIndexStore(db)` picks by dialect; `module.ts` hands it to the manager and `WikiService`.
- **Async ripple.** `createWikiSourceManager()` and the manager's `register/sync/init/search/graph/remove`
  return promises; routes `await` them. Only a missing SQLite `index.db` (`WikiIndexMissingError`) still
  reads as empty; Postgres errors propagate instead of turning into empty results.
- **Tables** (in `migrate-pg.ts`, same idempotent DDL under the migration advisory lock):
  `knowledge_wiki_page` (page_meta + pre-tokenised `title_tok`/`content_tok` + `tok_count` + generated
  `fts tsvector` = title weight A ‖ content weight D, GIN), `knowledge_wiki_edge`, `knowledge_wiki_source`.
  PKs lead with `wiki_id`. Writes take `pg_advisory_xact_lock(<ns>, hashtext(wiki_id))`; all SQL is
  parameterised.
- **Lifecycle.** Deleting a wiki (`WikiService.cleanupResources`) calls `drop`, which deletes the wiki's
  page, edge and source rows (SQLite: closes the read connection; the directory removal deletes the file).
  `source` rows are never touched by index rebuilds, so upload/ingest state survives restarts (the
  startup restore only rewrites pages and edges); tested with a fresh manager + service over the same DB.
- **Tokenisation.** Upstream does not use jieba for the wiki: `manager.ts#tokenize` lowercases, splits on
  whitespace/punctuation, drops a small stop-word list and emits CJK bigrams plus the whole CJK run.
  Both dialects index exactly that output. For Postgres every token is further split into letter/digit
  runs (`[\p{L}\p{N}\p{M}]+`), which is what FTS5 `unicode61` does, so `node.js` / `v2.0` index as two
  words on both sides instead of Postgres' host/version tokens; config `simple`.
- **Queries.** FTS5 `"tok"*` OR … becomes `'w1' <-> 'w2':*` | … (prefix on the last word of each token
  phrase, as in FTS5).

Behavioural differences vs upstream FTS5 (Postgres only):

- **Ranking.** `ts_rank_cd` (weights 1 : 1) divided by `1 - b + b·len/avg_len` (b = 0.75, the wiki's mean
  `tok_count`); no IDF. Against FTS5 bm25 on the repo's 69 markdown files and 12 English/Chinese queries:
  top-5 overlap 0.78, same top hit in 9/12 (plain `ts_rank_cd`: 0.58 and 4/12). Ties break by `page_id`.
- **Title weight.** Upstream calls `bm25(wiki_fts, 5.0, 1.0)`, but bm25 weights follow column order and
  column 0 is the `UNINDEXED page_id`, so title and content actually weigh the same. Postgres mirrors
  that 1 : 1 (`RANK_WEIGHTS`; `{0.2,0.2,0.2,1.0}` would give the intended 5 : 1). The SQLite path keeps
  upstream's SQL untouched.
- **Score scale.** Scores are `rank / (1 + rank)` in (0, 1) — strong hits cluster at 0.85–0.98 — while
  upstream returns raw `-bm25` (unbounded, ~1–10 on real wikis, but ~1e-6 on tiny ones where FTS5
  clamps IDF). With `hop > 0` the default `decay 0.5` / `minScore 0.1` therefore stop expansion after
  about 3 hops instead of 5; callers can lower `minScore`.
- **Snippets** are unchanged: upstream returns a static `page_meta.snippet` (description or first 80
  chars), no FTS highlighting on either dialect.
- **Limits.** Per page at most 500 000 characters of token text are indexed (tsvector's 1 MB cap);
  Postgres clamps positions above 16 383 and ignores words longer than 2 047 bytes.
- **Planner.** One GIN index over all wikis, filtered by `wiki_id` (a composite would need `btree_gin`).

Tests: `index-store.test.ts` (store contract on the test dialect: English/Chinese/prefix/punctuation
search, wiki isolation, rebuilds keep sources, source lifecycle, rollback, concurrent writes, drop,
missing index.db) and `wiki-index-lifecycle.test.ts` (WikiService + manager with the LLM stages stubbed:
upload → ingest → search → graph/hop → restart → re-ingest skips unchanged sources → delete).

| run | result |
|---|---|
| `npx vitest run` (SQLite) | 186 passed, 5 skipped (Postgres-only), exit 0 |
| `KNOWLEDGE_TEST_DB_URL=postgres://tdai:tdai-dev@127.0.0.1:55432/tdai_knowledge npx vitest run` | 190 passed, 1 skipped (SQLite-only), exit 0 |
| `tsc --noEmit` | only the known `response-envelope.ts:57` error |

Not ported: no copy of existing `index.db` contents into Postgres (pages/edges rebuild from disk; `source`
rows of an existing install start empty, so the first ingest after switching re-extracts every source).
The manager's own `_wiki_engines/wiki-sources.json` registry stays on disk, as upstream (moved later — see
"Wiki files on Postgres").

### Wiki files on Postgres (`pw/postgres-wiki-files`)

#### Inventory (before porting)

Every file the wiki engine (`engines/wiki/manager.ts`, `ingest-v2/*`), `WikiService` and the wiki routes
read or write. `{wiki}` = `{KNOWLEDGE_DATA_DIR}/{service_id}/{team_id}/{wiki_id}`. The routes (`routes/wiki.ts`,
`routes/tools.ts`) and the MCP server touch no files themselves; they go through `WikiService` / the manager.

| path pattern | what it is | writer → readers | durable / derived |
|---|---|---|---|
| `{wiki}/raw/sources/**` | uploaded source files (`raw/write`), UTF-8 text today | `WikiService.rawWrite*` → `rawRead*`, ingest (`findMdFiles`: `.md`/`.txt` only), `cascade.deleteSourceFiles` (rm) | **durable** — the only copy of the user's input |
| `{wiki}/wiki/**/*.md` (skipping any `media/` dir) | wiki pages: LLM-generated (`commitCandidates`) and hand-written (`page/write`, `locked: true`) | ingest merge, `WikiService.pageWrite*`, cascade rewrites/deletes → `page/ls|read`, manager `scanWikiDir` (index rebuild, restart restore), `scanExistingPages`, `index-builder`, `overview` | **durable** — hand-written pages and merged LLM output cannot be regenerated without re-running the LLM |
| `{wiki}/wiki/{schema,purpose}.md` | per-wiki extraction template (defaults written by `initWikiProject` if missing) | `initWikiProject`, (users via file access) → `template.loadTemplate` | **durable** (configuration) |
| `{wiki}/wiki/index.md` | table of contents | `index-builder.rebuildIndexFile` after every commit | derived from the pages, but served as a page |
| `{wiki}/wiki/log.md` | ingest log (append, newest day first) | `log-writer.appendIngestLog*` | **durable** (history is not reconstructible) |
| `{wiki}/wiki/overview.md` | LLM overview of all pages | `overview.generateOverview` | durable in practice (an LLM call to regenerate) |
| `{wiki}/wiki/{entities,concepts,sources,comparisons,synthesis}/`, `{wiki}/.llm-wiki/` | empty directory skeleton | `initWikiProject`; `WikiService.create` makes `raw/sources/` | layout only |
| `{wiki}/_debug/generate-fail-*.txt` | raw LLM output when a FILE block does not parse | `ingest-v2.dumpGenerateFailure` | diagnostic, never read back |
| `{wiki}/index.db` (+ `-wal`/`-shm`) | SQLite wiki index | `index-db.ts` | derived; already in Postgres with `KNOWLEDGE_DB_URL` (above) |
| `{KNOWLEDGE_DATA_DIR}/_wiki_engines/wiki-sources.json` | manager registry: name → `{path, status, pageCount, lastSyncAt, error}` | manager `persist()` after register/sync/ingest/remove → `loadState()` at boot | **durable** — the startup restore iterates it |
| whole `{wiki}` dir | removed on wiki delete | `WikiService.cleanupResources` (`rmSync`) | — |

Not wiki: `{KNOWLEDGE_DATA_DIR}/{service_id}/{team_id}/{code_graph_id}` (Code-Graph checkouts + codegraph
index), `_git_known_hosts/`, temp git-auth dirs under the OS tmpdir, and `KNOWLEDGE_DB_PATH` (SQLite only).

#### Abstraction

- **`WikiContentStore`** (`src/engines/wiki/content-store.ts`): `init(loc, dirs)`, `hasPages`, `listPages`,
  `readPage`, `applyPages({put, remove})` (all or nothing), `listSources(loc, match?)` → `{filename, size,
  sha256}`, `readSource` → `Buffer`, `writeSources` (all or nothing, size-checked first), `deleteSources`,
  `drop`, `loadRegistry` / `putRegistry` / `removeRegistry`. A wiki is a `WikiLoc {wikiId, dir}`: the
  filesystem uses `dir`, Postgres `wikiId`. Page paths are project-relative `wiki/…`, source names relative
  to `raw/sources/`; both are validated again inside the store (no `..`, no absolute, normalised).
- **Filesystem** (`FsWikiContentStore`, default and SQLite mode): upstream's layout and write rules —
  the same directories, `raw/sources/` created on wiki create (nested source names still need their
  directory), write-then-rollback batches, `rm -rf` of the wiki dir on delete, the registry JSON rewritten
  whole on every change.
- **Postgres** (`content-store-pg.ts`, selected by `createWikiContentStore(db)` when the metadata DB is
  Postgres, on `KnowledgeDb.pgPool`): `knowledge_wiki_page_file (wiki_id, path, content text)`,
  `knowledge_wiki_source_file (wiki_id, filename, data bytea, size, sha256)`,
  `knowledge_wiki_registry (name, state jsonb)` — idempotent DDL in `migrate-pg.ts` under the existing
  migration advisory lock. Batches run in one transaction under `pg_advisory_xact_lock(<"wikc">, hashtext(wiki_id))`,
  a namespace of their own so a content write never waits on an index write of the same wiki. All SQL is
  parameterised; wiki ids and paths are never interpolated. `drop` deletes the wiki's page, source and
  registry rows (the registry row too, because a build finishing after the delete can re-put it).
- **`PageTree`** (`page-tree.ts`): the ingest pipeline and the two delete cascades walk and rewrite many
  pages synchronously, so they now run on an in-memory copy loaded from the store and written back with
  one `flush` (changed and removed pages only). `ingest-v2` (`extractSource`, `commitCandidates`,
  `scanExistingPages`, `index-builder`, `log-writer`, `overview`, `template`, `cascade`) takes a `PageTree`
  instead of a project path; `extractSource` gets the source as `{name, text}`. The manager's scan,
  restart restore, `initWikiProject` and registry, and `WikiService`'s `raw/*` / `page/*`, go through the
  store directly. `getPages` / `readPage` on the manager became async.
- **Binary sources.** `raw/write` items take `encoding: "base64"` (validated; size limits apply to the
  decoded bytes) and `raw/read` takes `encoding: "base64"`; default stays UTF-8 text. Source sha256 is
  computed over the bytes (identical to upstream's for UTF-8 text).
- **Size limit.** `KNOWLEDGE_MAX_SOURCE_BYTES` (default 50 MiB) is enforced by the store on both dialects
  before anything is written: `SourceTooLargeError` (status 413) → `WikiService` `"too_large"` → HTTP 413.
  Upstream's tighter limits still apply in front of it (route: 512 KiB per file / 5 MiB per request;
  service: 5 MiB per file), so through today's HTTP API it is a backstop, reachable only by lowering it.

#### What remains on disk with `KNOWLEDGE_DB_URL`

Nothing of a wiki: no `{wiki}` directory is created, no `_wiki_engines/`, no `index.db`, no `_debug/`
(unparsable LLM output goes to the log at `warn`, first 4 000 characters). The test asserts the whole
data dir is empty after create → upload → ingest. What does live under `KNOWLEDGE_DATA_DIR` in that mode:
Code-Graph checkouts and codegraph indexes (`{service}/{team}/{code_graph_id}`, third-party, out of scope)
and `_git_known_hosts/known_hosts` once an SSH fetch writes it; git-auth key files go to the OS tmpdir.

**Temp-file materialisation: none.** No wiki stage needs a real path — sources are `.md`/`.txt` text
handed to the LLM as strings, and nothing hands a path to a third-party parser. Code-Graph is the only
path-bound consumer and stays on disk by decision.

#### Memory

- A stored source is read and written whole: node-postgres materialises `bytea` as a `Buffer` from its hex
  text, so a source costs about three times its size in flight — ≤ ~150 MB per request at the 50 MiB cap.
  Ingest reads only the sources it extracts, one per concurrent extraction (`listSources` returns size and
  sha256 without the bytes).
- `PageTree` holds all pages of one wiki while an ingest or cascade runs (page/write caps a page at 512 KiB).

#### Behaviour vs upstream (both dialects)

- Ingest and cascades write their pages at the end in one batch instead of file by file; a failure before
  the flush leaves the stored pages untouched (upstream kept what it had written so far). Unchanged pages
  are not rewritten.
- Non-`.md`/`.txt` sources are no longer classified as "deleted" by ingest. Upstream removed any such
  upload (and its `source` row) on the first ingest, which would have destroyed every binary source.
- A missing `raw/sources/` no longer short-circuits ingest; it reads as "no sources".
- Source names are normalised (`./a.md` → `a.md`) before they are stored and registered; upstream stored
  the file normalised but registered the raw name.
- Postgres `text` cannot hold NUL, so a page containing `\u0000` fails to store on Postgres (page/write answers 400 with the driver error; not covered by a test).

Tests: `content-store.test.ts` (store contract on the test dialect: pages, filter, traversal, text and
binary sources, 413 without partial writes, registry, drop) and `wiki-files.test.ts` (`createKnowledgeModule`
+ `/wiki` routes, only the LLM client stubbed, so the real extract/merge/index.md/log.md/overview run:
create → upload markdown + base64 binary (+ one source the stub cannot parse) → 413 → ingest → search/graph →
data dir empty (Postgres) or upstream's files incl. `_debug/` (SQLite) → restart on a fresh data dir →
pages, raw bytes and search → raw/rm cascade → delete → zero rows in `knowledge_wiki`, `knowledge_wiki_page`,
`_edge`, `_source`, `_page_file`, `_source_file`, `_registry`). `wiki-index-lifecycle.test.ts` now wires the
content store like `module.ts`. Audit rows (`knowledge_wiki_audit`) outlive the wiki by design.

| run | result |
|---|---|
| `npx vitest run` (SQLite) | 195 passed, 5 skipped (Postgres-only), exit 0 |
| `KNOWLEDGE_TEST_DB_URL=postgres://tdai:tdai-dev@127.0.0.1:55432/tdai_knowledge npx vitest run` | 199 passed, 1 skipped (SQLite-only), exit 0 |
| `tsc --noEmit` | only the known `response-envelope.ts:57` error (exit 2) |

Not ported: no copy of existing files into Postgres. Switching an install to `KNOWLEDGE_DB_URL` starts with
no pages, sources or registry; existing wiki directories are ignored (and not deleted).

## MemoryCore metadata on PostgreSQL (`pw/postgres-metadata`)

The metadata service (`meta_*`: users, API keys, teams, members, agents, tasks, assets, ACL, config params,
upstream configs — the panel's and `/v3/meta/*`'s store) gets a third backend next to sqlite and mongodb.
Code: `MemoryCore/src/metadata/store/postgres-adapter.ts`, `postgres-migrations.ts`, selection in `factory.ts`.

- **Implementation**: a port of `sqlite-adapter.ts` that keeps its SQL: statements are written with `?` and
  bare `meta_*` names and rewritten to `$n` and schema-qualified names; all values bound, the schema is the
  only interpolated identifier (validated). Every TEXT column is `COLLATE "C"`, so equality and ORDER BY match
  SQLite's BINARY collation. Compound writes (user + default key, team + admin member, task + links, fixed-asset
  replace, asset delete, key revoke with default promotion) run in one transaction; config-param upserts use
  `ON CONFLICT` on the partial unique indexes instead of select-then-write. Unique violations are recognised by
  SQLSTATE 23505 + constraint name (`*_pkey` → retry with a new id, `meta_user_keys_key_value_key` →
  `DuplicateUserKeyError`).
- **Reuse**: the shared `pg.Pool` per URL, `withTransaction`, `qi`, `assertSchemaName`, `schemaForInstance`
  and `runMigrations` of `core/store/postgres/` — component `metadata` in `<schema>.schema_migrations`, under
  the same advisory lock.
- **Layout**: one schema per instance, like mongo's one database per instance: `default` →
  `TDAI_METADATA_POSTGRES_SCHEMA` (default `tdai_metadata`), others → `<base>_i_<slug>_<hash>`. Purge
  (`/v3/instance/destroy`) drops the `meta_*` tables and the metadata migration rows, and the schema only when
  nothing else is left in it (it may be shared with the memory store if configured so).
- **Deviations**: none in behaviour the contract checks. `createUserKey` with an explicit duplicate `key_value`
  throws `DuplicateUserKeyError` (sqlite throws the raw driver error). `close()` does not end the shared pool;
  `MetadataStorePool.closeAll()` does at shutdown.

Configuration:

| key | default | meaning |
|---|---|---|
| `TDAI_METADATA_STORE_BACKEND` | `auto` | `sqlite` / `mongodb` / `postgres` forces the backend. `auto`: Mongo URI set → mongodb (upstream); else `STORE_MODE=postgres` and no explicit `TDAI_METADATA_SQLITE_BASE_DIR` → postgres; else sqlite (upstream). Unknown value → boot fails. |
| `TDAI_METADATA_POSTGRES_URL` | `POSTGRES_URL` | connection for the metadata store |
| `TDAI_METADATA_POSTGRES_SCHEMA` | `tdai_metadata` | base schema, validated `[a-z_][a-z0-9_]{0,62}` |
| `MEMORY_CORE_METADATA_BACKEND` (deploy script) | `auto` | now also `postgres`; `auto` follows `MEMORY_CORE_STORE_MODE=postgres`. Whenever postgres is involved the script passes `TDAI_METADATA_STORE_BACKEND` explicitly, so choosing `sqlite` there stays sqlite. |

`deployMode=service` now accepts postgres as well as mongodb for metadata.

Tests: the upstream contract `metadata-store.contract.ts` had no runner; it now runs against sqlite (58/58,
`:memory:`) and postgres (58/58, a fresh `tdai_test_*` schema per test, skipped when `POSTGRES_TEST_URL` does
not answer), plus 10 postgres specifics (backend selection, idempotent concurrent migrations, purge on a shared
schema, pool: schema per instance and purge). A gateway run with `STORE_MODE=postgres` created the admin, the
default team and agent through `/v3/internal/meta/user/init-admin` and listed them via `/v3/meta/team/list`,
rows in `<schema>_meta.meta_*`.

## Personal keys on the /v3 data plane (`pw/postgres-metadata`)

Code: `MemoryCore/src/gateway/personal-key-auth.ts`, gate `applyPersonalKeyGate` in `gateway/server.ts`
(`V3_ALLOWED_SUBPATHS` exported from `v2-router.ts`). No handler changed.

Rules, applied to `POST` on the 18 `/v3` L0–L3 routes (`conversation/*`, `atomic/*`, `scenario/*`, `core/*`):

| Bearer | result |
|---|---|
| `sk-mem-…` that resolves (metadata store of `x-tdai-service-id`) to an **active** user; not the memory system user's key | identity = that user |
| ↳ `user_id` in body or `x-tdai-user-id` absent | filled with the key's user (body and header) |
| ↳ `user_id` present and different | **403** — rejected, not overwritten: a misconfigured client fails loudly instead of silently acting under another identity |
| ↳ `team_id` (body or `x-tdai-team-id`) absent | **422** |
| ↳ body and header `team_id` differ, or a non-string id | **400** |
| ↳ team missing, not `active`, or the user's membership not `active` | **403** |
| `sk-mem-…` that does not resolve (unknown, revoked, expired, inactive user, system key) | **401** |
| the shared `TDAI_GATEWAY_API_KEY`, or anything else | upstream behaviour (identity from the request) while `TDAI_GATEWAY_SHARED_KEY_MODE=trusted`; **401** on these routes when `off` |

On `/v3/meta/*` a resolving personal Bearer passes layer 1 and doubles as `x-tdai-user-key` (a different
`x-tdai-user-key` → 401), so a client holding only its personal key can call `auth/verify` and `team/list`.
Everything else (`/v2/*`, `/v3/skill|knowledge|chat-memory|memory-prompt|…`, `/v3/internal/*`, analytics) is
unchanged: a personal Bearer there is still a 401 when the shared key is configured. Shared Bearer +
`x-tdai-user-key` (the panel's pattern — it reads borrowed chat-memory as the asset owner and runs its own ACL)
stays on the shared-key path. With `TDAI_GATEWAY_API_KEY` unset the gateway is open as upstream; personal keys
are still pinned, but a caller can simply send none — set the shared key in any real deployment.

| key | default | meaning |
|---|---|---|
| `TDAI_GATEWAY_SHARED_KEY_MODE` | `trusted` | `trusted`: the shared key may act as any team/user (upstream); a boot warning says so when the key is set, and the first shared-key request on an L0–L3 route logs once. `off`: L0–L3 requires a personal key; management routes keep the shared key. |
| `TDAI_GATEWAY_PERSONAL_KEYS` | on | `off` restores upstream exactly (not allowed together with mode `off`) |
| `TDAI_GATEWAY_PERSONAL_KEY_CACHE_MS` | `30000` | positive key → user and (user, team) → membership lookups are cached this long; a revoked key or removed member keeps working at most this long. `0` disables. |

The deploy script passes the three through when set. Not enforced: `agent_id` (the data plane has no agent
ownership model) and `session_id`; per-record ownership on `atomic/update|delete` is the handlers' existing
`iso.userId` check.

pw-mcp: `TDAI_USER_KEY` is the personal key; server and hooks derive the user from `/v3/meta/auth/verify` and
the team from `/v3/meta/team/list` (exactly one active team → used; several → `TDAI_TEAM_ID` required, memory
half off otherwise), cached 10 min in `<state dir>/pw-identity.json` (0600, hashed key). `TDAI_USER_ID` is
only an override for non-personal keys; with a personal key a different value is ignored with a note, because
the gateway would refuse it. When `auth/verify` does not resolve the key (the shared key, an older gateway) the
configured identity is kept, as before.

Tests: `personal-key-auth.test.ts` (11: config, pinning rules, resolver on a real sqlite metadata store incl.
revoked/inactive/system keys and removed memberships) and `personal-key.gateway.test.ts` (7 per backend,
sqlite and postgres metadata+data plane: own rows only with user_id derived, foreign team 403 on read and
write, spoofed user_id in body or header 403 with nothing written, unknown key 401, shared key unchanged in
trusted mode incl. both warnings, `/v3/meta` with the personal Bearer, mode `off`). pw-mcp `identity.test.ts`
(6) and a personal-key pass in `smoke.sh`.

Results (Node 22, pgvector/pgvector:pg17):

| suite | result |
|---|---|
| MemoryCore `npx vitest run` | 20 files, 244/244, exit 0 (93 before + 58 + 58 + 10 metadata + 11 + 14 gateway) |
| MemoryCore/claude-code-plugin | tsc clean, vitest 17/17, exit 0 |
| pw/mcp | tsc clean (exit 0), vitest 41/41 (exit 0), `npm run smoke` → SMOKE OK (exit 0) |

Still not on PostgreSQL: code-graph index files (third-party `@colbymchenry/codegraph`, rebuildable from git);
MemoryProxy's own SQLite (the proxy is not used). ~~The file plane and `LocalStateBackend`'s pipeline state~~ —
moved in `pw/postgres-core-files`, see below. SQLite stays the default for every store when `STORE_MODE` is
not `postgres`.

## Diskless `STORE_MODE=postgres` (`pw/postgres-core-files`)

Decision: with `STORE_MODE=postgres` nothing durable of MemoryCore lives on disk. Before this branch the gateway
in that mode still wrote, into `TDAI_DATA_DIR`: a SQLite `vectors.db` (the core's own default store, from the
yaml's `storeBackend: sqlite`), `.metadata/manifest.json`, `.metadata/checkpoint.json` (+ per-scope copies under
`profiles/<scope>/`), `scene_blocks/*.md` + `persona.md` materialised from the rows, `conversations/*.jsonl`
(L0 mirror), `records/*.jsonl` (L1 shards), generation logs, skill/offload files, and the empty skeleton
`conversations/ records/ scene_blocks/ .metadata/ .backup/`; the pipeline queue, timers and counters lived in
process memory (`LocalStateBackend`).

### Inventory of the file plane and where it goes

| artefact | writer | now |
|---|---|---|
| `scene_blocks/<name>.md`, `persona.md` (L2/L3) | L2/L3 runners, `/v3/scenario/*`, `/v3/core/*` | `profiles` rows via rowfs (`ProfileRowStorageBackend`) — already implemented by `PostgresMemoryStore` |
| `.metadata/scene_index.json` | scene extractor | not written: rowfs derives the index from the L2 rows (upstream P2-D2) |
| `.metadata/checkpoint.json`, `profiles/<scope>/.metadata/checkpoint.json` | `CheckpointManager` (L1 cursor, L2/L3 counters, persona trigger) | pgfs object, per profile domain (see scoping) |
| `instances/<inst>/…` generation logs | `MemoryGenerationLogStore` | pgfs |
| `records/<date>.jsonl` (L1 shards) | `l1-writer` | pgfs (append = one chunk row) |
| `conversations/<date>.jsonl` (L0 mirror) | v2 `conversation/add`, v1 capture | off by default (below); pgfs when re-enabled |
| skill resources, skill conversation buffers, offload artefacts | `SkillCore`, skill buffer storage, offload executors | pgfs (they already wrote through the core storage adapter) |
| `.backup/…` | `BackupManager` | not used on the storage path (local-fs only, upstream) |
| `.metadata/manifest.json` | `_doInitStores` (sync `fs`) | not written when diskless |
| `vectors.db` | core `initStores` | not created: `STORE_MODE=postgres` sets `memory.storeBackend=postgres` |
| data-dir skeleton | `initDataDirectories` (gateway start + core init) | skipped when diskless |

### What changed

- **`pgfs` — `PostgresFSBackend`** (`src/core/storage/postgres-fs-backend.ts`): a general `IStorageBackend` in the
  instance schema, the Postgres counterpart of `mongofs`. Tables `fs_objects (key PK, size, next_seq, version,
  content_type, metadata JSONB, updated_at_ms)` and `fs_chunks (key → fs_objects ON DELETE CASCADE, seq, data
  BYTEA)`, component `files` in `schema_migrations`. put/append are one transaction each; the object row is
  upserted first, so its row lock orders concurrent appends (the O_APPEND equivalent) and a put replaces the
  chunks atomically (the tmp+rename equivalent); reads are one statement, i.e. one snapshot. 1 MiB chunks. Keys:
  relative, no NUL, no `..` segment. String-prefix listing per the D9.2 contract.
- **Selection**: `validateResolution` allows `profile=rows` for `postgres`; `FILE_STORE_OTHERS=pgfs` requires
  `db.kind="postgres"`. With `STORE_MODE=postgres` the defaults are `FILE_STORE_MODE=rowfs`,
  `FILE_STORE_OTHERS=pgfs`; explicit values win (`FILE_STORE_MODE=local` restores the disk layout,
  `FILE_STORE_OTHERS=local` keeps rows for L2/L3 but files for the rest).
- **Per-domain others leg** (`CompositeStorageBackend` option `scopeOthers`, set by the gateway for postgres only):
  upstream rowfs passes the others leg through unscoped, so all teams would share one `.metadata/checkpoint.json`
  — L2 counters and the L3 persona trigger mixed across teams, and L3 would never discover a scope (it lists
  `profiles/`) and fall back to the global view. Rebinding a view to a domain now also prefixes the others leg
  with `profiles/{scope}/`, the layout local/COS mode use. L3's scoped view passes that prefix too
  (`scopedStorageForScope`); composites without `scopeOthers` ignore it, so mongodb rowfs is unchanged.
- **L0 JSONL mirror off by default** (`TDAI_L0_JSONL_MIRROR`): the mirror is an audit copy next to the store;
  L1 reads `l0_conversations` and falls back to the JSONL only when the store is unusable. In postgres mode the
  mirror would be a second copy of every message in the same database, append-only and never pruned (the
  memory cleaner only walks a local dir). The v1 capture path honours the switch through
  `memory.capture.l0JsonlMirror` but still writes while no usable store holds L0.
- **Core**: `STORE_MODE=postgres` sets `memory.storeBackend=postgres` (the core's own store for v1 routes), and
  `usesLocalDataDir()` (postgres + rowfs + pgfs) makes the gateway and `TdaiCore` (`localDataDir: false`) skip
  the data-dir skeleton and the manifest.
- **`PostgresStateBackend`** (`src/core/state/postgres-backend.ts`, component `state`): `pipeline_sessions`
  (counters as JSONB, patched with `||`), `pipeline_buffers`, `pipeline_timers`, `pipeline_tasks` (owner NULL =
  queued, else pending) and `pipeline_locks` (lease with expiry). Claims are `FOR UPDATE SKIP LOCKED`;
  `captureAtomic` is one transaction on the locked session row (count → enqueue → timer); `replacePendingTask`
  deletes and enqueues in one transaction. Consumed tasks stay pending until ACKed and `claimStaleTasks` hands
  a dead worker's claims to a live one, so a crash no longer loses in-flight or queued work. Timers fire
  through `TimerScanner.claimExpiredFromShard` (one shard) instead of `setTimeout`. Blocking consumes poll
  (≤ 200 ms) and are woken at once by in-process enqueues.
- `deploy/global-images/start-memory-core.sh` passes `FILE_STORE_MODE`, `FILE_STORE_OTHERS`, `STATE_BACKEND`,
  `TDAI_STATE_POSTGRES_SCHEMA`, `TDAI_L0_JSONL_MIRROR` through when set; its generated yaml says
  `stateBackend: local`, which `STORE_MODE=postgres` lifts to postgres.

### Configuration

| key | default | meaning |
|---|---|---|
| `FILE_STORE_MODE` / `data.fileStore` | `rowfs` with `STORE_MODE=postgres`, else upstream (`local` / `cos`) | `local` keeps the whole file plane on disk |
| `FILE_STORE_OTHERS` / `data.fileStoreOthers` | `pgfs` with `STORE_MODE=postgres`, else upstream | now also `pgfs` (postgres only) |
| `TDAI_L0_JSONL_MIRROR` / `data.l0JsonlMirror` | `off` with `STORE_MODE=postgres`, else `on` | `on`/`off` (`true`/`false`/`1`/`0`); invalid → boot fails |
| `STATE_BACKEND` / `stateBackend` | `postgres` with `STORE_MODE=postgres` when env is unset and yaml says nothing or `local`; else upstream (`local` / `redis` by deploy mode) | now also `postgres`; env `STATE_BACKEND=local` keeps the in-memory backend |
| `TDAI_STATE_POSTGRES_SCHEMA` | `POSTGRES_SCHEMA` (`tdai`) | schema of the `pipeline_*` tables, one per deployment (all instances) |

pgfs objects live in each instance's schema (`POSTGRES_SCHEMA`, `<base>_i_<slug>_<hash>`), next to its memory rows.

### What still touches the disk in postgres mode, and why

- **Logs**: `core.log` / `observability.log` under `LOG_PATH` (default `/data/log/`, rotating, skipped when not
  writable) plus stdout. Diagnostics, not state; point `LOG_PATH` elsewhere or leave it unwritable.
- **The data dir itself**: `TDAI_DATA_DIR` is still resolved and may exist (the deploy script mounts a volume);
  it stays empty. No lock file is written.
- Not touched in this mode, listed for completeness: `.backup/` (BackupManager runs only without a storage
  adapter), the sandboxed local LLM tools (used only without a storage adapter), OpenClaw's clean-context
  workspace (plugin path, not the gateway), MemoryKnowledge's files (separate service).

### Deviations and known limits

- **L1 JSONL shards stay** (`records/<date>.jsonl`, now in pgfs): a second copy of `l1_records`, append-only; no
  switch was added (not asked for). Each append is one chunk row, so a busy day's shard is many small rows.
- **Crash recovery speed**: a claim is stale after `pendingStaleMs`, which the worker raises to at least
  `lockTtlMs + 2 × 30 s` (the fixed lock-renew interval): ≥ 11 min with default settings, ~91 s with
  `lockTtlMs: 31000`. Queued-but-unclaimed tasks are picked up at once. A graceful stop hands its claims back
  immediately (upstream behaviour).
- **Existing installs**: no copy of an existing data dir into pgfs or of in-memory state into Postgres; switching
  starts with empty checkpoints (the L1 cursor restarts, so the first L1 run after the switch re-reads L0 from
  the beginning of the store) — or set `FILE_STORE_MODE=local` to keep the old layout.
- The standalone rowfs path logs `rowfs storage assembled` at info on every request (upstream; the composite is
  deliberately not cached).
- `closeSharedPostgresPools()` runs in `storePool.closeAll()` before `core.destroy()` at shutdown (upstream order);
  nothing writes in between today.

### Tests (Node 22, pgvector/pgvector:pg17)

| suite | result |
|---|---|
| `postgres-fs-backend.test.ts` — D9.2 storage contract (its first runner) at the root and under a prefix, concurrent appends, chunking, metadata, key validation, schema isolation | 30/30 |
| `rowfs-postgres.test.ts` — selection defaults/overrides, `validateResolution`, config resolvers; rowfs contract over `PostgresMemoryStore`; composite rows + pgfs with per-domain others, and without `scopeOthers` | 17/17 |
| `postgres-diskless-config.test.ts` — `loadGatewayConfig` with/without `STORE_MODE=postgres`, overrides, `resolveStateBackend`, `resolveL0JsonlMirror` | 5/5 |
| `state-backend.test.ts` — one behaviour suite against `LocalStateBackend` (reference) and Postgres (8 + 8), plus Postgres durability: state/queue/timers across a new backend instance, concurrent consumers, concurrent timer scanners | 19/19 |
| `postgres-diskless.gateway.test.ts` — real gateway, stub LLM: L0 → L1 → L2 → L3, data dir and HOME empty, pgfs holds the scoped checkpoint and L1 shards but no L0 mirror and no profile files; SIGKILL during an L1 call, the next process recovers and finishes the task; L0–L3 read back via `/v3`; graceful stop, dir still empty (~95 s) | 1/1 |
| MemoryCore `npx vitest run` | 25 files, 316/316, exit 0; without a database (`POSTGRES_TEST_URL` unreachable): 141 passed, 74 skipped, exit 0 |
| `tsc` on `src/gateway/server.ts` (strict, nodenext) | 187 errors before and after, same set (all upstream) |
