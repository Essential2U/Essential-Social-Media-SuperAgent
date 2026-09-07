/**
 * ESSENTIAL - Social Media Super Agent
 * packages/oauth/index.ts
 *
 * OAuth token persistence for platform connections (backlog: persist OAuth).
 *
 * Tokens are stored in Postgres (`essential_oauth_tokens`) with the access
 * and refresh tokens encrypted at rest (AES-256-GCM, same vault pattern as
 * the BYOK tool vault). OAuthTokenService adds refresh handling: a stored
 * refresh token can be exchanged for a new access token against the
 * provider's token endpoint (Facebook/Meta, Google/YouTube, LinkedIn, TikTok).
 * Live calls are gated behind LIVE_PUBLISH=true; in mock mode refresh returns
 * a mock token.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Pool } from 'pg';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type OAuthPlatform = 'facebook' | 'instagram' | 'linkedin' | 'tiktok' | 'youtube';

export interface OAuthTokenRecord {
  readonly clientId: string;
  readonly platform: OAuthPlatform;
  readonly accessTokenEnc: string;
  readonly refreshTokenEnc: string | null;
  readonly expiresAt: string | null;
  readonly scopes: readonly string[];
  readonly status: 'active' | 'revoked';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OAuthTokenInput {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresInSec?: number;
  readonly scopes?: readonly string[];
}

function vaultKey(): Buffer {
  const raw = process.env.TOOL_VAULT_KEY ?? 'dev-only-insecure-key-change-me';
  const buf = Buffer.from(raw, 'utf8');
  if (buf.length === 32) return buf;
  return createHash('sha256').update(buf).digest();
}

export class OAuthVault {
  encrypt(plain: string): string {
    const key = vaultKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
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

export class PgOAuthStore {
  private readonly vault = new OAuthVault();

  constructor(private readonly pool: Pool) {}

  async initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS essential_oauth_tokens (
        client_id  TEXT NOT NULL,
        platform   TEXT NOT NULL,
        record     JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (client_id, platform)
      );
    `);
  }

  async save(
    clientId: string,
    platform: OAuthPlatform,
    input: OAuthTokenInput,
  ): Promise<OAuthTokenRecord> {
    const now = new Date().toISOString();
    const record: OAuthTokenRecord = {
      clientId,
      platform,
      accessTokenEnc: this.vault.encrypt(input.accessToken),
      refreshTokenEnc: input.refreshToken ? this.vault.encrypt(input.refreshToken) : null,
      expiresAt: input.expiresInSec
        ? new Date(Date.now() + input.expiresInSec * 1000).toISOString()
        : null,
      scopes: input.scopes ?? [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await this.pool.query(
      `INSERT INTO essential_oauth_tokens (client_id, platform, record) VALUES ($1, $2, $3)
       ON CONFLICT (client_id, platform) DO UPDATE SET record = $3, updated_at = now()`,
      [clientId, platform, JSON.stringify(record)],
    );
    return record;
  }

  async get(clientId: string, platform: OAuthPlatform): Promise<OAuthTokenRecord | undefined> {
    const { rows } = await this.pool.query<{ record: OAuthTokenRecord }>(
      'SELECT record FROM essential_oauth_tokens WHERE client_id = $1 AND platform = $2',
      [clientId, platform],
    );
    return rows[0]?.record;
  }

  async revoke(clientId: string, platform: OAuthPlatform): Promise<boolean> {
    const existing = await this.get(clientId, platform);
    if (!existing) return false;
    const updated = { ...existing, status: 'revoked' as const, updatedAt: new Date().toISOString() };
    await this.pool.query(
      'UPDATE essential_oauth_tokens SET record = $3, updated_at = now() WHERE client_id = $1 AND platform = $2',
      [clientId, platform, JSON.stringify(updated)],
    );
    return true;
  }
}

const REFRESH_ENDPOINTS: Readonly<Record<OAuthPlatform, string>> = {
  facebook: 'https://graph.facebook.com/v26.0/oauth/access_token',
  instagram: 'https://graph.facebook.com/v26.0/oauth/access_token',
  linkedin: 'https://www.linkedin.com/oauth/v2/accessToken',
  tiktok: 'https://open.tiktokapis.com/v2/oauth/token/',
  youtube: 'https://oauth2.googleapis.com/token',
};

export class OAuthTokenService {
  constructor(
    private readonly db: PgOAuthStore,
    private readonly vault: OAuthVault = new OAuthVault(),
  ) {}

  async store(
    clientId: string,
    platform: OAuthPlatform,
    input: OAuthTokenInput,
  ): Promise<OAuthTokenRecord> {
    return this.db.save(clientId, platform, input);
  }

  async get(
    clientId: string,
    platform: OAuthPlatform,
  ): Promise<(OAuthTokenRecord & { accessToken: string; refreshToken?: string }) | undefined> {
    const rec = await this.db.get(clientId, platform);
    if (!rec) return undefined;
    return {
      ...rec,
      accessToken: this.vault.decrypt(rec.accessTokenEnc),
      refreshToken: rec.refreshTokenEnc ? this.vault.decrypt(rec.refreshTokenEnc) : undefined,
    };
  }

  async refresh(clientId: string, platform: OAuthPlatform): Promise<OAuthTokenRecord> {
    const rec = await this.get(clientId, platform);
    if (!rec) throw new Error('no oauth token stored for platform');
    if (!rec.refreshToken) throw new Error('no refresh token stored for platform');

    if (process.env.LIVE_PUBLISH !== 'true') {
      return this.db.save(clientId, platform, {
        accessToken: `mock-refreshed-${Date.now()}`,
        refreshToken: rec.refreshToken,
        expiresInSec: 3600,
        scopes: rec.scopes,
      });
    }

    const endpoint = REFRESH_ENDPOINTS[platform];
    const form = new URLSearchParams();
    if (platform === 'facebook' || platform === 'instagram') {
      form.set('grant_type', 'fb_exchange_token');
      form.set('client_id', process.env.META_APP_ID ?? '');
      form.set('client_secret', process.env.META_APP_SECRET ?? '');
      form.set('fb_exchange_token', rec.refreshToken);
    } else {
      form.set('grant_type', 'refresh_token');
      form.set('refresh_token', rec.refreshToken);
      form.set('client_id', process.env[`${platform.toUpperCase()}_CLIENT_ID`] ?? '');
      form.set('client_secret', process.env[`${platform.toUpperCase()}_CLIENT_SECRET`] ?? '');
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!res.ok) throw new Error(`oauth refresh failed for ${platform}: ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error(`oauth refresh returned no access_token for ${platform}`);
    return this.db.save(clientId, platform, {
      accessToken: body.access_token,
      refreshToken: rec.refreshToken,
      expiresInSec: body.expires_in ?? 3600,
      scopes: rec.scopes,
    });
  }
}

export function createOAuthService(pool: Pool): Promise<OAuthTokenService> {
  const store = new PgOAuthStore(pool);
  return store.initSchema().then(() => new OAuthTokenService(store));
}
