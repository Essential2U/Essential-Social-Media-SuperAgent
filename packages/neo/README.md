# Neo — Embedded AI Assistant (packages/neo)

**Owner:** E. Patricia Rogers — Unmatched Logistics LLC
**Part of:** the Essential monorepo (not a standalone package — no own `package.json`; compiled and tested via the repo root).

## What it is

Neo is the embedded AI assistant for Essential clients. It answers questions about Essential's functions and capabilities and searches topics, grounded in a capability registry — **RAG-lite: vector-space retrieval over the capability corpus + the live platform registry**. It reuises the existing Gemini client for generation (mock-mode aware) and ships with session memory and a sliding-window rate limiter.

## Source & dependencies

- Single file: `packages/neo/index.ts` (~15 KB)
- Imports from sibling packages (compile requires the full repo):
 - `../adapters` — `PLATFORM_REGISTRY`, `PlatformId`
  - `../core/errors` — `RateLimitError`
  - `../ai/gemini` — `createGeminiClient`, `GeminiClient`

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `NeoDoc` | interface | Capability document (`id`, `title`, `body`, `tags`) |
| `NeoChatResult` | interface | `{ answer,, sources, sessionId }` |
| `NeoSearchResult` | interface | `{ query, results }` |
| `NeoEngineOptions` | interface | `maxAsksPerMinute?` |
| `NeoEngine` | class | Engine: `capabilities()`, `search()`, `chat()`, SSE chat |
| `createNeoEngine` | factory | `createNeoEngine(opts?)` |
| `neoRoutes` | Fastify plugin | Registers all `/api/neo/*` routes |

## Routes

| Route | Method | Description |
|---|---|---|
| `/api/neo/capabilities` | GET | Full capability manifest (`neo.capabilities()`) |
| `/api/neo/chat` | POST | Grounded Q&A — body `{ question, sessionId? }` |
| `/api/neo/search` | POST | Topic/capability search — body `{ query }` |
| `/api/neo/chat?q=...&sessionId=...` | GET | SSE streaming chat (word-by-word tokens, `[DONE]` frame) |

## Behaviour (verified in source)

- **Rate limit:** sliding window, default **10 asks / 60 s** (`maxAsksPerMinute` option); over limit throws `RateLimitError` → HTTP 429.
- **Session memory:** in-memory `Map` keyed by `sessionId` (auto `neo_<rand>`), with **30-minute TTL** eviction (`SESSION_TTL_MS = 30 * 60 * 1000`); follow-up questions use prior context.
- **Retrieval (D4):** feature-hashed TF vectors (256-dim) + cosine similarity, plus a small lexical boost for exact tag/title hits — replaces the old keyword+stem scoring.
- **SSE:** `text/event-stream`, no-cache, flushed headers, 15 s heartbeat, abort/close cleanup.

## Wiring into the API

`apps/api/index.ts`:
```ts
import { NeoEngine, neoRoutes } from '../../packages/neo';
// in buildEssentialApp:
const neo = opts.neo ?? new NeoEngine();
await app.register(neoRoutes, { neo });
```
- `gateNeo?: boolean` option — when `true`, `/api/neo/*` routes require a JWT (auth hook in `apps/api/index.ts`); wired from `LIVE_PUBLISH === 'true'` in `apps/api/server.ts`.

## Testing

```bash
npx tsx apps/api/neo-test.ts   # capabilities, chat, search, session context, SSE frames, 429
```
Covered: capability manifest, grounded chat, topic search, session memory, SSE streaming, rate-limit 429.

## Standing constraints (from CLAUDE.md §9)

- Code-native only — no workflow-JSON artifacts.
- Never hard-code model IDs — read from env config.
- Never invent statistics or claims in copy.
