/**
 * ESSENTIAL - Social Media Super Agent
 * packages/approvals/index.ts
 *
 * Two-stage approval state machine.
 *
 * Stage 1 (DRAFT): preview approval of the generated content (text text,
 *   image, video, or both). The client reviews the preview and approves or
 *   rejects.
 * Stage 2 (FINAL): per-platform approval. The client explicitly approves
 *   posting to each selected platform before anything is published.
 *
 * Publishing is impossible until:
 *   - Stage 1 is approved, AND
 *   - every selected platform has an approved Stage 2 record.
 * Rejection returns BLOCKED with a reason and a regenerate path. Every state
 * change writes an audit record.
 *
 * DURABILITY (fix of the #1 publishing blocker): the state machine reads and
 * writes through a pluggable ApprovalStore. The default MemoryApprovalStore
 * keeps the single-process dev/test behavior; in production both the API and
 * the worker construct their state machine over the SAME Postgres-backed
 * store (packages/approvals/pg.ts), so approvals recorded by the API are
 * visible to the worker's publish gate across processes.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source. Mock-first.
 */

export type ApprovalStage = 'DRAFT' | 'FINAL';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'revoked';

export interface ApprovalRecord {
  readonly id: string;
  readonly draftId: string;
  readonly stage: ApprovalStage;
  readonly platform?: string;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly reason?: string;
  readonly resumeToken?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApproveInput {
  readonly draftId: string;
  readonly stage: ApprovalStage;
  readonly approvedBy: string;
  readonly platform?: string;
  readonly resumeToken?: string;
  readonly reason?: string;
}

export interface ApproveResult {
  readonly ok: boolean;
  readonly status: ApprovalStatus;
  readonly message: string;
  readonly nextStage?: ApprovalStage;
}

export interface PublishGate {
  readonly allowed: boolean;
  readonly missing: readonly string[];
  readonly perPlatform: Readonly<Record<string, ApprovalStatus>>;
}

export interface AuditEvent {
  readonly draftId: string;
  readonly event: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly at: string;
}

/** Pluggable durable store - in-memory by default, Postgres in production. */
export interface ApprovalStore {
  get(key: string): Promise<ApprovalRecord | undefined>;
  set(key: string, rec: ApprovalRecord): Promise<void>;
  allFor(draftId: string): Promise<ApprovalRecord[]>;
}

/** Default in-memory store (tests / single-process dev). */
export class MemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();
  async get(key: string): Promise<ApprovalRecord | undefined> {
    return this.records.get(key);
  }
  async set(key: string, rec: ApprovalRecord): Promise<void> {
    this.records.set(key, rec);
  }
  async allFor(draftId: string): Promise<ApprovalRecord[]> {
    return [...this.records.values()].filter((r) => r.draftId === draftId);
  }
}

export class ApprovalStateMachine {
  private readonly store: ApprovalStore;
  private readonly audits: AuditEvent[] = [];
  private seq = 0;

  constructor(store?: ApprovalStore) {
    this.store = store ?? new MemoryApprovalStore();
  }

  /** Stage 1 - request preview approval of the generated content. */
  async requestDraftApproval(draftId: string, requestedBy: string): Promise<ApprovalRecord> {
    return this.upsert({ draftId, stage: 'DRAFT', status: 'pending', requestedBy });
  }

  async approveDraft(input: ApproveInput): Promise<ApproveResult> {
    if (input.stage !== 'DRAFT') return this.bad('stage must be DRAFT');
    const rec = await this.get(draftKey(input.draftId, 'DRAFT'));
    if (!rec) return this.bad('no draft approval requested yet');
    if (rec.status === 'rejected') return this.bad('draft was rejected - regenerate before approving');
    return this.setStatus(rec, 'approved', input);
  }

  async rejectDraft(input: ApproveInput): Promise<ApproveResult> {
    const rec = await this.get(draftKey(input.draftId, 'DRAFT'));
    if (!rec) return this.bad('no draft approval requested yet');
    return this.setStatus(rec, 'rejected', input);
  }

  /** Stage 2 - request per-platform final approvals (requires approved draft). */
  async requestFinalApprovals(
    draftId: string,
    platforms: readonly string[],
    requestedBy: string,
  ): Promise<ApprovalRecord[]> {
    const draft = await this.get(draftKey(draftId, 'DRAFT'));
    if (!draft || draft.status !== 'approved') {
      throw new Error('final approvals require an approved draft (stage 1) first');
    }
    const records: ApprovalRecord[] = [];
    for (const platform of platforms) {
      records.push(await this.upsert({ draftId, stage: 'FINAL', platform, status: 'pending', requestedBy }));
    }
    return records;
  }

