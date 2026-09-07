/**
 * ESSENTIAL - Social Media Super Agent
 * packages/neo/index.ts
 *
 * Neo - the embedded AI assistant for Essential clients.
 *
 * Neo answers questions about Essential's functions and capabilities and
 * searches topics, grounded in a capability registry (RAG-lite: keyword
 * retrieval over the capability corpus + the live platform registry). It
 * reuses the existing Gemini client for generation (mock-mode aware) and
 * ships with session memory and a sliding-window rate limiter.
 *
 * Routes (registered by the API):
 *   GET  /api/neo/capabilities   - full capability manifest
 *   POST /api/neo/chat           - grounded Q&A  { question, sessionId? }
 *   POST /api/neo/search         - topic/capability search { query }
 *   GET  /api/neo/chat?q=...     - SSE streaming chat
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import type { FastifyPluginAsync } from 'fastify';
import { PLATFORM_REGISTRY, type PlatformId } from '../adapters';
import { RateLimitError } from '../core/errors';
import { createGeminiClient, type GeminiClient } from '../ai/gemini';

export interface NeoDoc {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

export interface NeoChatResult {
  readonly answer: string;
  readonly sources: readonly string[];
  readonly sessionId: string;
}

export interface NeoSearchResult {
  readonly query: string;
  readonly results: readonly { id: string; title: string; body: string }[];
}

/** Sliding-window rate limiter (mirrors the auth limiter, self-contained). */
class NeoRateLimiter {
  private readonly hits: number[] = [];
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(): boolean {
    const now = Date.now();
    while (this.hits.length && now - this.hits[0] > this.windowMs) this.hits.shift();
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

function stem(t: string): string {
  if (t.length <= 4) return t;
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.endsWith('es')) return t.slice(0, -2);
  if (t.endsWith('ing')) return t.slice(0, -3);
  if (t.endsWith('ed')) return t.slice(0, -2);
  if (t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .map(stem)
    .filter(Boolean);
}

function buildCorpus(): NeoDoc[] {
  const docs: NeoDoc[] = [
    { id: 'overview', title: 'What is Essential', tags: ['essential', 'superagent', 'overview', 'social', 'media'],
      body: 'Essential is an all-inclusive social media SuperAgent for small businesses. It turns a topic into researched strategy, platform-native copy, and talking-head avatar video, then previews, approves, and auto-publishes to Facebook, Instagram, LinkedIn, TikTok, and YouTube.' },
    { id: 'pipeline', title: 'Content pipeline', tags: ['pipeline', 'topic', 'render', 'preview', 'approve', 'publish', 'workflow'],
      body: 'The pipeline is topic-select -> research/strategy -> copy -> render -> preview -> two-stage approval -> publish. Each stage is a BullMQ job (research, copy, media, publish) processed by workers and persisted to Postgres.' },
    { id: 'platforms', title: 'Supported platforms', tags: ['platform', 'facebook', 'instagram', 'linkedin', 'tiktok', 'youtube'],
      body: 'Essential publishes natively to Facebook, Instagram, LinkedIn, TikTok, and YouTube. Verified per-platform limits: Instagram Reels max 3 minutes and feed posts 10 minutes, TikTok up to 60 minutes, LinkedIn 10-15 minutes, YouTube up to 12 hours, Facebook up to 4 hours.' },
    { id: 'video', title: 'Talking-head avatar video', tags: ['video', 'avatar', 'heygen', 'synthesia', 'did', 'argil', 'vendor'],
      body: 'Clients pick an avatar vendor: HeyGen, Synthesia, D-ID, or Argil. Scripts longer than a vendor clip limit are segmented and stitched. Video length is selectable from 3 to 15 minutes.' },
    { id: 'media', title: 'Media types', tags: ['media', 'image', 'video', 'both', 'generate'],
      body: 'Essential can generate video, image, or both for a topic. Media is rendered, stored, previewed, and approved before publishing.' },
    { id: 'approvals', title: 'Two-stage approvals', tags: ['approval', 'preview', 'gate', 'compliance'],
      body: 'Publishing is gated by a two-stage approval: first the preview is approved, then final per-platform approval. Publishing is blocked (403) until both stages pass.' },
    { id: 'tools', title: 'Connected Tools (BYOK)', tags: ['tools', 'byok', 'pollinations', 'pexels', 'unsplash', 'gemini', 'clipdrop', 'leonardo', 'stability', 'elevenlabs', 'perplexity', 'runway', 'heygen', 'canva', 'davinci'],
      body: 'Clients bring their own keys (BYOK) for 13 connected tools: Pollinations, Pexels, Unsplash, Gemini, ClipDrop, Leonardo, Stability, ElevenLabs, Perplexity, Runway, HeyGen, Canva, and DaVinci Resolve. The manager routes free-first and falls back when a key is missing.' },
    { id: 'auth', title: 'Accounts and security', tags: ['auth', 'login', 'password', 'jwt', 'session', 'security'],
      body: 'Client accounts use M10 auth: scrypt + pepper password hashing, JWT sessions with expiry and revocation, and a sliding-window login rate limiter (5 attempts per 60 seconds).' },
    { id: 'copy', title: 'Copywriting and compliance', tags: ['copy', 'copywriter', 'compliance', 'hashtags', 'platform-native'],
      body: 'The copywriter module writes platform-native copy with per-platform length limits and compliance checks, plus optional podcast scripts.' },
    { id: 'strategy', title: 'Strategy and research', tags: ['strategy', 'research', 'trend', 'audience', 'brand'],
      body: 'The strategist researches the topic, finds the angle, and produces a strategy with key points and a media plan. Minimum content is 15 minutes.' },
    { id: 'length', title: 'Video length options', tags: ['length', 'minutes', 'dropdown', '3', '5', '7', '10', '15'],
      body: 'Video length dropdown starts at 3 minutes and offers 3, 5, 7, 10, 15, 30, and 60 minutes, validated per platform (Instagram caps at 10 minutes).' },
    { id: 'neo', title: 'Neo assistant', tags: ['neo', 'assistant', 'chat', 'help', 'ai'],
      body: "Neo is the embedded AI assistant. Clients ask questions about Essential functions and capabilities and search topics, and Neo answers grounded in Essential's capability registry." },
  ];
  for (const id of Object.keys(PLATFORM_REGISTRY) as PlatformId[]) {
    const p = PLATFORM_REGISTRY[id];
    docs.push({
      id: `platform-${id}`,
      title: `${p.displayName} publishing`,
      tags: [id, p.displayName.toLowerCase(), ...p.mediaKinds.map((k) => k.toLowerCase())],
      body: `Essential publishes to ${p.displayName} with native support for ${p.mediaKinds.join(', ')}. (From the platform registry.)`,
    });
  }
  return docs;
}

const VEC_DIM = 256;

function hashToken(t: string): number {
  // FNV-1a -> fixed-dimension feature-hash index.
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % VEC_DIM;
}

function docVector(doc: NeoDoc): Float64Array {
  const v = new Float64Array(VEC_DIM);
  const toks = [...tokenize(doc.title), ...tokenize(doc.body), ...doc.tags.map((t) => t.toLowerCase())];
  for (const t of toks) v[hashToken(t)] += 1;
  return v;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < VEC_DIM; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function retrieve(docs: NeoDoc[], query: string, limit: number): NeoDoc[] {
  const q = tokenize(query);
  if (q.length === 0) return [];
  const qv = new Float64Array(VEC_DIM);
  for (const t of q) qv[hashToken(t)] += 1;
  const scored = docs
    .map((d) => {
      // D4: vector-space retrieval - feature-hashed TF vectors + cosine similarity,
      // plus a small lexical boost for exact tag/title hits to keep precision on
      // short queries. Replaces the old keyword+stem scoring.
      const sim = cosine(docVector(d), qv);
      let boost = 0;
      for (const t of q) {
        if (d.tags.some((tag) => tag.toLowerCase() === t)) boost += 0.1;
        if (tokenize(d.title).includes(t)) boost += 0.05;
      }
      return { doc: d, score: sim + boost };
    })
    .filter((s) => s.score > 0.001)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.doc);
}

export interface NeoEngineOptions {
  readonly maxAsksPerMinute?: number;
  readonly gemini?: GeminiClient;
}

export class NeoEngine {
  private readonly corpus: NeoDoc[];
  private readonly sessions = new Map<string, string[]>();
  private readonly sessionLast = new Map<string, number>();
  private static readonly SESSION_TTL_MS = 30 * 60 * 1000;
  private readonly limiter: NeoRateLimiter;
  private readonly gemini?: GeminiClient;

  constructor(opts: NeoEngineOptions = {}) {
    this.corpus = buildCorpus();
    this.limiter = new NeoRateLimiter(opts.maxAsksPerMinute ?? 10, 60_000);
    this.gemini = opts.gemini;
  }

  capabilities(): NeoDoc[] {
    return this.corpus;
  }

  search(query: string, limit = 5): NeoSearchResult {
    const results = retrieve(this.corpus, query, limit).map((d) => ({
      id: d.id,
      title: d.title,
      body: d.body,
    }));
    return { query, results };
  }

  async chat(
    question: string,
    sessionId?: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<NeoChatResult> {
    if (!this.limiter.allow()) throw new RateLimitError('Neo rate limit exceeded');
    const sid = sessionId ?? `neo_${Math.random().toString(36).slice(2, 10)}`;
    const history = this.sessions.get(sid) ?? [];
    // S2 fix: evict stale sessions (30 min TTL) on each access.
    const now = Date.now();
    for (const [k, last] of this.sessionLast) {
      if (now - last > NeoEngine.SESSION_TTL_MS) {
        this.sessions.delete(k);
        this.sessionLast.delete(k);
      }
    }
    this.sessionLast.set(sid, now);
    const contextQuery = [question, ...history.slice(-2)].join(' ');
    const hits = retrieve(this.corpus, contextQuery, 5);
    const sources = hits.map((h) => `${h.title} (${h.id})`);

    if (opts.signal?.aborted) throw new Error('cancelled');

    let answer: string;
    if (this.gemini && process.env.LIVE_PUBLISH === 'true') {
      const grounded = await this.gemini.generateStructured<{ answer: string }>({
        task: 'strategy',
        prompt: `Answer the client's question about Essential using ONLY these facts:\n${hits
          .map((h) => `- ${h.title}: ${h.body}`)
          .join('\n')}\n\nQuestion: ${question}`,
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      });
      answer = grounded.answer;
    } else if (hits.length > 0) {
      answer = `Here's what I found about that in Essential:\n${hits
        .map((h) => `- ${h.title}: ${h.body}`)
        .join('\n')}`;
    } else {
      answer =
        "I don't have a specific answer on that yet. Try asking about platforms, video, approvals, tools, or the content pipeline.";
    }

    this.sessions.set(sid, [...history, question].slice(-8));
    return { answer, sources, sessionId: sid };
  }
}

export function createNeoEngine(opts: NeoEngineOptions = {}): NeoEngine {
  const gemini = opts.gemini ?? (process.env.GEMINI_API_KEY ? createGeminiClient() : undefined);
  return new NeoEngine({ ...opts, gemini });
}

/** Fastify plugin exposing Neo's routes. */
export const neoRoutes: FastifyPluginAsync<{ neo: NeoEngine }> = async (fastify, opts) => {
  const neo = opts.neo;

  fastify.get('/api/neo/capabilities', async () => ({ capabilities: neo.capabilities() }));

  fastify.post<{ Body: { question: string; sessionId?: string } }>(
    '/api/neo/chat',
    {
      schema: {
        body: {
          type: 'object',
          required: ['question'],
          properties: { question: { type: 'string', minLength: 1 }, sessionId: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const result = await neo.chat(request.body.question, request.body.sessionId);
      return reply.send(result);
    },
  );

  fastify.post<{ Body: { query: string } }>(
    '/api/neo/search',
    {
      schema: {
        body: {
          type: 'object',
          required: ['query'],
          properties: { query: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request) => neo.search(request.body.query),
  );

  // SSE streaming chat: GET /api/neo/chat?q=...&sessionId=...
  // Production-grade streaming: text/event-stream + no-cache + flushed headers,
  // 15s heartbeat comments, and full cancellation (AbortController + close/abort
  // teardown) so a client that drops mid-stream leaks no timers or sockets.
  fastify.get<{ Querystring: { q?: string; sessionId?: string } }>(
    '/api/neo/chat',
    async (request, reply) => {
      const q = request.query.q ?? '';
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      if (typeof raw.flushHeaders === 'function') raw.flushHeaders();

      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        if (!controller.signal.aborted) raw.write(': heartbeat\n\n');
      }, 15_000);
      let closed = false;
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        controller.abort();
        raw.end();
      };
      request.raw.on('aborted', cleanup);
      reply.raw.on('close', cleanup);

      try {
        const result = await neo.chat(q, request.query.sessionId, {
          signal: controller.signal,
        });
        for (const word of result.answer.split(' ')) {
          if (controller.signal.aborted) break;
          raw.write(`data: ${JSON.stringify({ token: word + ' ' })}\n\n`);
          await new Promise((r) => setTimeout(r, 3));
        }
        if (!controller.signal.aborted) {
          raw.write(
            `data: ${JSON.stringify({ sources: result.sources, sessionId: result.sessionId })}\n\n`,
          );
          raw.write('data: [DONE]\n\n');
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          raw.write(`data: ${JSON.stringify({ error: (err as Error).message })}\n\n`);
        }
      } finally {
        cleanup();
      }
    },
  );
};

