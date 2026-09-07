/**
 * ESSENTIAL - Social Media Super Agent
 * apps/api/oauth-test.ts
 *
 * Test harness for OAuth token persistence + refresh (backlog: persist OAuth).
 * Proves against live Postgres: schema init, token save (encrypted at rest),
 * decrypted read-back, mock refresh (rotates the access token), and the
 * /api/clients/:id/oauth routes through the Fastify app.
 *
 * Run: npx tsx apps/api/oauth-test.ts   (requires local Postgres)
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Pool } from 'pg';
import { PgOAuthStore, OAuthTokenService } from '../../packages/oauth';
import { buildEssentialApp, type EssentialQueues } from './index';

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) process.exitCode = 1;
}

function fakeQueues(): EssentialQueues {
  return {
    research: { add: async () => ({ id: 'r' }) },
    copy: { add: async () => ({ id: 'c' }) },
    media: { add: async () => ({ id: 'm' }) },
    publish: { add: async () => ({ id: 'p' }) },
  };
}

async function main(): Promise<void> {
  console.log('=== ESSENTIAL OAUTH TEST ===');
  const pg = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'essential',
    password: process.env.PGPASSWORD ?? 'essential_dev',
    database: process.env.PGDATABASE ?? 'essential',
  });
  const store = new PgOAuthStore(pg);
  await store.initSchema();
  const oauth = new OAuthTokenService(store);

  const saved = await oauth.store('client_1', 'youtube', {
    accessToken: 'ya29.live-access-token',
    refreshToken: '1//refresh-secret',
    expiresInSec: 3600,
    scopes: ['youtube.upload'],
  });
  assert(saved.status === 'active', 'token saved with active status');
  assert(saved.accessTokenEnc !== 'ya29.live-access-token', 'access token encrypted at rest');
  assert(
    saved.refreshTokenEnc !== null && saved.refreshTokenEnc !== '1//refresh-secret',
    'refresh token encrypted at rest',
  );

  const got = await oauth.get('client_1', 'youtube');
  assert(got !== undefined && got.accessToken === 'ya29.live-access-token', 'read-back returns decrypted access token');
  assert(got !== undefined && got.refreshToken === '1//refresh-secret', 'read-back returns decrypted refresh token');

  await oauth.refresh('client_1', 'youtube');
  const got2 = await oauth.get('client_1', 'youtube');
  assert(got2 !== undefined && got2.accessToken.startsWith('mock-refreshed'), 'mock refresh rotates access token');

  const app = await buildEssentialApp({ oauth, queues: fakeQueues() });
  await app.ready();

  const put = await app.inject({
    method: 'POST',
    url: '/api/clients/client_2/oauth',
    payload: {
      platform: 'linkedin',
      accessToken: 'AQV-live',
      refreshToken: 'r2',
      expiresInSec: 3600,
      scopes: ['r_liteprofile'],
    },
  });
  assert(put.statusCode === 201, 'POST /oauth stores a token (201)');
  assert(put.json().status === 'active', 'POST /oauth returns active status');

  const get = await app.inject({ method: 'GET', url: '/api/clients/client_2/oauth?platform=linkedin' });
  assert(get.statusCode === 200, 'GET /oauth returns stored token info (200)');
  assert(get.json().hasRefreshToken === true, 'GET /oauth reports refresh token present');

  const rf = await app.inject({
    method: 'POST',
    url: '/api/clients/client_2/oauth/refresh',
    payload: { platform: 'linkedin' },
  });
  assert(rf.statusCode === 200 && rf.json().refreshed === true, 'POST /oauth/refresh refreshes (200)');

  await app.close();
  await pg.end();
  console.log('=== OAUTH TEST COMPLETE ===');
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error('OAUTH TEST FAILED:', err);
  process.exit(1);
});
