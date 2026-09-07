/**
 * ESSENTIAL - Social Media Super Agent
 * apps/api/neo-test.ts
 *
 * Test harness for Neo - the embedded AI assistant. Exercises the engine and
 * the /api/neo/* routes: capability manifest, grounded chat, topic search,
 * session memory, SSE streaming, and the sliding-window rate limit.
 *
 * Run: npx tsx apps/api/neo-test.ts
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { buildEssentialApp, type EssentialQueues } from './index';
import { NeoEngine } from '../../packages/neo';

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) process.exitCode = 1;
}

function fakeQueues(): EssentialQueues {
  return {
    research: { add: async () => ({ id: 'r' }) },
    copy: { add: async () => ({ id: 'c' }) },
    media: { add: async () => ({ id: 'm' }) },
    publish: { add: async () => ({ id: 'p' }) },
  };
}

async function main(): Promise<void> {
  console.log('=== ESSENTIAL NEO TEST ===');

  const neo = new NeoEngine();
  const app = await buildEssentialApp({ neo, queues: fakeQueues() });
  await app.ready();

  // 1. capability manifest
  const caps = await app.inject({ method: 'GET', url: '/api/neo/capabilities' });
  assert(caps.statusCode === 200, 'capabilities returns 200');
  const capsBody = caps.json().capabilities as { id: string }[];
  assert(capsBody.length >= 12, 'capabilities manifest has >= 12 entries');

  // 2. grounded chat
  const chat = await app.inject({
    method: 'POST',
    url: '/api/neo/chat',
    payload: { question: 'which platforms can I publish video to?' },
  });
  assert(chat.statusCode === 200, 'chat returns 200');
  const cj = chat.json();
  assert(typeof cj.answer === 'string' && cj.answer.length > 0, 'chat returns an answer');
  assert(
    cj.sources.some((s: string) => /youtube|platform|video/i.test(s)),
    'video answer grounded in a platform/video capability doc',
  );
  assert(typeof cj.sessionId === 'string' && cj.sessionId.startsWith('neo_'), 'chat returns sessionId');

  // 3. topic search
  const s = await app.inject({
    method: 'POST',
    url: '/api/neo/search',
    payload: { query: 'talking head avatar' },
  });
  assert(s.statusCode === 200, 'search returns 200');
  const sj = s.json();
  assert(sj.results.length > 0, 'search returns results');
  assert(sj.results.some((r: { id: string }) => r.id === 'video'), 'search surfaces avatar/video doc');

  // 4. session memory - follow-up
  const f = await app.inject({
    method: 'POST',
    url: '/api/neo/chat',
    payload: { question: 'which platforms?', sessionId: cj.sessionId },
  });
  assert(f.statusCode === 200 && f.json().sources.length > 0, 'follow-up chat uses session context');

  // 5. SSE streaming
  const st = await app.inject({ method: 'GET', url: '/api/neo/chat?q=platforms' });
  assert(st.statusCode === 200 && st.body.includes('data:'), 'SSE streaming emits data frames');

  // 6. rate limit
  const neo2 = new NeoEngine({ maxAsksPerMinute: 3 });
  const app2 = await buildEssentialApp({ neo: neo2, queues: fakeQueues() });
  await app2.ready();
  for (let i = 0; i < 3; i++) {
    await app2.inject({ method: 'POST', url: '/api/neo/chat', payload: { question: 'what is essential' } });
  }
  const rl = await app2.inject({ method: 'POST', url: '/api/neo/chat', payload: { question: 'what is essential' } });
  assert(rl.statusCode === 429, 'neo rate limit returns 429');

  await app.close();
  await app2.close();
  console.log('=== NEO TEST COMPLETE ===');
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error('NEO TEST FAILED:', err);
  process.exit(1);
});
