/**
 * ESSENTIAL - Social Media Super Agent
 * packages/ai/gemini.ts
 *
 * Gemini routing client ("the brain").
 *
 * Two routing surfaces live here:
 *  1. Content routing - selects the best platform adapter(s) for a given
 *     content type. The support map is DERIVED from the PLATFORM_REGISTRY in
 *     packages/adapters (each entry's mediaKinds), so it stays in sync with
 *     the adapters automatically; a ranking table then picks the best fit.
 *  2. Model routing - picks the right Gemini model per task (strategy, copy,
 *     visual QA, bulk pre-check) and provides a thin structured-output client
 *     (responseSchema) with mock mode.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source - API keys come from the
 * environment. No live calls unless LIVE_PUBLISH=true.
 */

import {
  PLATFORM_REGISTRY,
  PLATFORM_IDS,
  createAdapterFor,
  type PlatformId,
  type AnyAdapter,
} from '../adapters';

/* --------------------------------------------------------------------------
 * Content types.
 * The union is exactly the set of mediaKinds the adapters declare in the
 * registry: facebook/linkedin (text,image,video), instagram
 * (image,reels,carousel), tiktok (video,photo), youtube (video,shorts).
 * ------------------------------------------------------------------------ */
export type ContentType = 'text' | 'image' | 'video' | 'carousel' | 'reels' | 'shorts' | 'photo';

export const CONTENT_TYPES: readonly ContentType[] = [
  'text',
  'image',
  'video',
  'carousel',
  'reels',
  'shorts',
  'photo',
];

/* --------------------------------------------------------------------------
 * Content-type -> supported platforms, DERIVED from the registry.
 * ------------------------------------------------------------------------ */
const CONTENT_SUPPORT: Record<ContentType, readonly PlatformId[]> = (() => {
  const map = {} as Record<ContentType, PlatformId[]>;
  for (const ct of CONTENT_TYPES) map[ct] = [];
  for (const id of PLATFORM_IDS) {
    const entry = PLATFORM_REGISTRY[id];
    for (const kind of entry.mediaKinds) {
      const ct = kind as ContentType;
      if (map[ct]) map[ct].push(id);
    }
  }
  return map;
})();

/* --------------------------------------------------------------------------
 * Ranking - editorial "best fit" per content type, grounded in the verified
 * adapter capabilities (native scheduling, container types, audit gates).
 * ------------------------------------------------------------------------ */
interface RankedCandidate {
  platform: PlatformId;
  reason: string;
}

const CONTENT_RANKING: Record<ContentType, readonly RankedCandidate[]> = {
  text: [
    { platform: 'facebook', reason: 'native scheduling + broadest organic reach' },
    { platform: 'linkedin', reason: 'professional / company-page audience' },
  ],
  image: [
    { platform: 'instagram', reason: 'visual-first platform, carousel-ready' },
    { platform: 'facebook', reason: 'native image posts + scheduling' },
    { platform: 'linkedin', reason: 'company-page image posts' },
  ],
  video: [
    { platform: 'youtube', reason: 'long-form home, searchable, quota-managed' },
    { platform: 'tiktok', reason: 'short-form vertical reach (SELF_ONLY until app audit)' },
    { platform: 'facebook', reason: 'native video + scheduling' },
    { platform: 'linkedin', reason: 'company-page video (MP4, 3s-10min)' },
  ],
  reels: [
    { platform: 'instagram', reason: 'only native REELS container type' },
  ],
  carousel: [
    { platform: 'instagram', reason: 'only platform with CAROUSEL container (max 10)' },
  ],
  shorts: [
    { platform: 'youtube', reason: 'only native Shorts upload path' },
  ],
  photo: [
    { platform: 'tiktok', reason: 'only platform with PHOTO post type' },
  ],
};

/* --------------------------------------------------------------------------
 * Content routing - the public surface.
 * ------------------------------------------------------------------------ */
export interface ContentRoutingDecision {
  contentType: ContentType;
  /** Best-fit adapter platform, or null when nothing supports this type. */
  primary: { platform: PlatformId; displayName: string; reason: string } | null;
  /** Runner-up platforms in ranked order. */
  alternatives: Array<{ platform: PlatformId; displayName: string; reason: string }>;
  /** True when no registered platform supports this content type. */
  unsupported: boolean;
  /** Every platform that declares this type in the registry. */
  supportedPlatforms: readonly PlatformId[];
}

