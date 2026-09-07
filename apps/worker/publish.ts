/**
 * ESSENTIAL - Social Media Super Agent
 * apps/worker/publish.ts
 *
 * Worker publish path. Every publish job is gated by the two-stage approval
 * state machine (packages/approvals): publishing is allowed only when the
 * DRAFT approval is present AND every selected platform has an approved
 * FINAL record. Once approved, the job dispatches each platform to its
 * adapter and writes an audit event.
 *
 * This is the single publish path - do not create a parallel one.
 *
 * B3 (per-client OAuth): when an OAuthTokenService is provided, the worker
 * resolves the client's stored (decrypted) token per platform and uses it for
 * that platform's publish call instead of the single-tenant env token.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { ApprovalStateMachine, type PublishGate } from '../../packages/approvals';
import { createAdapterFor, type PlatformId } from '../../packages/adapters';
import type { OAuthTokenService, OAuthPlatform } from '../../packages/oauth';

export interface PublishJob {
  readonly jobId: string;
  readonly draftId: string;
  readonly clientId: string;
  readonly platforms: readonly PlatformId[];
  readonly contentVersion: string;
  readonly title?: string;
  readonly mediaUrls?: Readonly<Record<string, string>>;
}

export interface PublishOutcome {
  readonly jobId: string;
  readonly draftId: string;
  readonly gate: PublishGate;
  readonly published: readonly { platform: PlatformId; postId: string; postUrl: string }[];
  readonly skipped: readonly PlatformId[];
  /** Why each skipped platform was skipped (e.g. "not connected", an adapter error). Keyed by platform. */
  readonly skippedReasons: Readonly<Partial<Record<PlatformId, string>>>;
  readonly blocked: boolean;
}

export interface PublishWorkerDeps {
  readonly approvals: ApprovalStateMachine;
  readonly oauth?: OAuthTokenService;
}

/** Platform -> env var the adapter reads its token from (single-tenant fallback). */
const TOKEN_ENV: Readonly<Partial<Record<PlatformId, string>>> = {
  facebook: 'FB_PAGE_ACCESS_TOKEN',
  instagram: 'META_ACCESS_TOKEN',
  linkedin: 'LINKEDIN_ACCESS_TOKEN',
  tiktok: 'TIKTOK_ACCESS_TOKEN',
  youtube: 'YOUTUBE_ACCESS_TOKEN',
};

export class PublishWorker {
  constructor(private readonly deps: PublishWorkerDeps) {}

  async run(job: PublishJob): Promise<PublishOutcome> {
    const gate = await this.deps.approvals.canPublish(job.draftId, job.platforms);
    if (!gate.allowed) {
      return {
        jobId: job.jobId,
        draftId: job.draftId,
        gate,
        published: [],
        skipped: job.platforms,
        skippedReasons: {},
        blocked: true,
      };
    }

    const published: { platform: PlatformId; postId: string; postUrl: string }[] = [];
    const skipped: PlatformId[] = [];
    const skippedReasons: Partial<Record<PlatformId, string>> = {};
    for (const platform of job.platforms) {
      if (gate.perPlatform[platform] !== 'approved') {
        skipped.push(platform);
        continue;
      }
      const envKey = TOKEN_ENV[platform];
      const prev = envKey ? process.env[envKey] : undefined;
      if (this.deps.oauth && envKey) {
        const stored = await this.deps.oauth.get(job.clientId, platform as OAuthPlatform);
        if (stored) process.env[envKey] = stored.accessToken;
      }
      try {
        // Constraint #13: never publish to a platform without a connected
        // credential - degrade gracefully, skip that platform, and log.
        // Adapter construction is the only place credential absence is
        // detected, so it gets its own catch: a failure here skips just this
        // platform. A failure from adapter.publish() below (a real API/
        // transient error on a platform that IS connected) is left to
        // propagate and fail the job normally, preserving BullMQ retries.
        let adapter: ReturnType<typeof createAdapterFor>;
        try {
          adapter = createAdapterFor(platform);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          skippedReasons[platform] = reason;
          skipped.push(platform);
          console.warn(`[publish:${job.draftId}] skipping ${platform} (not connected): ${reason}`);
          continue;
        }
        const result = await adapter.publish({
          contentVersion: job.contentVersion,
          approvedDraft: true,
          approvedFinal: true,
          title: job.title,
          mediaUrl: job.mediaUrls?.[platform],
        } as never);
        published.push({ platform, postId: result.postId, postUrl: result.postUrl });
      } finally {
        if (envKey) {
          if (prev !== undefined) process.env[envKey] = prev;
          else delete process.env[envKey];
        }
      }
    }

    return { jobId: job.jobId, draftId: job.draftId, gate, published, skipped, skippedReasons, blocked: false };
  }
}

export function createPublishWorker(approvals: ApprovalStateMachine): PublishWorker {
  return new PublishWorker({ approvals });
}
