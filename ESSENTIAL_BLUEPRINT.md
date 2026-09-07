# ESSENTIAL - Social Media Super Agent (Code-Native Blueprint)

**Version:** 1.11 | **Status:** Build-ready spec for Claude Code | **Owner:** E. Patricia Rogers - Unmatched Logistics LLC
**Purpose:** A single source of truth that Claude Code reads to scaffold, build, and test Essential - a client-facing social-media Super Agent that (a) mines the web and social platforms for viral topics and generates 20 attention-grabbing trending topics each week, and (b) lets clients enter their own topic, pick how many content pieces to generate (1-10, max 10), choose image / video / both, and generate media directly from written text. Every script Essential generates is a minimum of 15 minutes of spoken content (`MIN_CONTENT_MINUTES` = 15). The client picks the video length from a dropdown capped by each platform's maximum (e.g. Facebook max 240 minutes). Topics and content (Essential-generated or client search) transfer into podcast scripts; if the client selects podscript, Essential creates audio AND video from the selected topic. A text-to-video/audio tool prepares content for YouTube. Clients can use a clone avatar + clone voice via HeyGen (they enter their HeyGen Avatar ID and Voice ID, which Essential saves) or an equivalent provider (Synthesia, D-ID, Argil); Essential renders the avatar+voice video from the selected content. Every flow produces platform-native content, enforces two-stage human approval (preview approval, then per-platform approval before posting), and once the client approves the video and/or images, Essential automatically posts to all the platforms the client selected. Publishing runs only on platforms with connected credentials. The system schedules, audits, and learns - with Gemini powering the brain, Canva producing brand-template designs, DaVinci Resolve available for pro video editing, full client accounts + security, a **Connected Tools (BYOK)** marketplace of image/video/voice/stock/design tools (free + paid), **Spanish language support**, and a remember-username convenience.
**Constraint:** This is a code-native system. No workflow-JSON files, no node-based automation tooling. Everything is TypeScript services, queues, and platform API adapters.

---

## 1. Stack Decision (default - do not ask, build this)

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript / Node.js 22 LTS** | First-class SDKs for every platform used; natural fit for Claude Code scaffolding; strong worker/queue ecosystem |
| HTTP API | **Fastify** | Fast, typed, first-class webhook callback support for the approval resume flow |
| Queue + scheduler | **BullMQ (Redis)** + repeatable jobs | Durable publish queue, retries, rate-limit throttling, cron scheduling |
| Database | **PostgreSQL** + **Prisma** ORM | Relational audit/approval/content data with migrations |
| Object storage | **S3-compatible** (AWS S3 or MinIO) | Media assets + signed URLs for platform uploads |
| Secrets | **.env + git-ignored secrets file**; upgrade path to AWS Secrets Manager | No secrets in code, no secrets in chat |
| AI models | OpenAI `gpt-image-1` (images)  -  Anthropic Claude (strategy)  -  OpenAI ChatGPT (copy)  -  **Gemini 2.5 Pro/Flash (co-brain + fallback)**  -  Perplexity Sonar/Agent API (trends) | Verified endpoints in Section 6 |
| Video | **HeyGen** (avatar narration) + **Runway** (cinematic text-to-video) | Two complementary engines |
| Notifications | **Slack** (approval pings) | Human-in-the-loop gates |
| Design | **Canva Connect API** | Brand-template autofill, asset upload, design export for platform-correct visuals |
| Connected tools (BYOK) | **Pollinations** (no key)  -  **Pexels**  -  **Unsplash** (free stock)  -  **Clipdrop**  -  **Leonardo**  -  **Stability** (image)  -  **ElevenLabs** (voice)  -  **Gemini free tier** (image/text)  -  **Perplexity** (research)  -  **Runway**  -  **HeyGen** (paid-opt-in) | Client connects tools by generating an API key on the tool's website and pasting it into Essential (BYOK); keys encrypted at rest |
| Trend sources | **Google Trends API (alpha)**  -  Reddit Data API  -  X API  -  TikTok/YouTube trending  -  Perplexity | Multi-source viral-topic mining for the weekly 20 |

**Repo layout (monorepo):**

