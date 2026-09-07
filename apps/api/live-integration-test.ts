/**
 * ESSENTIAL - Social Media Super Agent
 * apps/api/live-integration-test.ts
 *
 * Integration test for the FULL Essential pipeline against a LIVE stack:
 * real Redis (BullMQ queues + workers) + real Postgres (PgDraftStore).
 * The same round-trip that passes on fake queues must pass here:
 *
 *   topic-select -> research/copy (workers) -> render (worker) -> preview
 *   -> approve (two-stage) -> publish (worker)
 *
 * It also asserts the draft is actually persisted in Postgres and that jobs
 * flowed through Redis. Requires local Redis (127.0.0.1:6379) and Postgres
 * (127.0.0.1:5432, db `essential`, user `essential` / password
 * `essential_dev`). Override via env: REDIS_HOST/REDIS_PORT/PGHOST/PGPORT/
 * PGUSER/PGPASSWORD/PGDATABASE.
 *
 * Run: npx tsx apps/api/live-integration-test.ts
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Pool } from 'pg';
import { buildEssentialApp } from './index';
import { createPgDraftStore, type AsyncDraftStore } from '../../packages/persistence';
import type { DraftRecord } from './index';
import { ApprovalStateMachine } from '../../packages/approvals';
import { createLiveQueues } from '../worker/live-queues';
import { startLiveWorkers } from '../worker/live-worker';

const REDIS = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
};
const PG = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'essential',
  password: process.env.PGPASSWORD ?? 'essential_dev',
  database: process.env.PGDATABASE ?? 'essential',
};

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) process.exitCode = 1;
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  pred: (t: T) => boolean,
  label: string,
  timeoutMs = 25_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v && pred(v)) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function main(): Promise<void> {
  // Mock test-account credentials so adapters instantiate in mock mode.
  process.env.FB_PAGE_ACCESS_TOKEN = 'mock_fb_page_access_token';
  process.env.FB_PAGE_ID = 'mock_fb_page_id';
  process.env.INSTAGRAM_TOKEN = 'mock_instagram_token';
  process.env.INSTAGRAM_IG_ID = 'mock_instagram_ig_id';
  process.env.LINKEDIN_ACCESS_TOKEN = 'mock_linkedin_access_token';
  process.env.LINKEDIN_ORG_URN = 'mock_linkedin_org_urn';
  process.env.TIKTOK_ACCESS_TOKEN = 'mock_tiktok_access_token';
  process.env.TIKTOK_OPEN_ID = 'mock_tiktok_open_id';
  process.env.YOUTUBE_ACCESS_TOKEN = 'mock_youtube_access_token';
  process.env.YOUTUBE_CHANNEL_ID = 'mock_youtube_channel_id';

  console.log('=== ESSENTIAL LIVE INTEGRATION TEST (Redis + Postgres + BullMQ) ===');

  const pool = new Pool(PG);
  const store: AsyncDraftStore<DraftRecord> = createPgDraftStore<DraftRecord>(pool);
  await store.initSchema();
  await pool.query('DELETE FROM essential_drafts'); // clean slate

  const approvals = new ApprovalStateMachine();
  const queues = createLiveQueues(REDIS);
  const workers = startLiveWorkers(REDIS, store, approvals);

  // Give BullMQ workers a moment to connect.
  await new Promise((r) => setTimeout(r, 500));

  const app = await buildEssentialApp({ draftStore: store, approvals, queues });
  await app.ready();

  // 1. health
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert(health.statusCode === 200, 'GET /health returns 200');

  // 2. topic-select -> 202 + draftId
  const ts = await app.inject({
    method: 'POST',
    url: '/api/clients/live_001/topic-select',
    payload: {
      topic: 'AI for small business logistics',
      count: 1,
      mediaType: 'video',
      platforms: ['facebook', 'youtube'],
      vendor: 'heygen',
      targetMinutes: 3,
    },
  });
  if (ts.statusCode !== 202) { console.error('TOPIC-SELECT NOT 202 ->', ts.statusCode, ts.body); process.exit(1); }
  assert(ts.statusCode === 202, 'live topic-select returns 202');
  const draftId = ts.json().draftId as string;
  assert(typeof draftId === 'string' && draftId.startsWith('draft_'), 'live topic-select returns draftId');

  // 3. research + copy workers write copy into Postgres
  const withCopy = await waitFor(() => store.get(draftId), (d) => !!d.copy, 'copy written by worker');
  assert(!!withCopy.copy, 'copy worker persisted copy to Postgres');

  // 4. render -> 202, media worker renders -> preview_ready
  const rd = await app.inject({
    method: 'POST',
    url: `/api/clients/live_001/drafts/${draftId}/render`,
    payload: { mediaType: 'video', vendor: 'heygen', targetMinutes: 3 },
  });
  assert(rd.statusCode === 202, 'live render returns 202');

  const ready = await waitFor(
    () => store.get(draftId),
    (d) => d.status === 'preview_ready' && !!d.previewUrls?.length,
    'media worker preview_ready',
  );
  assert(!!ready.previewUrls?.length, 'media worker persisted previewUrls');
  assert((ready.previewUrls?.[0] ?? '').startsWith('mock://'), 'preview URL is mock://');

  // 5. preview endpoint
  const pv = await app.inject({ method: 'GET', url: `/api/clients/live_001/drafts/${draftId}/preview` });
  assert(pv.statusCode === 200, 'live preview returns 200');
  assert((pv.json().previewUrls as string[]).length > 0, 'live preview returns previewUrls');

  // 6. two-stage approvals
  const ap1 = await app.inject({
    method: 'POST',
    url: `/api/clients/live_001/drafts/${draftId}/preview/approve`,
    payload: { approvedBy: 'patricia' },
  });
  assert(ap1.statusCode === 200, 'live preview approve (stage 1) returns 200');

  const ap2 = await app.inject({
    method: 'POST',
    url: `/api/clients/live_001/drafts/${draftId}/approve`,
    payload: { approvedBy: 'patricia', platforms: ['facebook', 'youtube'] },
  });
  assert(ap2.statusCode === 200, 'live final approve (per-platform) returns 200');

  // 7. publish -> 202 (gate passes)
  const pub = await app.inject({ method: 'POST', url: `/api/clients/live_001/drafts/${draftId}/publish` });
  assert(pub.statusCode === 202, 'live publish returns 202');

  // 8. persisted in Postgres with final status
  const row = await pool.query<{ record: { status: string; previewUrls?: string[] } }>(
    'SELECT record FROM essential_drafts WHERE draft_id = $1',
    [draftId],
  );
  assert(row.rowCount === 1, 'draft row persisted in Postgres');
  assert(row.rows[0].record.status === 'published', 'persisted status is published');
  assert((row.rows[0].record.previewUrls?.length ?? 0) > 0, 'persisted previewUrls present');

  // 9. jobs flowed through Redis (BullMQ queue counters)
  const mediaQueue = queues.media as unknown as { getJobCounts(): Promise<Record<string, number>> };
  const counts = await mediaQueue.getJobCounts();
  console.log('media queue counts (Redis):', JSON.stringify(counts));
  assert(typeof counts.completed === 'number' && counts.completed >= 1, 'media job completed in Redis');

  // 10. negative: 15-min Instagram (max 10) -> 422 on the live stack
  const bad = await app.inject({
    method: 'POST',
    url: '/api/clients/live_001/topic-select',
    payload: {
      topic: 'AI for small business logistics',
      count: 1,
      mediaType: 'video',
      platforms: ['instagram'],
      vendor: 'heygen',
      targetMinutes: 15,
    },
  });
  assert(bad.statusCode === 422, 'live topic-select rejects 15 min on Instagram with 422');

  await workers.close();
  await app.close();
  await pool.end();

  console.log('=== LIVE INTEGRATION COMPLETE ===');
  // BullMQ keeps Redis connections open; exit explicitly so the harness
  // terminates even if a queue/worker handle is still referenced.
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error('LIVE INTEGRATION FAILED:', err);
  process.exit(1);
});
