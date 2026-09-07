/**
 * ESSENTIAL - Social Media Super Agent
 * packages/persistence/index.ts
 *
 * Postgres persistence for the draft pipeline (blueprint items 3-4).
 * PgDraftStore implements the same create/get/update contract as the
 * in-memory DraftStore (apps/api/index.ts) but backed by an
 * `essential_drafts` table, so the identical round-trip passes against a
 * live Postgres. The store is generic over the record type T so it can
 * persist the API's DraftRecord without a packages->apps dependency.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

import { Pool } from 'pg';

/** Minimal shape every persisted draft record must satisfy. */
export interface PersistedDraft {
  readonly draftId: string;
}

export type DraftCreateInput<T> = Omit<
  T,
  'draftId' | 'status' | 'jobIds' | 'createdAt' | 'updatedAt'
>;

export interface AsyncDraftStore<T extends PersistedDraft = PersistedDraft> {
  initSchema(): Promise<void>;
  create(input: DraftCreateInput<T>): Promise<T>;
  get(draftId: string): Promise<T | undefined>;
  update(draftId: string, patch: Partial<T>): Promise<T | undefined>;
}

export class PgDraftStore<T extends PersistedDraft = PersistedDraft>
  implements AsyncDraftStore<T>
{
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE SEQUENCE IF NOT EXISTS essential_draft_seq;
      CREATE TABLE IF NOT EXISTS essential_drafts (
        draft_id   TEXT PRIMARY KEY,
        record     JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async create(input: DraftCreateInput<T>): Promise<T> {
    const now = new Date().toISOString();
    const { rows } = await this.pool.query<{ nextval: string }>(
      "SELECT nextval('essential_draft_seq') AS nextval",
    );
    const draftId = `draft_${rows[0].nextval}`;
    const record = {
      ...input,
      draftId,
      status: 'queued',
      jobIds: [],
      createdAt: now,
      updatedAt: now,
    } as unknown as T;
    await this.pool.query(
      'INSERT INTO essential_drafts (draft_id, record) VALUES ($1, $2)',
      [draftId, JSON.stringify(record)],
    );
    return record;
  }

  async get(draftId: string): Promise<T | undefined> {
    const { rows } = await this.pool.query<{ record: T }>(
      'SELECT record FROM essential_drafts WHERE draft_id = $1',
      [draftId],
    );
    return rows[0]?.record;
  }

  async update(draftId: string, patch: Partial<T>): Promise<T | undefined> {
    // Atomic JSONB merge (fix P1): concurrent workers (copy/media/publish)
    // patch the record server-side with record || $2::jsonb instead of a
    // read-modify-write round trip, eliminating lost updates.
    const now = new Date().toISOString();
    const { rows } = await this.pool.query<{ record: T }>(
      `UPDATE essential_drafts
          SET record = record || $2::jsonb, updated_at = now()
        WHERE draft_id = $1
        RETURNING record`,
      [draftId, JSON.stringify({ ...patch, updatedAt: now })],
    );
    return rows[0]?.record;
  }
}

export function createPgDraftStore<T extends PersistedDraft = PersistedDraft>(
  pool: Pool,
): PgDraftStore<T> {
  return new PgDraftStore<T>(pool);
}
