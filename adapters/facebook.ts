/**
 * ESSENTIAL - Social Media Super Agent
 * packages/adapters/facebook.ts
 *
 * Facebook Pages adapter. Implements the PlatformAdapter contract defined in
 * ESSENTIAL_BLUEPRINT.md §4.8 ("Every adapter implements: validateConnection(),
 * validateMedia(), publish(payload), getStatus(), handleError()") and the
 * verified endpoints in §5.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. no secrets in source - everything comes from
 * the environment / a secret manager. No live calls unless LIVE_PUBLISH=true.
 */

/* --------------------------------------------------------------------------
 * Config constants - DO NOT hard-code these in business logic.
 * Graph API version, host, and rate-limit codes are config, not code.
 * ------------------------------------------------------------------------ */
export const FACEBOOK_CONFIG = {
  /** Current Graph API version (verified: v26.0, released 2026-07-29). */
  graphApiVersion: process.env.FACEBOOK_GRAPH_API_VERSION ?? 'v26.0',
  graphHost: 'https://graph.facebook.com',
  /** Long-lived Page tokens do not expire but must be monitored/rotated. */
  tokenExpiryGraceMs: 1000 * 60 * 60 * 24 * 30, // 30 days before rotation
  /** Scheduled posts must be between 10 minutes and 30 days out. */
  scheduleMinMs: 10 * 60 * 1000,
  scheduleMaxMs: 30 * 24 * 60 * 60 * 1000,
} as const;

/* --------------------------------------------------------------------------
 * Domain types (no `any` anywhere).
 * ------------------------------------------------------------------------ */
export type FacebookMediaKind = 'text' | 'image' | 'video';

export interface FacebookPublishPayload {
  pageId: string;
  message: string;
  mediaKind: FacebookMediaKind;
  /** Public URL of the media (image or video) to attach. */
  mediaUrl?: string;
  /** Optional link to attach to a text post. */
  link?: string;
  /** Optional: schedule time (ISO). Publish is immediate when omitted. */
  scheduledAt?: string;
  /** Optional: multi-photo post - array of public image URLs. */
  photoUrls?: readonly string[];
  /** Optional: video metadata. */
  video?: {
    title?: string;
    description?: string;
    thumbUrl?: string;
  };
  /** Content identity for the approval lock + audit trail. */
  contentVersion: string;
  approvedDraft: boolean;
  approvedFinal: boolean;
}

export interface FacebookPublishResult {
  platform: 'facebook';
  postId: string;
  postUrl: string;
  status: 'PUBLISHED' | 'SCHEDULED';
  publishedAt: string;
  auditEvent: 'FACEBOOK_PAGE_CONTENT_PUBLISHED';
}

export interface FacebookConnectionStatus {
  connected: boolean;
  pageId?: string;
  pageName?: string;
  tasks?: readonly string[];
  error?: string;
}

export interface FacebookMetrics {
  postId: string;
  impressions?: number;
  reach?: number;
  engagedUsers?: number;
  reactions?: number;
  comments?: number;
  shares?: number;
  recordedAt: string;
}

/** Typed errors - never throw a bare string. */
export class FacebookAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly retryable: boolean,
    public readonly subcode?: number,
  ) {
    super(message);
    this.name = 'FacebookAdapterError';
  }
}

/** Thrown for contract methods this adapter intentionally does not support. */
export class NotSupportedError extends Error {
  constructor(what: string) {
    super(`Not supported by the Facebook adapter: ${what}`);
    this.name = 'NotSupportedError';
  }
}

/* --------------------------------------------------------------------------
 * PlatformAdapter contract (mirrors blueprint §4.8).
 * ------------------------------------------------------------------------ */
export interface PlatformAdapter {
  readonly platform: string;
  validateConnection(): Promise<FacebookConnectionStatus>;
  validateMedia(payload: FacebookPublishPayload): Promise<void>;
  publish(payload: FacebookPublishPayload): Promise<FacebookPublishResult>;
  getStatus(postId: string): Promise<{ postId: string; status: string }>;
  handleError(err: unknown): FacebookAdapterError;
}

/* --------------------------------------------------------------------------
 * Minimal HTTP client (mock-mode aware). No secrets logged.
 * ------------------------------------------------------------------------ */
interface GraphResponse {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
}

