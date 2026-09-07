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

async function main(): Promise<void> {
  const redis = {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };
  const pg = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'essential',
    password: process.env.PGPASSWORD ?? 'essential_dev',
    database: process.env.PGDATABASE ?? 'essential',
  });

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
