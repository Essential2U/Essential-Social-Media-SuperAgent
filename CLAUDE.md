# CLAUDE.md - Essential (Social Media Super Agent)

**Owner:** E. Patricia Rogers - Unmatched Logistics LLC
**Build tool:** Claude Code. Code-native TypeScript monorepo. No node-based automation tools (no n8n, no workflow-JSON files).

## What this project is

An autonomous agent that (a) mines the web and social platforms for viral topics and generates 20 attention-grabbing trending topics each week, and (b) lets clients enter their own topic, pick how many content pieces to generate (dropdown 1-10, max 10), and choose image / video / both. Every script Essential generates is a **minimum of 15 minutes of spoken content** (`MIN_CONTENT_MINUTES` = 15). The client picks the video length from a dropdown that **begins at 3 minutes** (options 3, 5, 7, 10, 15, 30, 60) capped by each platform's maximum (e.g. Facebook max 240 minutes). Topics and content transfer into **podcast scripts**; if the client selects podscript, Essential creates audio AND video from the selected topic. A text-to-video/audio tool prepares content for YouTube.

**Talking-head video is easy to connect:** the client picks a topic, Essential hands the chosen content to **HeyGen, Synthesia, D-ID, or Argil** to render it into a video (avatar + voice), shows a **preview of the rendered video**, and after the client approves the video and/or images (or both), Essential **automatically posts to all selected platforms and YouTube**. Publishing runs only on platforms with connected credentials. The system schedules, audits, and learns.

Full specification: `ESSENTIAL_BLUEPRINT.md` (v1.8) - Section 1 stack, Section 4 module contracts, Section 5 verified API endpoints, Section 7 build milestones (M0-M14), Section 9 hard constraints, Section 15 Connected Tools (BYOK), Section 16 Language & UX, Section 19 Client Topic Research Flow, Section 20 Text-to-Media, Section 21 Video Lengths, Podcast Scripts & HeyGen Avatar Video. This file is the operating manual; the blueprint is the contract.

## Non-negotiable constraints (blueprint Section 9)

1. **Code-native only** - no node-based automation, no workflow-JSON files.
2. **Never store or log plaintext** tokens / passwords / 2FA; everything from env or a secrets manager.
3. **Never publish without BOTH approvals** (draft + final) present and active.
4. **Never invent statistics or claims** in copy.
5. **Never hard-code** client IDs or tokens in source.
6. **Never post to a live business account** before the M6 test-account pass.
7. **Never skip the compliance gate.**
8. **Never add a platform** without a verified API reference.
9. **Never bypass the Gemini visual-QA or Canva autofill** steps in media production.
10. **Never hard-code model IDs** - read model names from env config.
11. **Never store or log plaintext passwords** - argon2id + pepper; reset tokens hashed and expiring.
12. **Never ask for or store raw platform credentials** - OAuth connections only.
13. **Never publish to a platform without a connected credential** - degrade gracefully, skip, and log.
14. **Never accept a password shorter than 8 chars or without a `! # $ * %` special char** - enforce at registration, reset, and change-password.
15. **Never store a client tool API key in the browser, localStorage, or logs** - encrypt at rest (AES-256-GCM), server-side only.
16. **Never invent a hosted API for a local-only tool** - DaVinci Resolve has no cloud API; its adapter is a documented local/desktop stub.
17. **Never generate a script shorter than 15 minutes** - `MIN_CONTENT_MINUTES` = 15 is a hard floor for every topic and podcast script.
18. **Never fake a segmented render** - if the script exceeds a vendor's single-clip cap (e.g. D-ID max 5 min), segment + stitch for real; never claim a single render that exceeds the vendor's cap.

## Repo layout

```
essential/
|- apps/api         # Fastify HTTP API (ingest, webhooks, approval callbacks)
|- apps/worker      # BullMQ consumers - index.ts (queues/workers/local runner), processors.ts, publish.ts, m6-test.ts - DONE
|- packages/
|  |- core          # shared types, config, env
|  |- db            # Prisma schema + client (PostgreSQL)
|  |- ai            # gemini.ts brain - DONE; strategist.ts + copywriter.ts - DONE
|  |- media         # platform-limits.ts (dropdown 3-15+), vendors.ts (HeyGen/Synthesia/D-ID/Argil), index.ts (render/segment/stitch/preview) - DONE
|  |- design        # Canva Connect producer (autofill, export)
|  |- adapters      # facebook/linkedin/instagram/tiktok/youtube + index.ts registry - DONE
|  |- approvals     # two-stage state machine - DONE
|  |- heygen        # avatar+voice video renderer - DONE
|  |- analytics     # audit log, content library, metrics feedback
|  |- tools         # Connected Tools (BYOK): per-tool adapters + key vault - DONE
|  |- i18n          # en.json / es.json locale bundles + language service - TODO
|- ESSENTIAL_BLUEPRINT.md
|- CLAUDE.md
|- .env.example
|- tsconfig.json
```

