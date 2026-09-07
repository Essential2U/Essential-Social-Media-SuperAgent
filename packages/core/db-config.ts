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
  // On a managed host (Render sets RENDER=true, Railway RAILWAY_*, Fly FLY_*)
  // there is no local Postgres to fall back to. Failing here with a clear
  // message beats a downstream `connect ECONNREFUSED 127.0.0.1:5432`.
  if (isManagedHost() && !process.env.PGHOST) {
    throw new Error(
      'DATABASE_URL is not set. On Render, open this service -> Environment, ' +
        'add DATABASE_URL, and link it to your Postgres instance\'s Internal ' +
        'Database URL (or re-create this service via the Blueprint so it is ' +
        'wired from essential-db automatically).',
    );
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

function isManagedHost(): boolean {
  return Boolean(
    process.env.RENDER ||
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.FLY_APP_NAME,
  );
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
  if (isManagedHost() && !process.env.REDIS_HOST) {
    throw new Error(
      'REDIS_URL is not set. On Render, open this service -> Environment, add ' +
        'REDIS_URL, and link it to your Key Value instance\'s internal ' +
        'connection string (or re-create this service via the Blueprint so it ' +
        'is wired from essential-redis automatically).',
    );
  }
  return {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  };
}
