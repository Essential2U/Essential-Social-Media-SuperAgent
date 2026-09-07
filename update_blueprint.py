#!/usr/bin/env python3
"""Append Section 26 (Production Hardening) to ESSENTIAL_BLUEPRINT.md and CLAUDE.md, bump version to 1.9."""
import re

section = """
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
"""

def bump_version(text: str) -> str:
    return text.replace("Version: 1.8", "Version: 1.9").replace("Version: v1.8", "Version: v1.9")

for path in ["/home/user/ESSENTIAL_BLUEPRINT.md", "/home/user/CLAUDE.md"]:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    text = bump_version(text)
    text = text.rstrip() + "\n" + section
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"updated {path} -> {len(text)} bytes")
