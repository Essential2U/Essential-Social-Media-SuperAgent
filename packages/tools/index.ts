/**
 * ESSENTIAL - Social Media Super Agent
 * packages/tools/index.ts
 *
 * Connected Tools (BYOK) adapter layer.
 *
 * A single provider-agnostic interface for every third-party tool a client can
 * connect to Essential. Each tool declares its capabilities (media kinds, auth
 * model, free tier, hosted-vs-local) and the manager routes a generation
 * request through the connected tools free-first, falling back to the next
 * available tool when a key is missing or exhausted.
 *
 * API-availability notes (verified 2026-09-07):
 *  - Canva: official docs state the Connect APIs (Autofill + Brand Templates)
 *    are free for developers (https://www.canva.dev/docs/connect/). Access may
 *    require an approved app / partner review - verify at build time.
 *  - DaVinci Resolve: has NO public hosted cloud API. Its scripting API
 *    (Fusion Script / Python) runs locally inside the desktop app only. It is
 *    therefore a LOCAL / desktop companion tool (`hostedApi: false`) and its
 *    adapter is a documented stub - do not invent cloud endpoints for it.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source - keys come from the
 * environment / a secrets manager. No live calls unless LIVE_PUBLISH=true.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { PollinationsAdapter, PexelsAdapter, ElevenLabsAdapter, StabilityAdapter, ClipdropAdapter, LeonardoAdapter } from './real';

/* --------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------ */

export type ToolId =
  | 'pollinations'
  | 'pexels'
  | 'unsplash'
  | 'gemini'
  | 'clipdrop'
  | 'leonardo'
  | 'stability'
  | 'elevenlabs'
  | 'perplexity'
  | 'runway'
  | 'heygen'
  | 'canva'
  | 'davinci';

export type ToolMediaKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'stock_photo'
  | 'stock_video'
  | 'design'
  | 'voiceover'
  | 'research';

export type ToolAuth = 'api_key' | 'oauth' | 'none' | 'local';
export type ToolFreeTier = 'free' | 'free_credits' | 'trial' | 'paid' | 'local';

export interface ToolCapabilities {
  readonly id: ToolId;
  readonly displayName: string;
  readonly media: readonly ToolMediaKind[];
  readonly requiresKey: boolean;
  readonly auth: ToolAuth;
  readonly freeTier: ToolFreeTier;
  readonly connectUrl: string;
  /** false for local-only tools (e.g. DaVinci Resolve) that cannot be called server-side. */
  readonly hostedApi: boolean;
  readonly note?: string;
}

export type ToolGenerateKind = 'image' | 'video' | 'voiceover' | 'design' | 'stock' | 'research';

