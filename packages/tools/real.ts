/**
 * ESSENTIAL - Social Media Super Agent
 * packages/tools/real.ts
 *
 * Real HTTP tool adapters (backlog: finish tool adapters).
 *
 * Every adapter calls the provider's public HTTP API with fetch. All live
 * calls are gated behind LIVE_PUBLISH=true; in the default mock-first path
 * the adapter returns a mock:// URL exactly like the MockToolAdapter, so the
 * pipeline and tests are unchanged. Free/no-key tools (Pollinations) work
 * with no key; keyed tools read the key from the vault (BYOK) or the
 * environment when a vault key is absent.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import {
  TOOL_CAPABILITIES,
  type ToolAdapter,
  type ToolCapabilities,
  type ToolGenerateInput,
  type ToolGenerateResult,
  type ToolId,
  type ToolMediaKind,
} from './index';

const LIVE = (): boolean => process.env.LIVE_PUBLISH === 'true';

/** Base class: capabilities + key validation + mock fallback. */
abstract class RealToolAdapter implements ToolAdapter {
  constructor(readonly capabilities: ToolCapabilities) {}
  get id(): ToolId {
    return this.capabilities.id;
  }
  async validateKey(apiKey: string): Promise<boolean> {
    if (!this.capabilities.requiresKey) return true;
    return apiKey.length >= 8;
  }
  fallbackOrder(): readonly ToolId[] {
    return [];
  }
  abstract generate(input: ToolGenerateInput, apiKey?: string): Promise<ToolGenerateResult>;
  protected mock(input: ToolGenerateInput, mediaKind: ToolMediaKind): ToolGenerateResult {
    return {
      tool: this.id,
      mediaKind,
      url: `mock://${this.id}/${encodeURIComponent(input.prompt.slice(0, 40))}`,
      modelUsed: this.id,
      costUsd: 0,
      note: 'mock mode - set LIVE_PUBLISH=true to call the real API',
    };
  }
}

/** Pollinations - free, no key. Image generation. */
export class PollinationsAdapter extends RealToolAdapter {
  constructor() {
    super(TOOL_CAPABILITIES.pollinations);
  }
  async generate(input: ToolGenerateInput): Promise<ToolGenerateResult> {
    if (!LIVE()) return this.mock(input, 'image');
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(input.prompt)}`;
    return { tool: this.id, mediaKind: 'image', url, modelUsed: 'pollinations', costUsd: 0 };
  }
}

/** Pexels - free tier, API key. Stock photo search. */
export class PexelsAdapter extends RealToolAdapter {
  constructor() {
    super(TOOL_CAPABILITIES.pexels);
  }
  async generate(input: ToolGenerateInput, apiKey?: string): Promise<ToolGenerateResult> {
    if (!LIVE()) return this.mock(input, 'stock_photo');
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(input.prompt)}&per_page=1`,
      { headers: { Authorization: apiKey ?? '' } },
    );
    if (!res.ok) throw new Error(`pexels ${res.status}`);
    const body = (await res.json()) as { photos?: { src?: { large?: string } }[] };
    const url = body.photos?.[0]?.src?.large;
    if (!url) throw new Error('pexels returned no photo');
    return { tool: this.id, mediaKind: 'stock_photo', url, modelUsed: 'pexels', costUsd: 0 };
  }
}

/** ElevenLabs - BYOK text-to-speech voiceover. */
export class ElevenLabsAdapter extends RealToolAdapter {
  constructor() {
    super(TOOL_CAPABILITIES.elevenlabs);
  }
  async generate(input: ToolGenerateInput, apiKey?: string): Promise<ToolGenerateResult> {
    if (!LIVE()) return this.mock(input, 'voiceover');
    const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4IMlvpyjHzUl', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input.prompt, model_id: 'eleven_multilingual_v2' }),
    });
    if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
    const buf = await res.arrayBuffer();
    return {
      tool: this.id,
      mediaKind: 'voiceover',
      url: `data:audio/mpeg;base64,${Buffer.from(buf).toString('base64')}`,
      modelUsed: 'eleven_multilingual_v2',
      costUsd: 0.05,
    };
  }
}

/** Stability - BYOK image generation. */
export class StabilityAdapter extends RealToolAdapter {
  constructor() {
    super(TOOL_CAPABILITIES.stability);
  }
  async generate(input: ToolGenerateInput, apiKey?: string): Promise<ToolGenerateResult> {
    if (!LIVE()) return this.mock(input, 'image');
    const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'image/*' },
      body: new URLSearchParams({ prompt: input.prompt, output_format: 'png' }),
    });
    if (!res.ok) throw new Error(`stability ${res.status}`);
    const buf = await res.arrayBuffer();
    return {
      tool: this.id,
      mediaKind: 'image',
      url: `data:image/png;base64,${Buffer.from(buf).toString('base64')}`,
      modelUsed: 'stable-image-core',
      costUsd: 0.04,
    };
  }
}

/** Clipdrop - BYOK text-to-image. */
export class ClipdropAdapter extends RealToolAdapter {
  constructor() {
    super(TOOL_CAPABILITIES.clipdrop);
  }
  async generate(input: ToolGenerateInput, apiKey?: string): Promise<ToolGenerateResult> {
    if (!LIVE()) return this.mock(input, 'image');
    const form = new FormData();
    form.append('prompt', input.prompt);
    const res = await fetch('https://clipdrop-api.co/text-to-image/v1', {
      method: 'POST',
      headers: { 'x-api-key': apiKey ?? '' },
      body: form,
    });
    if (!res.ok) throw new Error(`clipdrop ${res.status}`);
    const buf = await res.arrayBuffer();
    return {
      tool: this.id,
      mediaKind: 'image',
      url: `data:image/png;base64,${Buffer.from(buf).toString('base64')}`,
      modelUsed: 'clipdrop-text-to-image',
      costUsd: 0.04,
    };
  }
}

/** Leonardo - BYOK image generation (async job; poll the generations endpoint). */
export class LeonardoAdapter extends RealToolAdapter {
  constructor() {
    super(TOOL_CAPABILITIES.leonardo);
  }
  async generate(input: ToolGenerateInput, apiKey?: string): Promise<ToolGenerateResult> {
    if (!LIVE()) return this.mock(input, 'image');
    const res = await fetch('https://cloud.leonardo.ai/api/rest/v1/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: input.prompt,
        modelId: '6bef9f1b-29cb-40c7-b9df-32b51c1f67d3',
        num_images: 1,
      }),
    });
    if (!res.ok) throw new Error(`leonardo ${res.status}`);
    const body = (await res.json()) as { sdGenerationJob?: { generationId?: string } };
    return {
      tool: this.id,
      mediaKind: 'image',
      url: `https://cloud.leonardo.ai/api/rest/v1/generations/${body.sdGenerationJob?.generationId ?? ''}`,
      modelUsed: 'leonardo',
      costUsd: 0.04,
      note: 'async job - poll the generations endpoint for the finished image',
    };
  }
}
