/**
 * ESSENTIAL - Social Media Super Agent
 * apps/worker/processors.ts
 *
 * BullMQ job processors for the full worker chain:
 *   research -> strategy -> copy -> media -> preview -> publish
 * Each processor is idempotent (jobId = draftId:stage) and retryable.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Strategist } from '../../packages/ai/strategist';
import { Copywriter } from '../../packages/ai/copywriter';
import { MediaProducer } from '../../packages/media';
import { ApprovalStateMachine } from '../../packages/approvals';
import { PublishWorker } from './publish';
import type { PlatformId } from '../../packages/adapters';

export const QUEUE_RESEARCH = 'essential-research';
export const QUEUE_STRATEGY = 'essential-strategy';
export const QUEUE_COPY = 'essential-copy';
export const QUEUE_MEDIA = 'essential-media';
export const QUEUE_PUBLISH = 'essential-publish';

export interface ResearchJob {
  readonly topicId: string;
  readonly topic: string;
  readonly audience?: string;
  readonly brandVoice?: string;
  readonly language?: 'en' | 'es';
  readonly podcastScript?: boolean;
}

export interface CopyJob {
  readonly draftId: string;
  readonly clientId: string;
  readonly topic: string;
  readonly platforms: readonly PlatformId[];
  readonly language?: 'en' | 'es';
  readonly podcastScript?: boolean;
  /** Strategy produced by the research/strategy processor (handoff). */
  readonly strategy?: Awaited<ReturnType<Strategist['generateStrategy']>>;
}

export interface MediaJob {
  readonly draftId: string;
  readonly clientId: string;
  readonly script: string;
  readonly topic: string;
  readonly vendor: 'heygen' | 'synthesia' | 'did' | 'argil';
  readonly avatarId: string;
  readonly voiceId: string;
  readonly targetMinutes: number;
  readonly mediaKind: 'image' | 'video' | 'both';
}

export interface PublishJobData {
  readonly jobId: string;
  readonly draftId: string;
  readonly clientId: string;
  readonly platforms: readonly PlatformId[];
  readonly contentVersion: string;
  readonly title?: string;
  readonly mediaUrls?: Readonly<Record<string, string>>;
}

export interface ProcessorContext {
  readonly strategist: Strategist;
  readonly copywriter: Copywriter;
  readonly media: MediaProducer;
  readonly approvals: ApprovalStateMachine;
  readonly publish: PublishWorker;
}

export function createProcessorContext(): ProcessorContext {
  const approvals = new ApprovalStateMachine();
  return {
    strategist: new Strategist(),
    copywriter: new Copywriter(),
    media: new MediaProducer(approvals),
    approvals,
    publish: new PublishWorker({ approvals }),
  };
}

/** Research + strategy processor. Produces a 15-min strategy and optional podcast script. */
export async function processStrategy(ctx: ProcessorContext, job: ResearchJob) {
  return ctx.strategist.generateStrategy({
    topic: job.topic,
    audience: job.audience,
    brandVoice: job.brandVoice,
    language: job.language,
    podcastScript: job.podcastScript,
  });
}

/** Copywriter processor. Platform-native copy + compliance + podcast script. */
export async function processCopy(ctx: ProcessorContext, job: CopyJob) {
  const strategy =
    job.strategy ??
    (await ctx.strategist.generateStrategy({
      topic: job.topic,
      language: job.language,
      podcastScript: job.podcastScript,
    }));
  return ctx.copywriter.generateCopy({ strategy, platforms: job.platforms, language: job.language });
}

/** Media processor. Renders talking-head video (segmented if needed), image, or both. */
export async function processMedia(ctx: ProcessorContext, job: MediaJob) {
  const input = {
    draftId: job.draftId,
    clientId: job.clientId,
    script: job.script,
    topic: job.topic,
    vendor: job.vendor,
    avatarId: job.avatarId,
    voiceId: job.voiceId,
    targetMinutes: job.targetMinutes,
  };
  if (job.mediaKind === 'image') return ctx.media.generateImage(input);
  if (job.mediaKind === 'video') return ctx.media.renderVideo(input);
  return ctx.media.generateBoth(input);
}

/** Publish processor. Gated by the two-stage approval state machine. */
export async function processPublish(ctx: ProcessorContext, job: PublishJobData) {
  return ctx.publish.run(job);
}