```
essential/
|--- apps/
|   |--- api/                 # Fastify HTTP server: ingest, callbacks, status
|   `--- worker/              # BullMQ consumer: generation + publishing workers
|--- packages/
|   |--- core/                # domain types, config, errors, logging
|   |--- db/                  # Prisma schema, migrations, seed
|   |--- ai/                  # OpenAI / Anthropic / Gemini / Perplexity clients + prompts
|   |--- media/               # image + video production orchestration
|   |--- design/               # Canva Connect: autofill, assets, export
|   |--- adapters/            # facebook, linkedin, instagram, youtube, tiktok, x, threads, pinterest, reddit
|   |--- approvals/           # two-stage approval state machine
|   |--- analytics/           # engagement feedback loop
|   |--- tools/               # Connected Tools (BYOK): per-tool adapters + key vault
|   `--- i18n/                # en.json / es.json locale bundles + language service
|--- .env.example
|--- package.json
|--- tsconfig.json
`--- README.md
```

---

## 2. Environment Variables (`.env.example`)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string for BullMQ |
| `PORT` | API server port (default 3000) |
| `PUBLIC_BASE_URL` | Public base URL for webhook callbacks |
| `OPENAI_API_KEY` | OpenAI (copy + images) |
| `ANTHROPIC_API_KEY` | Claude (strategy) |
| `PERPLEXITY_API_KEY` | Perplexity (trend research) |
| `HEYGEN_API_KEY` | HeyGen avatar video |
| `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID` | Default avatar/voice |
| `RUNWAY_API_KEY` | Runway text-to-video |
| `GEMINI_API_KEY` | Gemini Developer API key (brain + fallback) |
| `GEMINI_STRATEGY_MODEL` | Default `gemini-2.5-pro` (thinking enabled) |
| `GEMINI_COPY_MODEL` | Default `gemini-2.5-flash` |
| `GEMINI_LITE_MODEL` | Default `gemini-2.5-flash-lite` (bulk/compliance) |
| `GEMINI_THINKING_BUDGET` | Thinking tokens budget for strategy runs |
| `POLLINATIONS_ENABLED` | Pollinations (no key required) on/off |
| `PEXELS_API_KEY` | Pexels free stock photos/videos |
| `UNSPLASH_API_KEY` | Unsplash free stock photos |
| `CLIPDROP_API_KEY` | Clipdrop image gen (100 free credits) |
| `LEONARDO_API_KEY` | Leonardo AI image/video ($5 free credit) |
| `STABILITY_API_KEY` | Stability AI images (trial credits) |
| `ELEVENLABS_API_KEY` | ElevenLabs voice/TTS (free tier + Startup Grant) |
| `PASSWORD_MIN_LENGTH` | Password min length (default 8) |
| `PASSWORD_REQUIRE_SPECIAL` | Require `! # $ * %` (default true) |
| `DEFAULT_LANGUAGE` | `en` | `es` (default `en`) |
| `REMEMBER_USERNAME_ENABLED` | Remember-username convenience (default true) |
| `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET` | Canva Connect OAuth app |
| `CANVA_REDIRECT_URI` | Canva OAuth redirect (PKCE) |
| `CANVA_BRAND_TEMPLATE_ID` | Default brand template for autofill |
| `META_APP_ID`, `META_APP_SECRET` | Meta developer app |
| `FB_PAGE_ID`, `FB_PAGE_ACCESS_TOKEN` | Facebook Page target + token |
| `INSTAGRAM_IG_ID`, `INSTAGRAM_TOKEN` | Instagram professional account |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_ORG_URN` | LinkedIn OAuth + org author |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_OPEN_ID` | TikTok OAuth + account |
| `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_CHANNEL_ID` | YouTube OAuth |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Media storage |
| `SLACK_TOKEN`, `SLACK_APPROVAL_CHANNEL` | Approval notifications |
| `AUDIT_TABLE`, `LIBRARY_TABLE` | (optional) external log destinations |
| `JWT_SECRET`, `SESSION_TTL_HOURS` | Auth sessions (JWT) |
| `PASSWORD_PEPPER` | Pepper for password hashing (argon2id) |
| `CLIENT_TOPIC_MAX` | Client topic count cap (dropdown 1-10, default 10) |
| `TEXT_TO_MEDIA_ENABLED` | Enable text-to-media generation (default true) |
| `MIN_CONTENT_MINUTES` | Minimum spoken content per script (default 15) |
| `VIDEO_LENGTH_DEFAULT` | Default video length minutes for the dropdown (default 3) |
| `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID` | Client HeyGen avatar + voice IDs (saved per client) |
| `TOOL_VAULT_KEY` | AES-256-GCM key for the Connected Tools key vault |
| `RESET_TOKEN_TTL_MINUTES` | Password-reset token lifetime (default 30) |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | X OAuth 1.0a (pay-per-use) |
| `THREADS_USER_ID`, `THREADS_TOKEN` | Threads via Meta Graph |
| `PINTEREST_ACCESS_TOKEN`, `PINTEREST_BOARD_ID` | Pinterest v5 |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME` | Reddit Data API |
| `WEEKLY_DIGEST_CRON` | Weekly 20-topic job schedule (default `0 6 * * 1`) |
| `WEEKLY_TOPIC_COUNT` | Topics per digest (default 20) |
| `DEPLOY_TARGET` | `railway` | `fly` | `aws` | `vercel` |

---

## 3. Data Schema (PostgreSQL / Prisma)

**Client** - `id`, `name`, `brandVoice`, `language` (`en`|`es`, default `en`), `rememberUsername` (bool), `createdAt`
**PlatformConnection** - `id`, `clientId`, `platform`, `encryptedToken`, `scopes`, `expiresAt`, `revokedAt` (tokens AES-256-GCM encrypted, key from env)
**Topic** - `id`, `clientId`, `title`, `audience`, `status`, `createdAt`
**Draft** - `id`, `topicId`, `contentVersion`, `masterNarrative`, `strategy`, `posts` (JSONB per platform), `hashtags`, `cta`, `complianceReport` (JSONB), `status`
**Approval** - `id`, `draftId`, `stage` (`DRAFT`|`FINAL`), `approvedBy`, `approvedAt`, `resumeToken`, `status`
**MediaAsset** - `id`, `draftId`, `kind` (`image`|`video`|`voiceover`|`design`), `provider`, `modelUsed`, `costUsd`, `s3Key`, `publicUrl`, `altText`, `visualQaReport` (JSONB)
**Post** - `id`, `draftId`, `platform`, `postId`, `postUrl`, `status`, `publishedAt`, `scheduledAt`
**AuditLog** - `id`, `clientId`, `topicId`, `platform`, `event`, `detail` (JSONB), `createdAt`
**AnalyticsEvent** - `id`, `postId`, `platform`, `metric`, `value`, `recordedAt`
**ContentLibrary** - `id`, `clientId`, `topicId`, `platform`, `postUrl`, `approvedAt` (brand-voice memory + history)
**Design** - `id`, `draftId`, `canvaDesignId`, `templateId`, `autofillJobId`, `exportUrl`, `status`
**User** - `id`, `email` (unique), `passwordHash` (argon2id + pepper), `role` (`client`|`admin`), `emailVerifiedAt`, `lastLoginAt`, `status`, `createdAt`
**PasswordResetToken** - `id`, `userId`, `tokenHash`, `expiresAt`, `usedAt` (single-use, expiring)
**Session** - `id`, `userId`, `tokenHash`, `expiresAt`, `revokedAt`
**TrendTopic** - `id`, `source`, `title`, `score`, `dedupKey`, `seenAt` (dedup across weeks)
**WeeklyDigest** - `id`, `weekStart`, `topicIds` (JSONB), `status`, `generatedAt`
**PreviewDecision** - `id`, `draftId`, `contentKind` (`content`|`image`|`video`|`both`), `decision` (`publish`|`skip`), `decidedAt`
**ToolConnection** - `id`, `clientId`, `tool` (`pollinations`|`pexels`|`unsplash`|`clipdrop`|`leonardo`|`stability`|`elevenlabs`|`perplexity`|`runway`|`heygen`), `encryptedKey`, `keyHint` (last 4 chars), `status`, `createdAt`, `updatedAt` (keys AES-256-GCM encrypted, key from env)

---

## 4. Module Contracts (input -> output)

### 4.1 Ingest
`POST /api/topics` - body `{ clientId, title, audience?, brandVoice?, platforms[], mediaType?, schedule? }` -> creates Topic, enqueues `trend-research` job.

### 4.2 Trend Research (Perplexity)
Input: `{ topic, platforms[], brandVoice }` -> Output `{ research, perPlatformAngles[], competitorInsight[] }`. Prompt requires structured JSON; no invented statistics.

### 4.3 Strategist (Claude + Gemini 2.5 Pro)
Input: `{ topic, research, brandVoice, platforms[] }` -> Output `{ masterNarrative, strategy, hashtagSet, cta, complianceNotes, competitorInsight }`. Claude is primary; **Gemini 2.5 Pro (thinking enabled) runs in parallel as co-strategist** and is the automatic fallback if Claude errors, times out, or returns a safety block. Structured output enforced via `responseSchema` (JSON mode).

### 4.4 Copywriter (OpenAI + Gemini 2.5 Flash)
Input: master narrative + platform list -> Output `{ posts: { facebook, linkedin, instagram, youtube:{title,description,tags}, tiktok:{title,script,onScreenText} } }`. OpenAI is primary; **Gemini 2.5 Flash** produces caption variations and is the fallback copywriter. **Gemini 2.5 Flash-Lite** handles bulk pre-checks (hashtag expansion, alt-text, metadata). Long scripts stream via `streamGenerateContent` (SSE).

### 4.5 Draft Builder + Compliance
Assembles Draft row + `contentVersion`; compliance checks: Instagram caption <= 2,200 chars, TikTok title <= 2,200 chars, CTA present, claims flagged. Output `complianceReport { pass, issues[] }`.

### 4.6 Approval Manager (two-stage state machine)
- Stage 1 `DRAFT`: Slack ping with resume URL -> wait -> `approved` or `rejected`.
- Stage 2 `FINAL`: after media produced, Slack ping with asset previews -> wait -> `approved` or `rejected`.
- Publishing is **impossible** until both approvals exist and are un-revoked.

### 4.7 Media Producer
Input: `{ imageConcept, videoScript, shotList, brandVoice }` ->
- Image: OpenAI `gpt-image-1` generations endpoint -> store to S3 -> signed URL.
- Video: HeyGen avatar video from script (async, poll status) OR Runway text-to-video (async, poll) -> store MP4 -> signed URL.
- **Visual QA (Gemini 2.5 Flash, multimodal):** every produced image/video frame is checked against the topic + brand voice; non-aligned assets are flagged for regeneration before the final-approval gate.
- **Design (Canva):** brand-template autofill produces platform-correct designs (posts, stories, reel covers) via the Canva Connect API; exports stored to S3.
Output `{ imageUrl, videoUrl, designUrls[], assetIds[], visualQaReport }`.

### 4.8 Publisher (adapter interface)
Every adapter implements: `validateConnection()`, `validateMedia()`, `publish(payload)`, `getStatus()`, `handleError()`. Full contracts in Section 5.

### 4.9 Scheduler
BullMQ repeatable jobs: immediate publish, or `scheduledAt` in client timezone. Rate-limit throttling per platform.

### 4.10 Analytics + Audit
Post-publish: write AuditLog row; optionally poll platform analytics APIs (opt-in) -> AnalyticsEvent; top-performing topics feed back into Trend Research.

### 4.11 Gemini Brain (routing, fallback, cost)
- **Model routing:** strategy -> Gemini 2.5 Pro (thinking) as co-strategist/fallback to Claude; copy -> Gemini 2.5 Flash as fallback to OpenAI; bulk -> Gemini 2.5 Flash-Lite.
- **Structured output:** all Gemini calls use `responseSchema` (JSON mode) for type-safe drafts.
- **Multimodal:** Gemini 2.5 Flash analyzes generated images/video frames for topic + brand alignment (visual QA).
- **Token & cost accounting:** every Gemini call logs model, input/output tokens, and cost per draft -> stored on MediaAsset/Draft for grant-ready reporting.
- **Safety handling:** `safetySettings` with severity thresholds; a `BLOCKED_ON_SAFETY` result triggers fallback or human review, never silent publish.
- **Streaming:** long scripts use `streamGenerateContent` (SSE).

### 4.12 Canva Design Producer
Input: `{ brandTemplateId, autofillData, format }` ->
- OAuth 2.0 + PKCE (SHA-256) authorization -> store refresh token (encrypted).
- Autofill: `POST /v1/autofills` with brand template + data -> poll job -> design.
- Export: request PNG/MP4 export -> `exportUrl` -> store to S3 -> signed URL.
Output `{ designUrls[], exportUrls[], assetIds[] }`.

### 4.13 Trend Mining (multi-source)
Input: `{ weekStart, clientAudience?, brandVoice }` -> Output `{ minedTopics[], scores, dedupKeys }`. Sources: Google Trends API (alpha), Reddit Data API (rising), X API (trends + engagement), TikTok/YouTube trending, Perplexity synthesis. Every mined topic gets a `score` (velocity x reach x brand-fit) and a `dedupKey` so the same topic never repeats across weeks.

### 4.14 Weekly Digest (20 topics)
BullMQ repeatable job (default Monday 06:00, `WEEKLY_DIGEST_CRON`). Mines trends -> dedups against `TrendTopic` -> ranks -> emits exactly `WEEKLY_TOPIC_COUNT` (default 20) attention-grabbing topics. Output `WeeklyDigest`; clients review and pick which topics to develop. Picking a topic enqueues the normal `trend-research` -> draft pipeline (Section 4.2-4.6).

### 4.15 Auth & Accounts
`POST /api/auth/register` (email + password; **min 8 chars + at least one special char from `! # $ * %`**; hash with argon2id + pepper) -> email verification -> `POST /api/auth/login` (JWT session; optional **remember-username** saves only the email, never the password) -> `POST /api/auth/forgot` (emails a single-use, expiring reset token) -> `POST /api/auth/reset` -> `POST /api/auth/change-password` (anytime). Rate-limit login/reset attempts; lockout after repeated failures. Passwords are never stored or logged in plaintext.

