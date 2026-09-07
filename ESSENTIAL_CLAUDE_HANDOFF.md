# ESSENTIAL — Claude Code Development Handoff Spec (v1.11)

**Owner:** E. Patricia Rogers — Unmatched Logistics LLC
**Build tool:** Claude Code (code-native only — no workflow-JSON artifacts)
**Status:** READY for Claude Code development, with 8 known gaps and a prioritized backlog (Section 6)
**Verified:** 2026-09-07 — all five test suites green (evidence in Section 2)

---

## 1. Readiness verdict

**Verdict: ESSENTIAL IS READY for development in Claude Code.** This is a
standard TypeScript repo (ES2022, strict, `tsc --noEmit` clean), fully
code-native (zero workflow-JSON artifacts), with a `CLAUDE.md` present and all
five automated suites passing. It can be opened in Claude Code today and
developed incrementally. The 8 gaps in Section 5 are *scoped tasks*, not
blockers — each has a definition of done.

### Evidence (command outputs, 2026-09-07)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | `TSC_EXIT=0` |
| Fake-queue round-trip | `npx tsx apps/api/roundtrip-test.ts` | 21/21 PASS, `RT_EXIT=0` |
| Neo assistant | `npx tsx apps/api/neo-test.ts` | 12/12 PASS, `NEO_EXIT=0` |
| Production hardening | `npx tsx apps/api/prod-test.ts` | 25/25 PASS, `PROD_EXIT=0` |
| Live integration (Redis+Postgres+BullMQ) | `npx tsx apps/api/live-integration-test.ts` | 19/19 PASS, `LIVE_EXIT=0` |

### What is genuinely built (not stubbed)
- Full pipeline: topic-select → research/strategy → copy → render → preview →
  two-stage approval → publish (BullMQ workers, Postgres persistence)
- Live stack: real Redis queues/workers + Postgres `PgDraftStore`
- Neo embedded AI (RAG-lite over capability registry, SSE streaming, rate limit)
- M10 auth (scrypt+pepper, JWT sessions, login rate limiter)
- Error taxonomy, retry/timeout, structured logging/tracing
- 5 platform adapters (Facebook, Instagram, LinkedIn, TikTok, YouTube) in mock
  mode; per-platform length validation (Instagram 10-min cap → 422)
- Docker Compose: postgres + redis + api + worker, all healthchecked

### What is NOT built (gaps — see Section 5)
- Thin entrypoints (`apps/api/server.ts` 17 lines, `apps/worker/server.ts` 14
  lines) do not wire the live stack by default
- Tool registry declares 13 tools but only `pollinations` + `pexels` are
  concrete; the other 11 are documented stubs
- Auth `UserStore`/`SessionStore` are in-memory (sessions lost on restart)
- No LLM eval harness, no per-client usage/cost caps, no `/metrics`, no
  process-level unhandled-rejection guards
- Build-time TODO markers at real-call sites: `packages/heygen/index.ts:102`,
  `packages/ai/strategist.ts:62`, `packages/media/index.ts:78`,
  `packages/media/vendors.ts:57` (Argil endpoint unconfirmed)

---

## 2. Architecture map

```
Client dashboard (Fastify API, apps/api)
   |  topic-select -> render -> preview -> approve -> publish
   v
BullMQ queues (Redis)  essential-research / copy / media / publish
   |  (queue + job-ID names must NOT contain ':' — BullMQ restriction)
   v
Workers (apps/worker/live-worker.ts) run REAL processors, write back to Postgres
   v
Postgres (packages/persistence PgDraftStore: essential_drafts JSONB table)
```

