# ESSENTIAL — Deployment Runbook (v1.10)

Owner: E. Patricia Rogers — Unmatched Logistics LLC
Build tool: Claude Code (code-native, no workflow-JSON artifacts)

## 1. Architecture

```
Client dashboard (Fastify API)  ->  BullMQ queues (Redis)
                                      |  research -> copy -> media -> publish
                                      v
                              Workers (apps/worker/live-worker.ts)
                                      |
                                      v
                       Postgres (PgDraftStore: essential_drafts)
```

Pipeline: topic-select → research/strategy → copy → render → preview →
two-stage approval → publish. Every stage is idempotent (jobId = draftId:stage)
and retryable.

## 2. Prerequisites

- Node.js 20+ and npm
- Docker + Docker Compose (for the full stack), OR local Redis + Postgres
- A Redis server (BullMQ backend) and a Postgres server (draft persistence)

## 3. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_HOST` / `REDIS_PORT` | `127.0.0.1` / `6379` | BullMQ backend |
| `PGHOST` / `PGPORT` | `127.0.0.1` / `5432` | Postgres host/port |
| `PGUSER` / `PGPASSWORD` | `essential` / `essential_dev` | Postgres credentials |
| `PGDATABASE` | `essential` | Postgres database |
| `LOG_LEVEL` | `info` | Structured logger verbosity |
| `PASSWORD_MIN_LENGTH` / `PASSWORD_REQUIRE_SPECIAL` | `8` / `true` | M10 auth policy |
| `FB_PAGE_ACCESS_TOKEN`, `FB_PAGE_ID`, `INSTAGRAM_TOKEN`, `INSTAGRAM_IG_ID`, `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_ORG_URN`, `TIKTOK_ACCESS_TOKEN`, `TIKTOK_OPEN_ID`, `YOUTUBE_ACCESS_TOKEN`, `YOUTUBE_CHANNEL_ID` | `mock_*` | Platform publish credentials (mock in dev) |

Never commit real tokens. Use the platform's OAuth flow in production.

## 4. Local development

```bash
npm install
npx tsc --noEmit                # typecheck
npx tsx apps/api/roundtrip-test.ts          # fake queues + in-memory store
npx tsx apps/api/live-integration-test.ts   # real Redis + Postgres + BullMQ
```

The live integration test requires Redis and Postgres running locally. In the
sandbox these are started with:

```bash
redis-server --daemonize yes
sudo pg_ctlcluster 16 main start
sudo -u postgres psql -c "CREATE ROLE essential LOGIN PASSWORD 'essential_dev';"
sudo -u postgres psql -c "CREATE DATABASE essential OWNER essential;"
```

## 5. Docker Compose stack

`docker-compose.yml` defines four services: `redis`, `postgres`, `api`, `worker`.

```bash
docker compose up --build -d
docker compose ps        # all services healthy
```

Healthchecks: API probes `GET /health`; Redis probes `redis-cli ping`;
Postgres probes `pg_isready`. The API and worker wait for redis/postgres to be
healthy before starting.

## 6. Database migration

The schema is auto-created on boot (`PgDraftStore.initSchema()` — idempotent
`CREATE TABLE IF NOT EXISTS` + `CREATE SEQUENCE IF NOT EXISTS`). No manual
migration step is required for v1.10. For production, run the API once to
create the table, then deploy.

## 7. Smoke test after deploy

```bash
curl -s https://<host>/health                     # {"status":"ok"}
# POST /api/clients/:id/topic-select  -> 202 + draftId
# GET  /api/clients/:id/drafts/:draftId          # poll until copy done
# POST /api/clients/:id/drafts/:draftId/render   # 202
# GET  /api/clients/:id/drafts/:draftId/preview  # preview URLs
# POST .../preview/approve  ->  POST .../approve -> POST .../publish
# GET  .../status                                 # aggregate pipeline state
```

## 8. Deployment targets

| Target | API + Worker | Postgres | Redis | Notes |
|---|---|---|---|---|
| Render | 2× Starter `$7/mo` | Starter `$7/mo` | `$10/mo` or BYO | easiest managed |
| Railway | Hobby `$5/mo` min + usage | Postgres plugin | Redis plugin | usage-billed |
| Hetzner | 1× CX22 ~`€4.49/mo` (all 4 containers) | on-box | on-box | cheapest, DIY ops |
| Cloud Run | 2 services (free tier) | Cloud SQL | Upstash | serverless, cold starts |

See blueprint §28 for the full cost study with sources.

## 9. Operations

- **Scaling**: add worker replicas — BullMQ distributes jobs across workers on
  the same Redis. Scale API independently.
- **Backups**: nightly `pg_dump` of `essential` DB; enable Redis AOF for
  durability.
- **Monitoring**: `/health` liveness; structured JSON logs (`LOG_LEVEL`) are
  parseable by CloudWatch / Datadog / Loki; `request_start`/`request_end` carry
  `traceId`.
- **Rollback**: redeploy the previous image. Schema changes are additive
  (idempotent `initSchema`), so rollback is safe.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Queues not processing | Redis down or wrong `REDIS_HOST`/`REDIS_PORT`; check worker logs |
| Drafts return 500 | Postgres down or wrong `PG*` env; check `pg_isready` |
| `422` on render/topic-select | Video length exceeds a platform cap (e.g. Instagram max 10 min) |
| Publish blocked `403` | Missing two-stage approvals — approve preview then per-platform |
| Workers idle after deploy | Queue names must match (`essential-research/copy/media/publish`) |
