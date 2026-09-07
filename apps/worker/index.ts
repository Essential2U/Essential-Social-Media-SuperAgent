/**
 * ESSENTIAL - Social Media Super Agent
 * apps/worker/index.ts
 *
 * BullMQ worker registration + an in-process local runner for dev and the
 * M6 test-account pass (no Redis required). Production uses the BullMQ
 * Worker classes; the processors are shared between both paths.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Worker, Queue, type Job } from 'bullmq';
import {
  createProcessorContext,
  processStrategy,
  processCopy,
  processMedia,
  processPublish,
  QUEUE_RESEARCH,
  QUEUE_STRATEGY,
  QUEUE_COPY,
  QUEUE_MEDIA,
  QUEUE_PUBLISH,
  type ResearchJob,
  type CopyJob,
  type MediaJob,
  type PublishJobData,
  type ProcessorContext,
} from './processors';

export interface WorkerOptions {
  readonly connection?: { host: string; port: number };
}

function redisConnection(opts: WorkerOptions): { host: string; port: number } {
  return opts.connection ?? {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };
}

export function registerWorkers(opts: WorkerOptions = {}): Worker[] {
  const ctx = createProcessorContext();
  const conn = redisConnection(opts);
  return [
    new Worker(QUEUE_RESEARCH, (job: Job<ResearchJob>) => processStrategy(ctx, job.data), { connection: conn }),
    new Worker(QUEUE_STRATEGY, (job: Job<ResearchJob>) => processStrategy(ctx, job.data), { connection: conn }),
    new Worker(QUEUE_COPY, (job: Job<CopyJob>) => processCopy(ctx, job.data), { connection: conn }),
    new Worker(QUEUE_MEDIA, (job: Job<MediaJob>) => processMedia(ctx, job.data), { connection: conn }),
    new Worker(QUEUE_PUBLISH, (job: Job<PublishJobData>) => processPublish(ctx, job.data), { connection: conn }),
  ];
}

export function createQueues(opts: WorkerOptions = {}): Record<string, Queue> {
  const conn = redisConnection(opts);
  return {
    research: new Queue(QUEUE_RESEARCH, { connection: conn }),
    strategy: new Queue(QUEUE_STRATEGY, { connection: conn }),
    copy: new Queue(QUEUE_COPY, { connection: conn }),
    media: new Queue(QUEUE_MEDIA, { connection: conn }),
    publish: new Queue(QUEUE_PUBLISH, { connection: conn }),
  };
}

/** In-process runner for dev / M6 test - executes the same processors directly. */
export function createLocalRunner(): {
  ctx: ProcessorContext;
  strategy: (job: ResearchJob) => Promise<Awaited<ReturnType<typeof processStrategy>>>;
  copy: (job: CopyJob) => Promise<Awaited<ReturnType<typeof processCopy>>>;
  media: (job: MediaJob) => Promise<Awaited<ReturnType<typeof processMedia>>>;
  publish: (job: PublishJobData) => Promise<Awaited<ReturnType<typeof processPublish>>>;
} {
  const ctx = createProcessorContext();
  return {
    ctx,
    strategy: (job) => processStrategy(ctx, job),
    copy: (job) => processCopy(ctx, job),
    media: (job) => processMedia(ctx, job),
    publish: (job) => processPublish(ctx, job),
  };
}