  async approvePlatform(input: ApproveInput): Promise<ApproveResult> {
    if (input.stage !== 'FINAL' || !input.platform) return this.bad('stage must be FINAL with a platform');
    const rec = await this.get(draftKey(input.draftId, 'FINAL', input.platform));
    if (!rec) return this.bad('no final approval requested for this platform');
    return this.setStatus(rec, 'approved', input);
  }

  async rejectPlatform(input: ApproveInput): Promise<ApproveResult> {
    if (input.stage !== 'FINAL' || !input.platform) return this.bad('stage must be FINAL with a platform');
    const rec = await this.get(draftKey(input.draftId, 'FINAL', input.platform));
    if (!rec) return this.bad('no final approval requested for this platform');
    return this.setStatus(rec, 'rejected', input);
  }

  async revoke(draftId: string): Promise<void> {
    for (const rec of await this.allFor(draftId)) {
      await this.setStatus(rec, 'revoked', { draftId, stage: rec.stage, approvedBy: 'system', platform: rec.platform });
    }
  }

  async expire(draftId: string): Promise<void> {
    for (const rec of await this.allFor(draftId)) {
      if (rec.status === 'pending') {
        await this.setStatus(rec, 'expired', { draftId, stage: rec.stage, approvedBy: 'system', platform: rec.platform });
      }
    }
  }

  /** Gate every publish call: stage 1 approved AND every platform approved. */
  async canPublish(draftId: string, platforms: readonly string[]): Promise<PublishGate> {
    const draft = await this.get(draftKey(draftId, 'DRAFT'));
    const missing: string[] = [];
    if (!draft || draft.status !== 'approved') missing.push('DRAFT');
    const perPlatform: Record<string, ApprovalStatus> = {};
    for (const platform of platforms) {
      const rec = await this.get(draftKey(draftId, 'FINAL', platform));
      const status = rec ? rec.status : 'pending';
      perPlatform[platform] = status;
      if (status !== 'approved') missing.push(platform);
    }
    return { allowed: missing.length === 0, missing, perPlatform };
  }

  async getRecords(draftId: string): Promise<readonly ApprovalRecord[]> {
    return this.allFor(draftId);
  }

  getAudits(): readonly AuditEvent[] {
    return [...this.audits];
  }

  /* private helpers */

  private async upsert(partial: {
    draftId: string;
    stage: ApprovalStage;
    platform?: string;
    status: ApprovalStatus;
    requestedBy: string;
  }): Promise<ApprovalRecord> {
    const key = draftKey(partial.draftId, partial.stage, partial.platform);
    const now = new Date().toISOString();
    const existing = await this.store.get(key);
    const record: ApprovalRecord = existing
      ? { ...existing, status: partial.status, updatedAt: now }
      : {
          id: `appr_${++this.seq}`,
          draftId: partial.draftId,
          stage: partial.stage,
          platform: partial.platform,
          status: partial.status,
          requestedBy: partial.requestedBy,
          createdAt: now,
          updatedAt: now,
        };
    await this.store.set(key, record);
    return record;
  }

  private async setStatus(rec: ApprovalRecord, status: ApprovalStatus, input: ApproveInput): Promise<ApproveResult> {
    const now = new Date().toISOString();
    const updated: ApprovalRecord = {
      ...rec,
      status,
      approvedBy: input.approvedBy,
      approvedAt: status === 'approved' ? now : rec.approvedAt,
      reason: input.reason ?? rec.reason,
      resumeToken: input.resumeToken ?? rec.resumeToken,
      updatedAt: now,
    };
    await this.store.set(draftKey(rec.draftId, rec.stage, rec.platform), updated);
    this.audit(rec.draftId, `approval.${status.toLowerCase()}`, {
      stage: rec.stage,
      platform: rec.platform,
      approvedBy: input.approvedBy,
      reason: input.reason,
    });
    const nextStage = status === 'approved' && rec.stage === 'DRAFT' ? 'FINAL' : undefined;
    return {
      ok: true,
      status,
      message: `${rec.stage}${rec.platform ? ` ${rec.platform}` : ''} ${status}`,
      nextStage,
    };
  }

  private bad(message: string): ApproveResult {
    return { ok: false, status: 'pending', message };
  }

  private async get(key: string): Promise<ApprovalRecord | undefined> {
    return this.store.get(key);
  }

  private async allFor(draftId: string): Promise<ApprovalRecord[]> {
    return this.store.allFor(draftId);
  }

  private audit(draftId: string, event: string, detail: Readonly<Record<string, unknown>>): void {
    this.audits.push({ draftId, event, detail, at: new Date().toISOString() });
  }
}

function draftKey(draftId: string, stage: ApprovalStage, platform?: string): string {
  return platform ? `${draftId}|${stage}|${platform}` : `${draftId}|${stage}`;
}

export function createApprovalStateMachine(): ApprovalStateMachine {
  return new ApprovalStateMachine();
}