| Path | Module | Responsibility |
|---|---|---|
| `apps/api/index.ts` | Fastify API | All routes, `DraftStoreLike` (sync/async seam), `buildEssentialApp(opts)` |
| `apps/api/server.ts` | API entrypoint | Thin — MUST be wired to live stack (gap G1) |
| `apps/worker/processors.ts` | Processors | `processStrategy/Copy/Media/Publish`, queue-name constants |
| `apps/worker/live-queues.ts` | Live queues | BullMQ adapters, sanitizes `:` in queue + job IDs |
| `apps/worker/live-worker.ts` | Live workers | Consume queues, write results to Postgres |
| `apps/worker/publish.ts` | Publish worker | Platform publish flow |
| `packages/ai/strategist.ts` | Strategist | Research → 15-min strategy + optional podcast script |
| `packages/ai/copywriter.ts` | Copywriter | Platform-native copy, compliance, hashtags |
| `packages/ai/gemini.ts` | Gemini client | Model routing + structured output (mock-aware) |
| `packages/neo/index.ts` | Neo | Embedded AI: capabilities manifest, grounded chat, topic search, SSE |
| `packages/media/*` | Media | Video/image/both, vendor adapters, platform limits, segment+stitch |
| `packages/approvals/index.ts` | Approvals | Two-stage state machine (preview → per-platform) |
| `packages/auth/index.ts` | Auth | M10: scrypt+pepper, JWT, rate limiter |
| `packages/persistence/index.ts` | Persistence | `PgDraftStore` (generic over record type) |
| `packages/tools/index.ts` | Connected Tools | BYOK registry (13 declared, 2 concrete) |
| `packages/core/*` | Core | errors, retry, logger |
| `adapters/*` | Platform adapters | facebook, instagram, linkedin, tiktok, youtube (mock-first) |
| `apps/api/*-test.ts` | Test harnesses | roundtrip, neo, prod, live-integration |

---

## 3. Build & test commands

```bash
npm install
npx tsc --noEmit                     # typecheck (strict) — must be 0
npx tsx apps/api/roundtrip-test.ts   # fake queues + in-memory store
npx tsx apps/api/neo-test.ts         # Neo assistant
npx tsx apps/api/prod-test.ts        # auth, errors, retry, logging
npx tsx apps/api/live-integration-test.ts  # real Redis + Postgres + BullMQ
docker compose up --build -d         # full stack: postgres, redis, api, worker
```

Live test prerequisites (local dev):
```bash
redis-server --daemonize yes
sudo pg_ctlcluster 16 main start
sudo -u postgres psql -c "CREATE ROLE essential LOGIN PASSWORD 'essential_dev';"
sudo -u postgres psql -c "CREATE DATABASE essential OWNER essential;"
```

Env vars: `REDIS_HOST/PORT`, `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`,
`LOG_LEVEL`, `PASSWORD_MIN_LENGTH/PASSWORD_REQUIRE_SPECIAL`, mock platform
tokens (`FB_PAGE_ACCESS_TOKEN`, `YOUTUBE_ACCESS_TOKEN`, etc. — all `mock_*` in
dev). Never commit real tokens.

---

## 4. Coding conventions (Claude Code must follow)

1. **Code-native only.** No workflow-JSON artifacts (n8n etc.). JSON is used
   only as HTTP payloads. No `.json` config files beyond `package.json`,
   `tsconfig.json`, `package-lock.json`.
2. **Mock-first.** No live LLM/vendor/platform calls unless
   `LIVE_PUBLISH=true`. No secrets in source — keys come from the environment.
3. **TypeScript strict.** `tsconfig.json`: ES2022, `strict: true`, `noEmit`,
   `moduleResolution: bundler`. Every new file must pass `npx tsc --noEmit`.
4. **BullMQ constraint.** Queue names and custom job IDs must NOT contain `:`
   (Redis keys). Use `essential-research` style names; sanitize job IDs.
5. **Store seam.** Persistence goes through `DraftStoreLike` (sync or async).
   In-memory `DraftStore` for tests; `PgDraftStore` for production.
6. **Every change ships a test.** A fix without a passing assertion in one of
   the harnesses does not count as landed.
7. **Error taxonomy.** Throw `EssentialError` subclasses (NotFoundError,
   AuthError, RateLimitError, UpstreamError...) — never bare `Error`.
8. **Documentation.** Update `ESSENTIAL_BLUEPRINT.md` + this spec when
   behavior changes; bump the version line.

---

## 5. Known gaps (evidence-backed)

