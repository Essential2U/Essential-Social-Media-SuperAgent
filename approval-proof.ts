import { Pool } from 'pg';
import { PgApprovalStore } from './packages/approvals/pg';
import { ApprovalStateMachine } from './packages/approvals';
async function main(): Promise<void> {
  const pg = new Pool({ host:'127.0.0.1', port:5432, user:'essential', password:'essential_dev', database:'essential' });
  const store = new PgApprovalStore(pg);
  await store.initSchema();
  const api = new ApprovalStateMachine(store);
  await api.requestDraftApproval('draft_b1', 'client');
  await api.approveDraft({ draftId:'draft_b1', stage:'DRAFT', approvedBy:'client' });
  await api.requestFinalApprovals('draft_b1', ['facebook','youtube'], 'client');
  await api.approvePlatform({ draftId:'draft_b1', stage:'FINAL', platform:'facebook', approvedBy:'client' });
  await api.approvePlatform({ draftId:'draft_b1', stage:'FINAL', platform:'youtube', approvedBy:'client' });
  const worker = new ApprovalStateMachine(store);
  const gate = await worker.canPublish('draft_b1', ['facebook','youtube']);
  console.log(`B1 gate.allowed=${gate.allowed} missing=${gate.missing.join(',')}`);
  await pg.end();
  if (!gate.allowed) process.exit(1);
  console.log('B1_PASS');
}
main().catch((e)=>{console.error('B1_FAIL', e.message); process.exit(1);});
