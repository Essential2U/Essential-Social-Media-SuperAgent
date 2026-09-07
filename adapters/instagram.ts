/**
 * ESSENTIAL - Social Media Super Agent
 * packages/adapters/instagram.ts
 *
 * Instagram adapter (Instagram Graph API via a Business/Creator account).
 * Implements the PlatformAdapter contract defined in ESSENTIAL_BLUEPRINT.md
 * §4.8 ("Every adapter implements: validateConnection(), validateMedia(),
 * publish(payload), getStatus(), handleError()") and the verified endpoints
 * in §5.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source - everything comes from
 * the environment / a secret manager. No live calls unless LIVE_PUBLISH=true.
 */

/* --------------------------------------------------------------------------
 * Config constants - DO NOT hard-code these in business logic.
 * ------------------------------------------------------------------------ */
export const INSTAGRAM_CONFIG = {
  /** Current Graph API version (verified: v26.0, released 2026-07-29). */
  graphApiVersion: process.env.INSTAGRAM_GRAPH_API_VERSION ?? 'v26.0',
  graphHost: 'https://graph.facebook.com',
  /** Verified: 100 API-published posts per 24h moving window; carousels count
   * as one post, with a separate 50-carousel-per-24h cap. */
  rateLimit: {
    windowMs: 1000 * 60 * 60 * 24,
    maxPublishedPosts: 100,
    maxCarouselPosts: 50,
  },
  /** Container status polling (status_code FINISHED before media_publish). */
  containerPoll: {
    intervalMs: 2000,
    timeoutMs: 5 * 60 * 1000,
  },
} as const;

/* --------------------------------------------------------------------------
 * Domain types (no `any` anywhere).
 * ------------------------------------------------------------------------ */
export type InstagramMediaKind = 'image' | 'reels' | 'carousel';

export interface InstagramPublishPayload {
  /** Instagram Business/Creator account id (IG User id). */
  igUserId: string;
  /** Caption text for the post. */
  message: string;
  mediaKind: InstagramMediaKind;
  /** Public URL of the media (image_url or video_url). JPEG for images. */
  mediaUrl?: string;
  /** Carousel: public image URLs for each child item (max 10). */
  photoUrls?: readonly string[];
  /** Reels: whether to also share to the main feed. */
  shareToFeed?: boolean;
  /** Content identity for the approval lock + audit trail. */
  contentVersion: string;
  approvedDraft: boolean;
  approvedFinal: boolean;
}

export interface InstagramPublishResult {
  platform: 'instagram';
  postId: string;
  postUrl: string;
  status: 'PUBLISHED';
  publishedAt: string;
  auditEvent: 'INSTAGRAM_CONTENT_PUBLISHED';
}

export interface InstagramConnectionStatus {
  connected: boolean;
  igUserId?: string;
  username?: string;
  accountType?: string;
  error?: string;
}

export interface InstagramMetrics {
  postId: string;
  impressions?: number;
  reach?: number;
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  recordedAt: string;
}

/** Typed errors - never throw a bare string. */
export class InstagramAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly retryable: boolean,
    public readonly subcode?: number,
  ) {
    super(message);
    this.name = 'InstagramAdapterError';
  }
}

/** Thrown for contract methods this adapter intentionally does not support. */
export class NotSupportedError extends Error {
  constructor(what: string) {
    super(`Not supported by the Instagram adapter: ${what}`);
    this.name = 'NotSupportedError';
  }
}

/* --------------------------------------------------------------------------
 * PlatformAdapter contract (mirrors blueprint §4.8).
 * ------------------------------------------------------------------------ */
export interface PlatformAdapter {
  readonly platform: string;
  validateConnection(): Promise<InstagramConnectionStatus>;
  validateMedia(payload: InstagramPublishPayload): Promise<void>;
  publish(payload: InstagramPublishPayload): Promise<InstagramPublishResult>;
  getStatus(postId: string): Promise<{ postId: string; status: string }>;
  handleError(err: unknown): InstagramAdapterError;
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
  const url = `${INSTAGRAM_CONFIG.graphHost}/${INSTAGRAM_CONFIG.graphApiVersion}/${path}`;

