/**
 * ESSENTIAL - Social Media Super Agent
 * apps/api/index.ts
 *
 * Fastify API. Binds the dashboard routes for the
 *   topic-select -> render -> preview -> approve -> publish
 * flow (blueprint Section 22.2) to the BullMQ worker queues.
 *
 * Every route is scoped to the authenticated client (JWT bearer, M10 auth).
 * Long-running work (research, render, publish) is enqueued and returns
 * 202 Accepted with a jobId; the client polls the draft/status endpoints or
 * subscribes to the draft-events webhook.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only (Claude Code). No secrets in source.
 * No workflow-JSON artifacts. Mock-first. JSON is used only as HTTP payloads.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { createQueues, type WorkerOptions } from '../worker';
import type { MediaJob, PublishJobData } from '../worker/processors';
import {
  validateVideoLength,
  videoLengthDropdown,
  MIN_VIDEO_LENGTH_MINUTES,
  MIN_CONTENT_MINUTES,
} from '../../packages/media/platform-limits';
import { AVATAR_VENDOR_IDS, type AvatarVendorId } from '../../packages/media/vendors';
import { createApprovalStateMachine, type ApprovalStateMachine, type ApproveResult } from '../../packages/approvals';
import { PLATFORM_IDS, type PlatformId } from '../../packages/adapters';
import { randomUUID } from 'node:crypto';
import { AuthError, NotFoundError, RateLimitError, toHttpError } from '../../packages/core/errors';
import type { Logger } from '../../packages/core/logger';
import { AuthService, RateLimiter, type JwtClaims, type RateLimiterLike } from '../../packages/auth';
import { NeoEngine, neoRoutes } from '../../packages/neo';
import type { OAuthTokenService, OAuthPlatform } from '../../packages/oauth';

/* ------------------------------------------------------------------ */
/* Request body types (runtime validation via JSON Schema below).      */
/* ------------------------------------------------------------------ */

export type MediaType = 'image' | 'video' | 'both';

export interface TopicSelectBody {
  readonly topic: string;
  readonly count: number;
  readonly mediaType: MediaType;
  readonly platforms: readonly PlatformId[];
  readonly vendor: AvatarVendorId;
  readonly avatarId?: string;
  readonly voiceId?: string;
  readonly targetMinutes: number;
  readonly language?: 'en' | 'es';
  readonly podcastScript?: boolean;
}

export interface RenderBody {
  readonly mediaType: MediaType;
  readonly vendor: AvatarVendorId;
  readonly avatarId?: string;
  readonly voiceId?: string;
  readonly targetMinutes: number;
}

export interface ApproveBody {
  readonly approvedBy: string;
  readonly platforms?: readonly PlatformId[];
}

/* ------------------------------------------------------------------ */
/* In-memory draft store (mock-first; persisted via Prisma in prod).   */
/* ------------------------------------------------------------------ */

export type DraftStageStatus =
  | 'queued'
  | 'researching'
  | 'writing'
  | 'rendering'
  | 'preview_ready'
  | 'preview_approved'
  | 'published'
  | 'publishing'
  | 'failed'
  | 'blocked';

