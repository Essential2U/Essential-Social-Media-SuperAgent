/**
 * ESSENTIAL - Social Media Super Agent
 * packages/auth/pg.ts
 *
 * Durable auth stores + shared rate limiter (A1/A3 fixes):
 *   - PgUserStore / PgSessionStore: Postgres-backed users and revoked-token
 *     sessions, so accounts survive restarts and are shared across API
 *     replicas (the in-memory stores were per-process and vanished on boot).
 *   - RedisRateLimiter: sliding-window login limiter shared across replicas
 *     (the in-memory limiter was per-process and bypassable by scaling).
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Pool } from 'pg';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import type { UserRecord, UserStoreLike, SessionStoreLike, RateLimiterLike } from './index';

export class PgUserStore implements UserStoreLike {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS essential_users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'client',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS essential_sessions (
        token      TEXT PRIMARY KEY,
        revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async create(email: string, passwordHash: string, role: 'client' | 'admin' = 'client'): Promise<UserRecord> {
    const id = randomBytes(8).toString('hex');
    const createdAt = new Date().toISOString();
    await this.pool.query(
      'INSERT INTO essential_users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [id, email, passwordHash, role],
    );
    return { id, email, passwordHash, role, createdAt };
  }

  private map(row: {
    id: string;
    email: string;
    password_hash: string;
    role: string;
    created_at: string;
  }): UserRecord {
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role as 'client' | 'admin',
      createdAt: row.created_at,
    };
  }

  async getById(id: string): Promise<UserRecord | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      email: string;
      password_hash: string;
      role: string;
      created_at: string;
    }>('SELECT id, email, password_hash, role, created_at FROM essential_users WHERE id = $1', [id]);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async getByEmail(email: string): Promise<UserRecord | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      email: string;
      password_hash: string;
      role: string;
      created_at: string;
    }>('SELECT id, email, password_hash, role, created_at FROM essential_users WHERE lower(email) = $1', [
      email.toLowerCase(),
    ]);
    return rows[0] ? this.map(rows[0]) : undefined;
  }
}

export class PgSessionStore implements SessionStoreLike {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO essential_sessions (token) VALUES ($1) ON CONFLICT (token) DO NOTHING',
      [token],
    );
  }

  async isRevoked(token: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT 1 FROM essential_sessions WHERE token = $1', [token]);
    return rows.length > 0;
  }
}

/** Sliding-window rate limiter backed by Redis (shared across replicas). */
export class RedisRateLimiter implements RateLimiterLike {
  constructor(
    private readonly redis: Redis,
    private readonly windowMs: number,
    private readonly max: number,
    private readonly prefix = 'rl:',
  ) {}

  async check(key: string): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const k = this.prefix + key;
    const now = Date.now();
    const cutoff = now - this.windowMs;
    // ioredis generated types bind these args as string|Buffer - pass String().
    await this.redis.zremrangebyscore(k, '0', String(cutoff));
    const count = await this.redis.zcard(k);
    if (count >= this.max) {
      const oldest = await this.redis.zrange(k, '0', '0', 'WITHSCORES');
      const oldestTs = oldest.length >= 2 ? Number(oldest[1]) : now;
      return { allowed: false, retryAfterMs: Math.max(0, this.windowMs - (now - oldestTs)) };
    }
    await this.redis.zadd(k, String(now), `${now}-${Math.random()}`);
    await this.redis.expire(k, Math.ceil(this.windowMs / 1000) + 1);
    return { allowed: true, retryAfterMs: 0 };
  }
}
