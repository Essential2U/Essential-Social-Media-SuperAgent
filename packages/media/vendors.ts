/**
 * ESSENTIAL - Social Media Super Agent
 * packages/media/vendors.ts
 *
 * Talking-head avatar video vendors. Each vendor exposes the same surface:
 * render-create -> poll -> completed video URL. Verified caps (2026-09-07):
 *   - HeyGen: POST /v3/videos, single scene max 30 min [developers.heygen.com/docs/usage-limits]
 *   - Synthesia: up to 150 scenes x 5 min each, total up to 4 hr [docs.synthesia.io/docs/video-creation]
 *   - D-ID: max 5 min per video [d-id.com/faqs]
 *   - Argil: API exists (docs.argil.ai) but max length UNCONFIRMED -> TODO
 *
 * Because a 3-15 min talking-head video can exceed a vendor's single-clip cap
 * (D-ID = 5 min), packages/media segments the script and stitches the renders.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

export type AvatarVendorId = 'heygen' | 'synthesia' | 'did' | 'argil';

export interface AvatarVendor {
  readonly id: AvatarVendorId;
  readonly displayName: string;
  readonly maxClipMinutes: number;   // per single render
  readonly supportsSegments: boolean; // can the vendor render one long clip
  readonly createEndpoint: string;
  readonly pollEndpoint: (videoId: string) => string;
  readonly freeTier: string;
  readonly connectUrl: string;
  readonly note: string;
}

export const AVATAR_VENDORS: Readonly<Record<AvatarVendorId, AvatarVendor>> = {
  heygen: {
    id: 'heygen', displayName: 'HeyGen', maxClipMinutes: 30, supportsSegments: true,
    createEndpoint: 'POST https://api.heygen.com/v3/videos',
    pollEndpoint: (id) => `GET https://api.heygen.com/v3/videos/${id}`,
    freeTier: 'paid (trial credits)', connectUrl: 'https://www.heygen.com/enterprise-api',
    note: 'avatar_id + voice_id; single scene up to 30 min - a 15-min script is one render',
  },
  synthesia: {
    id: 'synthesia', displayName: 'Synthesia', maxClipMinutes: 5, supportsSegments: true,
    createEndpoint: 'POST https://api.synthesia.io/v2/videos',
    pollEndpoint: (id) => `GET https://api.synthesia.io/v2/videos/${id}`,
    freeTier: 'free plan (10 min/mo, 9 stock avatars)', connectUrl: 'https://docs.synthesia.io/reference/synthesia-api-quickstart',
    note: '150 scenes x 5 min each, up to 4 hr total',
  },
  did: {
    id: 'did', displayName: 'D-ID', maxClipMinutes: 5, supportsSegments: false,
    createEndpoint: 'POST https://api.d-id.com/talks',
    pollEndpoint: (id) => `GET https://api.d-id.com/talks/${id}`,
    freeTier: 'trial credits', connectUrl: 'https://docs.d-id.com/docs/quickstart',
    note: 'max 5 min per video - a 15-min script MUST be split into >=3 segments and stitched',
  },
  argil: {
    id: 'argil', displayName: 'Argil', maxClipMinutes: 5, supportsSegments: false,
    createEndpoint: 'POST https://api.argil.ai/v1/videos (TODO confirm exact endpoint)',
    pollEndpoint: (id) => `GET https://api.argil.ai/v1/videos/${id}`,
    freeTier: 'trial', connectUrl: 'https://docs.argil.ai/pages/get-started/introduction',
    note: 'API exists; max length UNCONFIRMED - assume 5 min, verify at build time',
  },
};

export const AVATAR_VENDOR_IDS: readonly AvatarVendorId[] = Object.keys(AVATAR_VENDORS) as AvatarVendorId[];

export function getAvatarVendor(id: AvatarVendorId): AvatarVendor {
  return AVATAR_VENDORS[id];
}