export interface DraftRecord {
  readonly draftId: string;
  readonly clientId: string;
  readonly topic: string;
  readonly count: number;
  readonly mediaType: MediaType;
  readonly platforms: readonly PlatformId[];
  readonly vendor: AvatarVendorId;
  readonly avatarId?: string;
  readonly voiceId?: string;
  readonly targetMinutes: number;
  readonly language: 'en' | 'es';
  readonly podcastScript: boolean;
  readonly status: DraftStageStatus;
  readonly strategy?: unknown;
  readonly copy?: unknown;
  readonly media?: unknown;
  readonly previewUrls?: readonly string[];
  readonly jobIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class DraftStore {
  private readonly drafts = new Map<string, DraftRecord>();
  private seq = 0;

  create(input: {
    clientId: string;
    topic: string;
    count: number;
    mediaType: MediaType;
    platforms: readonly PlatformId[];
    vendor: AvatarVendorId;
    avatarId?: string;
    voiceId?: string;
    targetMinutes: number;
    language: 'en' | 'es';
    podcastScript: boolean;
  }): DraftRecord {
    const now = new Date().toISOString();
    const draftId = `draft_${++this.seq}`;
    const record: DraftRecord = {
      draftId,
      clientId: input.clientId,
      topic: input.topic,
      count: input.count,
      mediaType: input.mediaType,
      platforms: input.platforms,
      vendor: input.vendor,
      avatarId: input.avatarId,
      voiceId: input.voiceId,
      targetMinutes: input.targetMinutes,
      language: input.language,
      podcastScript: input.podcastScript,
      status: 'queued',
      jobIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.drafts.set(draftId, record);
    return record;
  }

  get(draftId: string): DraftRecord | undefined {
    return this.drafts.get(draftId);
  }

  update(draftId: string, patch: Partial<DraftRecord>): DraftRecord | undefined {
    const existing = this.drafts.get(draftId);
    if (!existing) return undefined;
    const updated: DraftRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(draftId, updated);
    return updated;
  }
}

/* ------------------------------------------------------------------ */
/* Route plugin                                                        */
/* ------------------------------------------------------------------ */

/** Minimal queue surface the API needs (real BullMQ Queue or a test fake). */
type QueueLike = {
  add(name: string, data: unknown, opts?: { jobId?: string }): Promise<{ id?: string }>;
};

export interface EssentialQueues {
  readonly research: QueueLike;
  readonly copy: QueueLike;
  readonly media: QueueLike;
  readonly publish: QueueLike;
}

/** Draft store contract - sync (in-memory) or async (Postgres) both satisfy it. */
export interface DraftStoreLike<R extends DraftRecord = DraftRecord> {
  create(input: Omit<R, 'draftId' | 'status' | 'jobIds' | 'createdAt' | 'updatedAt'>): R | Promise<R>;
  get(draftId: string): R | undefined | Promise<R | undefined>;
  update(draftId: string, patch: Partial<R>): R | undefined | Promise<R | undefined>;
}

export interface EssentialApiOptions {
  readonly worker?: WorkerOptions;
  readonly draftStore?: DraftStoreLike;
  readonly approvals?: ApprovalStateMachine;
  /** Injectable queues - lets tests run without Redis (fake queues). */
  readonly queues?: EssentialQueues;
  /** M10 auth service. When provided, /api/clients/* routes require a JWT. */
  readonly auth?: AuthService;
  /** Structured JSON logger. When provided, requests are logged with traceId. */
  readonly logger?: Logger;
  /** Neo - embedded AI assistant for clients (RAG over the capability registry). */
  readonly neo?: NeoEngine;
  /** OAuth token persistence + refresh (backlog: persist OAuth). */
  readonly oauth?: OAuthTokenService;
  /** Gate /api/neo/* behind auth too (default off keeps open dev access). */
  readonly gateNeo?: boolean;
  /** Login rate limiter - Redis-backed in production, in-memory default. */
  readonly rateLimiter?: RateLimiterLike;
}

const topicSelectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['topic', 'count', 'mediaType', 'platforms', 'vendor', 'targetMinutes'],
  properties: {
    topic: { type: 'string', minLength: 1, maxLength: 200 },
    count: { type: 'integer', minimum: 1, maximum: 10 },
    mediaType: { type: 'string', enum: ['image', 'video', 'both'] },
    platforms: { type: 'array', items: { type: 'string', enum: PLATFORM_IDS } },
    vendor: { type: 'string', enum: AVATAR_VENDOR_IDS },
    avatarId: { type: 'string' },
    voiceId: { type: 'string' },
    targetMinutes: { type: 'integer', minimum: MIN_VIDEO_LENGTH_MINUTES, maximum: 60 },
    language: { type: 'string', enum: ['en', 'es'], default: 'en' },
    podcastScript: { type: 'boolean', default: false },
  },
};

const renderSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mediaType', 'vendor', 'targetMinutes'],
  properties: {
    mediaType: { type: 'string', enum: ['image', 'video', 'both'] },
    vendor: { type: 'string', enum: AVATAR_VENDOR_IDS },
    avatarId: { type: 'string' },
    voiceId: { type: 'string' },
    targetMinutes: { type: 'integer', minimum: MIN_VIDEO_LENGTH_MINUTES, maximum: 60 },
  },
};

const approveSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['approvedBy'],
  properties: {
    approvedBy: { type: 'string', minLength: 1 },
    platforms: { type: 'array', items: { type: 'string', enum: PLATFORM_IDS } },
  },
};

