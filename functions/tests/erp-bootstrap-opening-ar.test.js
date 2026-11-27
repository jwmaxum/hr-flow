const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paymentEvents, summarize } = require('../erp-finance-model');
const { settlementReport } = require('../erp-settlement-model');
const { monthSnapshot, purchaseEvents } = require('../erp-dashboard-service');
const { createErpBootstrapService, CONFIRM_PHRASE } = require('../erp-bootstrap-service');

test('OPENING_RECEIVABLE populates opening and balance without inflating period sales', () => {
  const paid = [
    {
      id: 'openar_1',
      type: 'OPENING_RECEIVABLE',
      date: '2026-11-06',
      partnerId: 'partner-test',
      partnerName: '합성 거래처',
      currency: 'KRW',
      amountMinor: 40000,
      documentNo: 'OPEN-TEST-1',
      notes: '11/6 기초 미수채권',
    },
    {
      id: 'rcpt_1',
      type: 'RECEIPT',
      date: '2026-11-20',
      partnerId: 'partner-test',
      partnerName: '합성 거래처',
      currency: 'KRW',
      amountMinor: 12000,
      method: 'BANK',
      reference: 'BANK-001',
      notes: '부분 입금',
    },
  ];
  const events = paymentEvents(paid);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'OPENING_RECEIVABLE');
  assert.equal(events[0].gross, 40000);
  assert.equal(events[0].supply, 0);
  assert.equal(events[0].tax, 0);

  // Full period summary: opening = 40,000, sales = 0, receipts = 12,000, balance = 28,000
  const rows = summarize(events, '2026-11-01', '2026-11-30');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].opening, 40000);
  assert.equal(rows[0].sales, 0);
  assert.equal(rows[0].tax, 0);
  assert.equal(rows[0].billed, 0);
  assert.equal(rows[0].receipts, 12000);
  assert.equal(rows[0].balance, 28000);

  // Settlement report treats opening receivable as allocatable document
  const settle = settlementReport({ events, paid, settlements: [] }, '2026-11-30');
  assert.equal(settle.documents.length, 1);
  assert.equal(settle.documents[0].openingReceivable, true);
  assert.equal(settle.documents[0].billed, 40000);
  assert.equal(settle.documents[0].balance, 40000);
  assert.equal(settle.summaries[0].balance, 28000);
  assert.deepEqual(settle.totals, [{ currency: 'KRW', balance: 28000, refundDue: 0 }]);

  // Monthly dashboard snapshot must NOT count opening AR as November sales, but MUST show outstanding balance
  const snap = monthSnapshot({ movements: [], events, paid, settlements: [] }, purchaseEvents([]), '2026-11', '2026-11-26');
  assert.equal(snap.salesKRW, 0);
  assert.equal(snap.sales.length, 0);
  const krw = snap.currencies.find(c => c.currency === 'KRW');
  assert.equal(krw.sales, 0);
  assert.equal(krw.salesGross, 0);
  assert.equal(krw.receipts, 12000);
  assert.equal(krw.outstanding, 28000);

  // Cancelling an OPENING_RECEIVABLE via CANCEL receipt entry must fail
  assert.throws(() => paymentEvents([
    paid[0],
    { id: 'c1', type: 'CANCEL', sourceId: 'openar_1', partnerId: 'partner-test', currency: 'KRW', amountMinor: 40000, date: '2026-11-21', method: 'OTHER', notes: '취소' },
  ]), /수금 취소 연결/);
});

const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { workbook, opening, cell } = require('./erp-import-fixtures.cjs');

