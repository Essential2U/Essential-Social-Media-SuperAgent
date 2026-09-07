#!/usr/bin/env python3
"""Append Sections 27-28 (live stack + hosting cost study) to ESSENTIAL_BLUEPRINT.md and CLAUDE.md, bump version to 1.10."""
import re

section = """
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
"""

def bump_version(text: str) -> str:
    return text.replace("**Version:** 1.9", "**Version:** 1.10").replace("Version: 1.9", "Version: 1.10").replace("Version: v1.9", "Version: v1.10")

for path in ["/home/user/ESSENTIAL_BLUEPRINT.md", "/home/user/CLAUDE.md"]:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    text = bump_version(text)
    if "## 27. Live Redis" not in text:
        text = text.rstrip() + "\n" + section
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"updated {path} -> {len(text)} bytes")
