/**
 * ESSENTIAL - Social Media Super Agent
 * packages/adapters/tiktok.ts
 *
 * TikTok adapter (TikTok Content Posting API - Direct Post flow).
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
export const TIKTOK_CONFIG = {
  apiHost: 'https://open.tiktokapis.com',
  /** Verified: ~6 requests per minute per access token (Content Posting API). */
  rateLimit: {
    windowMs: 60 * 1000,
    maxRequestsPerMinute: 6,
  },
  /** Verified flow: init -> upload -> poll /status/fetch/ for PUBLISH_COMPLETE. */
  statusPoll: {
    intervalMs: 5000,
    timeoutMs: 10 * 60 * 1000,
  },
} as const;

/* --------------------------------------------------------------------------
 * Domain types (no `any` anywhere).
 * ------------------------------------------------------------------------ */
export type TikTokMediaKind = 'video' | 'photo';

export interface TikTokPublishPayload {
  /** The user's TikTok open_id (returned by OAuth). */
  openId: string;
  /** Post title (required, max 255 chars). */
  title: string;
  /** Post description (max 2200 chars). */
  description?: string;
  mediaKind: TikTokMediaKind;
  /** Public URL of the video/photo for PULL_FROM_URL uploads. */
  mediaUrl?: string;
  /** Verified: apps that have not passed audit are forced to SELF_ONLY. */
  privacyLevel?: 'SELF_ONLY' | 'PUBLIC_ONLY' | 'FRIENDS' | 'PRIVATE_TO';
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  /** Mandatory AI-generated content disclosure (Content Sharing Guidelines). */
  aiLabel?: boolean;
  /** Content identity for the approval lock + audit trail. */
  contentVersion: string;
  approvedDraft: boolean;
  approvedFinal: boolean;
}

export interface TikTokPublishResult {
  platform: 'tiktok';
  /** The publish_id returned by the init call. */
  postId: string;
  /** TikTok does not return a shareable URL; the video appears on the profile. */
  postUrl: string;
  status: 'PUBLISH_COMPLETE';
  publishedAt: string;
  auditEvent: 'TIKTOK_CONTENT_PUBLISHED';
}

export interface TikTokConnectionStatus {
  connected: boolean;
  openId?: string;
  displayName?: string;
  error?: string;
}

export interface TikTokMetrics {
  postId: string;
  recordedAt: string;
  /** The Content Posting API does not expose engagement metrics; analytics
   * require the separate TikTok Analytics API (build-time TODO). */
  raw?: Record<string, unknown>;
}

/** Typed errors - never throw a bare string. */
export class TikTokAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TikTokAdapterError';
  }
}

/** Thrown for contract methods this adapter intentionally does not support. */
export class NotSupportedError extends Error {
  constructor(what: string) {
    super(`Not supported by the TikTok adapter: ${what}`);
    this.name = 'NotSupportedError';
  }
}

/* --------------------------------------------------------------------------
 * PlatformAdapter contract (mirrors blueprint §4.8).
 * ------------------------------------------------------------------------ */
export interface PlatformAdapter {
  readonly platform: string;
  validateConnection(): Promise<TikTokConnectionStatus>;
  validateMedia(payload: TikTokPublishPayload): Promise<void>;
  publish(payload: TikTokPublishPayload): Promise<TikTokPublishResult>;
  getStatus(postId: string): Promise<{ postId: string; status: string }>;
  handleError(err: unknown): TikTokAdapterError;
}

/* --------------------------------------------------------------------------
 * Minimal HTTP client (mock-mode aware). No secrets logged.
 * ------------------------------------------------------------------------ */
interface ApiResponse {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
}