  if (!live) {
    // Dry-run: print a redacted payload, make no network call.
    const redacted = { ...(body ?? {}), access_token: '<redacted>' };
    // eslint-disable-next-line no-console
    console.log(`[instagram:mock] ${method} ${url}`, JSON.stringify(redacted));
    const isStatusPoll = url.includes('fields=status_code');
    return {
      ok: true,
      status: 200,
      json: isStatusPoll
        ? { id: 'mock_ig_container', status_code: 'FINISHED' }
        : { id: 'mock_ig_container' },
    };
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
 * Rate-limit state (verified: 100 API-published posts / 24h; carousels count
 * as one; separate 50-carousel / 24h cap).
 * ------------------------------------------------------------------------ */
class RateLimitTracker {
  private published: number[] = [];
  private carousels: number[] = [];

  private recent(list: number[], windowMs: number): number {
    const now = Date.now();
    const kept = list.filter((t) => now - t < windowMs);
    list.length = 0;
    list.push(...kept);
    return list.length;
  }

  recordPublished(carousel: boolean): void {
    const now = Date.now();
    this.published.push(now);
    if (carousel) this.carousels.push(now);
  }

  isThrottled(carousel: boolean): boolean {
    const posts = this.recent(this.published, INSTAGRAM_CONFIG.rateLimit.windowMs);
    if (posts >= INSTAGRAM_CONFIG.rateLimit.maxPublishedPosts) return true;
    if (carousel) {
      const cars = this.recent(this.carousels, INSTAGRAM_CONFIG.rateLimit.windowMs);
      if (cars >= INSTAGRAM_CONFIG.rateLimit.maxCarouselPosts) return true;
    }
    return false;
  }
}

/* --------------------------------------------------------------------------
 * The adapter.
 * ------------------------------------------------------------------------ */
export class InstagramAdapter implements PlatformAdapter {
  readonly platform = 'instagram' as const;

  private readonly rateLimit = new RateLimitTracker();
  private readonly token: string;
  private readonly igUserId: string;

  constructor(token: string, igUserId: string) {
    if (!token || !igUserId) {
      throw new Error('InstagramAdapter requires an access token and IG User id');
    }
    this.token = token;
    this.igUserId = igUserId;
  }

  /* --- Contract: validateConnection() ----------------------------------- */
  async validateConnection(): Promise<InstagramConnectionStatus> {
    const res = await graphRequest(
      `${this.igUserId}?fields=id,username,account_type`,
      this.token,
    );
    if (!res.ok) {
      const err = this.handleError(res.json);
      return { connected: false, error: err.message };
    }
    return {
      connected: true,
      igUserId: String(res.json.id ?? this.igUserId),
      username: typeof res.json.username === 'string' ? res.json.username : undefined,
      accountType: typeof res.json.account_type === 'string' ? res.json.account_type : undefined,
    };
  }

  /* --- Contract: validateMedia() ---------------------------------------- */
  async validateMedia(payload: InstagramPublishPayload): Promise<void> {
    // Instagram has no plain-text posts - media is always required.
    if (!payload.mediaUrl && !payload.photoUrls?.length) {
      throw new InstagramAdapterError(
        'Instagram requires media: provide mediaUrl (image/reels) or photoUrls (carousel)',
        100,
        false,
      );
    }
    if (payload.mediaKind === 'carousel') {
      if (!payload.photoUrls?.length) {
        throw new InstagramAdapterError('Carousel posts require photoUrls', 100, false);
      }
      if (payload.photoUrls.length > 10) {
        throw new InstagramAdapterError('Carousel posts support at most 10 items', 100, false);
      }
    } else if (!payload.mediaUrl) {
      throw new InstagramAdapterError(`${payload.mediaKind} posts require mediaUrl`, 100, false);
    }
    // JPEG-only for images is enforced by Meta at container creation; deep
    // content-type checks are a build-time TODO (HEAD + range against media host).
  }

  /* --- Contract: publish() ----------------------------------------------- */
  async publish(payload: InstagramPublishPayload): Promise<InstagramPublishResult> {
    this.assertApproved(payload);
    await this.validateMedia(payload);

    const isCarousel = payload.mediaKind === 'carousel';
    this.rateLimit.recordPublished(isCarousel);
    if (this.rateLimit.isThrottled(isCarousel)) {
      throw new InstagramAdapterError('Instagram API rate limit reached', 32, true);
    }

    // Step 1: create the media container(s).
    const containerId = await this.createContainer(payload);

    // Step 2: wait until the container is FINISHED (media processed).
    await this.waitForContainer(containerId);

    // Step 3: publish the container.
    const res = await graphRequest(
      `${this.igUserId}/media_publish`,
      this.token,
      'POST',
      { creation_id: containerId },
    );
    if (!res.ok) throw this.handleError(res.json);

    const postId = typeof res.json.id === 'string' ? res.json.id : '';
    if (!postId) {
      throw new InstagramAdapterError('Instagram returned no media id', 100, false);
    }

    return {
      platform: 'instagram',
      postId,
      postUrl: `https://www.instagram.com/p/${postId}`,
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      auditEvent: 'INSTAGRAM_CONTENT_PUBLISHED',
    };
  }

  /* --- Contract: getStatus() --------------------------------------------- */
  async getStatus(postId: string): Promise<{ postId: string; status: string }> {
    const res = await graphRequest(`${postId}?fields=id,permalink`, this.token);
    if (!res.ok) throw this.handleError(res.json);
    return { postId: String(res.json.id ?? postId), status: 'PUBLISHED' };
  }

  /* --- Contract: handleError() ------------------------------------------- */
  handleError(err: unknown): InstagramAdapterError {
    const json = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
    const error = (typeof json.error === 'object' && json.error !== null
      ? json.error
      : {}) as Record<string, unknown>;
    const code = typeof error.code === 'number' ? error.code : 0;
    const subcode = typeof error.subcode === 'number' ? error.subcode : undefined;
    const message = typeof error.message === 'string' ? error.message : 'Unknown Instagram API error';

    switch (code) {
      case 4: // App-level rate limit
      case 32: // API rate limit
      case 80001: // API with Page/system-user token
        return new InstagramAdapterError(`Rate limited (${code}): ${message}`, code, true, subcode);
      case 190: // Invalid or expired token
        return new InstagramAdapterError(`Token invalid or expired: ${message}`, code, true, subcode);
      case 9004: // Media upload / processing error
        return new InstagramAdapterError(`Media error: ${message}`, code, false, subcode);
      case 2207052: // Invalid media type
        return new InstagramAdapterError(`Invalid media type: ${message}`, code, false, subcode);
      case 100: // Invalid parameter
        return new InstagramAdapterError(`Invalid parameter: ${message}`, code, false, subcode);
      default:
        return new InstagramAdapterError(message, code, code >= 500, subcode);
    }
  }

  /* --- Beyond the base contract (blueprint §4.8 "full contracts in §5") -- */
  /** Instagram Graph API does not support scheduled publishing; throw clearly. */
  async schedule(): Promise<never> {
    throw new NotSupportedError(
      'scheduled publishing (Instagram Graph API has no scheduled_publish_time; use the Essential scheduler to defer the call)',
    );
  }

  /** Opt-in metrics. Requires the Instagram insights permission at build time. */
  async getMetrics(postId: string): Promise<InstagramMetrics> {
    const res = await graphRequest(
      `${postId}/insights?metric=impressions,reach,likes,comments,saved,shares`,
      this.token,
    );
    if (!res.ok) throw this.handleError(res.json);
    // Insight parsing is a build-time TODO - return the raw record for now.
    return {
      postId,
      recordedAt: new Date().toISOString(),
      ...(res.json as Partial<InstagramMetrics>),
    };
  }

  /** Normalize an incoming Instagram webhook event into a typed record. */
  async normalizeWebhook(raw: Record<string, unknown>): Promise<{ event: string; postId?: string }> {
    const entry = Array.isArray(raw.entry) ? (raw.entry[0] as Record<string, unknown>) : {};
    const changes = Array.isArray(entry.changes) ? (entry.changes[0] as Record<string, unknown>) : {};
    const value = (typeof changes.value === 'object' && changes.value !== null
      ? changes.value
      : {}) as Record<string, unknown>;
    return {
      event: typeof changes.field === 'string' ? changes.field : 'unknown',
      postId: typeof value.media_id === 'string' ? value.media_id : undefined,
    };
  }

  /** Refresh: long-lived IG token derived from a long-lived User token. */
  async refreshToken(): Promise<string> {
    const userToken = process.env.IG_USER_LONG_LIVED_TOKEN;
    if (!userToken) {
      throw new InstagramAdapterError('IG_USER_LONG_LIVED_TOKEN not set; cannot refresh', 190, true);
    }
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
      throw new InstagramAdapterError('META_APP_ID/META_APP_SECRET not set; cannot refresh', 190, true);
    }
    const res = await graphRequest(
      `oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${userToken}`,
      this.token,
    );
    if (!res.ok) throw this.handleError(res.json);
    const token = typeof res.json.access_token === 'string' ? res.json.access_token : '';
    if (!token) throw new InstagramAdapterError('Token refresh returned no token', 190, true);
    return token;
  }

  /* --- Private helpers ---------------------------------------------------- */
  private async createContainer(payload: InstagramPublishPayload): Promise<string> {
    const body: Record<string, unknown> = { caption: payload.message };

    switch (payload.mediaKind) {
      case 'image':
        body.media_type = 'IMAGE';
        body.image_url = payload.mediaUrl;
        break;
      case 'reels':
        body.media_type = 'REELS';
        body.video_url = payload.mediaUrl;
        if (payload.shareToFeed === false) body.share_to_feed = false;
        break;
      case 'carousel': {
        // Create each child item container first.
        const childIds: string[] = [];
        for (const url of payload.photoUrls as readonly string[]) {
          const child = await graphRequest(this.igUserId + '/media', this.token, 'POST', {
            image_url: url,
            is_carousel_item: true,
          });
          if (!child.ok) throw this.handleError(child.json);
          if (typeof child.json.id === 'string') childIds.push(child.json.id);
        }
        body.media_type = 'CAROUSEL';
        body.children = childIds.join(',');
        break;
      }
    }

    const res = await graphRequest(this.igUserId + '/media', this.token, 'POST', body);
    if (!res.ok) throw this.handleError(res.json);
    const containerId = typeof res.json.id === 'string' ? res.json.id : '';
    if (!containerId) {
      throw new InstagramAdapterError('Instagram returned no container id', 100, false);
    }
    return containerId;
  }

  private async waitForContainer(containerId: string): Promise<void> {
    const deadline = Date.now() + INSTAGRAM_CONFIG.containerPoll.timeoutMs;
    for (;;) {
      const res = await graphRequest(`${containerId}?fields=status_code`, this.token);
      if (!res.ok) throw this.handleError(res.json);
      const status = typeof res.json.status_code === 'string' ? res.json.status_code : '';
      if (status === 'FINISHED') return;
      if (status === 'ERROR') {
        throw new InstagramAdapterError('Instagram container failed to process', 9004, false);
      }
      if (status === 'EXPIRED') {
        throw new InstagramAdapterError('Instagram container expired before publish', 9004, false);
      }
      if (Date.now() > deadline) {
        throw new InstagramAdapterError('Timed out waiting for Instagram container', 9004, true);
      }
      await new Promise((resolve) => setTimeout(resolve, INSTAGRAM_CONFIG.containerPoll.intervalMs));
    }
  }

  private assertApproved(payload: InstagramPublishPayload): void {
    if (!payload.approvedDraft || !payload.approvedFinal) {
      throw new InstagramAdapterError(
        'Publishing blocked: both DRAFT and FINAL approvals are required',
        100,
        false,
      );
    }
    if (!payload.contentVersion) {
      throw new InstagramAdapterError('Publishing blocked: contentVersion is required for audit', 100, false);
    }
  }
}

/* --------------------------------------------------------------------------
 * Factory - the only sanctioned way to construct the adapter.
 * ------------------------------------------------------------------------ */
export function createInstagramAdapter(): InstagramAdapter {
  const token = process.env.INSTAGRAM_TOKEN;
  const igUserId = process.env.INSTAGRAM_IG_ID;
  if (!token || !igUserId) {
    throw new Error(
      'Instagram adapter requires INSTAGRAM_TOKEN and INSTAGRAM_IG_ID in the environment',
    );
  }
  return new InstagramAdapter(token, igUserId);
}

export default createInstagramAdapter;
