/**
 * ESSENTIAL - Social Media Super Agent
 * packages/approvals/pg.ts
 *
 * Postgres-backed ApprovalStore (fix of the #1 publishing blocker: the API and
 * worker previously each held their own in-memory approval state, so in a
 * two-container deployment the worker's publish gate could never see the
 * client's approvals). Both entrypoints now construct their state machine over
 * this shared table, so approvals recorded by the API are visible to the
 * worker's publish processor across processes.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Pool } from 'pg';
import type { ApprovalRecord, ApprovalStore } from './index';

export class PgApprovalStore implements ApprovalStore {
  constructor(private readonly pool: Pool) {}

  async initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS essential_approvals (
        key        TEXT PRIMARY KEY,
        record     JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async get(key: string): Promise<ApprovalRecord | undefined> {
    const { rows } = await this.pool.query<{ record: ApprovalRecord }>(
      'SELECT record FROM essential_approvals WHERE key = $1',
      [key],
    );
    return rows[0]?.record;
  }

  async set(key: string, rec: ApprovalRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO essential_approvals (key, record) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET record = $2, updated_at = now()`,
      [key, JSON.stringify(rec)],
    );
  }

  async allFor(draftId: string): Promise<ApprovalRecord[]> {
    const { rows } = await this.pool.query<{ record: ApprovalRecord }>(
      "SELECT record FROM essential_approvals WHERE record->>'draftId' = $1",
      [draftId],
    );
    return rows.map((r) => r.record);
  }
}

export async function createPgApprovalStateMachine(
  pool: Pool,
): Promise<import('./index').ApprovalStateMachine> {
  const store = new PgApprovalStore(pool);
  await store.initSchema();
  const { ApprovalStateMachine } = await import('./index');
  return new ApprovalStateMachine(store);
}