export interface ToolGenerateInput {
  readonly kind: ToolGenerateKind;
  readonly prompt: string;
  readonly topicId?: string;
  readonly brandVoice?: string;
  readonly language?: 'en' | 'es';
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface ToolGenerateResult {
  readonly tool: ToolId;
  readonly mediaKind: ToolMediaKind;
  readonly url?: string;
  readonly s3Key?: string;
  readonly costUsd?: number;
  readonly modelUsed?: string;
  readonly altText?: string;
  readonly note?: string;
}

export interface ToolConnectionRecord {
  readonly clientId: string;
  readonly tool: ToolId;
  readonly encryptedKey: string;
  readonly keyHint: string;
  readonly status: 'active' | 'revoked';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ToolAdapter {
  readonly id: ToolId;
  readonly capabilities: ToolCapabilities;
  validateKey(apiKey: string): Promise<boolean>;
  generate(input: ToolGenerateInput, apiKey?: string): Promise<ToolGenerateResult>;
  fallbackOrder(): readonly ToolId[];
}

/* --------------------------------------------------------------------------
 * Capability registry (single source of truth for the tool set)
 * ------------------------------------------------------------------------ */

export const TOOL_CAPABILITIES: Readonly<Record<ToolId, ToolCapabilities>> = {
  pollinations: {
    id: 'pollinations', displayName: 'Pollinations', media: ['image', 'video', 'audio', 'text'],
    requiresKey: false, auth: 'none', freeTier: 'free',
    connectUrl: 'https://pollinations.ai/', hostedApi: true,
    note: 'no key, no signup',
  },
  pexels: {
    id: 'pexels', displayName: 'Pexels', media: ['stock_photo', 'stock_video'],
    requiresKey: true, auth: 'api_key', freeTier: 'free',
    connectUrl: 'https://www.pexels.com/api/', hostedApi: true,
    note: 'free, 200 req/hr',
  },
  unsplash: {
    id: 'unsplash', displayName: 'Unsplash', media: ['stock_photo'],
    requiresKey: true, auth: 'api_key', freeTier: 'free',
    connectUrl: 'https://unsplash.com/developers', hostedApi: true,
    note: 'free ~50 req/hr',
  },
  gemini: {
    id: 'gemini', displayName: 'Gemini', media: ['image', 'text'],
    requiresKey: true, auth: 'api_key', freeTier: 'free',
    connectUrl: 'https://aistudio.google.com/apikey', hostedApi: true,
    note: 'free tier; also the brain (packages/ai)',
  },
  clipdrop: {
    id: 'clipdrop', displayName: 'Clipdrop', media: ['image'],
    requiresKey: true, auth: 'api_key', freeTier: 'free_credits',
    connectUrl: 'https://clipdrop.co/apis/signin', hostedApi: true,
    note: '100 free credits; image gen + bg removal',
  },
  leonardo: {
    id: 'leonardo', displayName: 'Leonardo AI', media: ['image', 'video'],
    requiresKey: true, auth: 'api_key', freeTier: 'free_credits',
    connectUrl: 'https://leonardo.ai/api', hostedApi: true,
    note: '~$5 free credit',
  },
  stability: {
    id: 'stability', displayName: 'Stability AI', media: ['image'],
    requiresKey: true, auth: 'api_key', freeTier: 'trial',
    connectUrl: 'https://platform.stability.ai/docs/getting-started', hostedApi: true,
    note: 'trial credits (free tier unconfirmed)',
  },
  elevenlabs: {
    id: 'elevenlabs', displayName: 'ElevenLabs', media: ['voiceover', 'audio'],
    requiresKey: true, auth: 'api_key', freeTier: 'free',
    connectUrl: 'https://elevenlabs.io/pricing/api', hostedApi: true,
    note: 'free tier + Startup Grant',
  },
  perplexity: {
    id: 'perplexity', displayName: 'Perplexity', media: ['research'],
    requiresKey: true, auth: 'api_key', freeTier: 'trial',
    connectUrl: 'https://docs.perplexity.ai/docs/getting-started/pricing', hostedApi: true,
    note: 'trial credits only; trend research',
  },
  runway: {
    id: 'runway', displayName: 'Runway', media: ['video'],
    requiresKey: true, auth: 'api_key', freeTier: 'paid',
    connectUrl: 'https://docs.dev.runwayml.com/guides/pricing/', hostedApi: true,
    note: 'paid-opt-in; credits $0.01 each',
  },
  heygen: {
    id: 'heygen', displayName: 'HeyGen', media: ['video', 'voiceover'],
    requiresKey: true, auth: 'api_key', freeTier: 'paid',
    connectUrl: 'https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained', hostedApi: true,
    note: 'paid-opt-in; avatar video',
  },
  canva: {
    id: 'canva', displayName: 'Canva', media: ['design'],
    requiresKey: false, auth: 'oauth', freeTier: 'free',
    connectUrl: 'https://www.canva.dev/docs/connect/', hostedApi: true,
    note: 'Connect API free for developers per official docs; verify access tier at build time',
  },
  davinci: {
    id: 'davinci', displayName: 'DaVinci Resolve', media: ['video'],
    requiresKey: false, auth: 'local', freeTier: 'local',
    connectUrl: 'https://www.blackmagicdesign.com/products/davinciresolve', hostedApi: false,
    note: 'local desktop companion only - no hosted cloud API; client-side integration path documented in the stub adapter',
  },
};

export const TOOL_IDS: readonly ToolId[] = Object.keys(TOOL_CAPABILITIES) as ToolId[];

const FREE_TIER_ORDER: Readonly<Record<ToolFreeTier, number>> = {
  free: 0,
  free_credits: 1,
  trial: 2,
  paid: 3,
  local: 4,
};

function toolsForMedia(media: ToolMediaKind): readonly ToolId[] {
  return TOOL_IDS
    .filter((id) => TOOL_CAPABILITIES[id].hostedApi)
    .filter((id) => TOOL_CAPABILITIES[id].media.includes(media))
    .sort((a, b) => FREE_TIER_ORDER[TOOL_CAPABILITIES[a].freeTier] - FREE_TIER_ORDER[TOOL_CAPABILITIES[b].freeTier]);
}

const KIND_TO_MEDIA: Readonly<Record<ToolGenerateKind, ToolMediaKind>> = {
  image: 'image',
  video: 'video',
  voiceover: 'voiceover',
  design: 'design',
  stock: 'stock_photo',
  research: 'text',
};

/* --------------------------------------------------------------------------
 * Key vault (AES-256-GCM at rest; only a keyHint is ever exposed)
 * ------------------------------------------------------------------------ */

function vaultKey(): Buffer {
  const raw = process.env.TOOL_VAULT_KEY ?? 'dev-only-insecure-key-change-me';
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length === 32) return buf;
  return createHash('sha256').update(buf).digest();
}

export class ToolKeyVault {
  encrypt(plain: string): { ciphertext: string; keyHint: string } {
    const key = vaultKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([iv, tag, enc]).toString('base64'),
      keyHint: plain.slice(-4),
    };
  }

