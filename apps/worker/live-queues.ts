/**
 * ESSENTIAL - Social Media Super Agent
 * apps/worker/live-queues.ts
 *
 * Real BullMQ queue adapters (blueprint items 3-4). createLiveQueues returns
 * the same EssentialQueues surface the API consumes, but backed by live Redis
 * through BullMQ.
 *
 * BullMQ restrictions that only surface on the live backend:
 *   1. Queue names must NOT contain ':' (they are Redis keys).
 *   2. Custom job IDs must NOT contain ':' either.
 * The wrapper sanitizes both: queue names use '-' and job IDs have ':' mapped
 * to '-' before enqueueing. The shared API code and fake-queue harness are
 * unchanged - only this adapter differs.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Queue } from 'bullmq';
import type { EssentialQueues } from '../../apps/api/index';

export interface LiveRedisConfig {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly tls?: Record<string, never>;
}

function sanitizeJobId(jobId?: string): string | undefined {
  return jobId ? jobId.replace(/:/g, '-') : undefined;
}

/** Wrap a BullMQ Queue to satisfy the API's QueueLike contract and sanitize job IDs. */
function wrapQueue(queue: Queue): EssentialQueues['research'] & {
  getJobCounts(): Promise<Record<string, number>>;
} {
  return {
    async add(name: string, data: unknown, opts?: { jobId?: string }): Promise<{ id?: string }> {
      const job = await queue.add(
        name,
        data,
        opts ? { ...opts, jobId: sanitizeJobId(opts.jobId) } : undefined,
      );
      return { id: job.id ?? undefined };
    },
    async getJobCounts(): Promise<Record<string, number>> {
      return queue.getJobCounts();
    },
  };
}

export function createLiveQueues(redis: LiveRedisConfig): EssentialQueues {
  const connection = {
    host: redis.host,
    port: redis.port,
    username: redis.username,
    password: redis.password,
    tls: redis.tls,
  };
  return {
    research: wrapQueue(new Queue('essential-research', { connection })),
    copy: wrapQueue(new Queue('essential-copy', { connection })),
    media: wrapQueue(new Queue('essential-media', { connection })),
    publish: wrapQueue(new Queue('essential-publish', { connection })),
  };
}
