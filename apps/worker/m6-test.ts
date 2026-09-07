/**
 * ESSENTIAL - Social Media Super Agent
 * apps/worker/m6-test.ts
 *
 * M6 test-account pass (mock mode). Runs the full chain end-to-end:
 *   topic -> research/strategy -> copy (15-min script) -> media render
 *   (talking-head, segmented per vendor) -> preview -> approvals -> publish
 *   -> one harmless test post per platform returns a post URL.
 *
 * Run: npx tsx apps/worker/m6-test.ts
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 */

import { createLocalRunner } from './index';
import { AVATAR_VENDORS } from '../../packages/media/vendors';
import {
  MIN_CONTENT_MINUTES,
  validateVideoLength,
  VIDEO_LENGTH_OPTIONS_MINUTES,
} from '../../packages/media/platform-limits';

const PLATFORMS = ['facebook', 'linkedin', 'instagram', 'youtube', 'tiktok'] as const;

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  // Mock test-account credentials so adapters instantiate in mock mode (M6 = test accounts only).
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
  console.log('=== M6 TEST-ACCOUNT PASS (mock mode) ===');
  console.log(`video length dropdown (begins at 3 min): ${VIDEO_LENGTH_OPTIONS_MINUTES.join(', ')}`);
  assert(VIDEO_LENGTH_OPTIONS_MINUTES[0] === 3, 'dropdown begins at 3 minutes');

  const runner = createLocalRunner();
  const draftId = 'draft_m6_001';
  const clientId = 'client_m6';

  // 1) research + strategy
  const strategy = await runner.strategy({
    topicId: 't1',
    topic: 'AI for small business logistics',
    podcastScript: true,
  });
  console.log(`strategy angle: ${strategy.angle}`);
  console.log(`script minutes floor: ${strategy.minMinutes}`);
  assert(strategy.minMinutes >= MIN_CONTENT_MINUTES, `script >= ${MIN_CONTENT_MINUTES} minutes`);

  // 2) copy
  const copy = await runner.copy({
    draftId,
    clientId,
    topic: strategy.topic,
    platforms: [...PLATFORMS],
    podcastScript: true,
  });
  console.log(`copy posts: ${copy.posts.map((p) => `${p.platform}:${p.caption.length}ch`).join(', ')}`);
  assert(copy.compliance.ok, 'compliance gate passes');

  // 3) media - talking-head render with per-vendor segmentation
  for (const vendor of ['heygen', 'synthesia', 'did', 'argil'] as const) {
    const v = AVATAR_VENDORS[vendor];
    const result = await runner.media({
      draftId,
      clientId,
      script: copy.podcastScript,
      topic: strategy.topic,
      vendor,
      avatarId: 'avt_test',
      voiceId: 'voi_test',
      targetMinutes: 15,
      mediaKind: 'video',
    });
    const media = 'video' in result ? result.video : result;
    console.log(
      `render[${vendor}] segments=${media.segmentCount} needsStitch=${media.needsStitch} preview=${media.previewUrl}`,
    );
    if (vendor === 'did') {
      assert(media.segmentCount >= 3, `D-ID 15-min script splits into >=3 segments (max clip ${v.maxClipMinutes} min)`);
    }
    if (vendor === 'heygen') {
      assert(media.segmentCount === 1, `HeyGen renders 15-min as one scene (max clip ${v.maxClipMinutes} min)`);
    }
  }

  // 4) video length validation
  const fb = validateVideoLength('facebook', 15);
  assert(fb.ok, 'Facebook accepts 15 min');
  const x = validateVideoLength('x', 15);
  assert(!x.ok, `X rejects 15 min (max ${x.maxMinutes})`);
  const short = validateVideoLength('facebook', 1);
  assert(!short.ok, 'dropdown rejects < 3 min');

  // 5) preview + approvals
  await runner.ctx.media.requestPreview(draftId, clientId);
  const draftAppr = await runner.ctx.approvals.approveDraft({ draftId, stage: 'DRAFT', approvedBy: clientId });
  assert(draftAppr.ok, 'draft (preview) approval accepted');
  await runner.ctx.approvals.requestFinalApprovals(draftId, [...PLATFORMS], clientId);
  for (const p of PLATFORMS) {
    const r = await runner.ctx.approvals.approvePlatform({ draftId, stage: 'FINAL', platform: p, approvedBy: clientId });
    assert(r.ok, `final approval accepted for ${p}`);
  }

  // 6) publish (approved) - one harmless test post per platform
  const pub = await runner.publish({
    jobId: 'job_m6_001',
    draftId,
    clientId,
    platforms: [...PLATFORMS],
    contentVersion: 'v1',
    title: 'M6 test talking-head video',
    mediaUrls: {
      facebook: 'mock://preview/draft_m6_001.mp4',
      linkedin: 'mock://preview/draft_m6_001.mp4',
      instagram: 'mock://preview/draft_m6_001.mp4',
      youtube: 'mock://preview/draft_m6_001.mp4',
      tiktok: 'mock://preview/draft_m6_001.mp4',
    },
  });
  console.log(`published: ${pub.published.map((p) => `${p.platform}:${p.postUrl}`).join(', ')}`);
  assert(pub.published.length === PLATFORMS.length, `all ${PLATFORMS.length} platforms return a post URL`);
  assert(!pub.blocked, 'publish not blocked when fully approved');

  // 7) negative: publish blocked without approvals
  const blocked = await runner.publish({
    jobId: 'job_m6_002',
    draftId: 'draft_m6_unapproved',
    clientId,
    platforms: [...PLATFORMS],
    contentVersion: 'v1',
    title: 'M6 blocked test',
  });
  assert(blocked.blocked && blocked.skipped.length === PLATFORMS.length, 'publish blocked without approvals');

  console.log(process.exitCode ? '=== M6 RESULT: FAILURES PRESENT ===' : '=== M6 RESULT: ALL CHECKS PASSED ===');
}

main().catch((e) => {
  console.error('M6 test error:', e);
  process.exit(1);
});