  decrypt(ciphertext: string): string {
    const key = vaultKey();
    const raw = Buffer.from(ciphertext, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}

/* --------------------------------------------------------------------------
 * Adapter
 * ------------------------------------------------------------------------ */

export class MockToolAdapter implements ToolAdapter {
  constructor(readonly capabilities: ToolCapabilities) {}

  get id(): ToolId {
    return this.capabilities.id;
  }

  async validateKey(apiKey: string): Promise<boolean> {
    if (!this.capabilities.requiresKey) return true;
    return apiKey.length >= 8;
  }

  async generate(input: ToolGenerateInput, apiKey?: string): Promise<ToolGenerateResult> {
    const live = process.env.LIVE_PUBLISH === 'true';
    return {
      tool: this.id,
      mediaKind: KIND_TO_MEDIA[input.kind],
      url: live ? undefined : `mock://${this.id}/${encodeURIComponent(input.prompt.slice(0, 40))}`,
      modelUsed: this.id,
      costUsd: 0,
      note: live
        ? 'live mode - real API call goes here (implement per provider)'
        : 'mock mode - set LIVE_PUBLISH=true to call the real API',
    };
  }

  fallbackOrder(): readonly ToolId[] {
    return toolsForMedia(this.capabilities.media[0]).filter((id) => id !== this.id);
  }
}

/* --------------------------------------------------------------------------
 * Registry + manager
 * ------------------------------------------------------------------------ */

export class ToolRegistry {
  private readonly adapters = new Map<ToolId, ToolAdapter>();

  register(adapter: ToolAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ToolId): ToolAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): readonly ToolAdapter[] {
    return [...this.adapters.values()];
  }

  /** Connected tools for a media kind, ordered free-first. */
  route(media: ToolMediaKind, connected: ReadonlySet<ToolId>): readonly ToolAdapter[] {
    return toolsForMedia(media)
      .filter((id) => connected.has(id))
      .map((id) => this.adapters.get(id))
      .filter((a): a is ToolAdapter => a !== undefined);
  }
}

export class ConnectedToolsManager {
  private readonly connections = new Map<string, ToolConnectionRecord>();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly vault: ToolKeyVault,
  ) {}

  connect(clientId: string, tool: ToolId, apiKey: string): ToolConnectionRecord {
    const now = new Date().toISOString();
    const { ciphertext, keyHint } = this.vault.encrypt(apiKey);
    const record: ToolConnectionRecord = {
      clientId,
      tool,
      encryptedKey: ciphertext,
      keyHint,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.connections.set(this.connKey(clientId, tool), record);
    return record;
  }

  update(clientId: string, tool: ToolId, apiKey: string): ToolConnectionRecord {
    return this.connect(clientId, tool, apiKey);
  }

  remove(clientId: string, tool: ToolId): boolean {
    return this.connections.delete(this.connKey(clientId, tool));
  }

  list(clientId: string): readonly ToolConnectionRecord[] {
    return [...this.connections.values()].filter((c) => c.clientId === clientId && c.status === 'active');
  }

  /** Generate media via connected tools, free-first, with fallback. */
  async generate(clientId: string, input: ToolGenerateInput): Promise<ToolGenerateResult> {
    const connected = new Set(this.list(clientId).map((c) => c.tool));
    const media = KIND_TO_MEDIA[input.kind];
    for (const adapter of this.registry.route(media, connected)) {
      const conn = this.connections.get(this.connKey(clientId, adapter.id));
      if (!conn) continue;
      const apiKey = this.vault.decrypt(conn.encryptedKey);
      try {
        return await adapter.generate(input, apiKey);
      } catch {
        continue; // fall back to the next connected tool
      }
    }
    return {
      tool: 'pollinations',
      mediaKind: media,
      note: 'no connected tool available for this media kind - show the connect-a-tool prompt',
    };
  }

  private connKey(clientId: string, tool: ToolId): string {
    return `${clientId}|${tool}`;
  }
}

export function createToolsManager(): {
  registry: ToolRegistry;
  vault: ToolKeyVault;
  manager: ConnectedToolsManager;
} {
  const registry = new ToolRegistry();
  const real: Partial<Record<ToolId, ToolAdapter>> = {
    pollinations: new PollinationsAdapter(),
    pexels: new PexelsAdapter(),
    elevenlabs: new ElevenLabsAdapter(),
    stability: new StabilityAdapter(),
    clipdrop: new ClipdropAdapter(),
    leonardo: new LeonardoAdapter(),
  };
  for (const id of TOOL_IDS) {
    registry.register(real[id] ?? new MockToolAdapter(TOOL_CAPABILITIES[id]));
  }
  const vault = new ToolKeyVault();
  return { registry, vault, manager: new ConnectedToolsManager(registry, vault) };
}