async function graphRequest(
  path: string,
  accessToken: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<GraphResponse> {
  const live = process.env.LIVE_PUBLISH === 'true';
  const url = `${FACEBOOK_CONFIG.graphHost}/${FACEBOOK_CONFIG.graphApiVersion}/${path}`;

  if (!live) {
    // Dry-run: print a redacted payload, make no network call.
    const redacted = { ...(body ?? {}), access_token: '<redacted>' };
    // eslint-disable-next-line no-console
    console.log(`[facebook:mock] ${method} ${url}`, JSON.stringify(redacted));
    return { ok: true, status: 200, json: { id: 'mock_page_mock_post' } };
  }

  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify({ ...body, access_token: accessToken }) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

/* --------------------------------------------------------------------------
 * Rate-limit state (verified error codes: 4 = app limit, 32 = Pages API
 * limit, 80001 = Pages API with Page/system-user token).
 * ------------------------------------------------------------------------ */
class RateLimitTracker {
  private hits: number[] = [];

  private bucketedUsage(): number {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < 1000 * 60 * 60); // 1h window
    return this.hits.length;
  }

  recordHit(): void {
    this.hits.push(Date.now());
  }

  /** Conservative guard: block once we exceed 200 calls in the rolling hour. */
  isThrottled(): boolean {
    return this.bucketedUsage() >= 200;
  }
}

/* --------------------------------------------------------------------------
 * The adapter.
 * ------------------------------------------------------------------------ */
export class FacebookAdapter implements PlatformAdapter {
  readonly platform = 'facebook' as const;

  private readonly rateLimit = new RateLimitTracker();
  private readonly token: string;
  private readonly pageId: string;

  constructor(token: string, pageId: string) {
    if (!token || !pageId) {
      throw new Error('FacebookAdapter requires a Page access token and Page ID');
    }
    this.token = token;
    this.pageId = pageId;
  }

  /* --- Contract: validateConnection() ----------------------------------- */
  async validateConnection(): Promise<FacebookConnectionStatus> {
    const res = await graphRequest(
      `${this.pageId}?fields=id,name,tasks`,
      this.token,
    );
    if (!res.ok) {
      const err = this.handleError(res.json);
      return { connected: false, error: err.message };
    }
    return {
      connected: true,
      pageId: String(res.json.id ?? this.pageId),
      pageName: typeof res.json.name === 'string' ? res.json.name : undefined,
      tasks: Array.isArray(res.json.tasks) ? (res.json.tasks as string[]) : undefined,
    };
  }

  /* --- Contract: validateMedia() ---------------------------------------- */
  async validateMedia(payload: FacebookPublishPayload): Promise<void> {
    if (payload.mediaKind === 'text') return;
    if (!payload.mediaUrl && !payload.photoUrls?.length) {
      throw new FacebookAdapterError(
        'Media payload requires mediaUrl or photoUrls',
        100,
        false,
      );
    }
    if (payload.mediaKind === 'video' && !payload.mediaUrl) {
      throw new FacebookAdapterError('Video posts require mediaUrl', 100, false);
    }
    // Deep URL reachability is validated by Meta at publish time; we only
    // verify presence and shape here (build-time TODO: HEAD + range check).
  }

  /* --- Contract: publish() ----------------------------------------------- */
  async publish(payload: FacebookPublishPayload): Promise<FacebookPublishResult> {
    this.assertApproved(payload);
    await this.validateMedia(payload);

    const scheduled = payload.scheduledAt ? new Date(payload.scheduledAt) : undefined;
    if (scheduled) {
      const delta = scheduled.getTime() - Date.now();
      if (delta < FACEBOOK_CONFIG.scheduleMinMs || delta > FACEBOOK_CONFIG.scheduleMaxMs) {
        throw new FacebookAdapterError(
          'Scheduled publish time must be between 10 minutes and 30 days from now',
          100,
          false,
        );
      }
    }

    const body: Record<string, unknown> = {
      message: payload.message,
      published: scheduled ? false : true,
    };
    if (scheduled) {
      body.scheduled_publish_time = Math.floor(scheduled.getTime() / 1000);
    }
    if (payload.link) body.link = payload.link;

    let path: string;
    switch (payload.mediaKind) {
      case 'text':
      path = `${this.pageId}/feed`;
        break;
      case 'image': {
        path = `${this.pageId}/photos`;
        if (payload.photoUrls?.length) {
          // Multi-photo: upload each photo, then publish with attached_media.
          const ids: string[] = [];
          for (const url of payload.photoUrls) {
            const up = await graphRequest(`${this.pageId}/photos`, this.token, 'POST', {
              url,
              published: false,
            });
            if (typeof up.json.id === 'string') ids.push(up.json.id);
          }
          body.attached_media = JSON.stringify(ids.map((id) => ({ media_fbid: id })));
        } else if (payload.mediaUrl) {
          body.url = payload.mediaUrl;
        }
        break;
      }
      case 'video': {
        path = `${this.pageId}/videos`;
        body.file_url = payload.mediaUrl;
        body.title = payload.video?.title ?? payload.message;
        body.description = payload.video?.description ?? payload.message;
        if (payload.video?.thumbUrl) body.thumb = payload.video.thumbUrl;
        break;
      }
    }

    this.rateLimit.recordHit();
    if (this.rateLimit.isThrottled()) {
      throw new FacebookAdapterError('Facebook Pages API rate limit reached', 32, true);
    }

    const res = await graphRequest(path, this.token, 'POST', body);
    if (!res.ok) throw this.handleError(res.json);

    const postId = typeof res.json.id === 'string' ? res.json.id : '';
    if (!postId) {
      throw new FacebookAdapterError('Facebook returned no post id', 100, false);
    }

    return {
      platform: 'facebook',
      postId,
      postUrl: `https://www.facebook.com/${postId}`,
      status: scheduled ? 'SCHEDULED' : 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      auditEvent: 'FACEBOOK_PAGE_CONTENT_PUBLISHED',
    };
  }

  /* --- Contract: getStatus() --------------------------------------------- */
  async getStatus(postId: string): Promise<{ postId: string; status: string }> {
    const res = await graphRequest(
      `${postId}?fields=id,created_time,is_published`,
      this.token,
    );
    if (!res.ok) throw this.handleError(res.json);
    return {
      postId: String(res.json.id ?? postId),
      status: res.json.is_published === false ? 'SCHEDULED' : 'PUBLISHED',
    };
  }

  /* --- Contract: handleError() ------------------------------------------- */
  handleError(err: unknown): FacebookAdapterError {
    const json = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
    const error = (typeof json.error === 'object' && json.error !== null
      ? json.error
      : {}) as Record<string, unknown>;
    const code = typeof error.code === 'number' ? error.code : 0;
    const subcode = typeof error.subcode === 'number' ? error.subcode : undefined;
    const message = typeof error.message === 'string' ? error.message : 'Unknown Facebook API error';

    switch (code) {
      case 4: // App-level rate limit
      case 32: // Pages API limit
      case 80001: // Pages API with Page/system-user token
        return new FacebookAdapterError(`Rate limited (${code}): ${message}`, code, true, subcode);
      case 190: // Invalid or expired token
        return new FacebookAdapterError(`Token invalid or expired: ${message}`, code, true, subcode);
      case 100: // Invalid parameter / authorization
        return new FacebookAdapterError(`Invalid parameter: ${message}`, code, false, subcode);
      default:
        return new FacebookAdapterError(message, code, code >= 500, subcode);
    }
  }

  /* --- Beyond the base contract (blueprint §4.8 "full contracts in §5") -- */
  /** Schedule a post (delegates to publish with scheduledAt). */
  async schedule(payload: FacebookPublishPayload, scheduledAt: string): Promise<FacebookPublishResult> {
    return this.publish({ ...payload, scheduledAt });
  }

  /** Opt-in metrics. Requires the Page insights permission at build time. */
  async getMetrics(postId: string): Promise<FacebookMetrics> {
    const res = await graphRequest(
      `${postId}/insights?metric=post_impressions,post_reactions_by_type_total,post_comments,post_shares`,
      this.token,
    );
    if (!res.ok) throw this.handleError(res.json);
    // Insight parsing is a build-time TODO - return the raw record for now.
    return {
      postId,
      recordedAt: new Date().toISOString(),
      ...(res.json as Partial<FacebookMetrics>),
    };
  }

  /** Normalize an incoming Facebook webhook event into a typed record. */
  async normalizeWebhook(raw: Record<string, unknown>): Promise<{ event: string; postId?: string }> {
    const entry = Array.isArray(raw.entry) ? (raw.entry[0] as Record<string, unknown>) : {};
    const changes = Array.isArray(entry.changes) ? (entry.changes[0] as Record<string, unknown>) : {};
    const value = (typeof changes.value === 'object' && changes.value !== null
      ? changes.value
      : {}) as Record<string, unknown>;
    return {
      event: typeof changes.field === 'string' ? changes.field : 'unknown',
      postId: typeof value.post_id === 'string' ? value.post_id : undefined,
    };
  }

  /** Refresh: long-lived Page token derived from a long-lived User token. */
  async refreshToken(): Promise<string> {
    const userToken = process.env.FB_USER_LONG_LIVED_TOKEN;
    if (!userToken) {
      throw new FacebookAdapterError('FB_USER_LONG_LIVED_TOKEN not set; cannot refresh', 190, true);
    }
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      throw new FacebookAdapterError('META_APP_ID/META_APP_SECRET not set; cannot refresh', 190, true);
    }
    const res = await graphRequest(
      `oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${userToken}`,
      this.token,
    );
    if (!res.ok) throw this.handleError(res.json);
    const token = typeof res.json.access_token === 'string' ? res.json.access_token : '';
    if (!token) throw new FacebookAdapterError('Token refresh returned no token', 190, true);
    return token;
  }

  /* --- Private helpers ---------------------------------------------------- */
  private assertApproved(payload: FacebookPublishPayload): void {
    if (!payload.approvedDraft || !payload.approvedFinal) {
      throw new FacebookAdapterError(
        'Publishing blocked: both DRAFT and FINAL approvals are required',
        100,
        false,
      );
    }
    if (!payload.contentVersion) {
      throw new FacebookAdapterError('Publishing blocked: contentVersion is required for audit', 100, false);
    }
  }
}

/* --------------------------------------------------------------------------
 * Factory - the only sanctioned way to construct the adapter.
 * ------------------------------------------------------------------------ */
export function createFacebookAdapter(): FacebookAdapter {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const pageId = process.env.FB_PAGE_ID;
  if (!token || !pageId) {
    throw new Error(
      'Facebook adapter requires FB_PAGE_ACCESS_TOKEN and FB_PAGE_ID in the environment',
    );
  }
  return new FacebookAdapter(token, pageId);
}

export default createFacebookAdapter;
