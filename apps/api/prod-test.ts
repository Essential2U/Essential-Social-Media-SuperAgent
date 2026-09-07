/**
 * ESSENTIAL - Social Media Super Agent
 * apps/api/prod-test.ts
 *
 * Production-hardening test harness. Covers the modules landed in the
 * production sprint: error taxonomy, retries/timeouts, structured logging,
 * and M10 auth (register/login/me, JWT gate on /api/clients/*, rate limit).
 *
 * Run: npx tsx apps/api/prod-test.ts
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { randomUUID } from 'node:crypto';
import { buildEssentialApp, DraftStore, type EssentialQueues } from './index';
import {
  AuthService,
  UserStore,
  validatePassword,
  DEFAULT_PASSWORD_POLICY,
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
} from '../../packages/auth';
import { NotFoundError, UpstreamError, AuthError, toHttpError } from '../../packages/core/errors';
import { withRetry, withTimeout } from '../../packages/core/retry';
import { Logger } from '../../packages/core/logger';
import { ApprovalStateMachine } from '../../packages/approvals';
import { Strategist } from '../../packages/ai/strategist';
import { Copywriter } from '../../packages/ai/copywriter';
import { MediaProducer } from '../../packages/media';
import { PublishWorker } from '../worker/publish';
import {
  processStrategy,
  processCopy,
  processMedia,
  processPublish,
  type ProcessorContext,
} from '../worker/processors';

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) process.exitCode = 1;
}

type QueueKind = 'research' | 'copy' | 'media' | 'publish';

class FakeQueue {
  private lastStrategy: unknown;

  constructor(
    private readonly kind: QueueKind,
    private readonly ctx: ProcessorContext,
    private readonly drafts: DraftStore,
  ) {}

  async add(name: string, data: Record<string, unknown>, opts?: { jobId?: string }): Promise<{ id: string }> {
    const id = opts?.jobId ?? `job_${name}`;
    if (this.kind === 'research') {
      this.lastStrategy = await processStrategy(this.ctx, data as never);
    } else if (this.kind === 'copy') {
      const result = await processCopy(
        this.ctx,
        { ...(data as object), strategy: this.lastStrategy } as never,
      );
      this.drafts.update(String(data.draftId), { copy: result });
    } else if (this.kind === 'media') {
      const result = (await processMedia(this.ctx, data as never)) as { previewUrl?: string };
      const previewUrl = result.previewUrl ?? '';
      this.drafts.update(String(data.draftId), {
        media: result,
        previewUrls: previewUrl ? [previewUrl] : [],
        status: 'preview_ready',
      });
    } else if (this.kind === 'publish') {
      await processPublish(this.ctx, data as never);
    }
    return { id };
  }
}

async function main(): Promise<void> {
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

  console.log('=== ESSENTIAL PRODUCTION HARDENING TEST ===');

  /* 1) error taxonomy */
  const nf = toHttpError(new NotFoundError('missing'));
  assert(nf.statusCode === 404 && nf.body.code === 'NOT_FOUND', 'NotFoundError maps to 404');
  const up = new UpstreamError('provider down');
  assert(up.retryable === true, 'UpstreamError is retryable');
  const ae = toHttpError(new AuthError('bad token'));
  assert(ae.statusCode === 401 && ae.body.code === 'UNAUTHENTICATED', 'AuthError maps to 401');
  const unk = toHttpError(new Error('boom'));
  assert(unk.statusCode === 500 && unk.body.code === 'INTERNAL', 'unknown error maps to 500');

  /* 2) retry + timeout */
  let attempts = 0;
  const flaky = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error('transient');
      return 'ok';
    },
    { maxAttempts: 3, baseDelayMs: 5 },
  );
  assert(flaky === 'ok' && attempts === 3, 'withRetry succeeds after transient failures');
  let exhausted = false;
  try {
    await withRetry(
      async () => {
        throw new Error('always');
      },
      { maxAttempts: 2, baseDelayMs: 5 },
    );
  } catch {
    exhausted = true;
  }
  assert(exhausted, 'withRetry throws after maxAttempts');
  let timedOut = false;
  try {
    await withTimeout(new Promise((r) => setTimeout(r, 200)), 20, 'slow');
  } catch {
    timedOut = true;
  }
  assert(timedOut, 'withTimeout rejects after deadline');

  /* 3) structured logging */
  const lines: string[] = [];
  const logger = new Logger('info', (l) => lines.push(l));
  const child = logger.child({ traceId: randomUUID() });
  child.info('hello', { draftId: 'd1' });
  assert(lines.length === 1, 'logger emits one line');
  const parsed = JSON.parse(lines[0]) as { level: string; msg: string; traceId: string; draftId: string };
  assert(
    parsed.level === 'info' && parsed.msg === 'hello' && parsed.draftId === 'd1',
    'log line is structured JSON',
  );
  assert(typeof parsed.traceId === 'string' && parsed.traceId.length > 0, 'child logger binds traceId');

  /* 4) auth unit */
  const weak = validatePassword('short1', DEFAULT_PASSWORD_POLICY);
  assert(weak.ok === false, 'password policy rejects weak password');
  const strong = validatePassword('pass!word1', DEFAULT_PASSWORD_POLICY);
  assert(strong.ok === true, 'password policy accepts strong password');
  const hash = await hashPassword('pass!word1', 'pepper');
  assert((await verifyPassword('pass!word1', hash, 'pepper')) === true, 'password hash/verify roundtrip');
  assert((await verifyPassword('wrong', hash, 'pepper')) === false, 'wrong password rejected');
  const token = signJwt({ sub: 'u1', email: 'a@b.com', role: 'client' }, 'secret', 3600);
  const claims = verifyJwt(token, 'secret');
  assert(claims.sub === 'u1' && claims.email === 'a@b.com', 'JWT sign/verify roundtrip');
  let expired = false;
  try {
    verifyJwt(signJwt({ sub: 'u1', email: 'a@b.com', role: 'client' }, 'secret', -10), 'secret');
  } catch {
    expired = true;
  }
  assert(expired, 'expired JWT rejected');

  /* 5) auth API + protected roundtrip */
  const drafts = new DraftStore();
  const approvals = new ApprovalStateMachine();
  const ctx: ProcessorContext = {
    strategist: new Strategist(),
    copywriter: new Copywriter(),
    media: new MediaProducer(approvals),
    approvals,
    publish: new PublishWorker({ approvals }),
  };
  const queues: EssentialQueues = {
    research: new FakeQueue('research', ctx, drafts),
    copy: new FakeQueue('copy', ctx, drafts),
    media: new FakeQueue('media', ctx, drafts),
    publish: new FakeQueue('publish', ctx, drafts),
  };
  const auth = new AuthService({
    users: new UserStore(),
    jwtSecret: 'test-secret',
    passwordPepper: 'test-pepper',
  });
  const apiLogger = new Logger('info', (l) => lines.push(l));
  const app = await buildEssentialApp({ draftStore: drafts, approvals, queues, auth, logger: apiLogger });

  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'client@example.com', password: 'pass!word1' },
  });
  assert(reg.statusCode === 201, 'register returns 201');
  const regBody = reg.json() as { token: string; user: { email: string } };
  assert(typeof regBody.token === 'string' && regBody.token.split('.').length === 3, 'register returns JWT');
  assert(regBody.user.email === 'client@example.com', 'register returns user');

  const me = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: { authorization: `Bearer ${regBody.token}` },
  });
  assert(me.statusCode === 200 && me.json().user.email === 'client@example.com', 'me returns authenticated user');

  const badLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'client@example.com', password: 'wrong!pass' },
  });
  assert(badLogin.statusCode === 401, 'login with wrong password returns 401');

  /* rate limit: 5 allowed, 6th -> 429 */
  let got429 = false;
  for (let i = 0; i < 6; i++) {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'client@example.com', password: 'wrong!pass' },
    });
    if (r.statusCode === 429) got429 = true;
  }
  assert(got429, 'login rate limiter returns 429 after 5 attempts');

  /* protected client route: no token -> 401, with token -> 202 */
  const noToken = await app.inject({
    method: 'POST',
    url: '/api/clients/client_p_001/topic-select',
    payload: {
      topic: 'AI for small business logistics',
      count: 1,
      mediaType: 'video',
      platforms: ['facebook', 'youtube'],
      vendor: 'heygen',
      targetMinutes: 3,
    },
  });
  assert(noToken.statusCode === 401, 'client route without token returns 401');

  const withToken = await app.inject({
    method: 'POST',
    url: '/api/clients/client_p_001/topic-select',
    headers: { authorization: `Bearer ${regBody.token}` },
    payload: {
      topic: 'AI for small business logistics',
      count: 1,
      mediaType: 'video',
      platforms: ['facebook', 'youtube'],
      vendor: 'heygen',
      targetMinutes: 3,
    },
  });
  assert(withToken.statusCode === 202, 'client route with token returns 202');

  const logged = lines.filter((l) => l.includes('request_start') || l.includes('request_end'));
  assert(logged.length >= 2, 'API request logging emitted');

  console.log('=== PRODUCTION HARDENING COMPLETE ===');
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
