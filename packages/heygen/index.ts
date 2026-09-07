/**
 * ESSENTIAL - Social Media Super Agent
 * packages/heygen/index.ts
 *
 * HeyGen avatar+voice video renderer.
 *
 * The client stores their HeyGen Avatar ID and Voice ID (saved by Essential).
 * Essential takes the selected content (topic copy or a transferable podcast
 * script) and renders an avatar video for YouTube and the other platforms.
 *
 * Verified API (official docs, 2026-09-07):
 *   - Create: POST /v3/videos  body { type: 'avatar', avatar_id, voice_id,
 *     script, title?, resolution?, aspect_ratio? }  -> { data: { video_id } }
 *   - Poll:   GET  /v3/videos/{video_id} -> status: pending | processing |
 *     completed | failed; completed returns video_url, thumbnail_url, duration.
 *   - A type:"avatar" render is one scene, max 30 minutes - our 15-minute
 *     scripts fit comfortably.
 *   - Alternative avatar providers (same interface): Synthesia (free plan, 10
 *     min/mo, 9 stock avatars, REST API), D-ID (talking-head from image+audio),
 *     Argil (custom AI influencer avatars). See AVATAR_PROVIDERS.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

export type AvatarProviderId = 'heygen' | 'synthesia' | 'did' | 'argil';

export interface AvatarProvider {
  readonly id: AvatarProviderId;
  readonly displayName: string;
  readonly requiresKey: boolean;
  readonly freeTier: string;
  readonly connectUrl: string;
  readonly note: string;
}

export const AVATAR_PROVIDERS: Readonly<Record<AvatarProviderId, AvatarProvider>> = {
  heygen: {
    id: 'heygen', displayName: 'HeyGen', requiresKey: true, freeTier: 'paid (trial credits)',
    connectUrl: 'https://www.heygen.com/enterprise-api',
    note: 'avatar_id + voice_id; POST /v3/videos; poll GET /v3/videos/{id}',
  },
  synthesia: {
    id: 'synthesia', displayName: 'Synthesia', requiresKey: true, freeTier: 'free plan (10 min/mo, 9 stock avatars)',
    connectUrl: 'https://docs.synthesia.io/reference/synthesia-api-quickstart',
    note: 'REST API; avatars + voices; free plan available',
  },
  did: {
    id: 'did', displayName: 'D-ID', requiresKey: true, freeTier: 'trial credits',
    connectUrl: 'https://docs.d-id.com/docs/quickstart',
    note: 'talking-head video from an image + audio via API',
  },
  argil: {
    id: 'argil', displayName: 'Argil', requiresKey: true, freeTier: 'trial',
    connectUrl: 'https://www.argil.ai/',
    note: 'custom AI influencer-style avatars',
  },
};

export interface HeyGenCredentials {
  readonly apiKey: string;
  readonly avatarId: string;
  readonly voiceId: string;
}

export interface RenderRequest {
  readonly script: string;
  readonly credentials: HeyGenCredentials;
  readonly title?: string;
  readonly resolution?: '720p' | '1080p' | '4k';
  readonly aspectRatio?: '16:9' | '9:16' | '1:1' | '4:5';
}

export type RenderStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface RenderResult {
  readonly videoId: string;
  readonly status: RenderStatus;
  readonly videoUrl?: string;
  readonly thumbnailUrl?: string;
  readonly durationSeconds?: number;
  readonly failureMessage?: string;
}

export class HeyGenClient {
  constructor(
    private readonly baseUrl = 'https://api.heygen.com',
    private readonly live = process.env.LIVE_PUBLISH === 'true',
  ) {}

  async renderVideo(req: RenderRequest): Promise<RenderResult> {
    if (!this.live) {
      return {
        videoId: `mock_${Date.now()}`,
        status: 'completed',
        videoUrl: `mock://heygen/${encodeURIComponent(req.title ?? 'video')}.mp4`,
        thumbnailUrl: `mock://heygen/thumb_${Date.now()}.jpg`,
        durationSeconds: Math.round(req.script.length / 4),
        failureMessage: undefined,
      };
    }
    // TODO at build time: real calls.
    // 1) POST {base}/v3/videos with { type:'avatar', avatar_id, voice_id,
    //    script, title, resolution, aspect_ratio } -> { data: { video_id } }
    // 2) Poll GET {base}/v3/videos/{video_id} until status completed|failed.
    return {
      videoId: 'pending_live_impl',
      status: 'pending',
      failureMessage: 'live HeyGen call not yet implemented (mock mode)',
    };
  }
}

export interface AvatarIdStore {
  get(clientId: string): HeyGenCredentials | undefined;
  save(clientId: string, credentials: HeyGenCredentials): void;
}

/** In-memory credential store; persist via Prisma (Client.heyGenAvatarId etc.) in prod. */
export class InMemoryAvatarIdStore implements AvatarIdStore {
  private readonly map = new Map<string, HeyGenCredentials>();

  get(clientId: string): HeyGenCredentials | undefined {
    return this.map.get(clientId);
  }

  save(clientId: string, credentials: HeyGenCredentials): void {
    this.map.set(clientId, credentials);
  }
}

export function createHeyGenClient(): HeyGenClient {
  return new HeyGenClient();
}