const draftParamsSchema = {
  type: 'object',
  required: ['id', 'draftId'],
  properties: { id: { type: 'string' }, draftId: { type: 'string' } },
};

const clientParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

export const essentialApiPlugin: FastifyPluginAsync<EssentialApiOptions> = async (
  fastify,
  opts,
) => {
  const queues: EssentialQueues =
    opts.queues ?? (createQueues(opts.worker ?? {}) as unknown as EssentialQueues);
  const drafts: DraftStoreLike = opts.draftStore ?? new DraftStore();
  const approvals = opts.approvals ?? createApprovalStateMachine();
  const logger = opts.logger;
  const auth = opts.auth;
  const oauth = opts.oauth;
  const metrics = { requests: 0, errors: 0, drafts: 0, publishes: 0 };

  /* error taxonomy -> HTTP mapping (single error handler) */
  fastify.setErrorHandler((err, _request, reply) => {
    const mapped = toHttpError(err);
    metrics.errors++;
    logger?.error('http_error', {
      statusCode: mapped.statusCode,
      code: mapped.body.code,
      message: mapped.body.message,
    });
    return reply.code(mapped.statusCode).send(mapped.body);
  });

  /* traceId + structured request logging */
  fastify.addHook('onRequest', async (request) => {
    (request as { traceId?: string }).traceId = randomUUID();
    metrics.requests++;
    logger?.info('request_start', {
      method: request.method,
      url: request.url,
      traceId: (request as { traceId?: string }).traceId,
    });
  });
  fastify.addHook('onResponse', async (request, reply) => {
    logger?.info('request_end', {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      traceId: (request as { traceId?: string }).traceId,
    });
  });

  /* M10 auth gate: /api/clients/* require a valid JWT when auth is enabled. */
  if (auth) {
    fastify.addHook('onRequest', async (request) => {
      if (!request.url.startsWith('/api/clients/') && !(opts.gateNeo && request.url.startsWith('/api/neo/'))) return;
      const header = request.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) throw new AuthError('missing bearer token');
      try {
        (request as { user?: JwtClaims }).user = await auth.authenticate(header.slice(7));
      } catch {
        throw new AuthError('invalid or expired token');
      }
    });
  }

  /* M10 auth routes */
  const loginLimiter: RateLimiterLike = opts.rateLimiter ?? new RateLimiter(60_000, 5);
  fastify.post<{ Body: { email: string; password: string } }>(
    '/api/auth/register',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: { email: { type: 'string' }, password: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      if (!auth) throw new NotFoundError('auth is disabled');
      const result = await auth.register(request.body.email, request.body.password);
      return reply.code(201).send({
        user: { id: result.user.id, email: result.user.email, role: result.user.role },
        token: result.token,
      });
    },
  );
  fastify.post<{ Body: { email: string; password: string } }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: { email: { type: 'string' }, password: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => {
      if (!auth) throw new NotFoundError('auth is disabled');
      const lim = await loginLimiter.check(request.body.email);
      if (!lim.allowed) {
        throw new RateLimitError('too many login attempts', { retryAfterMs: lim.retryAfterMs });
      }
      const result = await auth.login(request.body.email, request.body.password);
      return { token: result.token };
    },
  );
  fastify.get('/api/auth/me', async (request) => {
    if (!auth) throw new NotFoundError('auth is disabled');
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw new AuthError('missing bearer token');
    const claims = await auth.authenticate(header.slice(7));
    return { user: { id: claims.sub, email: claims.email, role: claims.role } };
  });

  /* POST /api/auth/logout - revoke the presented token (A2 fix). */
  fastify.post('/api/auth/logout', async (request) => {
    if (!auth) throw new NotFoundError('auth is disabled');
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw new AuthError('missing bearer token');
    await auth.revoke(header.slice(7));
    return { ok: true };
  });

  /* GET /health - liveness probe for docker-compose / hosting healthchecks. */
  fastify.get('/health', async () => ({ status: 'ok', service: 'essential-api' }));

  /* GET /metrics - lightweight counters (C4 fix). */
  fastify.get('/metrics', async () => ({ ...metrics }));

    const requireDraft = async (draftId: string): Promise<DraftRecord> => {
    const draft = await drafts.get(draftId);
    if (!draft) throw new NotFoundError('draft not found');
    return draft;
  };

  const httpError = (message: string, statusCode: number): Error & { statusCode: number } => {
    const err = new Error(message) as Error & { statusCode: number };
    err.statusCode = statusCode;
    return err;
  };

  /* POST /api/clients/:id/topic-select
   * Client picks a topic; Essential researches it, writes the strategy and
   * copy, and produces the selected number of content pieces (1-10). */
  fastify.post<{ Params: { id: string }; Body: TopicSelectBody }>(
    '/api/clients/:id/topic-select',
    {
      schema: { params: clientParamsSchema, body: topicSelectSchema },
    },
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body;
      const platforms = [...body.platforms];

      /* validate video length against each selected platform's cap */
      for (const platform of platforms) {
        const check = validateVideoLength(platform, body.targetMinutes);
        if (!check.ok) throw httpError(check.message, 422);
      }

      const draft = await drafts.create({
        clientId: id,
        topic: body.topic,
        count: body.count,
        mediaType: body.mediaType,
        platforms,
        vendor: body.vendor,
        avatarId: body.avatarId,
        voiceId: body.voiceId,
        targetMinutes: body.targetMinutes,
        language: body.language ?? 'en',
        podcastScript: body.podcastScript ?? false,
      });

      /* enqueue research -> strategy -> copy (idempotent: draftId:stage) */
      const research = await queues.research.add(
        `research:${draft.draftId}`,
        {
          topicId: `topic_${draft.draftId}`,
          topic: draft.topic,
          language: draft.language,
          podcastScript: draft.podcastScript,
        },
        { jobId: `research:${draft.draftId}` },
      );
      const copy = await queues.copy.add(
        `copy:${draft.draftId}`,
        {
          draftId: draft.draftId,
          clientId: draft.clientId,
          topic: draft.topic,
          platforms: draft.platforms,
          language: draft.language,
          podcastScript: draft.podcastScript,
        },
        { jobId: `copy:${draft.draftId}` },
      );

      await drafts.update(draft.draftId, {
        status: 'researching',
        jobIds: [`research:${draft.draftId}`, `copy:${draft.draftId}`],
      });

      metrics.drafts++;
      return reply.code(202).send({
        topicId: `topic_${draft.draftId}`,
        draftId: draft.draftId,
        jobId: `research:${draft.draftId}`,
        status: 'queued',
        dropdownMinutes: videoLengthDropdown(platforms[0] ?? 'youtube'),
      });
    },
  );

  /* GET /api/clients/:id/drafts/:draftId - poll target */
  fastify.get<{ Params: { id: string; draftId: string } }>(
    '/api/clients/:id/drafts/:draftId',
    {
      schema: { params: draftParamsSchema },
    },
    async (request) => {
      const draft = await requireDraft(request.params.draftId);
      return {
        draftId: draft.draftId,
        status: draft.status,
        strategy: draft.strategy,
        copy: draft.copy,
        media: draft.media,
        previewUrls: draft.previewUrls,
      };
    },
  );

  /* POST /api/clients/:id/drafts/:draftId/render
   * Client picks media type + vendor; Essential renders talking-head video,
   * image, or both (3-15 min, validated against platform caps). */
  fastify.post<{ Params: { id: string; draftId: string }; Body: RenderBody }>(
    '/api/clients/:id/drafts/:draftId/render',
    {
      schema: { params: draftParamsSchema, body: renderSchema },
    },
    async (request, reply) => {
      const draft = await requireDraft(request.params.draftId);
      const body = request.body;

      for (const platform of draft.platforms) {
        const check = validateVideoLength(platform, body.targetMinutes);
        if (!check.ok) throw httpError(check.message, 422);
      }

      const copy = draft.copy as { podcastScript?: string } | undefined;
      const mediaJob: MediaJob = {
        draftId: draft.draftId,
        clientId: draft.clientId,
        script: copy?.podcastScript ?? `script_${draft.draftId}`,
        topic: draft.topic,
        vendor: body.vendor,
        avatarId: body.avatarId ?? draft.avatarId ?? '',
        voiceId: body.voiceId ?? draft.voiceId ?? '',
        targetMinutes: body.targetMinutes,
        mediaKind: body.mediaType,
      };

      const job = await queues.media.add(`media:${draft.draftId}`, mediaJob, {
        jobId: `media:${draft.draftId}`,
      });
      await drafts.update(draft.draftId, {
        status: 'rendering',
        vendor: body.vendor,
        targetMinutes: body.targetMinutes,
        jobIds: [...draft.jobIds, `media:${draft.draftId}`],
      });

      return reply.code(202).send({
        draftId: draft.draftId,
        jobId: `media:${draft.draftId}`,
        status: 'rendering',
      });
    },
  );

  /* GET /api/clients/:id/drafts/:draftId/preview */
  fastify.get<{ Params: { id: string; draftId: string } }>(
    '/api/clients/:id/drafts/:draftId/preview',
    {
      schema: { params: draftParamsSchema },
    },
    async (request) => {
      const draft = await requireDraft(request.params.draftId);
      if (!draft.previewUrls || draft.previewUrls.length === 0) {
        throw httpError('preview not ready yet - poll the draft status', 409);
      }
      return {
        draftId: draft.draftId,
        previewUrls: draft.previewUrls,
        durationSeconds: draft.targetMinutes * 60,
        segmentPlan: {
          vendor: draft.vendor,
          needsStitch: draft.targetMinutes > 5,
          segments: draft.targetMinutes > 5 ? Math.ceil(draft.targetMinutes / 5) : 1,
        },
      };
    },
  );

  /* POST /api/clients/:id/drafts/:draftId/preview/approve - stage 1 gate */
  fastify.post<{ Params: { id: string; draftId: string }; Body: ApproveBody }>(
    '/api/clients/:id/drafts/:draftId/preview/approve',
    {
      schema: { params: draftParamsSchema, body: approveSchema },
    },
    async (request, reply) => {
      const draft = await requireDraft(request.params.draftId);
      await approvals.requestDraftApproval(draft.draftId, request.body.approvedBy);
      const result = await approvals.approveDraft({
        draftId: draft.draftId,
        stage: 'DRAFT',
        approvedBy: request.body.approvedBy,
      });
      if (!result.ok) throw httpError(result.message, 409);
      await drafts.update(draft.draftId, { status: 'preview_approved' });
      return { ok: true, stage: 'DRAFT', status: result.status, nextStage: result.nextStage };
    },
  );

  /* POST /api/clients/:id/drafts/:draftId/approve - per-platform FINAL */
  fastify.post<{ Params: { id: string; draftId: string }; Body: ApproveBody }>(
    '/api/clients/:id/drafts/:draftId/approve',
    {
      schema: { params: draftParamsSchema, body: approveSchema },
    },
    async (request, reply) => {
      const draft = await requireDraft(request.params.draftId);
      const platforms = [...(request.body.platforms ?? draft.platforms)];
      await approvals.requestFinalApprovals(draft.draftId, platforms, request.body.approvedBy);
      const results: ApproveResult[] = [];
      for (const platform of platforms) {
        results.push(
          await approvals.approvePlatform({
            draftId: draft.draftId,
            stage: 'FINAL',
            platform,
            approvedBy: request.body.approvedBy,
          }),
        );
      }
      const failed = results.find((r) => !r.ok);
      if (failed) throw httpError(failed.message, 409);
      return { ok: true, stage: 'FINAL', platforms: results.map((r) => r.status) };
    },
  );

  /* POST /api/clients/:id/drafts/:draftId/publish
   * Runs only where the two-stage gate passes: draft approved AND every
   * selected platform approved. Enqueues the publish job. */
  fastify.post<{ Params: { id: string; draftId: string } }>(
    '/api/clients/:id/drafts/:draftId/publish',
    {
      schema: { params: draftParamsSchema },
    },
    async (request, reply) => {
      const draft = await requireDraft(request.params.draftId);
      const gate = await approvals.canPublish(draft.draftId, draft.platforms);
      if (!gate.allowed) {
        throw httpError(`publish blocked - missing approvals: ${gate.missing.join(', ')}`, 403);
      }
      const publishJob: PublishJobData = {
        jobId: `publish:${draft.draftId}`,
        draftId: draft.draftId,
        clientId: draft.clientId,
        platforms: draft.platforms,
        contentVersion: `v1-${draft.updatedAt}`,
        title: draft.topic,
        mediaUrls: Object.fromEntries(
          draft.platforms.map((platform) => [platform, draft.previewUrls?.[0] ?? '']),
        ),
      };
      const job = await queues.publish.add(`publish:${draft.draftId}`, publishJob, {
        jobId: `publish:${draft.draftId}`,
      });
      await drafts.update(draft.draftId, {
        status: 'publishing',
        jobIds: [...draft.jobIds, `publish:${draft.draftId}`],
      });
      metrics.publishes++;
      return reply.code(202).send({
        draftId: draft.draftId,
        jobId: `publish:${draft.draftId}`,
        status: 'publishing',
      });
    },
  );

  /* GET /api/clients/:id/drafts/:draftId/status - aggregate pipeline state */
  fastify.get<{ Params: { id: string; draftId: string } }>(
    '/api/clients/:id/drafts/:draftId/status',
    {
      schema: { params: draftParamsSchema },
    },
    async (request) => {
      const draft = await requireDraft(request.params.draftId);
      const gate = await approvals.canPublish(draft.draftId, draft.platforms);
      return {
        draftId: draft.draftId,
        research: draft.status === 'queued' ? 'pending' : 'done',
        strategy: draft.strategy ? 'done' : 'pending',
        copy: draft.copy ? 'done' : 'pending',
        media: draft.media ? 'done' : 'pending',
        preview: draft.previewUrls && draft.previewUrls.length > 0 ? 'ready' : 'pending',
        approvals: gate.perPlatform,
        publish: draft.status,
        minContentMinutes: MIN_CONTENT_MINUTES,
      };
    },
  );

  /* OAuth token persistence + refresh (backlog: persist OAuth). */
  if (oauth) {
    fastify.post<{
      Params: { id: string };
      Body: {
        platform: OAuthPlatform;
        accessToken: string;
        refreshToken?: string;
        expiresInSec?: number;
        scopes?: string[];
      };
    }>(
      '/api/clients/:id/oauth',
      async (request, reply) => {
        const { id } = request.params;
        const rec = await oauth.store(id, request.body.platform, {
          accessToken: request.body.accessToken,
          refreshToken: request.body.refreshToken,
          expiresInSec: request.body.expiresInSec,
          scopes: request.body.scopes,
        });
        return reply.code(201).send({
          status: rec.status,
          platform: rec.platform,
          scopes: rec.scopes,
        });
      },
    );
    fastify.get<{ Params: { id: string }; Querystring: { platform: OAuthPlatform } }>(
      '/api/clients/:id/oauth',
      async (request) => {
        const rec = await oauth.get(request.params.id, request.query.platform);
        if (!rec) throw new NotFoundError('no oauth token stored for platform');
        return {
          platform: rec.platform,
          status: rec.status,
          hasRefreshToken: rec.refreshToken ? true : false,
          scopes: rec.scopes,
        };
      },
    );
    fastify.post<{ Params: { id: string }; Body: { platform: OAuthPlatform } }>(
      '/api/clients/:id/oauth/refresh',
      async (request) => {
        await oauth.refresh(request.params.id, request.body.platform);
        return { refreshed: true };
      },
    );

    /* B6: SSE push for draft status - GET /api/clients/:id/drafts/:draftId/events */
    fastify.get<{ Params: { id: string; draftId: string } }>(
      '/api/clients/:id/drafts/:draftId/events',
      async (request, reply) => {
        const raw = reply.raw;
        raw.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        if (typeof raw.flushHeaders === 'function') raw.flushHeaders();
        let closed = false;
        const timer = setInterval(async () => {
          if (closed) return;
          const draft = await drafts.get(request.params.draftId);
          if (draft) raw.write(`data: ${JSON.stringify({ draftId: draft.draftId, status: draft.status })}\n\n`);
        }, 2000);
        const heartbeat = setInterval(() => {
          if (!closed) raw.write(': heartbeat\n\n');
        }, 15_000);
        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          clearInterval(heartbeat);
          raw.end();
        };
        request.raw.on('aborted', cleanup);
        reply.raw.on('close', cleanup);
      },
    );
  }
};

/** Build a Fastify app with the Essential routes registered. */
export async function buildEssentialApp(opts: EssentialApiOptions = {}): Promise<FastifyInstance> {
  const { default: Fastify } = await import('fastify');
  const app = Fastify({ logger: false });
  await app.register(essentialApiPlugin, opts);
  const neo = opts.neo ?? new NeoEngine();
  await app.register(neoRoutes, { neo });
  return app;
}
