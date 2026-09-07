/**
 * ESSENTIAL - Social Media Super Agent
 * apps/api/server.ts
 *
 * API entrypoint (Sprint A - wired to the live stack). Bootstraps:
 *   - Postgres PgDraftStore (draft persistence, auto-migrate on boot)
 *   - Live BullMQ queues on Redis
 *   - Shared ApprovalStateMachine persisted in Postgres (B1 fix: the worker's
 *     publish gate sees the API's approvals across processes)
 *   - M10 AuthService (JWT + scrypt/pepper password policy)
 *   - Neo embedded AI assistant
 *   - OAuth token persistence + refresh (Postgres, encrypted at rest)
 *   - Structured JSON logger (request tracing)
 *
 * Run: npx tsx apps/api/server.ts  (or via docker-compose)
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Pool } from 'pg';
import { buildEssentialApp, type DraftRecord } from './index';
import { createPgDraftStore } from '../../packages/persistence';
import { createLiveQueues } from '../worker/live-queues';
import { createPgApprovalStateMachine } from '../../packages/approvals/pg';
import { AuthService } from '../../packages/auth';
import { PgUserStore, PgSessionStore, RedisRateLimiter } from '../../packages/auth/pg';
import Redis from 'ioredis';
import { createLogger, parseLogLevel } from '../../packages/core/logger';
import { createNeoEngine } from '../../packages/neo';
import { createOAuthService } from '../../packages/oauth';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const redis = {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  };
  const pg = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'essential',
    password: process.env.PGPASSWORD ?? 'essential_dev',
    database: process.env.PGDATABASE ?? 'essential',
  });

  const logger = createLogger(parseLogLevel(process.env.LOG_LEVEL));

  // Fail fast on default secrets when running in production mode (A4/C1 fix):
  // a known JWT secret or vault key in prod is a critical vulnerability.
  if (process.env.LIVE_PUBLISH === 'true') {
    const insecure = {
      JWT_SECRET: process.env.JWT_SECRET,
      PASSWORD_PEPPER: process.env.PASSWORD_PEPPER,
      TOOL_VAULT_KEY: process.env.TOOL_VAULT_KEY,
    };
    for (const [k, v] of Object.entries(insecure)) {
      if (!v || /change-me|dev-secret|dev-pepper|dev-only/.test(v)) {
        throw new Error(`refusing to boot in production with insecure default for ${k}`);
      }
    }
  }

  // Persistence: Postgres-backed draft store, schema auto-created on boot.
  const drafts = createPgDraftStore<DraftRecord>(pg);
  await drafts.initSchema();

  // A1: durable Postgres-backed user + session stores (shared across replicas).
  const users = new PgUserStore(pg);
  const sessions = new PgSessionStore(pg);
  await users.initSchema();

  // Shared approval state machine - persisted in Postgres so the API and the
  // worker (separate processes) see the SAME approvals (B1 fix).
  const approvals = await createPgApprovalStateMachine(pg);

  // Live BullMQ queues on Redis (queue + job-ID names sanitized, no ':').
  const queues = createLiveQueues(redis);

  // A3: Redis-backed login rate limiter shared across API replicas.
  const redisLimiter = new Redis(redis.port, redis.host, { maxRetriesPerRequest: 1 });
  const rateLimiter = new RedisRateLimiter(redisLimiter, 60_000, 5);

  // M10 auth: JWT sessions + scrypt/pepper password policy.
  const auth = new AuthService({
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
    passwordPepper: process.env.PASSWORD_PEPPER ?? 'dev-pepper-change-me',
    users,
    sessions,
  });

  // Neo embedded AI assistant (RAG-lite over the capability registry).
  const neo = createNeoEngine();

  // OAuth token persistence + refresh (Postgres-backed, encrypted at rest).
  const oauth = await createOAuthService(pg);

  const app = await buildEssentialApp({
    draftStore: drafts,
    approvals,
    queues,
    auth,
    logger,
    neo,
    oauth,
    gateNeo: process.env.LIVE_PUBLISH === 'true',
    rateLimiter,
  });

  await app.listen({ port: port, host: '0.0.0.0' });
  logger.info('essential api listening', { port, redis, pg: pg.options.database });

  // Graceful shutdown: close HTTP, then the Postgres pool.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      logger.info('shutting down', { signal: sig });
      await app.close();
      await pg.end();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('API BOOT FAILED:', err);
  process.exit(1);
});