| # | Gap | Evidence | Impact |
|---|---|---|---|
| G1 | Entrypoints don't wire the live stack | `apps/api/server.ts` (17 lines), `apps/worker/server.ts` (14 lines) | `docker compose up` doesn't run the real pipeline by default |
| G2 | Tool registry overclaims | `packages/tools/index.ts`: 13 `ToolId`s, only `pollinations`+`pexels` concrete (lines 121, 127) | BYOK marketing exceeds actual capability |
| G3 | Auth stores in-memory | `packages/auth/index.ts` `UserStore`/`SessionStore` | Sessions lost on restart |
| G4 | No LLM eval harness | no golden-set tests for strategy/copy quality | Can't measure quality before scaling clients |
| G5 | No per-client cost controls | no usage ledger/caps on BYOK or vendor minutes | Unbounded spend; profitability risk |
| G6 | No `/metrics` | logs exist, no Prometheus counters | No operational visibility |
| G7 | No process-level guards | entrypoints lack unhandled-rejection handlers | A stray rejection kills the process |
| G8 | Build-time TODO markers | `heygen/index.ts:102`, `strategist.ts:62`, `media/index.ts:78`, `vendors.ts:57` (Argil endpoint) | Live vendor calls not yet implemented |

---

## 6. Prioritized next-sprint backlog (acceptance criteria per task)

**Sprint A — make `docker compose up` run the real product (G1, G7)**
- A1. Rewrite `apps/api/server.ts` to bootstrap `PgDraftStore` + live queues +
  auth + Neo by default (env-driven). AC: `docker compose up` → `/health` 200,
  topic-select persists to Postgres.
- A2. Rewrite `apps/worker/server.ts` to start live workers with
  `process.on('unhandledRejection')` guard. AC: worker consumes a job end-to-end;
  an injected rejection logs and continues, exit code 0.

**Sprint B — make the tool registry honest (G2)**
- B1. Mark the 11 stub tools `status: 'planned'` in the registry and expose it
  via `/api/tools`. AC: registry reflects reality; UI shows "planned" badges.
- B2. Implement the two highest-value adapters: Perplexity (research, for Neo
  topic search) and ElevenLabs (voiceover for podcast scripts). AC: each has a
  mock-mode test + live call behind `LIVE_PUBLISH=true`.

**Sprint C — persist auth + add cost controls (G3, G5)**
- C1. Back `UserStore`/`SessionStore` with Postgres (same pattern as
  `PgDraftStore`). AC: restart survives; login persists.
- C2. Add a usage ledger (per-client video count, BYOK calls) + per-client caps
  enforced at topic-select/render. AC: hitting a cap returns 429/422 with a
  clear message; ledger rows in Postgres.

**Sprint D — observability + quality (G4, G6)**
- D1. Add `/metrics` (Prometheus counters: requests, jobs, errors, vendor
  spend). AC: `/metrics` scrapes; counters increment on real traffic.
- D2. Add an eval harness: golden set of 10 topics, assert strategy ≥15 min and
  copy within platform limits. AC: `npx tsx apps/api/eval-test.ts` exits 0.

**Sprint E — live vendor calls (G8)**
- E1. Implement HeyGen render-create + status polling behind `LIVE_PUBLISH`.
  AC: mock + live paths both tested; confirm Argil endpoint via docs.argil.ai.

---

## 7. Claude Code project-context conventions (applied to this repo)

- `CLAUDE.md` at repo root is the project memory file — loaded at launch
  (per Anthropic docs: files in the directory hierarchy above the working
  directory load at launch; subdirectory files load on demand).
- Keep this spec as the single root `CLAUDE.md` (or the primary reference it
  points to). Do not split into many scattered memory files.
- Optional extensions (all documented by Anthropic): `.claude/rules/` for
  file-type-scoped rules, `.claude/settings.json` for permissions /
  `allowedTools`, custom slash commands, subagents, and hooks (PreToolUse /
  PostToolUse for running the test suites after edits).
- Recommended settings: run `npx tsc --noEmit` + the affected harness on every
  edit (a hook makes this automatic); keep `LIVE_PUBLISH=false` in dev.

---

## 8. Definition of done (for any sprint)

1. `npx tsc --noEmit` exits 0.
2. All five harnesses pass: roundtrip, neo, prod, live-integration (and eval
   once built).
3. Every changed file has a passing assertion covering the new behavior.
4. `ESSENTIAL_BLUEPRINT.md` + this spec updated; version bumped.
5. No secrets in source; no workflow-JSON artifacts introduced.
