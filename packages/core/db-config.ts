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
  const url = envStr('DATABASE_URL');
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
  if (isManagedHost() && !envStr('PGHOST')) {
    throw new Error(
      'DATABASE_URL is not set (or is empty) in this process. Postgres-related ' +
        'env vars visible here: ' + visibleKeys(/^(DATABASE_URL|PG|POSTGRES)/i) +
        '. On Render: this service -> Environment -> add DATABASE_URL as a ' +
        'literal value = your Postgres instance\'s Internal Database URL, then ' +
        'Save. A `fromService`/`fromDatabase` link is NOT reliable across plain ' +
        'redeploys - use a literal value.',
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

/** Env var names visible to this process that match a pattern - values are
 *  never included so a password in DATABASE_URL is not logged. */
function visibleKeys(pattern: RegExp): string {
  const hits = Object.keys(process.env).filter((k) => pattern.test(k));
  return hits.length ? hits.join(', ') : '(none)';
}

/** Trimmed non-empty string, or undefined. Render's Blueprint has been
 *  observed to inject an env var whose value is an empty string or has a
 *  trailing newline when a `fromService` reference fails to resolve. */
function envStr(name: string): string | undefined {
  const v = process.env[name];
  if (v == null) return undefined;
  const t = v.trim();
  return t.length ? t : undefined;
}

export function resolveRedisConnection(): ResolvedRedisConnection {
  const url = envStr('REDIS_URL');
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(
        `REDIS_URL is set but not a valid URL: ${JSON.stringify(url)}. ` +
          'Expected redis://host:port (or rediss://user:pass@host:port).',
      );
    }
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      tls: parsed.protocol === 'rediss:' ? {} : undefined,
    };
  }
  const host = envStr('REDIS_HOST');
  if (isManagedHost() && !host) {
    throw new Error(
      'REDIS_URL is not set (or is empty) in this process. Redis-related env ' +
        'vars visible here: ' + visibleKeys(/REDIS/i) +
        '. On Render: this service -> Environment -> add REDIS_URL as a literal ' +
        'value (e.g. redis://red-xxxx:6379 from your Key Value instance\'s ' +
        'internal URL), then Save. A `fromService` link is NOT reliable across ' +
        'plain redeploys - use a literal value.',
    );
  }
  return {
    host: host ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  };
}
