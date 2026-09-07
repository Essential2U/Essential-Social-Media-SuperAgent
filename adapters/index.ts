/**
 * ESSENTIAL - Social Media Super Agent
 * packages/adapters/index.ts
 *
 * Barrel export + platform registry.
 *
 * Re-exports every adapter module and provides a single typed registry that
 * maps each platform id to its config, factory, adapter class, and
 * capabilities. The registry is the one place the worker/API layers import
 * from - never import a concrete adapter directly outside this package.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source - everything comes from
 * the environment / a secret manager. No live calls unless LIVE_PUBLISH=true.
 */

/* Local bindings for the registry below - re-exports alone do not create
 * names usable in this module. */
import type { PlatformAdapter } from './facebook';
import { FACEBOOK_CONFIG, createFacebookAdapter } from './facebook';
import { LINKEDIN_CONFIG, createLinkedInAdapter } from './linkedin';
import { INSTAGRAM_CONFIG, createInstagramAdapter } from './instagram';
import { TIKTOK_CONFIG, createTikTokAdapter } from './tiktok';
import { YOUTUBE_CONFIG, createYouTubeAdapter } from './youtube';

/* --------------------------------------------------------------------------
 * Shared contract types.
 * NOTE: every adapter file declares its own PlatformAdapter interface and
 * NotSupportedError class (same shape). We re-export the canonical copies
 * from facebook.ts once, and skip them in the per-platform re-exports to
 * avoid ambiguous re-export errors.
 * ------------------------------------------------------------------------ */
export type { PlatformAdapter } from './facebook';
export { NotSupportedError } from './facebook';

/* --------------------------------------------------------------------------
 * Facebook
 * ------------------------------------------------------------------------ */
export {
  FACEBOOK_CONFIG,
  FacebookAdapter,
  FacebookAdapterError,
  createFacebookAdapter,
} from './facebook';
export type {
  FacebookMediaKind,
  FacebookPublishPayload,
  FacebookPublishResult,
  FacebookConnectionStatus,
 FacebookMetrics,
} from './facebook';

/* --------------------------------------------------------------------------
 * LinkedIn

 * ------------------------------------------------------------------------ */
export {
  LINKEDIN_CONFIG,
  LinkedInAdapter,
  LinkedInAdapterError,
  createLinkedInAdapter,
} from './linkedin';
export type {
  LinkedInMediaKind,
  LinkedInPublishPayload,
  LinkedInPublishResult,
  LinkedInConnectionStatus,
  LinkedInMetrics,
} from './linkedin';

/* --------------------------------------------------------------------------
 * Instagram
 * ------------------------------------------------------------------------ */
export {
  INSTAGRAM_CONFIG,
  InstagramAdapter,
  InstagramAdapterError,
  createInstagramAdapter,
} from './instagram';
export type {
  InstagramMediaKind,
  InstagramPublishPayload,
  InstagramPublishResult,
  InstagramConnectionStatus,
  InstagramMetrics,
} from './instagram';

/* --------------------------------------------------------------------------
 * TikTok
 * ------------------------------------------------------------------------ */
export {
  TIKTOK_CONFIG,
  TikTokAdapter,
  TikTokAdapterError,
  createTikTokAdapter,
} from './tiktok';
export type {
  TikTokMediaKind,
  TikTokPublishPayload,
  TikTokPublishResult,
  TikTokConnectionStatus,
  TikTokMetrics,
} from './tiktok';

/* --------------------------------------------------------------------------
 * YouTube
 * ------------------------------------------------------------------------ */
export {
  YOUTUBE_CONFIG,
  YouTubeAdapter,
  YouTubeAdapterError,
  createYouTubeAdapter,
} from './youtube';
export type {
  YouTubeMediaKind,
  YouTubePublishPayload,
  YouTubePublishResult,
  YouTubeConnectionStatus,
  YouTubeMetrics,
} from './youtube';

/* --------------------------------------------------------------------------
 * Platform registry.
 * ------------------------------------------------------------------------ */

/** Union of the concrete config objects each adapter exports. */
type PlatformConfig =
  | typeof FACEBOOK_CONFIG
  | typeof LINKEDIN_CONFIG
  | typeof INSTAGRAM_CONFIG

  | typeof TIKTOK_CONFIG
  | typeof YOUTUBE_CONFIG;

