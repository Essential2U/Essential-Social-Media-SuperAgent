/**
 * ESSENTIAL - Social Media Super Agent
 * packages/adapters/youtube.ts
 *
 * YouTube adapter (YouTube Data API v3 - resumable videos.insert).
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
export const YOUTUBE_CONFIG = {
  apiHost: 'https://www.googleapis.com',
  uploadHost: 'https://www.googleapis.com/upload/youtube/v3',
  apiVersion: 'v3',
  /** Verified: default 10,000 quota units/day; videos.insert ~= 1,600 units. */
  quota: {
    dailyUnits: 10000,
    insertCostUnits: 1600,
  },
  /** Resumable upload protocol uses 256 KB multiples for chunking. */
  chunkSizeBytes: 256 * 1024,
} as const;

/* --------------------------------------------------------------------------
 * Domain types (no `any` anywhere).
 * ------------------------------------------------------------------------ */
export type YouTubeMediaKind = 'video' | 'shorts';

export interface YouTubePublishPayload {
  /** Video title (required, max 100 chars). */
  title: string;
  /** Video description (max 5000 chars). */
  description?: string;
  mediaKind: YouTubeMediaKind;
  /** Public URL of the video file bytes (MP4). */
  mediaUrl?: string;
  /** Verified: valid values are private, unlisted, public. */
  privacyStatus?: 'private' | 'unlisted' | 'public';
  /** Searchable tags (max 500 chars total). */
  tags?: readonly string[];
  /** YouTube category id (e.g. 22 = People & Blogs). */
  categoryId?: string;
  /** Made-for-kids designation (COPPA compliance). */
  madeForKids?: boolean;
  /** Content identity for the approval lock + audit trail. */
  contentVersion: string;
  approvedDraft: boolean;
  approvedFinal: boolean;
}

export interface YouTubePublishResult {
  platform: 'youtube';
  postId: string;
  postUrl: string;
  status: 'PUBLISHED';
  publishedAt: string;
  auditEvent: 'YOUTUBE_CONTENT_PUBLISHED';
}

export interface YouTubeConnectionStatus {
  connected: boolean;
  channelId?: string;
  channelTitle?: string;
  error?: string;
}

export interface YouTubeMetrics {
  postId: string;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  recordedAt: string;
}

/** Typed errors - never throw a bare string. */
export class YouTubeAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'YouTubeAdapterError';
  }
}

/** Thrown for contract methods this adapter intentionally does not support. */
export class NotSupportedError extends Error {
  constructor(what: string) {
    super(`Not supported by the YouTube adapter: ${what}`);
    this.name = 'NotSupportedError';
  }
}

/* --------------------------------------------------------------------------
 * PlatformAdapter contract (mirrors blueprint §4.8).
 * ------------------------------------------------------------------------ */
export interface PlatformAdapter {
  readonly platform: string;
  validateConnection(): Promise<YouTubeConnectionStatus>;
  validateMedia(payload: YouTubePublishPayload): Promise<void>;
  publish(payload: YouTubePublishPayload): Promise<YouTubePublishResult>;
  getStatus(postId: string): Promise<{ postId: string; status: string }>;
  handleError(err: unknown): YouTubeAdapterError;
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
  const url = `${YOUTUBE_CONFIG.apiHost}/youtube/${YOUTUBE_CONFIG.apiVersion}${path}`;

  if (!live) {
    // Dry-run: print a redacted payload, make no network call.
    const redacted = { ...(body ?? {}), access_token: '<redacted>' };
    // eslint-disable-next-line no-console
    console.log(`[youtube:mock] ${method} ${url}`, JSON.stringify(redacted));
    return { ok: true, status: 200, json: { id: 'mock_video_id' } };
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
 * Quota state (verified: 10,000 units/day; videos.insert ~= 1,600 units).
 * ------------------------------------------------------------------------ */
class QuotaTracker {
  private usedToday = 0;
  private dayKey = '';

  private rollover(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.usedToday = 0;
    }
  }

  record(cost: number): void {
    this.rollover();
    this.usedToday += cost;
  }

  remaining(): number {
    this.rollover();
    return YOUTUBE_CONFIG.quota.dailyUnits - this.usedToday;
  }

  canAfford(cost: number): boolean {
    return this.remaining() >= cost;
  }
}

/* --------------------------------------------------------------------------
 * The adapter.
 * ------------------------------------------------------------------------ */
export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = 'youtube' as const;

  private readonly quota = new QuotaTracker();
  private readonly token: string;

  constructor(token: string) {
    if (!token) {
      throw new Error('YouTubeAdapter requires an access token');
    }
    this.token = token;
  }

