const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { ledgerParent, routeDatabase } = require('../erp-version-routing');
const { createErpService } = require('../erp-service');
const { createErpControlService } = require('../erp-control-service');
const { createErpDocumentService } = require('../erp-document-service');
const { createErpFinanceService } = require('../erp-finance-service');

test('versioned operational services protect cutover and preserve company metadata and history paths', async t => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(localhost|127\.0\.0\.1):\d+$/);
  const app = initializeApp({ projectId: 'demo-erp-version-routing' }, randomUUID());
  t.after(() => deleteApp(app));
  const db = getFirestore(app);
  const companyId = randomUUID(), uid = randomUUID();
  const company = db.collection('companies').doc(companyId);
  const now = () => new Date('2026-11-27T03:00:00Z');
  const req = data => ({ auth: { uid, token: { auth_time: Math.floor(now().getTime() / 1000) } }, data: { companyId, ...data } });
  const base = { nameKo: '합성 장부 회사', status: 'ACTIVE', accessUntil: Timestamp.fromDate(new Date('2030-01-01')) };
  await company.set(base);
  await db.collection('UserProfile').doc(uid).set({ companyId, uid, name: '합성 관리자', role: 'ADMIN', status: 'ACTIVE' });
  const master = createErpService({ db, now });
  const control = createErpControlService({ db, now });
  const finance = createErpFinanceService({ db, now });
  const documents = createErpDocumentService({ db, now });
  const saveWarehouse = (id, name) => master(req({ action: 'save', kind: 'warehouses', id, expectedRevision: 0,
    values: { code: id, name, address: '', notes: '', active: true } }));
  const listWarehouses = () => master(req({ action: 'list', kind: 'warehouses' }));
  const revision = async () => (await company.get()).get('erpLedgerWriteRevision');
  await saveWarehouse('wh-before', '이전 창고');
  assert.equal(await revision(), 1);
  const pinned = routeDatabase(db, { companyId, company: (await company.get()).data() });
  const staged = ledgerParent(company, 'new-v1');
  await staged.collection('erpPrintSettings').doc('profile').set({ companyId, version: 5, bankDetails: '합성 새 장부' });
  // Preparing a separate ledger leaves operational reads in the original one.
  assert.equal((await listWarehouses()).records[0].id, 'wh-before');
  assert.equal((await documents(req({ action: 'meta' }))).profile.version, 0);
  await company.update({ erpActiveLedgerVersion: 'new-v1', erpLedgerWriteRevision: 2 });
  await assert.rejects(pinned.runTransaction(async tx => {
    tx.create(company.collection('erpItems').doc('stale'), { companyId });
  }), error => error.code === 'aborted');
  assert.equal((await company.collection('erpItems').doc('stale').get()).exists, false);
  assert.equal((await listWarehouses()).records.length, 0);
  const meta = await documents(req({ action: 'meta' }));
  assert.equal(meta.profile.version, 5);
  assert.equal(meta.profile.bankDetails, '합성 새 장부');
  assert.equal((await finance(req({ action: 'dashboard', month: '2026-11' }))).companyName, base.nameKo);
  await saveWarehouse('wh-after', '전환 후 창고');
  assert.equal(await revision(), 3);
  assert.equal((await company.collection('erpWarehouses').get()).docs[0].id, 'wh-before');
  assert.equal((await staged.collection('erpWarehouses').get()).docs[0].id, 'wh-after');
  const history = await staged.collection('erpChangeHistory').get();
  assert.ok(history.docs.some(s => s.get('changes').some(x => x.path === 'erpWarehouses/wh-after')));
  await control(req({ action: 'reviewPolicySave', agedDays: 20, urgentDays: 50, revision: 0, reason: '합성 테스트' }));
  assert.equal(await revision(), 4);
  assert.equal((await staged.collection('erpReviewState').doc('policy').get()).get('agedDays'), 20);
  assert.equal((await company.collection('erpReviewState').doc('policy').get()).exists, false);

  // Either the business write wins or the reviewed revision is activated.
  // They must never both succeed from the same starting revision.
  const same = await company.get();
  const current = routeDatabase(db, { companyId, company: same.data() });
  const marker = staged.collection('erpAudit').doc('concurrent');
  const race = await Promise.allSettled([
    current.runTransaction(async tx => { tx.create(marker, { companyId }); }),
    db.runTransaction(async tx => {
      const atSwitch = await tx.get(company);
      if (atSwitch.get('erpLedgerWriteRevision') !== 4) throw Error('source changed');
      tx.update(company, { erpActiveLedgerVersion: 'new-v2', erpLedgerWriteRevision: 5 });
    }),
  ]);
  assert.equal(race.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(await revision(), 5);
  assert.equal((await marker.get()).exists, race[0].status === 'fulfilled');
});
