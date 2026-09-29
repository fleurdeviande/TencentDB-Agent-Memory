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
| MemoryKnowledge | vitest 161/161 |
| MemoryCore/claude-code-plugin | tsc clean, vitest 17/17 |

## Known issues inherited from upstream

- `MemoryKnowledge` `tsc --noEmit` fails in `src/middleware/response-envelope.ts:57`
  (`Promise<string>` vs `string` on `c.req.bodyCache.text`). The line is unchanged from upstream;
  the error comes from Hono 4.13 being pulled by the unpinned `^4.7.0` without a lockfile.
- Packages need **Node 22**: under Node 26 `better-sqlite3` has no prebuilt binary and `npm install`
  fails in node-gyp. `npm install` in MemoryKnowledge also trips on the workspace layout
  (`Cannot read properties of null (reading 'edgesOut')`); `pnpm install --ignore-workspace` works.
