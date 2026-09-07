/**
 * ESSENTIAL - Social Media Super Agent
 * packages/adapters/linkedin.ts
 *
 * LinkedIn adapter (Community Management API). Implements the PlatformAdapter
 * contract defined in ESSENTIAL_BLUEPRINT.md §4.8 ("Every adapter implements:
 * validateConnection(), validateMedia(), publish(payload), getStatus(),
 * handleError()") and the verified endpoints in §5.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source - everything comes from
 * the environment / a secret manager. No live calls unless LIVE_PUBLISH=true.
 */

/* --------------------------------------------------------------------------
 * Config constants - DO NOT hard-code these in business logic.
 * ------------------------------------------------------------------------ */
export const LINKEDIN_CONFIG = {
  apiHost: 'https://api.linkedin.com',
  /** Community Management API version header (verified: 202602). */
  apiVersion: process.env.LINKEDIN_API_VERSION ?? '202602',
  restliProtocol: '2.0.0',
  /** Verified video specs: MP4, 75 KB - 5 GB, 3s - 10min, 256x144 - 4096x2304. */
  video: {
    minBytes: 75 * 1024,
    maxBytes: 5 * 1024 * 1024 * 1024,
    minSeconds: 3,
    maxSeconds: 10 * 60,
  },
  /** Verified image spec: JPG/PNG/GIF, under 36,152,320 pixels. */
  imageMaxPixels: 36_152_320,
  rateLimit: {
    windowMs: 1000 * 60 * 60,
    maxCalls: 200,
  },
} as const;

/* --------------------------------------------------------------------------
 * Domain types (no `any` anywhere).
 * ------------------------------------------------------------------------ */
export type LinkedInMediaKind = 'text' | 'image' | 'video';

export interface LinkedInPublishPayload {
  /** Numeric organization id, or a full urn:li:organization:{id}. */
  organizationId: string;
  message: string;
  mediaKind: LinkedInMediaKind;
  /** Public URL of the media (image or video) to attach. */
  mediaUrl?: string;
  title?: string;
  description?: string;
  /** Content identity for the approval lock + audit trail. */
  contentVersion: string;
  approvedDraft: boolean;
  approvedFinal: boolean;
}

export interface LinkedInPublishResult {
  platform: 'linkedin';
  postId: string;
  postUrl: string;
  status: 'PUBLISHED';
  publishedAt: string;
  auditEvent: 'LINKEDIN_ORG_CONTENT_PUBLISHED';
}

export interface LinkedInConnectionStatus {
  connected: boolean;
  organizationId?: string;
  organizationName?: string;
  error?: string;
}

export interface LinkedInMetrics {
  postId: string;
  impressions?: number;
  clicks?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  recordedAt: string;
}

/** Typed errors - never throw a bare string. */
export class LinkedInAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LinkedInAdapterError';
  }
}

/** Thrown for contract methods this adapter intentionally does not support. */
export class NotSupportedError extends Error {
  constructor(what: string) {
    super(`Not supported by the LinkedIn adapter: ${what}`);
    this.name = 'NotSupportedError';
  }
}

/* --------------------------------------------------------------------------
 * PlatformAdapter contract (mirrors blueprint §4.8).
 * ------------------------------------------------------------------------ */
export interface PlatformAdapter {
  readonly platform: string;
  validateConnection(): Promise<LinkedInConnectionStatus>;
  validateMedia(payload: LinkedInPublishPayload): Promise<void>;
  publish(payload: LinkedInPublishPayload): Promise<LinkedInPublishResult>;
  getStatus(postId: string): Promise<{ postId: string; status: string }>;
  handleError(err: unknown): LinkedInAdapterError;
}

/* --------------------------------------------------------------------------
 * Minimal HTTP client (mock-mode aware). No secrets logged.
 * ------------------------------------------------------------------------ */
interface LinkedInResponse {
  ok: boolean;
  status: number;
  json: Record<string, unknown>;
  headers: Record<string, string | undefined>;
}

