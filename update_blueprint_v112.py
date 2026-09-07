#!/usr/bin/env python3
"""Append Section 30 (Sprint A - wired entrypoints) to ESSENTIAL_BLUEPRINT.md and CLAUDE.md, bump version to 1.12."""
import re

section = """
## 30. Sprint A - wired entrypoints (v1.12)

Items G1 and G7 of the handoff are landed: `apps/api/server.ts` and
`apps/worker/server.ts` now bootstrap the live stack so `docker compose up`
runs the real Essential product end-to-end.

### 30.1 API entrypoint (apps/api/server.ts)
Bootstraps, in order:
- Postgres `PgDraftStore` (draft persistence; `initSchema()` auto-migrates on
  boot) via env `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`
- Live BullMQ queues on Redis (`createLiveQueues`, sanitized names) via
  `REDIS_HOST/REDIS_PORT`
- Shared `ApprovalStateMachine` - the API and workers share one instance so
  the two-stage gate (preview -> per-platform) is enforced for real
- M10 `AuthService` (JWT + scrypt/pepper) via `JWT_SECRET`/`PASSWORD_PEPPER`
- Neo embedded AI assistant (`createNeoEngine`)
- Structured JSON logger (`createLogger` + `LOG_LEVEL`)
- Graceful shutdown on SIGINT/SIGTERM (close HTTP, close Postgres pool)

### 30.2 Worker entrypoint (apps/worker/server.ts)
Bootstraps: Postgres `PgDraftStore` (workers write results back), shared
`ApprovalStateMachine`, live BullMQ workers (`startLiveWorkers`), and a
process-level `unhandledRejection` guard so a stray rejection logs and
continues instead of killing the process.

### 30.3 docker-compose.yml (reconciled)
- `postgres` service added (postgres:16-alpine, `essential` user/db, healthcheck
  `pg_isready`, `pgdata` volume)
- `api` and `worker` now `depends_on` BOTH `redis` and `postgres` with
  `condition: service_healthy`, so startup order is correct
- services: postgres, redis, api, worker (validated via YAML parse)

### 30.4 End-to-end proof (apps/api/e2e-http-test.ts)
Drives the REAL running servers over HTTP (not inject): register -> topic-select
-> poll(copy persisted) -> render -> poll(preview_ready) -> preview ->
preview/approve -> approve -> publish -> status, plus a Neo chat call. The
pipeline completes end-to-end through Redis + Postgres + both processes.

### 30.5 Verified results (2026-09-07)
- `npx tsc --noEmit` -> exit 0
- roundtrip / neo / prod / live-integration harnesses -> all PASS
- `apps/api/e2e-http-test.ts` against the running servers -> all PASS
- docker-compose YAML validated; services [postgres, redis, api, worker]
- NOTE: the sandbox has no Docker daemon, so `docker compose up` was validated
  via YAML parse + the equivalent live-process boot instead of a container run.
  On a machine with Docker, `docker compose up --build -d` boots the same stack.
"""

def bump_version(text: str) -> str:
    return (
        text.replace("**Version:** 1.11", "**Version:** 1.12")
        .replace("Version: 1.11", "Version: 1.12")
        .replace("Version: v1.11", "Version: v1.12")
    )

for path in ["/home/user/ESSENTIAL_BLUEPRINT.md", "/home/user/CLAUDE.md"]:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    text = bump_version(text)
    if "## 30. Sprint A" not in text:
        text = text.rstrip() + "\n" + section
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"updated {path} -> {len(text)} bytes")
