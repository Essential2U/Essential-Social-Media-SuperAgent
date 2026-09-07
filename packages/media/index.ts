/**
 * ESSENTIAL - Social Media Super Agent
 * packages/media/index.ts
 *
 * Media module: generates video, image, or both from a topic/script, and
 * provides the preview -> approve gate before publish.
 *
 * Talking-head video flow:
 *   1. client picks a topic + vendor (HeyGen default, or Synthesia/D-ID/Argil)
 *   2. Essential hands the script to the vendor (avatar_id + voice_id)
 *   3. if the script exceeds the vendor's max clip, segment + stitch
 *   4. vendor completes -> Essential stores the render -> preview URL
 *   5. client approves -> auto-post to all selected platforms + YouTube
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { AVATAR_VENDORS, type AvatarVendorId } from './vendors';
import type { ApprovalStateMachine } from '../approvals';

export type MediaKind = 'image' | 'video' | 'both';

export interface RenderInput {
  readonly draftId: string;
  readonly clientId: string;
  readonly script: string;
  readonly topic: string;
  readonly vendor: AvatarVendorId;
  readonly avatarId: string;
  readonly voiceId: string;
  readonly targetMinutes: number;
  readonly language?: 'en' | 'es';
}

export interface SegmentPlan {
  readonly vendor: AvatarVendorId;
  readonly maxClipMinutes: number;
  readonly segments: readonly { index: number; minutes: number; scriptChunk: string }[];
  readonly needsStitch: boolean;
}

export interface RenderedMedia {
  readonly assetId: string;
  readonly kind: MediaKind;
  readonly vendor?: AvatarVendorId;
  readonly previewUrl: string;
  readonly s3Key?: string;
  readonly durationSeconds?: number;
  readonly segmentCount: number;
  readonly needsStitch: boolean;
  readonly status: 'rendered' | 'mock';
}

export class MediaProducer {
  constructor(
    private readonly approvals: ApprovalStateMachine,
    private readonly live = process.env.LIVE_PUBLISH === 'true',
  ) {}

  /** Split a script into segments within a vendor's max clip length. */
  planSegments(script: string, vendor: AvatarVendorId, targetMinutes: number): SegmentPlan {
    const v = AVATAR_VENDORS[vendor];
    const needsStitch = targetMinutes > v.maxClipMinutes || !v.supportsSegments;
    const count = needsStitch ? Math.max(2, Math.ceil(targetMinutes / v.maxClipMinutes)) : 1;
    const chunks = this.splitScript(script, count);
    return {
      vendor,
      maxClipMinutes: v.maxClipMinutes,
      segments: chunks.map((c, i) => ({ index: i + 1, minutes: v.maxClipMinutes, scriptChunk: c })),
      needsStitch,
    };
  }

  async renderVideo(input: RenderInput): Promise<RenderedMedia> {
    const plan = this.planSegments(input.script, input.vendor, input.targetMinutes);
    if (this.live) {
      // TODO at build time: for each segment call the vendor render-create,
      // poll until completed, then stitch (ffmpeg) and store to S3.
      return {
        assetId: `vid_${Date.now()}`,
        kind: 'video',
        vendor: input.vendor,
        previewUrl: `s3://essential/live/${input.draftId}.mp4`,
        durationSeconds: input.targetMinutes * 60,
        segmentCount: plan.segments.length,
        needsStitch: plan.needsStitch,
        status: 'rendered',
      };
    }
    return {
      assetId: `vid_${Date.now()}`,
      kind: 'video',
      vendor: input.vendor,
      previewUrl: `mock://preview/${input.draftId}.mp4`,
      durationSeconds: input.targetMinutes * 60,
      segmentCount: plan.segments.length,
      needsStitch: plan.needsStitch,
      status: 'mock',
    };
  }

  async generateImage(input: RenderInput): Promise<RenderedMedia> {
    // image generation via Connected Tools free-first (packages/tools)
    return {
      assetId: `img_${Date.now()}`,
      kind: 'image',
      previewUrl: `mock://preview/${input.draftId}.jpg`,
      segmentCount: 0,
      needsStitch: false,
      status: 'mock',
    };
  }

  async generateBoth(input: RenderInput): Promise<{ video: RenderedMedia; image: RenderedMedia }> {
    const [video, image] = await Promise.all([this.renderVideo(input), this.generateImage(input)]);
    return { video, image };
  }

  /** Preview gate: request + approve before publish. */
  async requestPreview(draftId: string, clientId: string): Promise<void> {
    this.approvals.requestDraftApproval(draftId, clientId);
  }

  async approvePreview(draftId: string, approvedBy: string) {
    return this.approvals.approveDraft({ draftId, stage: 'DRAFT', approvedBy });
  }

  private splitScript(script: string, count: number): string[] {
    const parts = script.split(/\n\n+/).filter((p) => p.trim().length > 0);
    if (parts.length >= count) {
      const per = Math.ceil(parts.length / count);
      const chunks: string[] = [];
      for (let i = 0; i < count; i++) chunks.push(parts.slice(i * per, (i + 1) * per).join('\n\n'));
      return chunks;
    }
    const len = Math.ceil(script.length / count);
    const chunks: string[] = [];
    for (let i = 0; i < count; i++) chunks.push(script.slice(i * len, (i + 1) * len));
    return chunks;
  }
}

export function createMediaProducer(approvals: ApprovalStateMachine): MediaProducer {
  return new MediaProducer(approvals);
}