/** Select the best adapter platform for a content type. */
export function routeContent(contentType: ContentType): ContentRoutingDecision {
  const ranked = CONTENT_RANKING[contentType] ?? [];
  const supported = CONTENT_SUPPORT[contentType] ?? [];

  // Keep ranking entries the registry actually supports, then append any
  // registry-supported platforms missing from the ranking (keeps the result
  // authoritative against the adapters even when the ranking is stale).
  const rankedSupported = ranked.filter((c) => supported.includes(c.platform));
  const extra = supported
    .filter((p) => !ranked.some((c) => c.platform === p))
    .map((p) => ({ platform: p, reason: 'supported per registry mediaKinds' }));

  const ordered = [...rankedSupported, ...extra];
  const withNames = ordered.map((c) => ({
    platform: c.platform,
    displayName: PLATFORM_REGISTRY[c.platform].displayName,
    reason: c.reason,
  }));

  return {
    contentType,
    primary: withNames[0] ?? null,
    alternatives: withNames.slice(1),
    unsupported: withNames.length === 0,
    supportedPlatforms: supported,
  };
}

/** Convenience: the best adapter platform id, or null when unsupported. */
export function selectBestAdapter(contentType: ContentType): PlatformId | null {
  return routeContent(contentType).primary?.platform ?? null;
}

/** Every platform that declares a content type (from the registry). */
export function supportedPlatformsFor(contentType: ContentType): readonly PlatformId[] {
  return CONTENT_SUPPORT[contentType] ?? [];
}

/**
 * Build an adapter instance for a platform. Requires that platform's env
 * credentials to be configured (the adapter factory throws otherwise).
 */
export function adapterForPlatform(platform: PlatformId): AnyAdapter {
  return createAdapterFor(platform);
}

/**
 * Build adapter instances for every platform that supports a content type.
 * Requires all those platforms' env credentials to be configured.
 */
export function adaptersForContent(
  contentType: ContentType,
): Array<{ platform: PlatformId; adapter: AnyAdapter }> {
  return supportedPlatformsFor(contentType).map((p) => ({
    platform: p,
    adapter: createAdapterFor(p),
  }));
}

/* --------------------------------------------------------------------------
 * Gemini model routing.
 * ------------------------------------------------------------------------ */
export type GeminiTask = 'strategy' | 'copy' | 'visual_qa' | 'bulk_precheck';

export const GEMINI_MODELS = {
  /** Co-strategist + fallback for the Claude strategist. */
  strategy: process.env.GEMINI_STRATEGY_MODEL ?? 'gemini-2.5-pro',
  /** Copywriter + multimodal visual QA. */
  copy: process.env.GEMINI_COPY_MODEL ?? 'gemini-2.5-flash',
  /** High-volume, low-cost bulk pre-checks (hashtags, alt-text, metadata). */
  lite: process.env.GEMINI_LITE_MODEL ?? 'gemini-2.5-flash-lite',
} as const;

/** Reasoning budget for the strategy model (kept separate from the model-name
 * map so model lookups stay string-typed). */
export const GEMINI_THINKING_BUDGET = Number(process.env.GEMINI_THINKING_BUDGET ?? 4096);

const TASK_MODEL: Record<GeminiTask, keyof typeof GEMINI_MODELS> = {
  strategy: 'strategy',
  copy: 'copy',
  visual_qa: 'copy',
  bulk_precheck: 'lite',
};

/** Pick the Gemini model for a task (env-overridable, never hard-coded). */
export function selectGeminiModel(task: GeminiTask): string {
  return GEMINI_MODELS[TASK_MODEL[task]];
}

/* --------------------------------------------------------------------------
 * Gemini structured-output client (mock-mode aware, no secrets logged).
 * ------------------------------------------------------------------------ */
export interface GeminiStructuredRequest<T> {
  task: GeminiTask;
  prompt: string;
  /** JSON schema enforced via responseSchema (guaranteed structured output). */
  schema: Record<string, unknown>;
}

export class GeminiClient {
  private readonly apiKey: string;
  private readonly live: boolean;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('GeminiClient requires an API key');
    this.apiKey = apiKey;
    this.live = process.env.LIVE_PUBLISH === 'true';
  }

  /** Generate a structured (schema-enforced) response from the chosen model. */
  async generateStructured<T>(req: GeminiStructuredRequest<T>): Promise<T> {
    const model = selectGeminiModel(req.task);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;

    if (!this.live) {
      // Dry-run: log a truncated prompt, make no network call.
      // eslint-disable-next-line no-console
      console.log(`[gemini:mock] ${model}`, req.prompt.slice(0, 120));
      return {} as T;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: req.schema,
          thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
        },
      }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      throw new Error(`Gemini API error: ${JSON.stringify(body)}`);
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini returned no content');
    return JSON.parse(text) as T;
  }
}

/** Factory - the only sanctioned way to construct the client. */
export function createGeminiClient(): GeminiClient {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GeminiClient requires GEMINI_API_KEY in the environment');
  }
  return new GeminiClient(key);
}

export default createGeminiClient;