### 4.16 Credentials Manager (per-platform, optional)
`GET/POST/PUT/DELETE /api/clients/:id/credentials/:platform`. Every platform is **optional** - a client connects one, several, or none. Connections are **OAuth-based** (never raw username/password), tokens encrypted at rest (AES-256-GCM) with refresh. Publishing degrades gracefully: a platform with no connection is simply skipped; the client can add/change credentials at any time and existing drafts route to newly connected platforms.

### 4.17 Connected Tools (BYOK)
`GET/POST/PUT/DELETE /api/clients/:id/tools/:tool`. Flow: the client clicks a tool -> Essential opens the tool's website in a new tab -> the client signs up and generates an API key -> the client pastes the key into Essential -> Essential encrypts it (AES-256-GCM) at rest, stores only a `keyHint` (last 4 chars), and uses it server-side for image/video/voice/stock/design generation. Keys are never stored in the browser, never in localStorage, never logged. The client can add, replace, or remove a tool key at any time; media production falls back to the next available tool (free tier first) when a key is absent or exhausted.

**Canva** (design) and **DaVinci Resolve** (pro video editing) are part of the tool set (Section 15). Canva uses OAuth (Connect API). DaVinci Resolve is a LOCAL desktop companion - it has no hosted cloud API (`hostedApi: false`), so it is client-side only and its adapter is a documented stub (do not invent cloud endpoints).

### 4.18 Client Topic Research (on-demand)
`POST /api/clients/:id/research` - body `{ topic, count, mediaType, platforms[], language? }`. `count` comes from a dropdown of 1-10 and is capped at `CLIENT_TOPIC_MAX` (default 10). Essential researches the client's topic (Section 4.2) and generates exactly `count` content pieces (drafts), each with the chosen media type (`image` | `video` | `both`). Output `{ topic, research, drafts[1..count] }`. Each draft flows through the normal draft -> compliance -> preview -> approval -> publish pipeline (Sections 4.2-4.6, 13).

### 4.19 Text-to-Media
`POST /api/clients/:id/text-to-media` - body `{ text, mediaType ('image'|'video'|'both'), brandVoice?, language? }`. Essential turns the client's written text into media: image via an image tool, video via a video tool, or both. Output `{ mediaAssetIds[], previewUrls[], visualQaReport }`. Media is produced through the Connected Tools free-first routing (Section 15) and passes visual QA + the two-stage approval lock before any publish.

---

## 5. Platform Adapters (verified endpoints)