## Build status (verified)

**Done:** `adapters/{facebook,linkedin,instagram,tiktok,youtube}.ts`, `adapters/index.ts`, `packages/ai/gemini.ts`, `packages/ai/strategist.ts`, `packages/ai/copywriter.ts`, `packages/media/platform-limits.ts`, `packages/media/vendors.ts`, `packages/media/index.ts`, `packages/heygen/index.ts`, `packages/tools/index.ts`, `packages/approvals/index.ts`, `apps/worker/index.ts` (BullMQ queues/workers + local runner), `apps/worker/processors.ts`, `apps/worker/publish.ts`, `apps/worker/m6-test.ts`. `npx tsc --noEmit` passes (exit 0). M6 test-account pass executes in mock mode (`npx tsx apps/worker/m6-test.ts`).

**Next (in order):** full Fastify API wiring -> M10 auth -> M11 credentials -> M12 weekly digest -> M13 Connected Tools (BYOK) -> M14 Language & UX.

## Working on this repo (Claude Code)

- **Typecheck gate:** `npx tsc --noEmit` must pass before any "done" claim.
- **Mock-first:** every adapter, the Gemini client, the tools manager, the approvals machine, the strategist/copywriter, the media producer, and the HeyGen client default to mock mode; `LIVE_PUBLISH=true` is the only way to hit real APIs. Never enable it for production accounts before M6.
- **Milestones:** follow blueprint Section 7 M0-M14 in order; each milestone has an acceptance test.
- **Worker chain:** research -> strategy -> copy -> media -> preview -> publish. BullMQ queues in `apps/worker/index.ts`; the same processors run in-process via `createLocalRunner()` for dev and the M6 test (no Redis needed). Job ids are idempotency keys (`draftId:stage`).
- **Subagents / slash commands** (create under `.claude/agents/` and `.claude/commands/`):
  - `strategist` - Claude + Gemini co-strategy with fallback routing
  - `adapter-builder` - new platform adapters against the `PlatformAdapter` contract + registry
  - `compliance-checker` - length / CTA / claim validation gate
  - `auditor` - audit-log, content-library, and analytics queries
- **MCP servers to configure** (`claude mcp add`): Slack (approval pings), Google Sheets (audit log), PostgreSQL + Redis (local dev), S3-compatible storage.
- **Scheduling:** production publish scheduling is **BullMQ repeatable jobs in-repo** (blueprint Section 4.7). Claude Code's `/loop` and scheduled tasks are for dev-time automation only - never production publishing.

## Talking-Head Video, Podcast Scripts & HeyGen - blueprint Section 21

- **15-minute floor:** every script (topic content or podcast script) is at least `MIN_CONTENT_MINUTES` = 15 minutes of spoken content. Never generate shorter.
- **Video length dropdown:** begins at 3 minutes (options 3, 5, 7, 10, 15, 30, 60), capped per platform. `validateVideoLength(platform, minutes)` rejects under 3 min or over the platform max.
- **Easy talking-head connect:** Settings -> Talking-Head Video -> pick a vendor (HeyGen recommended, or Synthesia/D-ID/Argil) -> enter Avatar ID + Voice ID (or pick a stock avatar) -> saved per client.
- **Vendor handoff:** the client selects topics; Essential hands the chosen content/script to the vendor (`packages/media`, `packages/heygen`).
- **Segmented render + stitch:** if the script exceeds the vendor's single-clip cap (D-ID max 5 min, HeyGen max 30 min/scene, Synthesia 150 scenes x 5 min), Essential segments the script and stitches the renders (ffmpeg). A 15-min video is >=3 segments for D-ID, one scene for HeyGen. Never fake this.
- **Preview + auto-post:** when the vendor completes, Essential provides a preview of the rendered video; the client approves the video and/or images (or both); Essential automatically posts to all selected platforms and YouTube, gated by the two-stage approval lock.