  /* --- Contract: validateConnection() ----------------------------------- */
  async validateConnection(): Promise<YouTubeConnectionStatus> {
    const res = await apiRequest('/channels?part=snippet&mine=true', this.token);
    if (!res.ok) {
      const err = this.handleError(res.json);
      return { connected: false, error: err.message };
    }
    const items = Array.isArray(res.json.items) ? res.json.items : [];
    const first = (items[0] as Record<string, unknown> | undefined) ?? {};
    const snippet = (typeof first.snippet === 'object' && first.snippet !== null
      ? first.snippet
      : {}) as Record<string, unknown>;
    return {
      connected: items.length > 0,
      channelId: typeof first.id === 'string' ? first.id : undefined,
      channelTitle: typeof snippet.title === 'string' ? snippet.title : undefined,
    };
  }

  /* --- Contract: validateMedia() ---------------------------------------- */
  async validateMedia(payload: YouTubePublishPayload): Promise<void> {
    if (!payload.mediaUrl) {
      throw new YouTubeAdapterError('YouTube requires mediaUrl (public MP4)', 400, false);
    }
    if (!payload.title) {
      throw new YouTubeAdapterError('YouTube requires a title', 400, false);
    }
    // Deep content-type / duration checks are a build-time TODO.
  }

  /* --- Contract: publish() ----------------------------------------------- */
  async publish(payload: YouTubePublishPayload): Promise<YouTubePublishResult> {
    this.assertApproved(payload);
    await this.validateMedia(payload);

    if (!this.quota.canAfford(YOUTUBE_CONFIG.quota.insertCostUnits)) {
      throw new YouTubeAdapterError('YouTube daily quota exhausted', 403, true);
    }
    this.quota.record(YOUTUBE_CONFIG.quota.insertCostUnits);

    // Step 1: initiate the resumable session (metadata only).
    const metadata: Record<string, unknown> = {
      snippet: {
        title: payload.title,
        ...(payload.description ? { description: payload.description } : {}),
        ...(payload.tags?.length ? { tags: [...payload.tags] } : {}),
        ...(payload.categoryId ? { categoryId: payload.categoryId } : {}),
      },
      status: {
        privacyStatus: payload.privacyStatus ?? 'private',
        ...(payload.madeForKids !== undefined ? { madeForKids: payload.madeForKids } : {}),
      },
    };
    const uploadUrl = await this.initiateUpload(metadata);

    // Step 2: upload the video bytes to the resumable session.
    const videoId = await this.uploadBytes(uploadUrl, payload.mediaUrl as string);

    return {
      platform: 'youtube',
      postId: videoId,
      postUrl: `https://www.youtube.com/watch?v=${videoId}`,
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      auditEvent: 'YOUTUBE_CONTENT_PUBLISHED',
    };
  }

  /* --- Contract: getStatus() --------------------------------------------- */
  async getStatus(postId: string): Promise<{ postId: string; status: string }> {
    const res = await apiRequest(`/videos?part=status&id=${postId}`, this.token);
    if (!res.ok) throw this.handleError(res.json);
    const items = Array.isArray(res.json.items) ? res.json.items : [];
    const first = (items[0] as Record<string, unknown> | undefined) ?? {};
    const status = (typeof first.status === 'object' && first.status !== null
      ? first.status
      : {}) as Record<string, unknown>;
    return {
      postId,
      status: typeof status.uploadStatus === 'string' ? status.uploadStatus : 'UNKNOWN',
    };
  }

  /* --- Contract: handleError() ------------------------------------------- */
  handleError(err: unknown): YouTubeAdapterError {
    const json = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
    const error = (typeof json.error === 'object' && json.error !== null
      ? json.error
      : {}) as Record<string, unknown>;
    const code = typeof error.code === 'number' ? error.code : 0;
    const message = typeof error.message === 'string' ? error.message : 'Unknown YouTube API error';
    const reasons = Array.isArray(error.errors)
      ? (error.errors as Array<{ reason?: string }>)
          .map((e) => e.reason ?? '')
          .filter((r) => r.length > 0)
      : [];

    switch (code) {
      case 400:
        return new YouTubeAdapterError(`Invalid request: ${message}`, code, false);
      case 401:
        return new YouTubeAdapterError(`Token invalid or expired: ${message}`, code, true);
      case 403:
        // quotaExceeded / dailyLimitExceeded are retryable only after the
        // quota window resets - surface the reason, do not auto-retry.
        return new YouTubeAdapterError(
          `Forbidden (${reasons.join(',') || 'permission'}): ${message}`,
          code,
          false,
        );
      case 404:
        return new YouTubeAdapterError(`Not found: ${message}`, code, false);
      case 500:
      case 503:
        return new YouTubeAdapterError(`YouTube server error (${code}): ${message}`, code, true);
      default:
        return new YouTubeAdapterError(message, code, code >= 500);
    }
  }

