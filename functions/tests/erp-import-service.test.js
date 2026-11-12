const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createErpImportService } = require('../erp-import-service');
const { createErpService } = require('../erp-service');
const { workbook, opening, movement } = require('./erp-import-fixtures.cjs');
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) throw new Error('ERP import tests require a loopback Firestore emulator.');
process.env.METADATA_SERVER_DETECTION = 'none';
const projectId = 'demo-erp-phase2', app = initializeApp({ projectId }, 'erp-import-test'), db = getFirestore(app);
const now = () => new Date('2026-11-11T12:00:00Z'), blobs = new Map();
let sequence = 0;
const bucket = { file: (path, selector = {}) => ({
  save: async (buffer, options) => {
    if (blobs.has(path) && options.preconditionOpts?.ifGenerationMatch === 0) throw Object.assign(new Error('exists'), { code: 412 });
    blobs.set(path, { buffer: Buffer.from(buffer), metadata: { ...options.metadata, size: buffer.length, generation: String(++sequence) } });
  },
  getMetadata: async () => { if (!blobs.has(path)) throw new Error('missing source'); return [blobs.get(path).metadata]; },
  download: async () => { const stored = blobs.get(path); if (!stored || selector.generation !== stored.metadata.generation) throw new Error('missing generation'); return [stored.buffer]; },
}) };
const service = createErpImportService({ db, bucket, now }), masters = createErpService({ db, now });
const request = (data, uid = 'admin', companyId = 'a') => ({ data: { companyId, ...data }, ...(uid ? { auth: { uid, token: { auth_time: now().getTime() / 1000 } } } : {}) });
const call = (action, data = {}, uid = 'admin', companyId = 'a') => service(request({ action, ...data }, uid, companyId));
const commit = (job, uid = 'admin', companyId = 'a') => call('commit', { id: job.id, fingerprint: job.preview.fingerprint }, uid, companyId);
const opts = { allowNewItems: true, allowNewPartners: true };
const reject = (promise, code) => assert.rejects(promise, error => error.code === code);
async function preview(type = 'OPENING', rows = [opening()], options = opts, uid = 'admin', companyId = 'a', extra = {}) {
  const source = await workbook(type, rows, extra);
  return (await call('preview', { id: `import-${++sequence}`, type, source, options }, uid, companyId)).import;
}
async function reset() {
  const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  assert.equal(response.status, 200); blobs.clear();
  const batch = db.batch();
  for (const companyId of ['a','b']) batch.set(db.doc(`companies/${companyId}`), { status: 'ACTIVE', accessUntil: Timestamp.fromDate(new Date('2027-01-01')) });
  for (const [uid, role, companyId] of [['admin','ADMIN','a'],['foreign','ADMIN','b'],['member','MEMBER','a'],['manager','SUB_ADMIN','a'],['root','SUPER_ADMIN','PLATFORM']]) batch.set(db.doc(`UserProfile/${uid}`), { uid, role, companyId, status: 'ACTIVE' });
  await batch.commit();
  for (const [uid, companyId] of [['admin','a'],['foreign','b']]) await masters(request({ action: 'save', kind: 'warehouses', id: 'warehouse', expectedRevision: 0,
    values: { code: 'WH-01', name: '본사 창고', active: true, notes: '', address: '' } }, uid, companyId));
}
const stock = async (companyId = 'a') => (await db.collection(`companies/${companyId}/erpInventory`).get()).docs.map(doc => doc.data());
async function initialized() { const job = await preview(); assert.equal(job.preview.canCommit, true, JSON.stringify(job.preview.errors)); await commit(job); return job; }

