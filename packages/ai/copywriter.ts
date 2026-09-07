/**
 * ESSENTIAL - Social Media Super Agent
 * packages/ai/copywriter.ts
 *
 * Copywriter module. Turns a strategy into platform-native copy for every
 * selected platform, plus a master narrative and a transferable podcast
 * script (>= MIN_CONTENT_MINUTES). Enforces the compliance gate: per-platform
 * character limits and a CTA requirement.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { MIN_CONTENT_MINUTES } from '../media/platform-limits';
import type { StrategyOutput } from './strategist';

export interface CopyInput {
  readonly strategy: StrategyOutput;
  readonly platforms: readonly string[];
  readonly language?: 'en' | 'es';
}

export interface PlatformPost {
  readonly platform: string;
  readonly caption: string;
  readonly hashtags: readonly string[];
  readonly cta: string;
}

export interface ComplianceReport {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly perPlatform: Readonly<Record<string, { chars: number; limit: number; ok: boolean }>>;
}

export interface CopyOutput {
  readonly masterNarrative: string;
  readonly posts: readonly PlatformPost[];
  readonly podcastScript: string;
  readonly minMinutes: number;
  readonly compliance: ComplianceReport;
  readonly language: 'en' | 'es';
}

const PLATFORM_CHAR_LIMITS: Readonly<Record<string, number>> = {
  facebook: 63206,
  linkedin: 3000,
  instagram: 2200,
  tiktok: 2200,
  youtube: 5000,
  x: 280,
};

export class Copywriter {
  constructor(private readonly live = process.env.LIVE_PUBLISH === 'true') {}

  generateCopy(input: CopyInput): CopyOutput {
    const language = input.language ?? input.strategy.language ?? 'en';
    const masterNarrative = this.buildMasterNarrative(input.strategy, language);
    const posts = input.platforms.map((platform) => this.buildPost(platform, input.strategy, language));
    const podcastScript = this.buildPodcastScript(input.strategy, language);
    const compliance = this.checkCompliance(posts);
    return {
      masterNarrative,
      posts,
      podcastScript,
      minMinutes: MIN_CONTENT_MINUTES,
      compliance,
      language,
    };
  }

  private buildMasterNarrative(strategy: StrategyOutput, language: 'en' | 'es'): string {
    const prefix = language === 'es' ? 'Narrativa maestra' : 'Master narrative';
    return `${prefix}: ${strategy.angle}. Key points: ${strategy.keyPoints.join('; ')}.`;
  }

  private buildPost(platform: string, strategy: StrategyOutput, language: 'en' | 'es'): PlatformPost {
    const cta = language === 'es' ? 'Comparte y comenta' : 'Share and comment below';
    const point = strategy.keyPoints[0] ?? '';
    return {
      platform,
      caption: `${strategy.angle} ${point} (${language === 'es' ? 'publicacion' : 'post'} for ${platform})`,
      hashtags: [`#${strategy.topic.replace(/\s+/g, '')}`],
      cta,
    };
  }

  private buildPodcastScript(strategy: StrategyOutput, language: 'en' | 'es'): string {
    if (strategy.podcastScript) return strategy.podcastScript;
    const sections: string[] = [];
    sections.push(
      `INTRO (${language === 'es' ? 'aprox. 1 minuto' : 'about 1 minute'}): Welcome to this deep dive on ${strategy.topic}.`,
      `SECTION 1 (${language === 'es' ? 'aprox. 4 minutos' : 'about 4 minutes'}): The landscape.`,
      `SECTION 2 (${language === 'es' ? 'aprox. 5 minutos' : 'about 5 minutes'}): The three pillars.`,
      `SECTION 3 (${language === 'es' ? 'aprox. 4 minutos' : 'about 4 minutes'}): Practical takeaways.`,
      `OUTRO (${language === 'es' ? 'aprox. 1 minuto' : 'about 1 minute'}): Recap and call to action.`,
    );
    return sections.join('\n\n');
  }

  private checkCompliance(posts: readonly PlatformPost[]): ComplianceReport {
    const issues: string[] = [];
    const perPlatform: Record<string, { chars: number; limit: number; ok: boolean }> = {};
    for (const post of posts) {
      const limit = PLATFORM_CHAR_LIMITS[post.platform] ?? 280;
      const chars = post.caption.length;
      const ok = chars <= limit && post.cta.length > 0;
      perPlatform[post.platform] = { chars, limit, ok };
      if (chars > limit) issues.push(`${post.platform}: ${chars} chars exceeds ${limit}`);
      if (!post.cta) issues.push(`${post.platform}: missing CTA`);
    }
    return { ok: issues.length === 0, issues, perPlatform };
  }
}

export function createCopywriter(): Copywriter {
  return new Copywriter();
}
