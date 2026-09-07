/**
 * ESSENTIAL - Social Media Super Agent
 * apps/api/roundtrip-test.ts
 *
 * Fastify test harness. Runs the full dashboard round-trip against the
 * in-memory DraftStore and an injectable queue set:
 *
 *   POST  /api/clients/:id/topic-select   (202 + draftId)
 *   GET   /api/clients/:id/drafts/:draftId
 *   POST  /api/clients/:id/drafts/:draftId/render   (202)
 *   GET   /api/clients/:id/drafts/:draftId/preview  (rendered artifact)
 *   POST  .../preview/approve  ->  POST .../approve  ->  POST .../publish
 *
 * BullMQ strategy: the sandbox has NO Redis server, so instead of a live
 * queue the harness injects FakeQueues that record each job and execute the
 * REAL processors (processStrategy / processCopy / processMedia /
 * processPublish) in-process. That makes the pipeline deterministic - no
 * sleeps, no polling - because the media processor has already completed by
 * the time the render route returns. The same ApprovalStateMachine instance
 * is shared by the API and the publish processor, so the two-stage gate is
 * exercised for real.
 *
 * Run: npx tsx apps/api/roundtrip-test.ts
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { buildEssentialApp, DraftStore, type EssentialQueues } from './index';
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

/** Fake queue: records the job, then runs the matching real processor. */
class FakeQueue {
  readonly jobs: { name: string; data: unknown; id: string }[] = [];
  private lastStrategy: unknown;

  constructor(
    private readonly kind: QueueKind,
    private readonly ctx: ProcessorContext,
    private readonly drafts: DraftStore,
  ) {}

  async add(name: string, data: Record<string, unknown>, opts?: { jobId?: string }): Promise<{ id: string }> {
    const id = opts?.jobId ?? `job_${this.jobs.length + 1}`;
    this.jobs.push({ name, data, id });

    if (this.kind === 'research') {
      this.lastStrategy = await processStrategy(this.ctx, data as never);
    } else if (this.kind === 'copy') {
      const result = await processCopy(
        this.ctx,
        { ...(data as object), strategy: this.lastStrategy } as never,
      );
      this.drafts.update(String(data.draftId), { copy: result });
    } else if (this.kind === 'media') {
      const result = await processMedia(this.ctx, data as never) as { previewUrl?: string };
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

  console.log('=== ESSENTIAL API ROUND-TRIP TEST ===');
  console.log('mode: no Redis in sandbox -> FakeQueues run the real processors in-process');

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

  const app = await buildEssentialApp({ draftStore: drafts, approvals, queues });
  const clientId = 'client_rt_001';

  // 0) health probe (used by docker-compose / hosting healthchecks)
  const health = await app.inject({ method: 'GET', url: '/health' });
  assert(health.statusCode === 200 && health.json().status === 'ok', 'GET /health returns ok');

  // 1) topic-select
  const select = await app.inject({
    method: 'POST',
    url: `/api/clients/${clientId}/topic-select`,
    payload: {
      topic: 'AI for small business logistics',
      count: 1,
      mediaType: 'video',
      platforms: ['facebook', 'youtube'],
      vendor: 'heygen',
      targetMinutes: 3,
      language: 'en',
    },
  });
  assert(select.statusCode === 202, 'topic-select returns 202');
  const selectBody = select.json();
  const draftId = selectBody.draftId as string;
  assert(typeof draftId === 'string' && draftId.startsWith('draft_'), `topic-select returns draftId (${draftId})`);
  assert(
    Array.isArray(selectBody.dropdownMinutes) && selectBody.dropdownMinutes[0] === 3,
    'dropdownMinutes begins at 3',
  );

  // 2) draft poll
  const poll = await app.inject({ method: 'GET', url: `/api/clients/${clientId}/drafts/${draftId}` });
  assert(poll.statusCode === 200, 'draft poll returns 200');
  assert(poll.json().status === 'researching', 'draft status is researching after topic-select');

  // 3) render (enqueues media; FakeQueue runs the media processor synchronously)
  const render = await app.inject({
    method: 'POST',
    url: `/api/clients/${clientId}/drafts/${draftId}/render`,
    payload: { mediaType: 'video', vendor: 'heygen', targetMinutes: 3 },
  });
  assert(render.statusCode === 202, 'render returns 202');
  assert(render.json().status === 'rendering', 'render returns status rendering');

  // 4) preview - deterministic: the media processor already completed
  const preview = await app.inject({ method: 'GET', url: `/api/clients/${clientId}/drafts/${draftId}/preview` });
  assert(preview.statusCode === 200, 'preview returns 200');
  const previewBody = preview.json();
  assert(
    Array.isArray(previewBody.previewUrls) && previewBody.previewUrls.length > 0,
    'preview returns previewUrls',
  );
  assert(previewBody.durationSeconds === 180, 'preview duration is 3 minutes (180s)');
  console.log(`previewUrls: ${(previewBody.previewUrls as string[]).join(', ')}`);

  // 5) publish is blocked before approvals (two-stage gate)
  const blocked = await app.inject({ method: 'POST', url: `/api/clients/${clientId}/drafts/${draftId}/publish` });
  assert(blocked.statusCode === 403, 'publish blocked (403) before approvals');

  // 6) approvals: stage 1 (preview) then stage 2 (per-platform FINAL)
  const pa = await app.inject({
    method: 'POST',
    url: `/api/clients/${clientId}/drafts/${draftId}/preview/approve`,
    payload: { approvedBy: clientId },
  });
  assert(pa.statusCode === 200 && pa.json().stage === 'DRAFT', 'preview approve (stage 1) succeeds');

  const fa = await app.inject({
    method: 'POST',
    url: `/api/clients/${clientId}/drafts/${draftId}/approve`,
    payload: { approvedBy: clientId, platforms: ['facebook', 'youtube'] },
  });
  assert(fa.statusCode === 200 && fa.json().stage === 'FINAL', 'final approve (per-platform) succeeds');

  // 7) publish after approvals
  const pub = await app.inject({ method: 'POST', url: `/api/clients/${clientId}/drafts/${draftId}/publish` });
  assert(pub.statusCode === 202, 'publish returns 202 after approvals');

  // 8) status aggregate
  const status = await app.inject({ method: 'GET', url: `/api/clients/${clientId}/drafts/${draftId}/status` });
  assert(status.statusCode === 200, 'status returns 200');
  const statusBody = status.json();
  assert(statusBody.preview === 'ready', 'status shows preview ready');
  assert(
    statusBody.approvals.facebook === 'approved' && statusBody.approvals.youtube === 'approved',
    'status shows both platforms approved',
  );

  // 9) negative: video length validation (X max 2.33 min)
  const bad = await app.inject({
    method: 'POST',
    url: `/api/clients/${clientId}/topic-select`,
    payload: {
      topic: 'too long for X',
      count: 1,
      mediaType: 'video',
      platforms: ['instagram'],
      vendor: 'heygen',
      targetMinutes: 15,
    },
  });
  assert(bad.statusCode === 422, 'topic-select rejects 15 min on Instagram (max 10) with 422');

  console.log('=== ROUND-TRIP COMPLETE ===');
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