async function linkedinRequest(
  pathOrUrl: string,
  accessToken: string,
  method: 'GET' | 'POST' = 'GET',
  body?: Record<string, unknown>,
): Promise<LinkedInResponse> {
  const live = process.env.LIVE_PUBLISH === 'true';
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${LINKEDIN_CONFIG.apiHost}${pathOrUrl}`;

  if (!live) {
    // Dry-run: print a redacted payload, make no network call.
    // eslint-disable-next-line no-console
    console.log(`[linkedin:mock] ${method} ${url}`, JSON.stringify(body ?? {}));
    return {
      ok: true,
      status: 201,
      json: { id: 'urn:li:share:mock' },
      headers: { 'x-restli-id': 'urn:li:share:mock' },
    };
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Linkedin-Version': LINKEDIN_CONFIG.apiVersion,
      'X-Restli-Protocol-Version': LINKEDIN_CONFIG.restliProtocol,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const headers: Record<string, string | undefined> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { ok: res.ok, status: res.status, json, headers };
}

/** Raw binary PUT to a LinkedIn upload URL (images/videos). */
async function linkedinRawUpload(
  uploadUrl: string,
  accessToken: string,
  bytes: Uint8Array,
): Promise<LinkedInResponse> {
  const live = process.env.LIVE_PUBLISH === 'true';
  if (!live) {
    // eslint-disable-next-line no-console
    console.log(`[linkedin:mock] PUT ${uploadUrl} <binary redacted, ${bytes.byteLength} bytes>`);
    return { ok: true, status: 201, json: {}, headers: {} };
  }
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: new Blob([bytes.buffer as ArrayBuffer]),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const headers: Record<string, string | undefined> = {};
  res.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { ok: res.ok, status: res.status, json, headers };
}

/** Fetch media bytes from a public URL (only in live mode). */
async function fetchMediaBytes(mediaUrl: string): Promise<Uint8Array> {
  const live = process.env.LIVE_PUBLISH === 'true';
  if (!live) return new Uint8Array(0);
  const res = await fetch(mediaUrl);
  if (!res.ok) {
    throw new LinkedInAdapterError(
      `Could not fetch media from ${mediaUrl}`,
      res.status,
      res.status >= 500,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/* --------------------------------------------------------------------------
 * Rate-limit state (LinkedIn returns 429 with a Retry-After header).
 * ------------------------------------------------------------------------ */
class RateLimitTracker {
  private hits: number[] = [];

  private recent(): number {
    const now = Date.now();
    this.hits = this.hits.filter((t) => now - t < LINKEDIN_CONFIG.rateLimit.windowMs);
    return this.hits.length;
  }

  recordHit(): void {
    this.hits.push(Date.now());
  }

  isThrottled(): boolean {
    return this.recent() >= LINKEDIN_CONFIG.rateLimit.maxCalls;
  }
}

/* --------------------------------------------------------------------------
 * The adapter.
 * ------------------------------------------------------------------------ */
export class LinkedInAdapter implements PlatformAdapter {
  readonly platform = 'linkedin' as const;

  private readonly rateLimit = new RateLimitTracker();
  private readonly token: string;
  private readonly organizationId: string;

  constructor(token: string, organizationId: string) {
    if (!token || !organizationId) {
      throw new Error('LinkedInAdapter requires an access token and organization id');
    }
    this.token = token;
    this.organizationId = organizationId;
  }

  private orgUrn(): string {
    return this.organizationId.startsWith('urn:li:organization:')
      ? this.organizationId
      : `urn:li:organization:${this.organizationId}`;
  }

  /* --- Contract: validateConnection() ----------------------------------- */
  async validateConnection(): Promise<LinkedInConnectionStatus> {
    const id = this.organizationId.replace('urn:li:organization:', '');
    const res = await linkedinRequest(`/rest/organizations/${id}`, this.token);
    if (!res.ok) {
      const err = this.handleError(res.json);
      return { connected: false, error: err.message };
    }
    return {
      connected: true,
      organizationId: this.organizationId,
      organizationName:
        typeof res.json.localizedName === 'string' ? res.json.localizedName : undefined,
    };
  }

  /* --- Contract: validateMedia() ---------------------------------------- */
  async validateMedia(payload: LinkedInPublishPayload): Promise<void> {
    if (payload.mediaKind === 'text') return;
    if (!payload.mediaUrl) {
      throw new LinkedInAdapterError('Media posts require mediaUrl', 400, false);
    }
    // Deep checks (byte size, duration, pixel count) require fetching the
    // asset; flagged as build-time TODO (HEAD + range check against media host).
  }

  /* --- Contract: publish() ----------------------------------------------- */
  async publish(payload: LinkedInPublishPayload): Promise<LinkedInPublishResult> {
    this.assertApproved(payload);
    await this.validateMedia(payload);

    const post: Record<string, unknown> = {
      author: this.orgUrn(),
      commentary: payload.message,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED' },
    };

    if (payload.mediaKind === 'image') {
      const imageUrn = await this.uploadImage(payload.mediaUrl as string);
      post.content = {
        media: {
          id: imageUrn,
          title: payload.title ?? payload.message,
          description: payload.description ?? payload.message,
        },
      };
    } else if (payload.mediaKind === 'video') {
      const videoUrn = await this.uploadVideo(payload.mediaUrl as string);
      post.content = {
        media: {
          id: videoUrn,
          title: payload.title ?? payload.message,
          description: payload.description ?? payload.message,
        },
      };
    }

    this.rateLimit.recordHit();
    if (this.rateLimit.isThrottled()) {
      throw new LinkedInAdapterError('LinkedIn API rate limit reached', 429, true);
    }

    const res = await linkedinRequest('/rest/posts', this.token, 'POST', post);
    if (!res.ok) throw this.handleError(res.json);

    const postId =
      res.headers['x-restli-id'] ?? (typeof res.json.id === 'string' ? res.json.id : '');
    if (!postId) {
      throw new LinkedInAdapterError('LinkedIn returned no post id', 400, false);
    }

    return {
      platform: 'linkedin',
      postId,
      postUrl: `https://www.linkedin.com/feed/update/${postId}`,
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      auditEvent: 'LINKEDIN_ORG_CONTENT_PUBLISHED',
    };
  }

  /* --- Contract: getStatus() --------------------------------------------- */
  async getStatus(postId: string): Promise<{ postId: string; status: string }> {
    const res = await linkedinRequest(
      `/rest/posts/${encodeURIComponent(postId)}`,
      this.token,
    );
    if (!res.ok) throw this.handleError(res.json);
    return { postId, status: 'PUBLISHED' };
  }

  /* --- Contract: handleError() ------------------------------------------- */
  handleError(err: unknown): LinkedInAdapterError {
    const json = (typeof err === 'object' && err !== null ? err : {}) as Record<string, unknown>;
    const status = typeof json.status === 'number' ? json.status : 0;
    const message = typeof json.message === 'string' ? json.message : 'Unknown LinkedIn API error';

    switch (status) {
      case 429:
        return new LinkedInAdapterError(`Rate limited: ${message}`, 429, true);
      case 401:
      case 403:
        return new LinkedInAdapterError(`Authorization failed: ${message}`, status, true);
      case 400:
        return new LinkedInAdapterError(`Invalid request: ${message}`, status, false);
      default:
        return new LinkedInAdapterError(message, status, status >= 500);
    }
  }

  /* --- Beyond the base contract (blueprint §4.8 "full contracts in §5") -- */
  /** LinkedIn Posts API does not support scheduling; throw clearly. */
  async schedule(): Promise<never> {
    throw new NotSupportedError(
      'scheduled publishing (LinkedIn Posts API has no scheduled_publish_time; use the Essential scheduler to defer the call)',
    );
  }

  /** Opt-in metrics. LinkedIn organic analytics needs the Analytics API. */
  async getMetrics(postId: string): Promise<LinkedInMetrics> {
    // Build-time TODO: wire the LinkedIn Analytics API (requires additional
    // permissions). Return the shell so the audit row is always written.
    return { postId, recordedAt: new Date().toISOString() };
  }

  /** Normalize an incoming LinkedIn webhook event into a typed record. */
  async normalizeWebhook(raw: Record<string, unknown>): Promise<{ event: string; postId?: string }> {
    const data = (typeof raw.data === 'object' && raw.data !== null
      ? raw.data
      : {}) as Record<string, unknown>;
    return {
      event: typeof data.verb === 'string' ? data.verb : 'unknown',
      postId: typeof data.objectUrn === 'string' ? data.objectUrn : undefined,
    };
  }

  /** Refresh the OAuth2 access token via LinkedIn's token endpoint. */
  async refreshToken(): Promise<string> {
    const refreshToken = process.env.LINKEDIN_REFRESH_TOKEN;
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    if (!refreshToken || !clientId || !clientSecret) {
      throw new LinkedInAdapterError(
        'LINKEDIN_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET not set; cannot refresh',
        401,
        true,
      );
    }
    const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw this.handleError(json);
    const token = typeof json.access_token === 'string' ? json.access_token : '';
    if (!token) throw new LinkedInAdapterError('Token refresh returned no token', 400, false);
    return token;
  }

  /* --- Private helpers ---------------------------------------------------- */
  private async uploadImage(mediaUrl: string): Promise<string> {
    const init = await linkedinRequest(
      '/rest/images?action=initializeUpload',
      this.token,
      'POST',
      { initializeUploadRequest: { owner: this.orgUrn() } },
    );
    if (!init.ok) throw this.handleError(init.json);
    const uploadUrl = typeof init.json.uploadUrl === 'string' ? init.json.uploadUrl : '';
    const imageUrn = typeof init.json.image === 'string' ? init.json.image : '';
    if (!uploadUrl || !imageUrn) {
      throw new LinkedInAdapterError('Image upload init missing uploadUrl/image', 400, false);
    }
    const bytes = await fetchMediaBytes(mediaUrl);
    const up = await linkedinRawUpload(uploadUrl, this.token, bytes);
    if (!up.ok) throw this.handleError(up.json);
    return imageUrn;
  }

  private async uploadVideo(mediaUrl: string): Promise<string> {
    const init = await linkedinRequest(
      '/rest/videos?action=initializeUpload',
      this.token,
      'POST',
      { initializeUploadRequest: { owner: this.orgUrn() } },
    );
    if (!init.ok) throw this.handleError(init.json);
    const uploadUrl = typeof init.json.uploadUrl === 'string' ? init.json.uploadUrl : '';
    const videoUrn = typeof init.json.video === 'string' ? init.json.video : '';
    if (!uploadUrl || !videoUrn) {
      throw new LinkedInAdapterError('Video upload init missing uploadUrl/video', 400, false);
    }
    const bytes = await fetchMediaBytes(mediaUrl);
    const up = await linkedinRawUpload(uploadUrl, this.token, bytes);
    if (!up.ok) throw this.handleError(up.json);
    return videoUrn;
  }

  private assertApproved(payload: LinkedInPublishPayload): void {
    if (!payload.approvedDraft || !payload.approvedFinal) {
      throw new LinkedInAdapterError(
        'Publishing blocked: both DRAFT and FINAL approvals are required',
        400,
        false,
      );
    }
    if (!payload.contentVersion) {
      throw new LinkedInAdapterError('Publishing blocked: contentVersion is required for audit', 400, false);
    }
  }
}

/* --------------------------------------------------------------------------
 * Factory - the only sanctioned way to construct the adapter.
 * ------------------------------------------------------------------------ */
export function createLinkedInAdapter(): LinkedInAdapter {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const organizationId = process.env.LINKEDIN_ORG_URN;
  if (!token || !organizationId) {
    throw new Error(
      'LinkedIn adapter requires LINKEDIN_ACCESS_TOKEN and LINKEDIN_ORG_URN in the environment',
    );
  }
  return new LinkedInAdapter(token, organizationId);
}

export default createLinkedInAdapter;
