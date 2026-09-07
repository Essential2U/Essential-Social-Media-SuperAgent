/**
 * ESSENTIAL - Social Media Super Agent
 * packages/core/db-config.ts
 *
 * Resolves Postgres and Redis connection config from environment variables,
 * preferring the single-URL form every managed host (Render, Railway, Fly,
 * Heroku-style) provides (DATABASE_URL / REDIS_URL), and falling back to the
 * discrete PGHOST/PGPORT/... and REDIS_HOST/REDIS_PORT/... vars used for
 * local dev and docker-compose. Both entrypoints (apps/api/server.ts,
 * apps/worker/server.ts) and live-queues.ts share this so the two connection
 * forms stay in sync in exactly one place.
 *
 * Managed Postgres almost always requires SSL over the connection a URL
 * implies (Render, Railway, etc. terminate with a cert their own tooling
 * doesn't ask you to pin) - resolvePgPoolConfig() enables
 * `ssl: { rejectUnauthorized: false }` by default whenever DATABASE_URL is
 * set, unless DATABASE_SSL=false is explicit. Managed Redis analogously
 * requires TLS (a `rediss://` URL) and a password almost everywhere it's
 * offered as an add-on - resolveRedisConnection() parses both off the URL.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source.
 */

import type { PoolConfig } from 'pg';

export function resolvePgPoolConfig(): PoolConfig {
  const url = process.env.DATABASE_URL;
  if (url) {
    const sslDisabled = process.env.DATABASE_SSL === 'false';
    return {
      connectionString: url,
      ssl: sslDisabled ? undefined : { rejectUnauthorized: false },
    };
  }
  return {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'essential',
    password: process.env.PGPASSWORD ?? 'essential_dev',
    database: process.env.PGDATABASE ?? 'essential',
  };
}

export interface ResolvedRedisConnection {
  readonly host: string;
  readonly port: number;
  readonly username?: string;
  readonly password?: string;
  readonly tls?: Record<string, never>;
}

export function resolveRedisConnection(): ResolvedRedisConnection {
  const url = process.env.REDIS_URL;
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      tls: parsed.protocol === 'rediss:' ? {} : undefined,
    };
  }
  return {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  };
}
