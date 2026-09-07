/**
 * ESSENTIAL - Social Media Super Agent
 * apps/worker/live-worker.ts
 *
 * Real BullMQ workers (blueprint items 3-4). Consume the live queues and run
 * the REAL processors, writing results back to the Postgres draft store -
 * mirroring the fake-queue write-back in apps/api/roundtrip-test.ts so the
 * same pipeline runs identically on fake and live backends. Queue names have
 * no ':' (BullMQ restriction) and match live-queues.ts.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Worker } from 'bullmq';
import { Strategist } from '../../packages/ai/strategist';
import { Copywriter } from '../../packages/ai/copywriter';
import { MediaProducer } from '../../packages/media';
import { ApprovalStateMachine } from '../../packages/approvals';
import { PublishWorker } from './publish';
import {
  processStrategy,
  processCopy,
  processMedia,
  processPublish,
  type ProcessorContext,
} from './processors';
import type { AsyncDraftStore } from '../../packages/persistence';
import type { DraftRecord } from '../../apps/api/index';
import type { LiveRedisConfig } from './live-queues';

export interface LiveWorkers {
  readonly ctx: ProcessorContext;
  close(): Promise<void>;
}

export function startLiveWorkers(
  redis: LiveRedisConfig,
  drafts: AsyncDraftStore<DraftRecord>,
  approvals?: ApprovalStateMachine,
): LiveWorkers {
  const approvalsSM = approvals ?? new ApprovalStateMachine();
  const ctx: ProcessorContext = {
    strategist: new Strategist(),
    copywriter: new Copywriter(),
    media: new MediaProducer(approvalsSM),
    approvals: approvalsSM,
    publish: new PublishWorker({ approvals: approvalsSM }),
  };

  const connection = { host: redis.host, port: redis.port };

  const workers = [
    new Worker('essential-research', async (job) => processStrategy(ctx, job.data as never), {
      connection,
    }),
    new Worker('essential-copy', async (job) => {
      const data = job.data as { draftId?: string };
      const result = await processCopy(ctx, job.data as never);
      await drafts.update(String(data.draftId), { copy: result });
      return result;
    }, { connection }),
    new Worker('essential-media', async (job) => {
      const data = job.data as { draftId?: string };
      const result = (await processMedia(ctx, job.data as never)) as { previewUrl?: string };
      const previewUrl = result.previewUrl ?? '';
      await drafts.update(String(data.draftId), {
        media: result,
        previewUrls: previewUrl ? [previewUrl] : [],
        status: 'preview_ready',
      });
      return result;
    }, { connection }),
    new Worker('essential-publish', async (job) => {
      const data = job.data as { draftId?: string };
      const outcome = await processPublish(ctx, job.data as never);
      if (outcome && !outcome.blocked && outcome.published.length > 0) {
        await drafts.update(String(data.draftId), { status: 'published' });
      }
      return outcome;
    }, { connection }),
  ];

  // E4 fix: a failed job marks the draft failed (no silent dead jobs).
  // Also log the underlying error - previously the draft flipped to 'failed'
  // with zero trace of why, so diagnosing a production failure meant reaching
  // into BullMQ's internal failed-job list by hand.
  for (const w of workers) {
    w.on('failed', (job, err) => {
      const draftId = (job?.data as { draftId?: string } | undefined)?.draftId;
      console.error(
        `[worker:${w.name}] job ${job?.id ?? '(unknown)'} failed` +
          (draftId ? ` (draftId=${draftId})` : ''),
        err,
      );
      if (draftId) void drafts.update(draftId, { status: 'failed' });
    });
  }

  return {
    ctx,
    close: async () => {
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