  /* --- Beyond the base contract (blueprint §4.8 "full contracts in §5") -- */
  /** YouTube Data API has no native scheduled publish; throw clearly. */
  async schedule(): Promise<never> {
    throw new NotSupportedError(
      'scheduled publishing (YouTube has no scheduled_publish_time on videos.insert; use the Essential scheduler to defer the call)',
    );
  }

  /** Opt-in metrics via the videos.statistics part. */
  async getMetrics(postId: string): Promise<YouTubeMetrics> {
    const res = await apiRequest(`/videos?part=statistics&id=${postId}`, this.token);
    if (!res.ok) throw this.handleError(res.json);
    const items = Array.isArray(res.json.items) ? res.json.items : [];
    const first = (items[0] as Record<string, unknown> | undefined) ?? {};
    const stats = (typeof first.statistics === 'object' && first.statistics !== null
      ? first.statistics
      : {}) as Record<string, unknown>;
    return {
      postId,
      viewCount: typeof stats.viewCount === 'string' ? Number(stats.viewCount) : undefined,
      likeCount: typeof stats.likeCount === 'string' ? Number(stats.likeCount) : undefined,
      commentCount: typeof stats.commentCount === 'string' ? Number(stats.commentCount) : undefined,
      recordedAt: new Date().toISOString(),
    };
  }

  /** Normalize an incoming webhook event into a typed record. */
  async normalizeWebhook(raw: Record<string, unknown>): Promise<{ event: string; postId?: string }> {
    // YouTube PubSubHubbub delivers Atom XML, not JSON. XML parsing is a
    // build-time TODO; this handles the JSON envelope for internal callers.
    return {
      event: typeof raw.event === 'string' ? raw.event : 'unknown',
      postId: typeof raw.video_id === 'string' ? raw.video_id : undefined,
    };
  }

  /** Refresh: OAuth2 refresh_token exchange. */
  async refreshToken(): Promise<string> {
    const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!refreshToken || !clientId || !clientSecret) {
      throw new YouTubeAdapterError(
        'YOUTUBE_REFRESH_TOKEN/YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET not set; cannot refresh',
        401,
        true,
      );
    }
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw this.handleError(json);
    const token = typeof json.access_token === 'string' ? json.access_token : '';
    if (!token) throw new YouTubeAdapterError('Token refresh returned no token', 401, true);
    return token;
  }

  /* --- Private helpers ---------------------------------------------------- */
  private async initiateUpload(metadata: Record<string, unknown>): Promise<string> {
    const live = process.env.LIVE_PUBLISH === 'true';
    const url = `${YOUTUBE_CONFIG.uploadHost}/videos?uploadType=resumable&part=snippet,status`;

    if (!live) {
      // eslint-disable-next-line no-console
      console.log(`[youtube:mock] POST ${url}`, JSON.stringify(metadata));
      return 'https://mock-upload-url.invalid';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': 'video/*',
      },
      body: JSON.stringify(metadata),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw this.handleError(json);
    }
    const location = res.headers.get('location');
    if (!location) {
      throw new YouTubeAdapterError('YouTube returned no resumable upload URL', 400, false);
    }
    return location;
  }

  private async uploadBytes(uploadUrl: string, mediaUrl: string): Promise<string> {
    const live = process.env.LIVE_PUBLISH === 'true';
    if (!live) return 'mock_video_id';

    // Fetch the source bytes and PUT them to the resumable session.
    // Chunked (multi-part) resumable upload is a build-time TODO; this is a
    // single-shot upload of the full media body.
    const media = await fetch(mediaUrl);
    if (!media.ok) {
      throw new YouTubeAdapterError('Could not fetch mediaUrl for upload', 400, false);
    }
    const bytes = await media.arrayBuffer();

    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'video/*',
        'content-length': String(bytes.byteLength),
      },
      body: bytes,
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw this.handleError(json);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const videoId = typeof json.id === 'string' ? json.id : '';
    if (!videoId) {
      throw new YouTubeAdapterError('YouTube returned no video id', 400, false);
    }
    return videoId;
  }

  private assertApproved(payload: YouTubePublishPayload): void {
    if (!payload.approvedDraft || !payload.approvedFinal) {
      throw new YouTubeAdapterError(
        'Publishing blocked: both DRAFT and FINAL approvals are required',
        400,
        false,
      );
    }
    if (!payload.contentVersion) {
      throw new YouTubeAdapterError('Publishing blocked: contentVersion is required for audit', 400, false);
    }
  }
}

/* --------------------------------------------------------------------------
 * Factory - the only sanctioned way to construct the adapter.
 * ------------------------------------------------------------------------ */
export function createYouTubeAdapter(): YouTubeAdapter {
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  if (!token) {
    throw new Error('YouTube adapter requires YOUTUBE_ACCESS_TOKEN in the environment');
  }
  return new YouTubeAdapter(token);
}

export default createYouTubeAdapter;