## Connected Tools (BYOK) - blueprint Section 15

Clients connect third-party AI tools to Essential by generating an API key on the tool's website and pasting it into Essential. Every tool is optional; Essential works with free tools, paid tools, or none.

**Connect flow:** Settings -> Connected Tools -> click a tool -> Essential opens the tool's website in a new tab -> client signs up + generates a key -> pastes it into Essential's secure field -> encrypted at rest (AES-256-GCM), only a `keyHint` (last 4 chars) stored -> used server-side. Keys can be added / replaced / removed anytime; media production falls back to the next available tool.

**Approved tool set (free-first):** Pollinations (no key, no signup), Pexels (free), Unsplash (free), Gemini (free tier), Clipdrop (100 free credits), Leonardo AI (~$5 free credit), Stability AI (trial, unconfirmed), ElevenLabs (free tier + Startup Grant), Perplexity (trial credits), Runway (paid-opt-in), HeyGen (paid-opt-in), Canva (design; Connect API free for developers per official docs - verify access tier), DaVinci Resolve (pro video editing; local desktop companion only - no hosted cloud API, client-side stub), Synthesia / D-ID / Argil (avatar video alternatives).

**Media routing:** image/video production uses connected tools in free-first order; missing or exhausted key -> fall back to the next tool; none available -> clear "connect a tool" prompt.

## Client Topic Flow & Text-to-Media - blueprint Sections 19-20

- **Two entry buttons on the dashboard:** "Research My Topic" (client enters their own topic) and "Essential-Generated Topics" (the 20 weekly trending topics). Both converge on the same draft -> approval -> media -> preview -> publish pipeline.
- **Count dropdown:** client picks 1-10 content pieces (capped at `CLIENT_TOPIC_MAX` = 10); Essential researches the topic and generates exactly that many drafts.
- **Media selector:** per topic the client chooses **image**, **video**, or **both**.
- **Text-to-Media:** `POST /api/clients/:id/text-to-media` turns the client's written text into an image, a video, or both (Section 4.19).
- **Preview + approval:** every piece gets a preview (content, image, and/or video); the client approves or rejects, then approves per selected platform before anything is posted. Publishing runs only on platforms with connected credentials.

## Accounts, Password & UX - blueprint Section 10, Section 16

- **Password policy (client requirement):** minimum 8 characters AND at least one special char from `! # $ * %`. Enforced at registration, reset, and change-password. Configurable via `PASSWORD_MIN_LENGTH` / `PASSWORD_REQUIRE_SPECIAL` (defaults enforce the rule). Hash with argon2id + pepper; never plaintext.
- **Spanish:** account-level `language` setting (`en` | `es`); locale bundles `en.json` / `es.json`. Switching to Spanish translates the full UI AND instructs the AI to generate captions, titles, and descriptions in Spanish.
- **Remember username:** login "Remember me" checkbox saves only the email (never the password) in a cookie and pre-fills it on the next visit. Toggle via `REMEMBER_USERNAME_ENABLED`.

## Legacy n8n artifacts - DELETED

All legacy n8n artifacts (essential_superagent_n8n.json,
facebook_pages_superagent_n8n.json, build_essential_workflow.py,
social_superagent_setup.md) and the POC verification.json were deleted from
the repo. Essential is developed in Claude Code only - code-native TS, no
workflow-JSON. JSON appears only as HTTP request/response payloads.
## Environment (see `.env.example`)

`DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `HEYGEN_API_KEY`, `RUNWAY_API_KEY`, `META_APP_ID`/`META_APP_SECRET`, `FB_PAGE_ID`/`FB_PAGE_ACCESS_TOKEN`, `INSTAGRAM_IG_ID`/`INSTAGRAM_TOKEN`, `LINKEDIN_CLIENT_ID`/`CLIENT_SECRET`/`ORG_URN`, `TIKTOK_ACCESS_TOKEN`/`OPEN_ID`, `YOUTUBE_ACCESS_TOKEN`, `SLACK_*`, `CANVA_*`, `LIVE_PUBLISH`.

**Connected Tools (v1.7):** `POLLINATIONS_ENABLED`, `PEXELS_API_KEY`, `UNSPLASH_API_KEY`, `CLIPDROP_API_KEY`, `LEONARDO_API_KEY`, `STABILITY_API_KEY`, `ELEVENLABS_API_KEY`, `TOOL_VAULT_KEY` (AES-256-GCM vault key).

**Accounts & UX (v1.7):** `PASSWORD_MIN_LENGTH` (default 8), `PASSWORD_REQUIRE_SPECIAL` (default true, `! # $ * %`), `DEFAULT_LANGUAGE` (`en` | `es`, default `en`), `REMEMBER_USERNAME_ENABLED` (default true), `PASSWORD_PEPPER`.