export interface PlatformRegistryEntry {
  id: PlatformId;
  displayName: string;
  config: PlatformConfig;
  /** Factory - the sanctioned way to construct an adapter instance. */
  createAdapter: () => PlatformAdapter;
  mediaKinds: readonly string[];
  supportsScheduling: boolean;
  supportsTextOnly: boolean;
  supportsCarousel: boolean;
  rateLimitNote: string;
}

/**
 * The registry. `as const` keeps each entry's precise types so
 * `getPlatformEntry('facebook').config` is typed as FACEBOOK_CONFIG, etc.
 */
export const PLATFORM_REGISTRY = {
  facebook: {
    id: 'facebook',
    displayName: 'Facebook',
    config: FACEBOOK_CONFIG,
    createAdapter: createFacebookAdapter,
    mediaKinds: ['text', 'image', 'video'],
    supportsScheduling: true,
    supportsTextOnly: true,
    supportsCarousel: false,
    rateLimitNote: '200 calls per hour (Graph API)',
  },
  linkedin: {
    id: 'linkedin',
    displayName: 'LinkedIn',
    config: LINKEDIN_CONFIG,
    createAdapter: createLinkedInAdapter,
    mediaKinds: ['text', 'image', 'video'],
    supportsScheduling: false,
    supportsTextOnly: true,
    supportsCarousel: false,
    rateLimitNote: '200 calls per hour; HTTP 429 with Retry-After',
  },
  instagram: {
    id: 'instagram',
    displayName: 'Instagram',
    config: INSTAGRAM_CONFIG,
    createAdapter: createInstagramAdapter,
    mediaKinds: ['image', 'reels', 'carousel'],
    supportsScheduling: false,
    supportsTextOnly: false,
    supportsCarousel: true,
    rateLimitNote: '100 API-published posts / 24h; 50 carousels / 24h',
  },
  tiktok: {
    id: 'tiktok',
    displayName: 'TikTok',
    config: TIKTOK_CONFIG,
    createAdapter: createTikTokAdapter,
    mediaKinds: ['video', 'photo'],
    supportsScheduling: false,
    supportsTextOnly: false,
    supportsCarousel: false,
    rateLimitNote: '~6 requests / minute / access token; SELF_ONLY until app audit passes',
  },
  youtube: {
    id: 'youtube',
    displayName: 'YouTube',
    config: YOUTUBE_CONFIG,
    createAdapter: createYouTubeAdapter,
    mediaKinds: ['video', 'shorts'],
    supportsScheduling: false,
    supportsTextOnly: false,
    supportsCarousel: false,
    rateLimitNote: '10,000 quota units / day; ~1,600 units per videos.insert',
  },
} as const;

export type PlatformId = keyof typeof PLATFORM_REGISTRY;

export const PLATFORM_IDS = Object.keys(PLATFORM_REGISTRY) as readonly PlatformId[];

/** Look up a registry entry with full type narrowing. */
export function getPlatformEntry<K extends PlatformId>(id: K): (typeof PLATFORM_REGISTRY)[K] {
  const entry = PLATFORM_REGISTRY[id];
  if (!entry) throw new Error(`Unknown platform: ${String(id)}`);
  return entry;
}

/** Union of every concrete adapter class the registry can produce. */
export type AnyAdapter = ReturnType<(typeof PLATFORM_REGISTRY)[PlatformId]['createAdapter']>;

/** Construct an adapter instance for a platform (reads env vars). */
export function createAdapterFor(id: PlatformId): AnyAdapter {
  return getPlatformEntry(id).createAdapter();
}

/** Get the config object for a platform. */
export function getAdapterConfig<K extends PlatformId>(id: K): (typeof PLATFORM_REGISTRY)[K]['config'] {
  return getPlatformEntry(id).config;
}

/** Type guard - is this string a supported platform id? */
export function isSupportedPlatform(id: string): id is PlatformId {
  return id in PLATFORM_REGISTRY;
}

/** Human-friendly listing for logs, docs, and the audit trail. */
export function listPlatforms(): ReadonlyArray<{ id: PlatformId; displayName: string }> {
  return PLATFORM_IDS.map((id) => ({ id, displayName: PLATFORM_REGISTRY[id].displayName }));
}