test('bootstrap protects an active ledger, verifies a full backup, and activates a replacement once', async t => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(localhost|127\.0\.0\.1):\d+$/, 'Local Firestore emulator required');
  const projectId = 'demo-bootstrap-protection';
  const app = initializeApp({ projectId }, projectId);
  t.after(() => deleteApp(app));
  const db = getFirestore(app);
  const suffix = require('node:crypto').randomUUID();
  const companyId = 'pilot-' + suffix;
  const otherId = 'other-' + suffix;
  const parent = db.collection('companies').doc(companyId);
  const other = db.collection('companies').doc(otherId);
  const adminId = 'admin-' + suffix;
  const otherAdminId = 'foreign-' + suffix;
  const managerId = 'manager-' + suffix;
  const active = async () => {
    const id = (await parent.get()).get('erpActiveLedgerVersion');
    return id ? parent.collection('erpLedgerVersions').doc(id).collection('ledger').doc(companyId) : parent;
  };
  let time = Date.parse('2026-11-27T03:00:00Z');
  const now = () => new Date(time);
  const service = createErpBootstrapService({ db, now });
  const req = (uid, data, ageSeconds = 0, provider = 'password') => ({
    auth: { uid, token: { auth_time: Math.floor(time / 1000) - ageSeconds, firebase: {sign_in_provider: provider} } },
    data: {companyId, ...data}
  });
  const company = {nameKo:'합성 ERP 회사',domain:'example.invalid',status:'ACTIVE',accessUntil:Timestamp.fromDate(new Date('2030-01-01T00:00:00Z'))};
  await parent.set(company);
  await other.set({...company,nameKo:'다른 합성 회사'});
  for (const [uid,role,tenant] of [[adminId,'ADMIN',companyId],[otherAdminId,'ADMIN',otherId],[managerId,'SUB_ADMIN',companyId]]) {
    await db.collection('UserProfile').doc(uid).set({uid,companyId:tenant,status:'ACTIVE',role,...(role==='SUB_ADMIN'?{erpAccess:'MANAGER'}:{})});
  }
  const source = await workbook('OPENING',[opening()],{modifyZip:async zip=>{
    const file='xl/worksheets/sheet1.xml';
    let guide=await zip.file(file).async('string');
    guide=cell(cell(guide,'B7','WH-01'),'B8','본사 창고');
    zip.file(file,guide);
  }});
  const preview = id => service(req(adminId,{action:'preview',id,source}));
  const commit = async (job,extra={},age=0,provider='password') => {
    const data = {action:'commit',id:job.id,fingerprint:job.fingerprint,confirmPhrase:CONFIRM_PHRASE,...extra};
    let result;
    do { result = await service(req(adminId,data,age,provider)); } while(result.pending && !result.stageMismatch);
    return result;
  };
  const deny = promise => assert.rejects(promise,e=>['failed-precondition','permission-denied','aborted','unauthenticated'].includes(e.code));
  await deny(service(req(managerId,{action:'preview',id:'manager',source})));
  await deny(service(req(otherAdminId,{action:'preview',id:'foreign',source})));
  const empty=(await preview('empty')).bootstrap;
  assert.equal(empty.protection.hasExistingData,false);
  const first=await commit(empty);
  assert.equal(first.bootstrap.status,'COMMITTED');
  const firstRoot = await active();
  assert.notEqual(firstRoot.path,parent.path);
  assert.equal((await firstRoot.collection('erpInventory').get()).docs[0].get('quantity'),10);
  const old = firstRoot.collection('erpItems').doc('legacy');
  const keep=other.collection('erpItems').doc('keep');
  await keep.set({companyId:otherId,code:'OTHER'});
  await old.set({companyId,code:'OLD',name:'기존 세트',itemType:'BUNDLE',components:[{itemId:'x',quantity:1},{itemId:'y',quantity:2}]});
  const stale=(await preview('stale')).bootstrap;
  assert.equal(stale.protection.hasExistingData,true);
  const approvals=firstRoot.collection('erpApprovals').doc('approval');
  await db.runTransaction(async tx => {
    const company = await tx.get(parent);
    tx.set(approvals,{companyId,status:'APPROVED',createdAt:now().toISOString()});
    tx.update(parent,{erpLedgerWriteRevision:(company.get('erpLedgerWriteRevision') || 0) + 1});
  });
  time+=2000;
  const reset={resetExisting:true,warningAccepted:true};
  await deny(commit(stale,reset));
  assert.equal((await old.get()).exists,true);
  const job=(await preview('reset')).bootstrap;
  await deny(commit(job));
  await deny(commit(job,{resetExisting:true}));
  await deny(commit(job,reset)); // preview and authentication were in the same second
  time+=2000;
  await deny(commit(job,reset,0,'google.com'));
  await deny(commit(job,reset,20));
  const res=await commit(job,reset);
  assert.equal(res.bootstrap.status,'COMMITTED');
  assert.equal(res.bootstrap.backup.reconciliation.verified,true);
  assert.ok(res.bootstrap.backup.id);
  const nextRoot = await active();
  assert.notEqual(nextRoot.path,firstRoot.path);
  assert.equal((await nextRoot.collection('erpItems').doc('legacy').get()).exists,false);
  assert.equal((await nextRoot.collection('erpApprovals').doc('approval').get()).exists,false);
  assert.equal((await old.get()).exists,true);
  assert.equal((await approvals.get()).exists,true);
  assert.equal((await keep.get()).exists,true);
  assert.equal((await nextRoot.collection('erpMovements').get()).size,1);
  const again=await commit(job,reset);
  assert.equal(again.idempotent,true);
  assert.equal(again.bootstrap.backup.id,res.bootstrap.backup.id);
});
