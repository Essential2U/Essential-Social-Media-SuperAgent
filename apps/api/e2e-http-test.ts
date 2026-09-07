/**
 * ESSENTIAL - Social Media Super Agent
 * apps/api/e2e-http-test.ts
 *
 * End-to-end HTTP test against the WIRED entrypoint (apps/api/server.ts) and
 * the live worker (apps/worker/server.ts). Unlike the inject-based harnesses,
 * this drives the real running servers over HTTP + Redis + Postgres:
 *
 *   register -> topic-select -> poll(copy) -> render -> poll(preview_ready)
 *   -> preview -> preview/approve -> approve -> publish -> status
 *
 * Requires: Redis (127.0.0.1:6379), Postgres (127.0.0.1:5432, db essential),
 * and both servers running (start them first):
 *   nohup npx tsx apps/worker/server.ts > /tmp/worker.log 2>&1 &
 *   nohup npx tsx apps/api/server.ts    > /tmp/api.log    2>&1 &
 *
 * Run: npx tsx apps/api/e2e-http-test.ts
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

const BASE = process.env.E2E_BASE ?? 'http://localhost:8080';

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log('=== ESSENTIAL E2E HTTP TEST (wired entrypoint) ===');

  const email = `e2e_${Date.now()}@essential.local`;
  const password = 'Password!2026';

  // 1. register -> token
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert(reg.status === 201, 'register returns 201');
  const token = (await reg.json()).token as string;
  assert(typeof token === 'string' && token.length > 20, 'register returns JWT');
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // 2. topic-select -> 202 + draftId
  const ts = await fetch(`${BASE}/api/clients/e2e_001/topic-select`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      topic: 'AI for small business logistics',
      count: 1,
      mediaType: 'video',
      platforms: ['facebook', 'youtube'],
      vendor: 'heygen',
      targetMinutes: 3,
    }),
  });
  assert(ts.status === 202, 'topic-select returns 202');
  const draftId = (await ts.json()).draftId as string;
  assert(typeof draftId === 'string' && draftId.startsWith('draft_'), 'topic-select returns draftId');

  // 3. poll draft until the copy worker persisted copy
  let draft: { copy?: unknown; status?: string; previewUrls?: string[] } = {};
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/clients/e2e_001/drafts/${draftId}`, { headers: auth });
    draft = (await r.json()) as typeof draft;
    if (draft.copy) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  assert(!!draft.copy, 'copy worker persisted copy (polled over HTTP)');

  // 4. render -> 202
  const rd = await fetch(`${BASE}/api/clients/e2e_001/drafts/${draftId}/render`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ mediaType: 'video', vendor: 'heygen', targetMinutes: 3 }),
  });
  assert(rd.status === 202, 'render returns 202');

  // 5. poll until media worker -> preview_ready
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/clients/e2e_001/drafts/${draftId}`, { headers: auth });
    draft = (await r.json()) as typeof draft;
    if (draft.status === 'preview_ready' && draft.previewUrls?.length) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  assert(draft.status === 'preview_ready', 'media worker set preview_ready');
  assert((draft.previewUrls?.length ?? 0) > 0, 'previewUrls present over HTTP');

  // 6. preview -> 200
  const pv = await fetch(`${BASE}/api/clients/e2e_001/drafts/${draftId}/preview`, { headers: auth });
  assert(pv.status === 200, 'preview returns 200');

  // 7. two-stage approvals
  const ap1 = await fetch(`${BASE}/api/clients/e2e_001/drafts/${draftId}/preview/approve`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ approvedBy: 'patricia' }),
  });
  assert(ap1.status === 200, 'preview approve (stage 1) returns 200');

  const ap2 = await fetch(`${BASE}/api/clients/e2e_001/drafts/${draftId}/approve`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ approvedBy: 'patricia', platforms: ['facebook', 'youtube'] }),
  });
  assert(ap2.status === 200, 'final approve (per-platform) returns 200');

  // 8. publish -> 202
  const pub = await fetch(`${BASE}/api/clients/e2e_001/drafts/${draftId}/publish`, {
    method: 'POST',
    headers: auth,
  });
  assert(pub.status === 202, 'publish returns 202');

  // 9. status -> 200
  const st = await fetch(`${BASE}/api/clients/e2e_001/drafts/${draftId}/status`, { headers: auth });
  assert(st.status === 200, 'status returns 200');

  // 10. Neo over HTTP (bonus: interactive assistant live)
  const neo = await fetch(`${BASE}/api/neo/chat`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ question: 'which platforms can I publish to?' }),
  });
  assert(neo.status === 200 && (await neo.json()).answer.length > 0, 'Neo answers over HTTP');

  console.log('=== E2E HTTP COMPLETE ===');
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error('E2E HTTP FAILED:', err);
  process.exit(1);
});