async function apiRequest(
  path: string,
  accessToken: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<ApiResponse> {
  const live = process.env.LIVE_PUBLISH === 'true';
  const url = `${TIKTOK_CONFIG.apiHost}${path}`;

  if (!live) {
    // Dry-run: print a redacted payload, make no network call.
    const redacted = { ...(body ?? {}), access_token: '<redacted>' };
    // eslint-disable-next-line no-console
    console.log(`[tiktok:mock] ${method} ${url}`, JSON.stringify(redacted));
    return { ok: true, status: 200, json: { data: { publish_id: 'mock_publish_id' } } };
  }

  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

/* --------------------------------------------------------------------------
 * Rate-limit state (verified: ~6 requests / minute / access token).
 * ------------------------------------------------------------------------ */
class RateLimitTracker {
  private requests: number[] = [];

  private recent(): number {
    const now = Date.now();
    const kept = this.requests.filter((t) => now - t < TIKTOK_CONFIG.rateLimit.windowMs);
    this.requests = kept;
    return kept.length;
  }

  recordRequest(): void {
    this.requests.push(Date.now());
  }

  isThrottled(): boolean {
    return this.recent() >= TIKTOK_CONFIG.rateLimit.maxRequestsPerMinute;
  }
}

/* --------------------------------------------------------------------------
 * The adapter.
 * ------------------------------------------------------------------------ */
export class TikTokAdapter implements PlatformAdapter {
  readonly platform = 'tiktok' as const;

  private readonly rateLimit = new RateLimitTracker();
  private readonly token: string;
  private readonly openId: string;

  constructor(token: string, openId: string) {
    if (!token || !openId) {
      throw new Error('TikTokAdapter requires an access token and open_id');
    }
    this.token = token;
    this.openId = openId;
  }

  /* --- Contract: validateConnection() ----------------------------------- */
  async validateConnection(): Promise<TikTokConnectionStatus> {
    const res = await apiRequest('/v2/user/info/?fields=open_id,display_name', this.token);
    if (!res.ok) {
      const err = this.handleError(res.json);
      return { connected: false, error: err.message };
    }
    const data = (typeof res.json.data === 'object' && res.json.data !== null
      ? res.json.data
      : {}) as Record<string, unknown>;
    return {
      connected: true,
      openId: typeof data.open_id === 'string' ? data.open_id : this.openId,
      displayName: typeof data.display_name === 'string' ? data.display_name : undefined,
    };
  }

  /* --- Contract: validateMedia() ---------------------------------------- */
  async validateMedia(payload: TikTokPublishPayload): Promise<void> {
    // TikTok has no plain-text posts - media is always required.
    if (!payload.mediaUrl) {
      throw new TikTokAdapterError(
        'TikTok requires mediaUrl (public video/photo URL for PULL_FROM_URL)',
        10008,
        false,
      );
    }
    if (!payload.title) {
      throw new TikTokAdapterError('TikTok requires a title', 10008, false);
    }
    // The FILE_UPLOAD chunked path is a build-time TODO; PULL_FROM_URL is
    // the verified default and requires a publicly reachable media URL.
  }

  /* --- Contract: publish() ----------------------------------------------- */
  async publish(payload: TikTokPublishPayload): Promise<TikTokPublishResult> {
    this.assertApproved(payload);
    await this.validateMedia(payload);

    if (this.rateLimit.isThrottled()) {
      throw new TikTokAdapterError('TikTok API rate limit reached', 10003, true);
    }
    this.rateLimit.recordRequest();

    // Step 1: initialize the Direct Post.
    const initBody: Record<string, unknown> = {
      post_info: {
        title: payload.title,
        privacy_level: payload.privacyLevel ?? 'SELF_ONLY',
        disable_comment: payload.disableComment ?? false,
        disable_duet: payload.disableDuet ?? false,
        disable_stitch: payload.disableStitch ?? false,
        ...(payload.description ? { description: payload.description } : {}),
        ...(payload.aiLabel !== undefined ? { ai_label: payload.aiLabel } : {}),
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: payload.mediaUrl,
      },
    };
    const init = await apiRequest('/v2/post/publish/video/init/', this.token, 'POST', initBody);
    if (!init.ok) throw this.handleError(init.json);
    const data = (typeof init.json.data === 'object' && init.json.data !== null
      ? init.json.data
      : {}) as Record<string, unknown>;
    const publishId = typeof data.publish_id === 'string' ? data.publish_id : '';
    if (!publishId) {
      throw new TikTokAdapterError('TikTok returned no publish_id', 10008, false);
    }

    // Step 2: poll until PUBLISH_COMPLETE.
    await this.waitForPublish(publishId);

    return {
      platform: 'tiktok',
      postId: publishId,
      postUrl: '',
      status: 'PUBLISH_COMPLETE',
      publishedAt: new Date().toISOString(),
      auditEvent: 'TIKTOK_CONTENT_PUBLISHED',
    };
  }

  /* --- Contract: getStatus() --------------------------------------------- */
  async getStatus(postId: string): Promise<{ postId: string; status: string }> {
    const res = await apiRequest(
      `/v2/post/publish/status/fetch/?publish_id=${postId}`,
      this.token,
    );
    if (!res.ok) throw this.handleError(res.json);
    const data = (typeof res.json.data === 'object' && res.json.data !== null
      ? res.json.data
      : {}) as Record<string, unknown>;
    const status = typeof data.status === 'string' ? data.status : 'UNKNOWN';
    return { postId, status };
  }

  /* --- Contract: handleError() ------------------------------------------- */
  handleError(err: unknown): TikTokAdapterError {
    const json = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
    const error = (typeof json.error === 'object' && json.error !== null
      ? json.error
      : {}) as Record<string, unknown>;
    const code = typeof error.code === 'number' ? error.code : 0;
    const message = typeof error.message === 'string' ? error.message : 'Unknown TikTok API error';

    // Codes follow TikTok's standard error-code table (10001-10016).
    switch (code) {
      case 10002: // Unauthorized / invalid token
        return new TikTokAdapterError(`Token invalid or expired: ${message}`, code, true);
      case 10003: // Rate limit reached
        return new TikTokAdapterError(`Rate limited: ${message}`, code, true);
      case 10004: // Server error
      case 10005: // Service unavailable
      case 10006: // Internal error
        return new TikTokAdapterError(`TikTok server error (${code}): ${message}`, code, true);
      case 10007: // Invalid parameter
      case 10008: // Missing parameter
        return new TikTokAdapterError(`Invalid request: ${message}`, code, false);
      case 10009: // Duplicate request
        return new TikTokAdapterError(`Duplicate request: ${message}`, code, false);
      case 10010: // Resource not found
        return new TikTokAdapterError(`Resource not found: ${message}`, code, false);
      case 10014: // Resource forbidden (e.g. SELF_ONLY before app audit)
        return new TikTokAdapterError(
          `Forbidden (app audit may be pending): ${message}`,
          code,
          false,
        );
      default:
        return new TikTokAdapterError(message, code, code >= 500);
    }
  }

  /* --- Beyond the base contract (blueprint §4.8 "full contracts in §5") -- */
  /** TikTok Content Posting API has no native scheduling; throw clearly. */
  async schedule(): Promise<never> {
    throw new NotSupportedError(
      'scheduled publishing (TikTok has no scheduled_publish_time; use the Essential scheduler to defer the call)',
    );
  }

  /** Placeholder - engagement metrics require the separate TikTok Analytics API. */
  async getMetrics(postId: string): Promise<TikTokMetrics> {
    // Analytics API integration is a build-time TODO. Return the raw status
    // payload so the audit trail still has a snapshot.
    const res = await apiRequest(
      `/v2/post/publish/status/fetch/?publish_id=${postId}`,
      this.token,
    );
    if (!res.ok) throw this.handleError(res.json);
    return { postId, recordedAt: new Date().toISOString(), raw: res.json };
  }

  /** Normalize an incoming TikTok webhook event into a typed record. */
  async normalizeWebhook(raw: Record<string, unknown>): Promise<{ event: string; postId?: string }> {
    // TikTok Content Posting webhooks deliver { status, publish_id }.
    return {
      event: typeof raw.status === 'string' ? raw.status : 'unknown',
      postId: typeof raw.publish_id === 'string' ? raw.publish_id : undefined,
    };
  }

  /** Refresh: TikTok access tokens expire in 24h; exchange a refresh token. */
  async refreshToken(): Promise<string> {
    const refreshToken = process.env.TIKTOK_REFRESH_TOKEN;
    const clientKey = process.env.TIKTOK_CLIENT_KEY;
    const clientSecret = process.env.TIKTOK_CLIENT_SECRET;
    if (!refreshToken || !clientKey || !clientSecret) {
      throw new TikTokAdapterError(
        'TIKTOK_REFRESH_TOKEN/TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET not set; cannot refresh',
        10002,
        true,
      );
    }
    const res = await fetch(`${TIKTOK_CONFIG.apiHost}/v2/oauth/token/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw this.handleError(json);
    const token = typeof json.access_token === 'string' ? json.access_token : '';
    if (!token) throw new TikTokAdapterError('Token refresh returned no token', 10002, true);
    return token;
  }

  /* --- Private helpers ---------------------------------------------------- */
  private async waitForPublish(publishId: string): Promise<void> {
    const deadline = Date.now() + TIKTOK_CONFIG.statusPoll.timeoutMs;
    for (;;) {
      const res = await apiRequest(
        `/v2/post/publish/status/fetch/?publish_id=${publishId}`,
        this.token,
      );
      if (!res.ok) throw this.handleError(res.json);
      const data = (typeof res.json.data === 'object' && res.json.data !== null
        ? res.json.data
        : {}) as Record<string, unknown>;
      const status = typeof data.status === 'string' ? data.status : '';
      if (status === 'PUBLISH_COMPLETE') return;
      if (status === 'FAILED' || status === 'UPLOAD_FAILED') {
        throw new TikTokAdapterError(`TikTok publish failed (${status})`, 10012, false);
      }
      if (Date.now() > deadline) {
        throw new TikTokAdapterError('Timed out waiting for TikTok publish', 10004, true);
      }
      await new Promise((resolve) => setTimeout(resolve, TIKTOK_CONFIG.statusPoll.intervalMs));
    }
  }

  private assertApproved(payload: TikTokPublishPayload): void {
    if (!payload.approvedDraft || !payload.approvedFinal) {
      throw new TikTokAdapterError(
        'Publishing blocked: both DRAFT and FINAL approvals are required',
        10008,
        false,
      );
    }
    if (!payload.contentVersion) {
      throw new TikTokAdapterError('Publishing blocked: contentVersion is required for audit', 10008, false);
    }
  }
}

/* --------------------------------------------------------------------------
 * Factory - the only sanctioned way to construct the adapter.
 * ------------------------------------------------------------------------ */
export function createTikTokAdapter(): TikTokAdapter {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  const openId = process.env.TIKTOK_OPEN_ID;
  if (!token || !openId) {
    throw new Error(
      'TikTok adapter requires TIKTOK_ACCESS_TOKEN and TIKTOK_OPEN_ID in the environment',
    );
  }
  return new TikTokAdapter(token, openId);
}

export default createTikTokAdapter;