| Platform | Publish call | Auth / scope | Limits |
|---|---|---|---|
| **Facebook Pages** | `POST https://graph.facebook.com/v26.0/{page-id}/feed` | Page access token; `pages_manage_posts` | - |
| **Instagram** | 2-step: `POST .../{ig-id}/media` (container) -> `POST .../{ig-id}/media_publish` | IG user or Page token; `instagram_business_content_publish` | <= 100 API posts / 24h moving window; carousels count as one |
| **LinkedIn** | `POST https://api.linkedin.com/rest/posts` (author = org URN) | OAuth2 `w_organization_social` | - |
| **YouTube** | Resumable `videos.insert` (title, description, tags, privacyStatus) | OAuth2 `youtube.upload` | 10,000 quota units/day default |
| **TikTok** | `POST /v2/post/publish/video/init/` -> upload (URL-pull or direct) -> complete | OAuth2 `video.publish` | ~6 requests/min/token; app audit required for public posting |
| **X (Twitter)** | `POST https://api.x.com/2/tweets` | OAuth 1.0a user context; `tweet.write` | **Pay-per-use** - ~$0.015/post write; no free tier [X API pricing](https://docs.x.com/x-api/getting-started/pricing) |
| **Threads** | 2-step: `POST /{threads-user-id}/threads` (container) -> `POST /{threads-user-id}/threads_publish` | Meta Graph; publish scope | <= 250 posts / 24h; carousels count as one [Threads Posts](https://developers.facebook.com/documentation/threads/posts) |
| **Pinterest** | `POST https://api.pinterest.com/v5/pins` (image/video pin on a board) | OAuth2; Trial/Standard tier | Trial tier restricts POST; Standard requires approval [Pinterest access tiers](https://developers.pinterest.com/docs/key-concepts/access-tiers/) |
| **Reddit** | `POST https://oauth.reddit.com/api/submit` (link/self post) | OAuth2; app approval required | 100 QPM per OAuth client id [Reddit Data API](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki) |

Sources: [Meta Instagram Content Publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)  -  [Graph API v26](https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26/)  -  [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)  -  [YouTube quota](https://developers.google.com/youtube/v3/determine_quota_cost)  -  [TikTok Content Posting API](https://developers.tiktok.com/doc/content-posting-api-get-started)  -  [X API pricing](https://docs.x.com/x-api/getting-started/pricing)  -  [Threads Posts](https://developers.facebook.com/documentation/threads/posts)  -  [Pinterest access tiers](https://developers.pinterest.com/docs/key-concepts/access-tiers/)  -  [Reddit Data API](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki)  -  [Google Trends API (alpha)](https://developers.google.com/search/blog/2025/07/trends-api)

**Design & AI services (verified endpoints):**
- **Canva Connect API** - OAuth 2.0 Authorization Code + PKCE (SHA-256); scopes `asset:read/write`, `brandtemplate:content:read`, `brandtemplate:meta:read`, `design:content:write`, `design:meta:read/write`, `folder:read/write`; endpoints: Assets (upload), Designs (create/export), **Autofills** (`POST /v1/autofills`), Folders; export rate ~10 requests/10s; refresh-token rotation required. [Canva authentication](https://www.canva.dev/docs/connect/authentication/)  -  [Autofill API](https://www.canva.dev/docs/connect/api-reference/autofills/)  -  [Starter kit scopes](https://github.com/canva-sdks/canva-connect-api-starter-kit)  -  [Security guidelines](https://www.canva.dev/docs/connect/guidelines/security/)
- **Gemini (Developer API)** - API-key auth (Vertex AI OAuth is the enterprise alternative; both via the unified Google Gen AI SDK); `POST /v1beta/models/{model}:generateContent` and `:streamGenerateContent` (SSE); structured output via `responseSchema`; thinking configurable via `thinkingBudget`; safety via `safetySettings` (severity NEGLIGIBLE/LOW/MEDIUM/HIGH); rate limits tied to project usage tier. [Gemini models](https://ai.google.dev/gemini-api/docs/models)  -  [Structured output](https://ai.google.dev/gemini-api/docs/structured-output)  -  [Thinking](https://ai.google.dev/gemini-api/docs/thinking)  -  [Safety settings](https://ai.google.dev/gemini-api/docs/safety-settings)  -  [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)  -  [Streaming](https://ai.google.dev/api)

**AI model endpoints (verified):**
- Images: OpenAI `gpt-image-1` - Generations endpoint [OpenAI Image API](https://developers.openai.com/api/docs/guides/image-generation)
- Strategy: Anthropic Claude (Sonnet-class; verify exact model ID against [Claude models overview](https://platform.claude.com/docs/en/models/overview) at build time - Sonnet 4/Opus 4 retire April 2026 per [deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations))
- Trends: Perplexity Sonar (OpenAI-compatible) - **TODO at build time:** Perplexity is migrating Sonar Chat Completions to its Agent API (Sonar supported until 2026-09-27 per [pricing page](https://docs.perplexity.ai/docs/getting-started/pricing)); implement behind a thin client so the endpoint can swap.
- Brain: **Gemini 2.5 Pro** (strategy/co-strategist + fallback, thinking enabled)  -  **Gemini 2.5 Flash** (copy/fallback + multimodal visual QA)  -  **Gemini 2.5 Flash-Lite** (bulk pre-checks) - Developer API key auth; verify exact model IDs at build time against [Gemini models](https://ai.google.dev/gemini-api/docs/models).
- Video: HeyGen [Create Video API](https://developers.heygen.com/reference/create-video) (Avatar III/IV/V)  -  Runway [Dev API](https://docs.dev.runwayml.com/) (Gen-4.5 / WAN 3.0, text-to-video)

**Connected tools (BYOK) - verified endpoints:**
- **Pollinations** - no key, no signup; image/video/audio/text via `https://image.pollinations.ai/prompt/{prompt}` (free). [Pollinations](https://pollinations.ai/)
- **Pexels** - free stock photos/videos; `GET https://api.pexels.com/v1/search?query=...` with `Authorization: <API_KEY>`; 200 req/hr, 20k/mo. [Pexels API](https://www.pexels.com/api/)
- **Unsplash** - free stock photos; `GET https://api.unsplash.com/search/photos?query=...` with `Authorization: Client-ID <API_KEY>`; ~50 req/hr free tier. [Unsplash developers](https://unsplash.com/developers)
- **Clipdrop** - image gen + background removal; `POST https://clipdrop-api.co/text-to-image/v1` with `x-api-key`; 100 free credits, 60 req/min. [Clipdrop APIs](https://clipdrop.co/apis/docs/text-to-image)
- **Leonardo AI** - image/video; API key from [leonardo.ai/api](https://leonardo.ai/api); ~$5 free API credit.
- **Stability AI** - image gen; API key from [platform.stability.ai](https://platform.stability.ai/docs/getting-started); trial credits (free tier unconfirmed).
- **ElevenLabs** - voice/TTS for video narration; API key from [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api); free tier ~10k credits/mo + Startup Grant (12 mo free, 33M chars).
- **Gemini free tier** - image/text generation at no cost (already the brain) [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing).
- **Perplexity** - research; API key from [perplexity.ai/api-platform](https://docs.perplexity.ai/docs/getting-started/pricing); no permanent free tier (trial credits; Pro $5/mo).
- **Runway** - video (paid-opt-in); API key from [dev.runwayml.com](https://docs.dev.runwayml.com/guides/pricing/); credits $0.01 each, no free tier.
- **HeyGen** - avatar video (paid-opt-in); API token from [Settings -> API](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained); no free API credits since Feb 2026.

---

## 6. Approval Workflow (human-in-the-loop)

```
Topic -> Draft -> [COMPLIANCE] -> Slack "Draft approval needed" -> resume webhook
     -> approved? -> Media production -> Slack "Final approval needed" -> resume webhook
     -> approved? -> Scheduler -> Publisher -> Audit + Analytics
     -> rejected at any gate -> BLOCKED response, reason logged
```
Resume URLs are single-use, signed, expiring. Both approvals must be present and un-revoked before any publish branch runs.

---

## 7. Build Order (numbered milestones for Claude Code)

- **M0 - Scaffold:** monorepo, tsconfig, Fastify API boots, Prisma connects, BullMQ connects, `.env.example`, health endpoint. *Accept: `GET /health` returns ok.*
- **M1 - Ingest + DB:** `POST /api/topics`, Topic/Draft schema, migrations. *Accept: create topic persists.*
- **M2 - AI pipeline:** Trend Research, Strategist (Claude + Gemini 2.5 Pro co-strategist/fallback), Copywriter (OpenAI + Gemini 2.5 Flash fallback), Gemini Flash-Lite pre-checks, token/cost accounting. *Accept: draft JSON generated end-to-end with model routing + fallback tested.*
- **M3 - Compliance + Draft approval:** compliance checks, Slack ping, resume webhook, Approval state machine. *Accept: reject/approve both work.*
- **M4 - Media production:** image + HeyGen/Runway video + **Canva brand-template autofill/export** + **Gemini multimodal visual QA**, S3 storage, signed URLs. *Accept: assets produced, visually QA'd, and retrievable.*
- **M5 - Final approval:** asset preview ping + second gate. *Accept: nothing publishes without final approval.*
- **M6 - Adapters + talking-head render:** Facebook -> LinkedIn -> Instagram -> YouTube -> TikTok, each in a sandbox/test account first; talking-head video rendered via HeyGen/Synthesia/D-ID/Argil with per-vendor segmentation. *Accept: one harmless test post per platform returns a real post URL; a 15-min talking-head render completes and auto-posts to all selected platforms.*
- **M7 - Scheduler:** BullMQ repeatable jobs, timezone-aware scheduling, rate-limit throttling. *Accept: scheduled post fires at correct time.*
- **M8 - Audit + Analytics:** AuditLog on every publish, opt-in analytics poll, content library. *Accept: full audit trail queryable.*
- **M9 - Hardening:** retries with exponential backoff, dead-letter queue, token refresh, revocation, security scan (no secrets in repo), README.
- **M10 - Auth & accounts:** register/login/reset/change-password, argon2id hashing, email verification, rate-limit + lockout, JWT sessions. *Accept: full auth flow works; wrong password locks out; reset token expires.*
- **M11 - Credentials manager:** OAuth connect per platform, encrypted at rest, graceful degradation, add/remove UI. *Accept: connect one platform only -> publishing skips the rest; add a platform later -> routes existing drafts.*
- **M12 - Weekly digest + preview:** cron job, 20-topic mining/dedup/rank, preview->publish decision UI, image/video/both. *Accept: exactly 20 deduped topics; preview->publish only on connected platforms.*
- **M13 - Connected Tools (BYOK):** tool registry, connect flow (open tool site -> paste key), encrypted key vault, media fallback across tools, free-tier-first routing. *Accept: client connects a free tool (e.g. Pexels) and a paid tool; media production uses the connected tool and falls back when a key is missing.*
- **M14 - Language & UX:** `en`/`es` locale bundles, language selector, Spanish content generation, remember-username login. *Accept: switching to Spanish translates the UI and AI-generated copy; remember-username pre-fills the email.*

---

## 8. Test / Acceptance Criteria

- Every milestone has an acceptance test (above); M6 additionally requires a **test account** per platform - never the live business page until M6 passes.
- Compliance gate must block over-length captions and missing CTAs.
- Gemini fallback must engage automatically when Claude/OpenAI error, time out, or return a safety block; visual QA must flag a deliberately off-topic asset.
- Approval state machine: unit tests for approve/reject/expire/revoke paths.
- Adapter tests run in **mock mode** (dry-run payloads, no network) by default; live mode requires explicit env flag `LIVE_PUBLISH=true`.
- A security scan must report zero plaintext credentials in the repo.
- Auth tests: register -> verify -> login -> reset -> change-password; wrong-password lockout; reset-token expiry.
- Weekly digest: exactly 20 deduped topics; preview->publish runs only on connected platforms.
- Connected Tools: a client connects only a free tool -> media production succeeds without paid keys; a missing key falls back to the next available tool.
- Password policy: 8+ chars with a `! # $ * %` special char is accepted; shorter or special-less passwords are rejected.
- i18n: switching to Spanish translates the UI and the AI-generated captions/titles/descriptions.
- Remember-username: the email is pre-filled on next login; the password is never saved.

---

## 9. "Do Not" Constraints (hard rules for Claude Code)

1. **No node-based automation tooling / workflow-JSON files.** This system is code-native only.
2. **Never store or log plaintext tokens/passwords/2FA.** Encrypt tokens at rest; read secrets only from env/secret manager.
3. **Never publish without both approvals** present and un-revoked.
4. **Never invent statistics or claims** in generated copy; flag any claim needing verification.
5. **Never hard-code a client's account IDs or tokens** into source files.
6. **Never post to a live business account** before the M6 test-account pass.
7. **Never skip the compliance gate** or allow it to be bypassed by configuration.
8. **Never add a platform** without a verified API reference in Section 5 and an adapter contract.
9. **Never bypass the Gemini visual-QA or Canva autofill** steps in media production; both are part of the final-approval gate.
10. **Never hard-code model IDs** - read Gemini/Claude model names from env config so deprecations are a config change, not a code change.
11. **Never store or log plaintext passwords** - hash with argon2id + pepper; reset tokens hashed and expiring.
12. **Never ask for or store raw platform credentials** - OAuth connections only.
13. **Never publish to a platform without a connected credential** - degrade gracefully, skip, and log.
14. **Never accept a password shorter than 8 chars or without a `! # $ * %` special char** - enforce the policy at registration, reset, and change-password.
15. **Never store a client tool API key in the browser, in localStorage, or in logs** - encrypt at rest (AES-256-GCM) and use server-side only.

---

## 10. Auth & Security (client accounts)

- **Registration:** email + password. **Password policy (client requirement): minimum 8 characters AND at least one special character from `! # $ * %`.** (Configurable via `PASSWORD_MIN_LENGTH` / `PASSWORD_REQUIRE_SPECIAL`; the default enforces the client's rule.) Hashed with **argon2id + pepper**; never stored or logged in plaintext.
- **Email verification:** a verification link is emailed on registration.
- **Login:** JWT session (env `JWT_SECRET`, `SESSION_TTL_HOURS`); rate-limited; lockout after repeated failures.
- **Password reset:** `forgot` emails a **single-use, expiring** reset token (default 30 min, `RESET_TOKEN_TTL_MINUTES`) to the registered email; `reset` sets a new password. Tokens are stored hashed, never in plaintext.
- **Change password anytime:** authenticated `change-password` endpoint (verifies current password first).
- **Session management:** revocable sessions; logout revokes the token.
- **Transport:** all auth endpoints require HTTPS; no secrets in logs.
- **Remember username:** the login screen offers a **"Remember me"** checkbox that saves only the email in a cookie (never the password) and pre-fills it next time.
- **Language:** each account has a `language` setting (`en` | `es`). Spanish translates the full UI (locale bundles) and instructs the AI to generate captions/titles/descriptions in Spanish.

## 11. Credentials Manager (per-platform, optional)

- Every social platform is **optional**. A client connects all, one, or none.
- Connections are **OAuth-based** - Essential never asks for or stores raw platform username/password.
- Tokens encrypted at rest (AES-256-GCM, key from env) with refresh-token rotation.
- `GET/POST/PUT/DELETE /api/clients/:id/credentials/:platform` - add, update, remove at any time.
- **Graceful degradation:** publishing runs only on platforms with connected credentials; unconnected platforms are skipped with a logged note. The client can connect a new platform later and previously approved content can be routed to it.
- UI: a dedicated "Social Media Credentials" section listing all platforms with connected / not-connected status and an "Add" / "Edit" / "Remove" action per platform.

## 12. Weekly 20-Topics Pipeline

1. **Schedule:** BullMQ repeatable job, default `0 6 * * 1` (Monday 06:00, `WEEKLY_DIGEST_CRON`), timezone-aware.
2. **Mine:** Trend Mining (Section 4.13) pulls from Google Trends API (alpha), Reddit rising, X trends, TikTok/YouTube trending, and Perplexity synthesis.
3. **Dedup:** every topic carries a `dedupKey`; topics already seen are dropped so the same idea never repeats across weeks.
4. **Rank:** score = velocity x reach x brand-fit; the top `WEEKLY_TOPIC_COUNT` (default 20) become the digest.
5. **Deliver:** the client sees 20 attention-grabbing topics in a friendly UI, picks any subset, and each pick flows into the normal draft -> approval -> media -> preview -> publish pipeline.
6. **Learn:** engagement analytics feed back into scoring for future weeks.

**Two entry buttons (client UI):** the client dashboard offers two distinct buttons:
- **"Research My Topic"** - the client enters their own topic, picks a count (1-10) and a media type (image / video / both); Essential researches and generates that many content pieces (Section 19).
- **"Essential-Generated Topics"** - shows the 20 weekly trending topics; the client picks any subset to develop (this pipeline).
Both buttons feed the same draft -> approval -> media -> preview -> publish pipeline.

## 13. Preview -> Approve -> Publish

- After media production + visual QA, the client gets a **preview** of the content, image, and/or video before anything is published.
- Per draft, the client chooses the output: **content only**, **create an image**, **create a video**, or **create both an image and a video**.
- The client reviews each asset and decides **Publish** or **Skip** per platform.
- Publishing runs **only** on platforms where the client has connected credentials; everything else is skipped.
- The two-stage approval lock (Section 6) still applies - preview approval is the final human gate before any publish branch runs.
- The same preview -> approve -> publish flow applies to client-entered topics (Section 19) and text-to-media output (Section 4.19).
- Once the client approves the video and/or images (or both), Essential **automatically posts** to all the platforms the client selected for posting (Section 21).

## 14. Deployment & Publishing Options

| Option | Best for | Notes |
|---|---|---|
| **Railway / Render / Fly.io** (managed) | Fastest path to production | One-click Postgres + Redis; CI/CD from the repo; web service for `apps/api` + worker |
| **AWS (ECS / Lambda + RDS + ElastiCache + S3)** | Scale + enterprise | More setup; full control; Secrets Manager for env |
| **Vercel + managed Postgres/Redis (Neon/Upstash)** | API-first, low ops | Serverless-friendly; webhook callbacks need a stable public URL |
| **Local dev (Claude Code) -> CI/CD** | Development | Claude Code scaffolds and tests locally (mock mode), then `git push` deploys |

**Recommended default:** Railway or Fly.io - one command deploys the Fastify API + BullMQ worker + Postgres + Redis, with S3-compatible storage (MinIO or AWS S3) for media. `DEPLOY_TARGET` env selects the pattern. Production publishing stays behind BullMQ repeatable jobs; Claude Code's own scheduling is dev-time only.

**Claude Code upload:** `ESSENTIAL_BLUEPRINT.md` is a **single self-contained markdown file** (~20 KB, well under Claude Code's project-file limits) - it can be dropped into the `essential/` repo root and read directly by Claude Code alongside `CLAUDE.md`.

## 15. Connected Tools (BYOK) - approved & integrated

Clients connect third-party AI tools to Essential by generating an API key on the tool's website and pasting it into Essential (Bring Your Own Key). Every tool is optional; Essential works with free tools, paid tools, or none.

**Connect flow (user-friendly):**
1. Settings -> Connected Tools -> click a tool (e.g., "Leonardo").
2. Essential opens the tool's website in a new tab (the connect URL).
3. The client signs up and generates an API key.
4. The client pastes the key into Essential's secure field.
5. Essential encrypts it (AES-256-GCM) at rest, stores only a `keyHint` (last 4 chars), and uses it server-side.
6. The client can add, replace, or remove keys anytime; media production falls back to the next available tool.

**Approved tool set (free-first):**
| Tool | Media | Free tier | Connect URL |
|---|---|---|---|
| **Pollinations** | Image/video/audio/text | OK No key, no signup | [pollinations.ai](https://pollinations.ai/) |
| **Pexels** | Stock photos/videos | OK Free, 200 req/hr | [pexels.com/api](https://www.pexels.com/api/) |
| **Unsplash** | Stock photos | OK Free ~50 req/hr | [unsplash.com/developers](https://unsplash.com/developers) |
| **Gemini** | Image/text (brain) | OK Free tier | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **Clipdrop** | Image gen + bg removal | OK 100 free credits | [clipdrop.co/apis/signin](https://clipdrop.co/apis/signin) |
| **Leonardo AI** | Image/video | OK ~$5 free credit | [leonardo.ai/api](https://leonardo.ai/api) |
| **Stability AI** | Image | ! Trial credits (unconfirmed) | [platform.stability.ai](https://platform.stability.ai/docs/getting-started) |
| **ElevenLabs** | Voice/TTS | OK Free tier + Startup Grant | [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api) |
| **Perplexity** | Research | X Trial credits only | [perplexity.ai/api-platform](https://docs.perplexity.ai/docs/getting-started/pricing) |
| **Runway** | Video | X Paid-opt-in | [dev.runwayml.com](https://docs.dev.runwayml.com/guides/pricing/) |
| **HeyGen** | Avatar video | X Paid-opt-in | [Settings -> API](https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained) |
| **Synthesia** | Avatar video (alternative) | OK Free plan (10 min/mo, 9 stock avatars) | [docs.synthesia.io](https://docs.synthesia.io/reference/synthesia-api-quickstart) |
| **D-ID** | Avatar video (alternative) | OK Trial credits | [docs.d-id.com](https://docs.d-id.com/docs/quickstart) |
| **Argil** | Avatar video (alternative) | OK Trial | [argil.ai](https://www.argil.ai/) |
| **Canva** | Design (posts, stories, reel covers) | OK Free for developers per official docs | [canva.dev/docs/connect](https://www.canva.dev/docs/connect/) |
| **DaVinci Resolve** | Pro video editing | OK Free desktop app (local only) | [blackmagicdesign.com](https://www.blackmagicdesign.com/products/davinciresolve) |

**Media routing:** image/video production uses connected tools in free-first order; a missing or exhausted key falls back to the next tool; if none is available, production reports a clear "connect a tool" prompt.
**Canva** is the design producer (Autofill + Brand Templates, Section 4.12). **DaVinci Resolve** is a local desktop companion for pro video editing - it has no hosted cloud API, so it is client-side only (`hostedApi: false`); do not call it as a server-side API.
**Avatar video:** clients use HeyGen (clone avatar + clone voice) or an equivalent provider (Synthesia, D-ID, Argil). The client enters their HeyGen Avatar ID and Voice ID in Settings; Essential saves them and renders avatar+voice video from the selected content (Section 21).

## 16. Language & UX

- **Spanish support:** a language selector (English / Espanol) on the account. Choosing Spanish translates the full UI (locale bundles `en.json` / `es.json`) **and** instructs the AI to generate captions, titles, and descriptions in Spanish.
- **Remember username:** login offers a **"Remember me"** checkbox that saves only the email (never the password) and pre-fills it on the next visit.

## 17. Proposed Additions (pending client approval - NOT built)

The following remain **not approved / not integrated**; each needs explicit approval before integration:

| Addition | What it adds | Cost / access |
|---|---|---|
| **Buffer API** | Cross-platform scheduling + queue | Subscription [Buffer developers](https://developers.buffer.com/) |
| **Apify** | Social scraping / listening for trend mining | Usage-based [Apify](https://apify.com/) |

## 18. Open Items (mark TODO in code)

- Perplexity endpoint migration (Sonar -> Agent API) - swap behind thin client.
- Exact Anthropic model ID at build time (deprecation cycle).
- TikTok app audit status for public posting.
- Verify Canva Connect API access tier at build time (official docs say free for developers; some reports mention Enterprise-only - confirm).
- DaVinci Resolve has no hosted cloud API - confirm the local/desktop companion integration path (client-side only).
- Verify client-topic count cap behavior (`CLIENT_TOPIC_MAX`, default 10) and text-to-media provider routing.
- Verify HeyGen v3 endpoints and free-tier/credit status at build time; confirm Synthesia/D-ID/Argil API keys and limits.
- Confirm per-platform max video lengths at build time (Facebook ~240 min, Instagram Reels 3 min / feed 10 min, TikTok 60 min, X 140 sec free / 4 hr Premium, YouTube 12 hr, LinkedIn 15 min).

## 19. Client Topic Research Flow (on-demand)

Distinct from the weekly 20-topic pipeline (Section 12). The client dashboard shows two buttons:

1. **"Research My Topic"** - the client enters a topic, selects a count from a dropdown (1-10, capped at `CLIENT_TOPIC_MAX` = 10), and selects a media type: **image**, **video**, or **both**.
2. Essential researches the topic (Section 4.2) and generates exactly the selected number of content pieces (drafts), each with the chosen media type.
3. Each draft passes the normal pipeline: strategist -> copywriter -> compliance -> draft approval (Sections 4.3-4.6).
4. Media is produced per draft (image and/or video, Section 4.7) through the Connected Tools free-first routing (Section 15).
5. The client gets a **preview** of the content, image, and/or video for each piece (Section 13).
6. The client approves or rejects each piece, then approves per selected platform before anything is posted (two-stage approval lock, Section 6).
7. Publishing runs only on platforms with connected credentials; everything else is skipped.

**"Essential-Generated Topics"** button - shows the 20 weekly trending topics (Section 12); picking a topic runs the same pipeline. Both buttons converge on the same draft -> approval -> media -> preview -> publish flow.

## 20. Text-to-Media

`POST /api/clients/:id/text-to-media` (contract in Section 4.19). The client pastes written text and chooses **image**, **video**, or **both**; Essential generates the media from that text:

- **Image:** image tool from Connected Tools (free-first, Section 15).
- **Video:** video tool (e.g. Runway, HeyGen, or a scripted/edited video via Canva or the DaVinci Resolve companion).
- **Both:** image and video generated from the same text.
- Output is stored to S3, passes Gemini visual QA (Section 4.11), and is shown in the preview area.
- Nothing is published without the client's approval (two-stage lock, Section 6).
- Instagram rate-limit formula re-verification at build time (official docs state 100 posts/24h; third parties report variable caps - treat official as source of truth, implement configurable throttle).
- Optional: Pinterest, Threads, Google Business Profile adapters (not in MVP).
- Verify exact Gemini model IDs at build time (2.5-family deprecation cycle; see [Gemini changelog](https://ai.google.dev/gemini-api/docs/changelog)).
- Canva brand-template availability (autofill requires a brand template on the connected account; confirm access tier at build time).
- Stability AI free tier - confirm trial-credit availability at build time (primary page blocked during research).
- Pollinations / Unsplash - re-verify free-tier limits at build time (primary pages blocked during research).
- ElevenLabs Startup Grant eligibility - confirm at build time.
- Spanish locale - full translation pass for all UI strings + AI content prompts.

## 21. Video Lengths, Podcast Scripts & HeyGen Avatar Video

**15-minute floor:** every script (topic content or podcast script) is at least `MIN_CONTENT_MINUTES` = 15 minutes of spoken content. The strategist and copywriter build scripts to this floor; never generate shorter.

**Per-platform maximum video lengths (verified 2026):**
| Platform | Max video length | Source |
|---|---|---|
| Facebook | ~240 min (4 hr) feed; Reels 90s-3 min | [Meta help](https://www.facebook.com/business/help/817989058548892) |
| Instagram | Reels up to 3 min; feed up to 10 min | [Instagram help](https://help.instagram.com/2720958398006062/) |
| TikTok | 10 min in-app; up to 60 min uploaded | [TikTok support](https://support.tiktok.com/en/using-tiktok/creating-videos/camera-tools) |
| X | 140 sec (2:20) free; up to 4 hr Premium | [X help](https://help.x.com/en/using-x/premium-longer-videos) |
| YouTube | up to 12 hr / 256 GB (verified accounts) | [YouTube help](https://support.google.com/youtube/answer/71673) |
| LinkedIn | up to 10 min mobile / 15 min desktop | [LinkedIn help](https://www.linkedin.com/help/linkedin/answer/a1311816) |

**Video length dropdown:** the client selects the video length; the dropdown is capped by each platform's maximum (`packages/media/platform-limits.ts`, `validateVideoLength`).

**Podcast scripts:** any topic (Essential-generated or client search) converts to a transferable podcast script. If the client selects **podscript**, Essential creates audio AND video from the selected content.

**Text-to-video/audio for YouTube:** a tool converts written text into video and audio ready for YouTube posting.

**HeyGen avatar + voice:** the client enters their HeyGen Avatar ID and Voice ID in Settings; Essential saves them (per client) and renders avatar+voice video from the selected content (`packages/heygen`, POST /v3/videos then poll GET /v3/videos/{id}). Equivalent providers: Synthesia, D-ID, Argil.

**Auto-post:** once the client approves the video and/or images (or both), Essential automatically posts to all the platforms the client selected, gated by the two-stage approval lock (Section 6).


## 22. One-Click Connect (OAuth) and Dashboard API (topic-select -> render -> preview)

### 22.1 How clients connect (the easy method)

Chosen method: OAuth "Connect with [Platform]" buttons. The client never types a
password and never copies a token. Essential opens the platform's official login,
the client approves, and Essential stores the resulting token encrypted at rest
(AES-256-GCM, key from env). Manual username/password entry is NOT supported: it
violates every platform's Terms of Service and breaks the moment the client
enables two-factor authentication (2FA). Manual token paste is offered only as a
fallback for the M6 test-account pass (mock mode), never in production.

Per-platform scopes and flows (verified against developer docs):
- Facebook: Facebook Login for Business; scopes pages_show_list,
  pages_manage_posts, pages_read_engagement. Client picks the Page. Advanced
  Access requires Meta App Review.
- Instagram: Instagram API with Instagram Login (Business/Creator account);
  scope instagram_business_content_publish. 100 API posts per 24h.
- YouTube: Google OAuth 2.0; scope youtube.upload; client picks the channel.
  10,000 quota units/day default.
- TikTok: TikTok Login Kit; scope video.publish. App must pass TikTok audit for
  public posting; before audit, posts land in drafts/inbox.
- LinkedIn: Community Management API; scope w_organization_social; client picks
  the organization page. Requires app approval and a legal registered entity.
- X: OAuth 1.0a (tweet.write); pay-per-use, optional.

What Essential stores: the encrypted token (or refresh token) plus scopes and
expiry, never the password. Disconnect: client clicks "Disconnect" in Settings;
Essential revokes the token and sets PlatformConnection.revokedAt.

### 22.2 Dashboard API routes

All routes are under /api, require a JWT bearer token (M10 auth), and are scoped
to the authenticated client. Long-running operations (render, publish) return
202 Accepted with a jobId; the client polls the draft/status endpoints or
subscribes to the webhook. Render is async by design: a 3-15 minute talking-head
video takes minutes to produce, so a blocking response is never returned.

Connect (credentials):
- GET    /api/clients/:id/connections
         -> { platforms: [{ platform, status: connected|expired|never,
              scopes[], expiresAt?, keyHint? }] }
- POST   /api/clients/:id/connections/:platform/oauth/start
         body {} -> { authorizeUrl } (state = signed nonce)
- GET    /api/clients/:id/connections/:platform/oauth/callback?code&state
         -> { connected: true, platform } (exchanges code, stores encrypted token)
- DELETE /api/clients/:id/connections/:platform
         -> { disconnected: true } (revoke + revokedAt)
- GET    /api/clients/:id/connections/:platform/status
         -> { connected, expiresAt, scopes, refreshTokenPresent }

Topic-select -> render -> preview:
- POST   /api/clients/:id/topic-select
         body { topic, count (1-10, cap CLIENT_TOPIC_MAX=10),
                mediaType (image|video|both), platforms[],
                vendor (heygen|synthesia|did|argil),
                avatarId?, voiceId?, targetMinutes (3-15),
                language (en|es)?, podcastScript? }
         -> 202 { topicId, draftId, jobId } ; enqueues research/strategy/copy
- GET    /api/clients/:id/drafts/:draftId
         -> { status, strategy?, copy?, media?, previewUrls? } (poll target)
- POST   /api/clients/:id/drafts/:draftId/render
         body { mediaType, vendor, avatarId, voiceId, targetMinutes }
         -> 202 { jobId } ; enqueues media job; validates 3-15 and platform caps
- GET    /api/clients/:id/drafts/:draftId/preview
         -> { previewUrls, segmentPlan, needsStitch, durationSeconds,
              visualQaReport? }
- POST   /api/clients/:id/drafts/:draftId/preview/approve
         body { approvedBy } -> { stage: DRAFT, status } (preview gate)
- POST   /api/clients/:id/drafts/:draftId/approve
         body { platforms[] } -> per-platform FINAL approvals
- POST   /api/clients/:id/drafts/:draftId/publish
         -> 202 { jobId } ; enqueues publish job; runs only on approved AND
         connected platforms (approvals.canPublish gate)
- GET    /api/clients/:id/drafts/:draftId/status
         -> { research, strategy, copy, media, preview, approvals, publish }

Webhook (optional): POST /api/webhooks/draft-events
         body { draftId, event: draft.ready|media.rendered|preview.ready|
                approval.updated|publish.done, detail{} }

Error codes: 400 invalid body, 401 unauthenticated, 403 not owner/not approved,
404 not found, 409 already rendering, 422 video length outside 3-15 or over the
platform max, 429 rate limit, 500 internal. All bodies are JSON.


## 23. Fastify API Implementation and Client Instructions

### 23.1 Implementation status

The Section 22 routes are implemented in apps/api/index.ts as a Fastify
plugin (essentialApiPlugin). It binds the topic-select -> render -> preview ->
approve -> publish flow to the existing BullMQ queues (research, copy, media,
publish). Drafts are tracked in an in-memory DraftStore (mock-first; persisted
via Prisma in prod). Approvals use the packages/approvals state machine.

Routes implemented:
- POST   /api/clients/:id/topic-select            -> 202 { topicId, draftId, jobId }
- GET    /api/clients/:id/drafts/:draftId         -> poll target
- POST   /api/clients/:id/drafts/:draftId/render  -> 202 { jobId }
- GET    /api/clients/:id/drafts/:draftId/preview
- POST   /api/clients/:id/drafts/:draftId/preview/approve (stage 1)
- POST   /api/clients/:id/drafts/:draftId/approve (per-platform FINAL)
- POST   /api/clients/:id/drafts/:draftId/publish (gated by canPublish)
- GET    /api/clients/:id/drafts/:draftId/status

All routes require a JWT bearer token (M10 auth). Video length is validated
against the per-platform caps (Section 21) and the 3-minute minimum.

### 23.2 Client instructions: select a topic and preview your video

1. Log in to your Essential dashboard.
2. Click "Create Content."
3. Type your topic in the box (for example: "How small businesses can use
   AI"). Or click "Use Essential's Topics" to pick from 20 trending topics.
4. Choose how many pieces of content you want: 1 to 10.
5. Choose the type: Video, Image, or Both.
6. Choose your video length: 3, 5, 7, 10, or 15 minutes.
7. Pick your talking avatar (if you have one saved) and your voice.
8. Pick which platforms to post to: Facebook, Instagram, YouTube, TikTok,
   LinkedIn.
9. Click "Research My Topic." Essential starts working.
10. When it is ready, click "Preview." Watch the video right in the dashboard.
11. Like it? Click "Approve Preview." Then click "Approve" for each platform
    you chose.
12. Click "Publish." Essential posts it for you.

### 23.3 Claude Code only - no n8n, no workflow JSON

Essential is developed in Claude Code as a code-native TypeScript monorepo.
Legacy n8n artifacts (essential_superagent_n8n.json,
facebook_pages_superagent_n8n.json, build_essential_workflow.py,
social_superagent_setup.md) and the POC verification.json were deleted from
the repo. There are no workflow/config JSON artifacts for Essential
development. JSON is used only as HTTP request/response payloads (Section 22),
which is standard and expected. All configuration lives in .env / env vars and
TypeScript modules.


## 24. Deep Audit, Competitive Comparison, Profitability and Hosting (2026-09-07)

### 24.1 Audit verdict

Essential is a well-architected, mock-first TypeScript monorepo with verified
platform adapters, a working two-stage approval state machine, a Fastify API
with an executed round-trip test, and a clean de-n8n codebase. It is a strong
blueprint and skeleton, NOT yet a production SuperAgent. The AI brain
(strategist, copywriter, research) is still template/mock (no live LLM calls),
auth (M10), Prisma persistence, live publishing, analytics, and the weekly
digest worker are not implemented. Flaws found and fixed this audit:
- Strategist.generateStrategy dropped topic/angle/keyPoints from its return
  (TS2739) - fixed; copywriter now includes the hook point in each post;
  the copy processor accepts a strategy handoff from research (no duplicate
  research); the render route uses the real podcast script from the draft
  instead of a placeholder; package.json renamed to "essential".
  All fixes proven: TSC_EXIT=0 and the round-trip test passes 20/20.
- Missing runtime entrypoints: added apps/api/server.ts and
  apps/worker/server.ts (the API had no listen() and the workers were never
  started), plus Dockerfile and docker-compose.yml.

### 24.2 Competitive comparison (cited)

General autonomous agents: Genspark Super Agent (Plus $24.99/mo or $19.99/mo
annual, 10,000 credits/mo, 50 GB) [eesel.ai/blog/genspark-ai-review,
floatboat.ai/blog/genspark-super-agent-explained]; Manus AI (free 1,000
starter credits + 300 daily; paid plans) [lindy.ai/blog/manus-ai-review];
Flowith (Pro $19.90/mo, Ultimate $49.90/mo, Infinite $499.90/mo)
[therundown.ai/tools/flowith]. Coding agents: Claude Code ranked #1 in 2026
[firecrawl.dev/blog/best-ai-coding-agents, mightybot.ai]. Social media tools:
Buffer (free 1 user/3 profiles; ~$6-12/channel) [zapier.com/blog/
best-social-media-management-tools], Metricool ($25/mo starter, 5 brands)
[zapier.com], Publer (Business $10/mo) [ampifire.com].

Essential vs competitors: Essential is a VERTICAL domain agent (social
content + publishing) with a two-stage human approval lock and BYOK tools -
deeper for its niche than general agents (Genspark/Manus/Flowith), which
handle broad tasks but do not publish to Facebook/Instagram/YouTube/TikTok/
LinkedIn natively with per-platform compliance. Essential's gap: no live AI
calls, no auth/DB, no analytics yet. Unmatched only after M10-M14 are built.

### 24.3 Profitability

Unit costs (cited): avatar video - HeyGen $29/mo for 3 videos (~$9.67/video)
[arcade.software/post/synthesia-pricing], D-ID $5.90/mo for 10 min (~$1.77
per 3-min video) [arcade.software], Synthesia $29/mo ~10 min/mo
[argil.ai/blog/d-id-pricing-5be73]. LLM tokens: OpenAI from ~$0.20-0.30/M
input, Gemini from ~$1.5/M, Perplexity Sonar search fee $5-14 per 1,000
queries [amnic.com, buildmvpfast.com, cloudzero.com]. Hosting: Render Hobby
$5/mo + usage, Starter web $7/mo; Railway Hobby $5/mo + $5 usage
[render.com/articles/railway-vs-fly-io, expresstech.io]. Most media tools
(Pollinations, Pexels, Unsplash) are free.

Model: BYOK is the profitability lever - clients bring their own avatar/LLM
keys, so Essential does not absorb per-render costs. Essential's own cost per
client is then ~hosting only (split across clients) + free-first tooling.
At $49-99/mo per client (vs Buffer $6-12/channel, Metricool $25, Genspark
$25), break-even is ~5-10 clients; 20+ clients at $79/mo is comfortably
profitable. Verdict: profitable as a per-client SaaS with BYOK + free-first
routing; NOT profitable if Essential pays all avatar/LLM costs itself.

### 24.4 Hosting recommendation

Recommendation: Render (Starter web $7/mo + managed Redis ~$7/mo, no egress
surprise) or Railway (Hobby $5/mo + usage). Both run the docker-compose
stack (Redis + API + worker) unchanged. Render is recommended for
dependability and predictable cost at small scale; migrate to AWS ECS/RDS/
ElastiCache when client count grows. [render.com, expresstech.io]


## 25. Step-by-Step Runbook (local + deploy)

See RUNBOOK.md for the full guide. Summary:
1. npm install; npx tsc --noEmit (must exit 0).
2. npx tsx apps/api/roundtrip-test.ts (must pass 20/20).
3. docker compose up -d --build (Redis + API + worker).
4. curl localhost:8080/health; POST /api/clients/:id/topic-select.
5. Set .env (JWT_SECRET, PASSWORD_PEPPER, API keys); LIVE_PUBLISH=false.
6. M6: run test-account posts per platform in mock mode first.
7. Enable LIVE_PUBLISH=true only after M6 passes on test accounts.
8. Deploy to Render/Railway with the same compose stack + managed Redis.

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
