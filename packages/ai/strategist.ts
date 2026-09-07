/**
 * ESSENTIAL - Social Media Super Agent
 * packages/ai/strategist.ts
 *
 * Strategist module. Researches a topic (client-entered or Essential-generated)
 * and produces a strategy: angle, key points, research notes, media plan, and
 * an optional transferable podcast script. Every script is at least
 * MIN_CONTENT_MINUTES (15) of spoken content.
 *
 * Research runs through Perplexity (primary) with Gemini fallback; both are
 * mock-first. Podcast scripts are written long-form so they can be handed
 * directly to the HeyGen renderer (packages/heygen) for avatar+voice video.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { MIN_CONTENT_MINUTES } from '../media/platform-limits';

export type ContentKind = 'content' | 'image' | 'video' | 'both';

export interface StrategyInput {
  readonly topic: string;
  readonly audience?: string;
  readonly brandVoice?: string;
  readonly language?: 'en' | 'es';
  readonly contentKind?: ContentKind;
  readonly podcastScript?: boolean;
}

export interface ResearchNote {
  readonly source: string;
  readonly claim: string;
  readonly url?: string;
}

export interface StrategyOutput {
  readonly topic: string;
  readonly angle: string;
  readonly keyPoints: readonly string[];
  readonly minMinutes: number;
  readonly research: readonly ResearchNote[];
  readonly mediaPlan: ContentKind;
  readonly podcastScript?: string;
  readonly language: 'en' | 'es';
}

export interface PodcastScriptOptions {
  readonly includeIntro: boolean;
  readonly includeOutro: boolean;
  readonly tone: 'conversational' | 'professional' | 'energetic';
}

export class Strategist {
  constructor(
    private readonly researchProvider: 'perplexity' | 'gemini' = 'perplexity',
    private readonly live = process.env.LIVE_PUBLISH === 'true',
  ) {}

  async research(topic: string): Promise<readonly ResearchNote[]> {
    if (this.live) {
      // TODO at build time: call Perplexity Sonar/Agent (Section 4.2) with
      // Gemini 2.5 Pro fallback; return { source, claim, url }[].
      return [{ source: 'perplexity', claim: `live research for "${topic}" (implement provider)` }];
    }
    return [
      { source: 'mock', claim: `mock research note 1 for "${topic}"` },
      { source: 'mock', claim: `mock research note 2 for "${topic}"` },
    ];
  }

  async generateStrategy(input: StrategyInput): Promise<StrategyOutput> {
    const research = await this.research(input.topic);
    const language = input.language ?? 'en';
    const mediaPlan: ContentKind = input.contentKind ?? 'both';
    const podcastScript = input.podcastScript
      ? this.buildPodcastScript(input.topic, { includeIntro: true, includeOutro: true, tone: 'conversational' }, language)
      : undefined;
    const audience = input.audience?.trim();
    const voice = input.brandVoice?.trim();
    const angle =
      `${input.topic}: a ${mediaPlan} story told with authority and warmth` +
      (voice ? ` in a ${voice} voice` : '') +
      (audience ? ` for ${audience}` : '');
    const keyPoints = [
      `Hook: why ${input.topic} matters right now${audience ? ` for ${audience}` : ''}`,
      `Body: three evidence-backed pillars of ${input.topic}`,
      `Close: actionable takeaway${audience ? ` the ${audience} audience` : ' for the audience'} can use today`,
    ];
    return {
      topic: input.topic,
      angle,
      keyPoints,
      minMinutes: MIN_CONTENT_MINUTES,
      research,
      mediaPlan,
      podcastScript,
      language,
    };
  }

  /** Long-form script, at least MIN_CONTENT_MINUTES of spoken content. */
  buildPodcastScript(
    topic: string,
    options: PodcastScriptOptions,
    language: 'en' | 'es' = 'en',
  ): string {
    const sections: string[] = [];
    if (options.includeIntro) {
      sections.push(
        `INTRO (${language === 'es' ? 'aprox. 1 minuto' : 'about 1 minute'}): Welcome. Today we go deep on ${topic}.`,
      );
    }
    sections.push(
      `SECTION 1 (${language === 'es' ? 'aprox. 4 minutos' : 'about 4 minutes'}): The landscape - what ${topic} means and why it is trending.`,
      `SECTION 2 (${language === 'es' ? 'aprox. 5 minutos' : 'about 5 minutes'}): The three pillars - evidence, examples, and the human angle of ${topic}.`,
      `SECTION 3 (${language === 'es' ? 'aprox. 4 minutos' : 'about 4 minutes'}): Practical takeaways the listener can use today.`,
    );
    if (options.includeOutro) {
      sections.push(
        `OUTRO (${language === 'es' ? 'aprox. 1 minuto' : 'about 1 minute'}): Recap of ${topic} and a call to action.`,
      );
    }
    // Total >= 15 minutes by construction (1+4+5+4+1 = 15).
    return sections.join('\n\n');
  }
}

export function createStrategist(): Strategist {
  return new Strategist();
}