test('ERP imports validate and atomically post to the authenticated company', async t => {
  try {
    await t.test('preview only saves review/source; confirmation creates masters, opening ledger and balances exactly once', async () => {
      await reset(); const job = await preview(); assert.equal(job.preview.canCommit, true, JSON.stringify(job.preview.errors));
      assert.equal((await stock()).length, 0); assert.equal((await db.collection('companies/a/erpItems').get()).size, 0);
      assert.equal((await call('list')).imports[0].id, job.id);
      assert.equal((await call('get', { id: job.id })).import.status, 'PENDING');
      const template = await call('template', { type: 'OPENING' }); assert.ok(template.base64.length > 1000);
      await reject(call('template', { type: '../secret' }), 'invalid-argument');
      await reject(call('commit', { id: job.id, fingerprint: 'forged' }), 'failed-precondition');
      assert.equal(job.preview.rows[0].afterQuantity, 10); assert.equal(job.preview.rows[0].afterValue, 1000);
      const results = await Promise.all([commit(job), commit(job)]);
      assert.equal(results.filter(r => r.idempotent).length, 1); assert.equal((await stock())[0].quantity, 10);
      assert.equal((await db.collection('companies/a/erpMovements').get()).size, 1);
      assert.equal((await db.collection('companies/a/erpItems').get()).docs[0].data().purchasePrice, 0);
      const original = await call('downloadSource', { id: job.id }); assert.equal(original.name, job.source.name);
      await reject(call('cancel', { id: job.id }), 'failed-precondition');
      const repeated = await preview(); assert.equal(repeated.preview.canCommit, false);
      await reject(commit(repeated), 'failed-precondition');
      const renamed = await preview('OPENING', [opening({ 15: '새 파일로 저장' })]); assert.equal(renamed.preview.canCommit, false);
    });
    await t.test('same codes in two companies store independent quantities and reject ID/company/role tampering', async () => {
      await reset(); const a = await initialized();
      const b = await preview('OPENING', [opening({ 2: '다른 회사 품목', 10: 30, 12: 9000 })], opts, 'foreign', 'b'); await commit(b, 'foreign', 'b');
      assert.equal((await stock())[0].value, 1000); assert.equal((await stock('b'))[0].value, 270000);
      for (const action of ['get','cancel','downloadSource']) await reject(call(action, { id: a.id }, 'foreign', 'a'), 'permission-denied');
      await reject(call('get', { id: a.id }, 'foreign', 'b'), 'not-found');
      for (const uid of [null,'member','manager','root']) await reject(call('list', {}, uid), uid ? 'permission-denied' : 'unauthenticated');
      await reject(call('commit', { id: a.id, fingerprint: a.preview.fingerprint, quantity: 999 }), 'invalid-argument');
      await reject(call('get', { id: '../a' }), 'invalid-argument');
    });
    await t.test('warehouse blanks and new masters require explicit choices; errors cannot partially change inventory', async () => {
      await reset(); const denied = await preview('OPENING', [opening({ 8: '', 9: '' })], {}); assert.equal(denied.preview.canCommit, false);
      const ready = await preview('OPENING', [opening({ 8: '', 9: '' })], { ...opts, defaultWarehouseId: 'warehouse' }); assert.equal(ready.preview.canCommit, true);
      await commit(ready);
      const mixed = await preview('MOVEMENTS', [movement(), movement({ 1: 2, 3: 'OUT-01', 2: '출고', 11: 999 })]);
      assert.equal(mixed.preview.canCommit, false); assert.ok(mixed.preview.errors.some(e => /재고 부족/.test(e.message)));
      await reject(commit(mixed), 'failed-precondition'); assert.equal((await stock())[0].quantity, 10);
      assert.equal((await db.collection('companies/a/erpPartners').get()).size, 0);
      await call('cancel', { id: mixed.id }); assert.equal((await call('get', { id: mixed.id })).import.status, 'CANCELLED');
    });
    await t.test('moving-average cost differs from selling price and final depletion consumes all book value', async () => {
      await reset(); await initialized();
      const trade = await preview('MOVEMENTS', [movement(), movement({ 1: 2, 2: '출고', 3: 'OUT-001', 11: 5, 12: 300 })]);
      assert.equal(trade.preview.canCommit, true, JSON.stringify(trade.preview.errors));
      assert.equal(trade.preview.rows[1].cost, 750); assert.equal(trade.preview.rows[1].supply, 1500);
      assert.equal(trade.preview.rows[1].afterValue, 2250); await commit(trade);
      assert.equal((await stock())[0].quantity, 15); assert.equal((await stock())[0].value, 2250);
      const all = await preview('MOVEMENTS', [movement({ 0: '2026-11-03', 1: 1, 2: '출고', 3: 'OUT-ALL', 11: 15, 12: 999 })]);
      assert.equal(all.preview.rows[0].cost, 2250); await commit(all); assert.equal((await stock())[0].value, 0);
      assert.equal((await stock())[0].quantity, 0); assert.equal((await db.collection('companies/a/erpPartners').get()).size, 1);
    });
    await t.test('concurrent outflows recheck preview and prevent overselling; no stale partial writes', async () => {
      await reset(); await initialized();
      const one = await preview('MOVEMENTS', [movement({ 2: '출고', 3: 'OUT-A', 11: 8 })]);
      const two = await preview('MOVEMENTS', [movement({ 2: '출고', 3: 'OUT-B', 11: 8 })]);
      const results = await Promise.allSettled([commit(one), commit(two)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.find(r => r.status === 'rejected').reason.code, 'failed-precondition');
      assert.equal((await stock())[0].quantity, 2); assert.equal((await db.collection('companies/a/erpDocuments').get()).size, 1);
    });
    await t.test('changed master, revoked session, company suspension and changed basis invalidate confirmation', async () => {
      await reset(); const openingJob = await preview();
      await db.doc('companies/a/erpWarehouses/warehouse').update({ name: '변경 창고', revision: 2 });
      await reject(commit(openingJob), 'failed-precondition'); assert.equal((await stock()).length, 0);
      await reset(); const job = await preview();
      await db.doc('companies/a').update({ status: 'SUSPENDED' }); await reject(commit(job), 'permission-denied');
      await db.doc('companies/a').update({ status: 'ACTIVE' }); await db.doc('UserProfile/admin').update({ sessionValidAfter: now().getTime() / 1000 + 1 });
      await reject(commit(job), 'unauthenticated');
      await reset(); await initialized();
      const wrongDate = await preview('MOVEMENTS', [movement()], opts, 'admin', 'a', { basisDate: '2026-10-31' }); assert.equal(wrongDate.preview.canCommit, false);
    });
    await t.test('document grouping, chronological append, duplicate re-exports and late openings are rejected', async () => {
      await reset(); await initialized();
      const badOrder = await preview('MOVEMENTS', [movement(), movement({ 3: 'SECOND', 4: 2 })]); assert.equal(badOrder.preview.canCommit, false);
      const badGroup = await preview('MOVEMENTS', [movement(), movement({ 4: 2, 2: '출고' })]); assert.equal(badGroup.preview.canCommit, false);
      const good = await preview('MOVEMENTS', [movement()]); await commit(good);
      const duplicate = await preview('MOVEMENTS', [movement({ 26: '다른 파일 이름/내용' })]); assert.equal(duplicate.preview.canCommit, false);
      const past = await preview('MOVEMENTS', [movement({ 3: 'PAST' })]); assert.equal(past.preview.canCommit, false);
      const openingJob = await preview('OPENING', [opening({ 1: 'NEW' })]); assert.equal(openingJob.preview.canCommit, false);
    });
    await t.test('explicit selection reuses a same-name partner without registration and foreign mapping is refused', async () => {
      await reset(); await initialized();
      const first = await preview('MOVEMENTS', [movement({ 18: '', 21: '' })]); await commit(first);
      const partner = (await db.collection('companies/a/erpPartners').get()).docs[0];
      const rows = [movement({ 0: '2026-11-03', 3: 'NEXT', 18: '', 21: '' })];
      const candidate = await preview('MOVEMENTS', rows, { allowNewItems: true });
      assert.equal(candidate.preview.canCommit, false); assert.equal(candidate.preview.rows[0].partnerCandidates[0].id, partner.id);
      const mapped = await preview('MOVEMENTS', rows, { ...opts, allowNewPartners: false, partnerByRow: { 10: partner.id } }); await commit(mapped);
      assert.equal((await db.collection('companies/a/erpPartners').get()).size, 1);
      const foreign = await preview('MOVEMENTS', [movement({ 0: '2026-11-04', 3: 'FORGED' })], { ...opts, partnerByRow: { 10: 'foreign-only' } }); assert.equal(foreign.preview.canCommit, false);
    });
    await t.test('200 new item rows commit atomically and request size stays below document limits', async () => {
      await reset(); const rows = Array.from({ length: 200 }, (_, i) => opening({ 0: i + 1, 1: `ITEM-${i}`, 2: `품목 ${i}` }));
      const job = await preview('OPENING', rows); assert.equal(job.preview.canCommit, true, JSON.stringify(job.preview.errors));
      await commit(job); assert.equal((await stock()).length, 200); assert.equal((await db.collection('companies/a/erpMovements').get()).size, 200);
    });
  } finally { await deleteApp(app); }
});
