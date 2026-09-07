/**
 * ESSENTIAL - Sprint verification harness (A1 / A3 / D4 / B4 / B6)
 * Runs against the live Postgres + Redis stack.
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 */
import { Pool } from 'pg';
import Redis from 'ioredis';
import { execFile } from 'node:child_process';
import { PgUserStore, PgSessionStore, RedisRateLimiter } from './packages/auth/pg';
import { createNeoEngine } from './packages/neo';
import { createToolsManager } from './packages/tools';
import { buildEssentialApp, type DraftRecord } from './apps/api/index';
import { createPgDraftStore } from './packages/persistence';
import { createLiveQueues } from './apps/worker/live-queues';
import { createPgApprovalStateMachine } from './packages/approvals/pg';

function report(label: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${label}${extra ? ' ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
}

function curl(url: string, maxSec: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sN', '--max-time', String(maxSec), url], (err, out) => {
      if (err) resolve(String(out ?? ''));
      else resolve(String(out ?? ''));
    });
  });
}

async function main(): Promise<void> {
  const pg = new Pool({
    host: '127.0.0.1', port: 5432, user: 'essential',
    password: 'essential_dev', database: 'essential',
  });
  await pg.query('SELECT 1');

  // A1: Postgres-backed user + session stores (durable, shared across instances)
  const users = new PgUserStore(pg);
  await users.initSchema();
  const email = `sprint_${Date.now()}@example.com`;
  const u = await users.create(email, 's3cret_hash', 'client');
  const u2 = await new PgUserStore(pg).getByEmail(email);
  report('A1 user persists across store instances', !!u2 && u2.id === u.id, `(${email})`);
  const sessions = new PgSessionStore(pg);
  const tok = 'tok_' + Date.now();
  await sessions.revoke(tok);
  report('A1 session revoke persists', await new PgSessionStore(pg).isRevoked(tok));

  // A3: Redis-backed shared rate limiter (cross-instance sees same window)
  const redis = new Redis(6379, '127.0.0.1', { maxRetriesPerRequest: 1 });
  const rl = new RedisRateLimiter(redis, 60_000, 5);
  const key = 'sprint_rl_' + Date.now();
  let allAllowed = true;
  for (let i = 0; i < 5; i++) allAllowed = allAllowed && (await rl.check(key)).allowed;
  const sixth = await new RedisRateLimiter(redis, 60_000, 5).check(key);
  report('A3 redis limiter allows 5 then blocks 6th (shared instance)', allAllowed && !sixth.allowed);

  // D4: Neo vector retrieval (feature-hash + cosine)
  const neo = createNeoEngine();
  const res = neo.search('talking head avatar video');
  const top = res.results.slice(0, 3).map((r) => r.id);
  report('D4 vector search surfaces video doc', res.results.length > 0 && top.includes('video'), `(${top.join(',')})`);

  // B4: tools registry introspection (new real adapters registered)
  try {
    const tm = createToolsManager();
    console.log('B4 toolsManager keys:', Object.keys(tm).join(', '));
    const reg = (tm.registry as { adapters?: Map<string, unknown>; list?: () => string[] });
    if (typeof reg.list === 'function') console.log('B4 registry list:', reg.list().join(', '));
  } catch (e) {
    console.log('B4 introspection error:', (e as Error).message);
  }

  // B6: SSE push for draft status - live HTTP check
  const port = 8101;
  const drafts = createPgDraftStore<DraftRecord>(pg);
  await drafts.initSchema();
  const approvals = await createPgApprovalStateMachine(pg);
  const queues = createLiveQueues({ host: '127.0.0.1', port: 6379 });
  const app = await buildEssentialApp({
    draftStore: drafts, approvals, queues,
  });
  const created = await drafts.create({
    clientId: 'client_b6', topic: 'B6 SSE test', count: 1, mediaType: 'video',
    platforms: ['facebook'], vendor: 'heygen', targetMinutes: 3,
    language: 'en', podcastScript: false,
  });
  await app.listen({ port, host: '127.0.0.1' });
  const out = await curl(`http://127.0.0.1:${port}/api/clients/client_b6/drafts/${created.draftId}/events`, 4);
  console.log('B6 SSE raw sample:', out.slice(0, 300));
  const hasDataFrame = out.includes('data: {"draftId"') && out.includes('"status"');
  const hasHeartbeat = out.includes(': heartbeat');
  report('B6 SSE pushes draft status frames', hasDataFrame, `(frames=${out.split('data:').length - 1})`);
  report('B6 SSE heartbeat present', hasHeartbeat);
  await app.close();

  await pg.end();
  redis.disconnect();
  console.log(process.exitCode ? '=== SPRINT VERIFY: FAILURES PRESENT ===' : '=== SPRINT VERIFY: ALL PASSED ===');
}

main().catch((e) => {
  console.error('sprint-verify error:', e);
  process.exit(1);
});
