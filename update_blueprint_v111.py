#!/usr/bin/env python3
"""Append Section 29 (Neo assistant + gap audit + recommendations) to ESSENTIAL_BLUEPRINT.md and CLAUDE.md, bump version to 1.11."""
import re

section = """
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
"""

def bump_version(text: str) -> str:
    return (
        text.replace("**Version:** 1.10", "**Version:** 1.11")
        .replace("Version: 1.10", "Version: 1.11")
        .replace("Version: v1.10", "Version: v1.11")
    )

for path in ["/home/user/ESSENTIAL_BLUEPRINT.md", "/home/user/CLAUDE.md"]:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    text = bump_version(text)
    if "## 29. Neo" not in text:
        text = text.rstrip() + "\n" + section
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"updated {path} -> {len(text)} bytes")
