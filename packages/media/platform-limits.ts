/**
 * ESSENTIAL - Social Media Super Agent
 * packages/media/platform-limits.ts
 *
 * Verified per-platform maximum video lengths (2026) and the client-facing
 * video-length dropdown. Every cap below was checked against official docs:
 *   - Facebook feed: up to ~240 min (4 hours) [facebook.com/business/help/817989058548892]
 *   - Instagram: Reels up to 3 min (official help center); feed posts up to 10 min
 *   - TikTok: 10 min recorded in-app, up to 60 min uploaded [support.tiktok.com]
 *   - X: 140 sec (2:20) on free accounts; up to 4 hours for Premium [help.x.com]
 *   - YouTube: up to 12 hours / 256 GB for verified accounts (15 min unverified)
 *   - LinkedIn: up to 10 min mobile / 15 min desktop native posts [linkedin.com/help]
 *
 * The content floor is MIN_CONTENT_MINUTES = 15: every script Essential
 * generates (topic content or podcast script) is at least 15 minutes of
 * spoken content.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

export interface PlatformVideoLimit {
  readonly platform: string;
  readonly displayName: string;
  readonly maxMinutes: number;
  readonly note: string;
}

export const PLATFORM_VIDEO_LIMITS: Readonly<Record<string, PlatformVideoLimit>> = {
  facebook: {
    platform: 'facebook',
    displayName: 'Facebook',
    maxMinutes: 240,
    note: 'feed posts up to ~240 min; Reels 90s-3 min',
  },
  instagram: {
    platform: 'instagram',
    displayName: 'Instagram',
    maxMinutes: 10,
    note: 'Reels up to 3 min; feed posts up to 10 min',
  },
  tiktok: {
    platform: 'tiktok',
    displayName: 'TikTok',
    maxMinutes: 60,
    note: '10 min recorded in-app; up to 60 min uploaded',
  },
  x: {
    platform: 'x',
    displayName: 'X (Twitter)',
    maxMinutes: 2.33,
    note: '140 sec (2:20) free accounts; up to 4 hours Premium',
  },
  youtube: {
    platform: 'youtube',
    displayName: 'YouTube',
    maxMinutes: 720,
    note: 'up to 12 hours / 256 GB verified accounts',
  },
  linkedin: {
    platform: 'linkedin',
    displayName: 'LinkedIn',
    maxMinutes: 15,
    note: '10 min mobile / 15 min desktop native posts',
  },
};

/** Client-facing dropdown options, in minutes. Begins at 3 minutes (client requirement). */
export const VIDEO_LENGTH_OPTIONS_MINUTES: readonly number[] = [
  3, 5, 7, 10, 15, 30, 60,
];

/** Minimum selectable video length in the dropdown (client requirement). */
export const MIN_VIDEO_LENGTH_MINUTES = 3;

/** Minimum spoken-content length Essential generates per topic (client requirement). */
export const MIN_CONTENT_MINUTES = 15;

export function videoLengthDropdown(platform: string): readonly number[] {
  const limit = PLATFORM_VIDEO_LIMITS[platform];
  if (!limit) return VIDEO_LENGTH_OPTIONS_MINUTES;
  return VIDEO_LENGTH_OPTIONS_MINUTES.filter((m) => m <= limit.maxMinutes);
}

export interface VideoLengthCheck {
  readonly ok: boolean;
  readonly message: string;
  readonly maxMinutes: number;
}

export function validateVideoLength(platform: string, minutes: number): VideoLengthCheck {
  if (minutes < MIN_VIDEO_LENGTH_MINUTES) {
    return {
      ok: false,
      message: `minimum selectable video length is ${MIN_VIDEO_LENGTH_MINUTES} minutes (selected ${minutes})`,
      maxMinutes: minutes,
    };
  }
  const limit = PLATFORM_VIDEO_LIMITS[platform];
  if (!limit) {
    return { ok: true, message: `no limit recorded for ${platform}`, maxMinutes: minutes };
  }
  if (minutes > limit.maxMinutes) {
    return {
      ok: false,
      message: `${limit.displayName} maximum is ${limit.maxMinutes} minutes (selected ${minutes}). ${limit.note}`,
      maxMinutes: limit.maxMinutes,
    };
  }
  return { ok: true, message: 'ok', maxMinutes: limit.maxMinutes };
}

export function listPlatformLimits(): readonly PlatformVideoLimit[] {
  return Object.values(PLATFORM_VIDEO_LIMITS);
}
