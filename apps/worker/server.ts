/**
 * ESSENTIAL - Social Media Super Agent
 * apps/worker/server.ts
 *
 * Worker entrypoint (Sprint A - wired to the live stack). Bootstraps:
 *   - Postgres PgDraftStore (results written back by workers)
 *   - Shared ApprovalStateMachine persisted in Postgres (B1 fix: the publish
 *     gate reads the API's approvals across processes)
 *   - Live BullMQ workers on Redis (research/copy/media/publish)
 *   - Process-level unhandledRejection guard
 *
 * Run: npx tsx apps/worker/server.ts  (or via docker-compose)
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Pool } from 'pg';
import { createPgDraftStore } from '../../packages/persistence';
import type { DraftRecord } from '../../apps/api/index';
import { startLiveWorkers } from './live-worker';
import { createPgApprovalStateMachine } from '../../packages/approvals/pg';
import { resolvePgPoolConfig, resolveRedisConnection } from '../../packages/core/db-config';

async function main(): Promise<void> {
  // Prefers DATABASE_URL / REDIS_URL (what every managed host - Render,
  // Railway, Fly - hands you), falls back to discrete PGHOST/REDIS_HOST for
  // local dev and docker-compose. See packages/core/db-config.ts.
  const redis = resolveRedisConnection();
  const pg = new Pool(resolvePgPoolConfig());

  // Persistence: Postgres-backed draft store (workers write results here).
  const drafts = createPgDraftStore<DraftRecord>(pg);
  await drafts.initSchema();

  // Shared approval state machine - persisted in Postgres so the API and the
  // worker (separate processes) see the SAME approvals (B1 fix).
  const approvals = await createPgApprovalStateMachine(pg);

  // Live BullMQ workers on Redis (queue names sanitized, no ':').
  const workers = startLiveWorkers(redis, drafts, approvals);

  // Process-level guard: a stray rejection must not kill the worker.
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection', reason);
  });

  console.log(`Essential worker started on ${redis.host}:${redis.port} (research/copy/media/publish)`);
}

main().catch((err) => {
  console.error('WORKER BOOT FAILED:', err);
  process.exit(1);
});
