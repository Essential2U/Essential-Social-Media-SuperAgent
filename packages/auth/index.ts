/**
 * ESSENTIAL - Social Media Super Agent
 * packages/auth/index.ts
 *
 * M10 auth, self-contained on node:crypto (no external deps):
 *   - Password policy: min length + required special chars (! # $ * %).
 *   - Password hashing: scrypt (N=16384) with a per-account salt and a
 *     server-side pepper. Format: scrypt$N$r$p$saltB64$hashB64.
 *     (argon2id is the blueprint's target; scrypt is the built-in,
 *     NIST-approved equivalent until the argon2 package is added.)
 *   - Sessions: HS256 JWTs with expiry, verified with timing-safe compare,
 *     plus a revocable session store.
 *   - Rate limiting: sliding-window limiter for login.
 *   - Persistence seam: UserStore/SessionStore are in-memory; swap for
 *     Prisma via the same interface.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { AuthError, ConflictError, ValidationError } from '../core/errors';

/* ------------------------------------------------------------------ */
/* Password policy                                                     */
/* ------------------------------------------------------------------ */

export interface PasswordPolicy {
  readonly minLength: number;
  readonly requireSpecial: boolean;
  readonly specialChars: string;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireSpecial: true,
  specialChars: '!#$*%',
};

export function validatePassword(
  password: string,
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): { ok: boolean; errors: readonly string[] } {
  const errors: string[] = [];
  if (password.length < policy.minLength) {
    errors.push(`must be at least ${policy.minLength} characters`);
  }
  if (policy.requireSpecial && ![...password].some((c) => policy.specialChars.includes(c))) {
    errors.push(`must contain at least one special character from ${policy.specialChars}`);
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* Password hashing (scrypt + pepper)                                  */
/* ------------------------------------------------------------------ */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;

function scryptDerive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEYLEN, { N: n, r, p }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password: string, pepper: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptDerive(`${pepper}:${password}`, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string, pepper: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const derived = await scryptDerive(`${pepper}:${password}`, salt, n, r, p);
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/* ------------------------------------------------------------------ */
/* JWT sessions (HS256)                                                */
/* ------------------------------------------------------------------ */

export interface JwtClaims {
  readonly sub: string;
  readonly email: string;
  readonly role: 'client' | 'admin';
  readonly iat: number;
  readonly exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signJwt(
  claims: Omit<JwtClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds })));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [header, payload, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  const actual = b64urlDecode(sig);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('invalid signature');
  }
  const claims = JSON.parse(b64urlDecode(payload).toString('utf8')) as JwtClaims;
  if (claims.exp * 1000 < Date.now()) throw new Error('token expired');
  return claims;
}

/* ------------------------------------------------------------------ */
/* Rate limiter (sliding window)                                       */
/* ------------------------------------------------------------------ */

export interface RateLimiterLike {
  check(key: string): Promise<{ allowed: boolean; retryAfterMs: number }>;
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly max: number,
  ) {}

  async check(key: string): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(0, this.windowMs - (now - recent[0])) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Users + sessions (in-memory; Prisma swap via same interface)        */
/* ------------------------------------------------------------------ */

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly role: 'client' | 'admin';
  readonly createdAt: string;
}

/** Async user store contract - in-memory or Postgres both satisfy it. */
export interface UserStoreLike {
  create(email: string, passwordHash: string, role?: 'client' | 'admin'): Promise<UserRecord>;
  getById(id: string): Promise<UserRecord | undefined>;
  getByEmail(email: string): Promise<UserRecord | undefined>;
}

/** Async session store contract - in-memory or Postgres both satisfy it. */
export interface SessionStoreLike {
  revoke(token: string): Promise<void>;
  isRevoked(token: string): Promise<boolean>;
}

export class UserStore implements UserStoreLike {
  private readonly byId = new Map<string, UserRecord>();
  private readonly byEmail = new Map<string, UserRecord>();

  async create(email: string, passwordHash: string, role: 'client' | 'admin' = 'client'): Promise<UserRecord> {
    const user: UserRecord = {
      id: randomBytes(8).toString('hex'),
      email,
      passwordHash,
      role,
      createdAt: new Date().toISOString(),
    };
    this.byId.set(user.id, user);
    this.byEmail.set(email.toLowerCase(), user);
    return user;
  }

  async getById(id: string): Promise<UserRecord | undefined> {
    return this.byId.get(id);
  }

  async getByEmail(email: string): Promise<UserRecord | undefined> {
    return this.byEmail.get(email.toLowerCase());
  }
}

export class SessionStore implements SessionStoreLike {
  private readonly revoked = new Set<string>();

  async revoke(token: string): Promise<void> {
    this.revoked.add(token);
  }

  async isRevoked(token: string): Promise<boolean> {
    return this.revoked.has(token);
  }
}

/* ------------------------------------------------------------------ */
/* AuthService                                                         */
/* ------------------------------------------------------------------ */

export interface AuthServiceOptions {
  readonly users?: UserStoreLike;
  readonly sessions?: SessionStoreLike;
  readonly jwtSecret: string;
  readonly passwordPepper: string;
  readonly sessionTtlSeconds?: number;
  readonly policy?: PasswordPolicy;
}

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: 'client' | 'admin';
}

export class AuthService {
  private readonly users: UserStoreLike;
  private readonly sessions: SessionStoreLike;
  private readonly jwtSecret: string;
  private readonly pepper: string;
  private readonly ttlSeconds: number;
  private readonly policy: PasswordPolicy;

  constructor(opts: AuthServiceOptions) {
    this.users = opts.users ?? new UserStore();
    this.sessions = opts.sessions ?? new SessionStore();
    this.jwtSecret = opts.jwtSecret;
    this.pepper = opts.passwordPepper;
    this.ttlSeconds = opts.sessionTtlSeconds ?? 24 * 3600;
    this.policy = opts.policy ?? DEFAULT_PASSWORD_POLICY;
  }

  async register(email: string, password: string): Promise<{ user: AuthUser; token: string }> {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new ValidationError('invalid email address');
    }
    const policy = validatePassword(password, this.policy);
    if (!policy.ok) throw new ValidationError(policy.errors.join('; '));
    if (await this.users.getByEmail(normalized)) throw new ConflictError('email already registered');
    const user = await this.users.create(normalized, await hashPassword(password, this.pepper));
    return { user: { id: user.id, email: user.email, role: user.role }, token: this.issueToken(user) };
  }

  async login(email: string, password: string): Promise<{ token: string }> {
    const user = await this.users.getByEmail(email.trim().toLowerCase());
    if (!user || !(await verifyPassword(password, user.passwordHash, this.pepper))) {
      throw new AuthError('invalid email or password');
    }
    return { token: this.issueToken(user) };
  }

  async authenticate(token: string): Promise<JwtClaims> {
    const claims = verifyJwt(token, this.jwtSecret);
    if (await this.sessions.isRevoked(token)) throw new AuthError('token revoked');
    return claims;
  }

  /** Revoke a token (logout) - A2 fix: the revocation store is now reachable. */
  async revoke(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }

  private issueToken(user: UserRecord): string {
    return signJwt({ sub: user.id, email: user.email, role: user.role }, this.jwtSecret, this.ttlSeconds);
  }
}