**Client Topic, Video & Talking-Head (v1.7):** `CLIENT_TOPIC_MAX` (dropdown 1-10, default 10), `TEXT_TO_MEDIA_ENABLED` (default true), `MIN_CONTENT_MINUTES` (default 15), `VIDEO_LENGTH_DEFAULT` (default 3), `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID`, `AVATAR_VENDOR_DEFAULT` (`heygen` | `synthesia` | `did` | `argil`), `SEGMENT_MAX_MINUTES` (default 5).


## 22. One-Click Connect (OAuth) + Dashboard API (sync)

- Connect method: OAuth "Connect with [Platform]" buttons. Never username/password
  (violates ToS, breaks with 2FA). Manual token paste only as M6 mock fallback.
- Scopes: FB pages_manage_posts (App Review for Advanced Access), IG
  instagram_business_content_publish, YT youtube.upload, TikTok video.publish
  (audit for public), LinkedIn w_organization_social (app approval + legal entity).
- Routes: /api/clients/:id/connections/* (start/callback/status/disconnect) and
  topic-select -> drafts/:id (GET, render, preview, preview/approve, approve,
  publish, status). Render/publish are async: 202 + jobId, poll or webhook.
- Errors: 400/401/403/404/409/422/429/500. JSON bodies.


## 23. Fastify API + client instructions (sync)

- apps/api/index.ts implements the Section 22 routes as a Fastify plugin bound
  to the BullMQ queues (topic-select -> render -> preview -> approve -> publish).
- Client instructions (plain language) live in blueprint Section 23.2.
- Legacy n8n artifacts and POC verification.json deleted. No workflow JSON for
  Essential development; JSON only as HTTP payloads.


## 24-25. Audit + runbook (sync)

- Audit fixed: strategist return shape, copywriter hook, strategy handoff to
  copy, render uses real podcast script, package name "essential", added
  apps/api/server.ts + apps/worker/server.ts entrypoints, Dockerfile +
  docker-compose.yml (redis/api/worker with healthchecks). Proven: TSC exit 0,
  round-trip test 20/20.
- Competitive + profitability + hosting analysis in blueprint Section 24.
- Step-by-step runbook in RUNBOOK.md and blueprint Section 25.

## 26. Production Hardening (v1.9)

Landed code that turns the audit's open gaps into tested behavior. Every item
below has a passing assertion in `apps/api/prod-test.ts` or the round-trip
harness.

### 26.1 Error taxonomy (packages/core/errors.ts)
Single error hierarchy: `EssentialError` with stable `code`, `statusCode`,
`retryable`. Codes: NOT_FOUND(404), VALIDATION(400/422), UNAUTHENTICATED(401),
FORBIDDEN(403), RATE_LIMITED(429), CONFLICT(409), UPSTREAM(502, retryable),
INTERNAL(500). `toHttpError()` maps ANY thrown value to a consistent JSON body
`{ code, message, retryable, details? }`. The Fastify app registers one
`setErrorHandler` using it, so clients always get the same shape.

### 26.2 Reliability (packages/core/retry.ts)
- `withRetry(fn, { maxAttempts, baseDelayMs, maxDelayMs, timeoutMs, retryable })`
  - exponential backoff + jitter, default 3 attempts / 200ms / 2s cap / 30s timeout.
- `withTimeout(promise, ms, label)` - deadline enforcement for hung calls.
- Wire into the worker processors so a transient UPSTREAM error retries and a
  hung vendor call is cut off instead of blocking the queue.

### 26.3 Structured logging + tracing (packages/core/logger.ts)
JSON-lines logger with levels (debug/info/warn/error) and child loggers that
bind `traceId`. The API emits `request_start` / `request_end` per request with
method, url, statusCode, traceId. Greppable and parseable by Datadog/CloudWatch/
Loki. Set `LOG_LEVEL` env to control verbosity (default info).

### 26.4 M10 auth (packages/auth/index.ts) - self-contained, no external deps
- Password policy: min 8 chars + at least one of `!#$*%` (env-configurable via
  PASSWORD_MIN_LENGTH / PASSWORD_REQUIRE_SPECIAL).
- Hashing: scrypt (N=16384) + per-account salt + server-side pepper. Format
  `scrypt$N$r$p$salt$hash`. (argon2id remains the blueprint target; scrypt is
  the built-in NIST-approved equivalent until the argon2 package is added.)
- Sessions: HS256 JWT with expiry, timing-safe verification, revocable
  SessionStore. `signJwt` / `verifyJwt` exported for reuse.
- Rate limiting: sliding-window `RateLimiter` - login allows 5 attempts / 60s,
  the 6th returns 429.
- Persistence seam: `UserStore` / `SessionStore` are in-memory; swap for Prisma
  through the same interface without touching route code.
- Routes: `POST /api/auth/register` (201 + JWT), `POST /api/auth/login` (200 +
  JWT, rate-limited), `GET /api/auth/me`. When auth is enabled, every
  `/api/clients/*` route requires `Authorization: Bearer <jwt>` (401 otherwise).

### 26.5 CI (`.github/workflows/ci.yml`)
GitHub Actions on push/PR: install -> `npx tsc --noEmit` -> round-trip test ->
prod hardening test. Any regression fails the build before merge.

### 26.6 Test coverage
`apps/api/prod-test.ts` (run: `npx tsx apps/api/prod-test.ts`):
- error taxonomy mapping (404/401/500, retryable UPSTREAM)
- withRetry succeeds after transient failures; throws after maxAttempts;
  withTimeout rejects after deadline
- structured logging: single JSON line, traceId bound on child logger
- password policy rejects weak / accepts strong; hash/verify roundtrip
- JWT sign/verify roundtrip; expired token rejected
- register 201 + JWT; /me 200; wrong-password login 401; rate limit 429
- protected client route: no token -> 401, valid token -> 202
- request_start / request_end logging emitted

`apps/api/roundtrip-test.ts` (unchanged, still green): topic-select -> render ->
preview -> approvals -> publish, plus 422 on Instagram 15-min over-limit.

### 26.7 Verified results (2026-09-07)
- `npx tsc --noEmit` -> exit 0
- `npx tsx apps/api/roundtrip-test.ts` -> 21 assertions PASS, exit 0
- `npx tsx apps/api/prod-test.ts` -> all PASS, exit 0
- `docker-compose.yml` -> services [redis, api, worker], YAML valid

### 26.8 Backlog (not landed this turn - ordered)
1. Tool-call sandboxing: run Connected-Tools BYOK calls in an isolated worker
   (timeout + resource caps) to prevent a misbehaving tool from taking down the
   main process.
2. Streaming/cancellation: SSE progress on draft status + POST cancel for a
   draft's running jobs.
3. Prisma persistence: swap DraftStore / UserStore / SessionStore to Postgres.
4. Real Redis + BullMQ wiring (docker-compose already provides redis).
5. Live LLM + live avatar-vendor calls behind the BYOK gate.
6. OAuth PKCE for platform connections (facebook/instagram/youtube/linkedin/
   tiktok) replacing manual token paste.

## 27. Live Redis + Postgres stack (v1.10)

Items 3-4 of the production backlog are landed: real BullMQ queues/workers and
Postgres persistence, behind the same interfaces the fake-queue harness uses.

### 27.1 Persistence (packages/persistence/index.ts)
`PgDraftStore` implements the same create/get/update contract as the in-memory
`DraftStore` but backed by an `essential_drafts` table (JSONB record +
timestamps). `initSchema()` is idempotent (`CREATE TABLE IF NOT EXISTS` +
`CREATE SEQUENCE IF NOT EXISTS`) so boot-time migration is safe. The API now
accepts a `DraftStoreLike` (sync or async) and awaits every store call, so the
identical round-trip runs on memory or Postgres.

### 27.2 Live queues (apps/worker/live-queues.ts)
`createLiveQueues()` returns the same `EssentialQueues` surface backed by real
BullMQ `Queue` instances on Redis (queues: essential-research / copy / media /
publish). BullMQ queue names must not contain ':' (they are Redis keys).

### 27.3 Live workers (apps/worker/live-worker.ts)
`startLiveWorkers()` runs real BullMQ `Worker`s that execute the REAL
processors and write results back to Postgres (copy -> draft.copy, media ->
draft.media + previewUrls + status preview_ready), mirroring the fake-queue
write-back so behavior is identical on both backends. The API and workers share
one ApprovalStateMachine instance, so the two-stage gate is enforced for real.

### 27.4 Integration test (apps/api/live-integration-test.ts)
Full-pipeline test against live Redis + Postgres + BullMQ:
topic-select -> research/copy worker -> render worker -> preview -> two-stage
approve -> publish worker. Asserts: 202s, copy persisted, preview_ready,
preview URLs, approvals, publish 202, row persisted in Postgres with status
'published', media job completed in Redis, and 422 on Instagram 15-min.

### 27.5 Verified results (2026-09-07)
- `npx tsc --noEmit` -> exit 0
- `npx tsx apps/api/roundtrip-test.ts` -> 21 assertions PASS (fake backends)
- `npx tsx apps/api/live-integration-test.ts` -> all PASS (live Redis+Postgres)
- `docker-compose.yml` -> services [redis, postgres, api, worker]

## 28. Hosting cost study (2026-09-07, sources cited)

Target workload: 2 containers (API + worker), managed or on-box Postgres and
Redis. Figures are list prices from vendor pricing pages as of 2026-09-07.

| Provider | Compute (API+worker) | Postgres | Redis | Est. monthly | Source |
|---|---|---|---|---|---|
| Hetzner Cloud | CX22 ~EUR4.49/mo (2 vCPU/4GB, all 4 containers on one box) | on-box | on-box | ~$6-9 | hetzner.com/cloud, cloudron forum (2026 increase) |
| Railway | Hobby $5/mo min + usage (CPU/RAM/vol/egress) | Postgres plugin | Redis plugin | ~$10-20 | railway.com/pricing, srvrlss.io |
| Render | 2x Starter $7/mo (512MB/0.5 CPU) | Starter $7/mo (256MB/0.1 CPU) | $10/mo or BYO | ~$31 | render.com/pricing, checkthat.ai |
| Fly.io | shared-cpu-1x $2.02/mo per machine | Managed Postgres Basic $38/mo (Shared-2x 1GB) | Upstash Redis add-on | ~$47-50 | fly.io/docs/about/pricing, fly community MPG pricing |
| Google Cloud Run | 2 services, $0.000018/vCPU-sec + $0.000002/GiB-sec, free 240k vCPU-sec + 2M req/mo | Cloud SQL (from ~$8-25) | Upstash/Memorystore | ~$10-25 | cloud.google.com/run/pricing |
| AWS Fargate | 2 tasks, $0.000011244/vCPU-sec + $0.000001235/GB-sec (us-east-1), 1-min min | RDS (from ~$15) | ElastiCache/Upstash | ~$20-35 | aws.amazon.com/fargate/pricing |

### 28.1 Recommendation
- Cheapest: Hetzner Cloud single CX22/CPX11 box running the docker-compose
  stack (~$6-9/mo). Best price-performance per hetzner.com/cloud; note the
  June 2026 price increases (up to 3.1x on some lines per northflank.com).
- Easiest managed: Render (~$31/mo) or Railway (~$10-20/mo) — zero ops, built-in
  healthchecks, managed Postgres/Redis.
- Avoid managed Postgres on Fly ($38/mo Basic) at small scale.
- Cloud Run/Fargate are competitive only once traffic justifies serverless or
  when you already run in GCP/AWS.

### 28.2 Profitability note
At $49-99/mo per client (BYOK model), break-even is ~5-10 clients on Render or
~2-3 clients on Hetzner. Hosting is not the cost driver; avatar-vendor minutes
and LLM tokens are (see Section 25).

## 29. Neo - embedded AI assistant + gap audit (v1.11)

### 29.1 Neo (packages/neo/index.ts)
Neo is the embedded AI assistant that lets clients ask questions about
Essential's functions and capabilities and search topics. It is RAG-lite:
keyword retrieval over a capability corpus (built from the verified feature set
plus the live PLATFORM_REGISTRY), grounded answers, session memory, and a
sliding-window rate limiter. It reuses the existing Gemini client for
generation when live (LIVE_PUBLISH=true) and returns deterministic grounded
answers in mock mode.

Routes:
- GET  /api/neo/capabilities  - full capability manifest
- POST /api/neo/chat          - grounded Q&A { question, sessionId? }
- POST /api/neo/search        - topic/capability search { query }
- GET  /api/neo/chat?q=...    - SSE streaming chat

### 29.2 Neo tests (apps/api/neo-test.ts) - verified 2026-09-07
- capabilities manifest >= 12 entries
- chat returns grounded answer; video question grounded in YouTube
- topic search surfaces avatar/video doc
- follow-up chat uses session context
- SSE streaming emits data frames
- rate limit returns 429 after maxAsksPerMinute

### 29.3 Gap audit (file evidence)
1. In-memory default store: apps/api/index.ts line ~250
   `const drafts: DraftStoreLike = opts.draftStore ?? new DraftStore();` -
   production default is in-memory unless the caller injects PgDraftStore.
   FIX: make apps/api/server.ts bootstrap PgDraftStore + live queues by default.
2. Entrypoints are thin: apps/api/server.ts (~491 bytes) and
   apps/worker/server.ts (~414 bytes) do not wire the live stack. FIX: wire
   PgDraftStore + createLiveQueues + startLiveWorkers in the entrypoints.
3. Tool registry overclaims: packages/tools/index.ts declares 13 ToolIds but
   only pollinations and pexels have concrete registry entries; the rest are
   stubs. FIX: implement adapters or mark 'planned' in the registry.
4. Auth persistence: packages/auth/index.ts UserStore/SessionStore are
   in-memory; sessions are lost on restart. FIX: Postgres-backed stores.
5. No LLM eval harness: no golden-set tests for strategy/copy quality. FIX:
   add an eval suite (unit economics + quality) before scaling clients.
6. No per-client cost controls: no quota/usage caps per client on BYOK or
   vendor minutes. FIX: add usage ledger + per-client caps (profitability).
7. Observability lacks metrics: structured logs exist but no /metrics
   endpoint. FIX: expose Prometheus-style counters.
8. No global unhandled-rejection guard in the entrypoints. FIX: add
   process-level handlers + healthcheck.

### 29.4 Tool-integration recommendations (enhance performance)
- Embeddings for Neo: swap keyword retrieval for a local embedding index
  (e.g. sqlite-vec or pgvector) to improve recall on fuzzy questions.
- Add a search tool for Neo: connect Perplexity (research) so Neo can answer
  questions about topics, not just Essential itself.
- Add ElevenLabs voiceover to the media pipeline (already a BYOK tool) for
  podcast scripts.
- Add Canva Autofill (already BYOK) to generate on-brand image posts.
- Add a scheduling calendar (native scheduling is already in the adapters).

### 29.5 Profitability model (2026-09-07)
Pricing tiers: Starter $49/mo (1 platform, 5 videos), Growth $99/mo (all 5
platforms, 15 videos, BYOK), Agency $199/mo (multi-client, white-label).
Unit economics per video: LLM ~$0.10-1.00 (Gemini ~$1.5/M tokens), avatar
vendor ~$1.77-9.67 (D-ID to HeyGen). Hosting $6-31/mo (Hetzner CX22 ~$6-9 to
Render ~$31). BYOK shifts vendor cost to the client. Break-even ~2-3 clients
on Hetzner, ~5-10 on Render. Profit levers: BYOK default, usage caps,
white-label agency tier, annual prepay.

### 29.6 Marketing (minimal out-of-pocket)
- Founder-led content: Patricia's story (63, Boeing, 5 sisters, Florida,
  second-chance mission) on LinkedIn/TikTok/IG - zero cost.
- Partnerships: SC minority business centers, veteran orgs, re-entry
  programs, local chambers - the mission IS the pitch.
- Grants: SBIR/STTR, SC state small-business grants, workforce grants for
  second-chance hiring - funds dev + hosting.
- SEO blog + Product Hunt launch + referral program (1 month free).
- Hosting included in the cost: Hetzner CX22 (~$6-9/mo) keeps opex near zero.

### 29.7 Build-tool verdict
Claude Code remains the best fit for Essential: the repo is already
Claude-Code-native (CLAUDE.md), code-native only (no workflow-JSON artifacts),
flat monthly cost, strong multi-file agentic refactors. Alternatives exist
(Codex CLI, Cursor, Aider, Copilot Workspace) but none change the repo's
advantage; the repo is standard TypeScript so it can be opened in any of them
if desired. Verdict: stay with Claude Code.
