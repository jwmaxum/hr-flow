const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createErpService } = require('../erp-service');

if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) throw new Error('ERP tests require a loopback Firestore emulator.');
process.env.METADATA_SERVER_DETECTION = 'none';
const projectId = 'demo-erp-phase1';
const app = initializeApp({ projectId }, 'erp-test'), db = getFirestore(app);
const now = () => new Date('2026-11-11T12:00:00Z');
const authTime = Math.floor(now().getTime() / 1000);
const service = createErpService({ db, now });
const request = (uid, data) => ({ ...(uid ? { auth: { uid, token: { auth_time: authTime, role: 'SUPER_ADMIN' } } } : {}), data });
const call = (action, values = {}, uid = 'admin', companyId = 'a') => service(request(uid, { companyId, action, ...values }));
const item = (patch = {}) => ({ code: '0001', name: '회사 품목', active: true, notes: '', specification: '규격 A', unit: 'EA', purchasePrice: 1000.5, salePrice: 2000, taxType: '과세', group: '', ...patch });
const warehouse = (patch = {}) => ({ code: 'WH-01', name: '본사 창고', address: '', active: true, notes: '', ...patch });
const partner = (patch = {}) => ({ code: 'PT-01', name: '재사용 거래처', type: 'BOTH', country: 'KR', registrationNumber: '123-45-67890', contactName: '', email: '', phone: '', address: '', active: true, notes: '', ...patch });
const save = (kind, id, values, expectedRevision = 0, uid = 'admin', companyId = 'a') => call('save', { kind, id, values, expectedRevision }, uid, companyId);
const reject = (promise, code) => assert.rejects(promise, error => error.code === code);
async function reset() {
  const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  const batch = db.batch();
  for (const id of ['a', 'b']) batch.set(db.doc(`companies/${id}`), { status: 'ACTIVE', accessUntil: Timestamp.fromDate(new Date('2027-01-01')) });
  for (const [uid, role, companyId] of [['admin', 'ADMIN', 'a'], ['foreign', 'ADMIN', 'b'], ['member', 'MEMBER', 'a'], ['manager', 'SUB_ADMIN', 'a'], ['root', 'SUPER_ADMIN', 'PLATFORM']]) {
    batch.set(db.doc(`UserProfile/${uid}`), { uid, role, companyId, status: 'ACTIVE' });
  }
  await batch.commit();
}

test('company-scoped ERP master data and inventory', async t => {
  try {
    await t.test('item search finds model and name substrings beyond the first page without leaking tenants',async()=>{
      await reset();const batch=db.batch();for(let i=0;i<260;i++)batch.set(db.doc(`companies/a/erpItems/filler-${String(i).padStart(4,'0')}`),{...item({code:`F${i}`,name:`기본 품목 ${i}`}),companyId:'a'});await batch.commit();
      await save('items','target-a',item({code:'SG-OTHER-900',name:'냉장고 OMR322BK',specification:'Model-Alpha'}));
      await save('items','target-b',item({code:'SG-OTHER-901',name:'사무용 냉장고',specification:'Model-OMR322WT'}));
      await save('items','target-hidden',item({code:'OMR322-hidden',active:false}));await save('items','target-a',item({code:'OMR322-foreign'}),0,'foreign','b');
      const first=await call('itemSearch',{search:'322'});assert.equal(first.records.length,0);assert.equal(first.scanned,250);assert.ok(first.nextCursor);
      const second=await call('itemSearch',{search:'322',cursor:first.nextCursor});assert.deepEqual(second.records.map(r=>r.id),['target-a','target-b']);assert.equal(second.nextCursor,null);
      for(const search of ['ｏｍｒ３２２','냉장','model omr']){let cursor,found=[];do{const r=await call('itemSearch',{search,...(cursor?{cursor}:{})});found.push(...r.records);cursor=r.nextCursor;}while(cursor);assert.equal(found.length,2);}
      await reject(call('itemSearch',{search:'다른',cursor:first.nextCursor}),'invalid-argument');await reject(call('itemSearch',{search:'322',cursor:{...first.nextCursor,id:'../b'}}),'invalid-argument');await reject(call('itemSearch',{search:'322'},'admin','b'),'permission-denied');await reject(call('itemSearch',{search:'322'},null),'unauthenticated');await reject(call('itemSearch',{search:'x'.repeat(121)}),'invalid-argument');
      await db.doc('UserProfile/member').update({erpAccess:'VIEW'});assert.ok((await call('itemSearch',{search:'',},'member')).records.length>0);
    });
    await t.test('companies may use identical codes with independent names and prices', async () => {
      await reset();
      await save('items', 'same-id', item());
      await save('items', 'same-id', item({ name: '다른 회사 품목', purchasePrice: 9000 }), 0, 'foreign', 'b');
      const a = await call('list', { kind: 'items' }), b = await call('list', { kind: 'items' }, 'foreign', 'b');
      assert.equal(a.records[0].name, '회사 품목'); assert.equal(a.records[0].purchasePrice, 1000.5);
      assert.equal(b.records[0].name, '다른 회사 품목'); assert.equal(b.records[0].purchasePrice, 9000);
      await reject(call('list', { kind: 'items' }, 'admin', 'b'), 'permission-denied');
      assert.equal((await db.doc('companies/a/erpItems/same-id').get()).data().companyId, 'a');
    });
    await t.test('current server identity blocks unauthenticated, platform, inactive and read-only writes', async () => {
      await reset();
      for (const uid of [null, 'root', 'missing']) await reject(call('list', { kind: 'items' }, uid), uid ? 'permission-denied' : 'unauthenticated');
      for (const uid of ['member', 'manager']) await reject(save('items', 'blocked', item(), 0, uid), 'permission-denied');
      for (const patch of [{ status: 'RESIGNED' }, { mustChangePassword: true }, { sessionValidAfter: authTime + 1 }]) {
        await reset(); await db.doc('UserProfile/admin').update(patch);
        await assert.rejects(call('list', { kind: 'items' }));
      }
      for (const patch of [{ status: 'SUSPENDED' }, { status: 'DELETING' }, { accessUntil: Timestamp.fromMillis(now().getTime()) }]) {
        await reset(); await db.doc('companies/a').update(patch);
        await reject(save('items', 'blocked', item()), 'permission-denied');
      }
    });
    await t.test('code reservations handle concurrent creation, rename and stale edits', async () => {
      await reset();
      const results = await Promise.allSettled([save('items', 'one', item()), save('items', 'two', item({ code: ' ０００１ ' }))]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.find(result => result.status === 'rejected').reason.code, 'already-exists');
      const created = results.find(result => result.status === 'fulfilled').value.record;
      const updated = await save('items', created.id, item({ code: '0002', name: '바뀐 품목', salePrice: 3000 }), 1);
      assert.equal(updated.record.revision, 2);
      await reject(save('items', created.id, item(), 1), 'aborted');
      await save('items', 'released-code', item());
      assert.equal((await call('list', { kind: 'items', search: '바뀐' })).records[0].salePrice, 3000);
      await save('items', created.id, item({ code: '0002', name: '바뀐 품목', active: false }), 2);
      assert.equal((await call('list', { kind: 'items', searchBy: 'code', search: '0002' })).records[0].active, false);
      await reject(save('items', 'reused-archived', item({ code: '0002' })), 'already-exists');
    });
    await t.test('writes recheck role and company inside the transaction', async () => {
      await reset();
      const proxy = new Proxy(db, { get(target, key) {
        if (key === 'runTransaction') return async callback => { await db.doc('UserProfile/admin').update({ role: 'MEMBER' }); return target.runTransaction(callback); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      await reject(createErpService({ db: proxy, now })(request('admin', { companyId: 'a', action: 'save', kind: 'items', id: 'race', expectedRevision: 0, values: item() })), 'permission-denied');
      assert.equal((await db.doc('companies/a/erpItems/race').get()).exists, false);
    });
    await t.test('transactional validation rejects forged stock, invalid prices and bad references', async () => {
      await reset();
      for (const values of [item({ name: '' }), item({ purchasePrice: -1 }), item({ salePrice: Infinity }), item({ salePrice: '1' }), item({ salePrice: 0.00001 }), item({ taxType: 'bad' }), item({ quantity: 10 }), item({ companyId: 'b' }), item({ unit: '' })]) {
        await reject(save('items', 'invalid', values), 'invalid-argument');
      }
      await reject(save('items', '../escape', item()), 'invalid-argument');
      await reject(call('inventory', { itemId: '../escape' }), 'invalid-argument');
      await reject(call('list', { kind: 'unknown' }), 'invalid-argument');
      await reject(call('list', { kind: 'items', searchBy: 'companyId' }), 'invalid-argument');
      assert.equal((await db.collection('companies/a/erpItems').get()).size, 0);
    });
    await t.test('partners are reusable within a company and registration duplicates are normalized', async () => {
      await reset();
      await save('partners', 'partner-a', partner());
      await reject(save('partners', 'duplicate', partner({ code: 'NEW', registrationNumber: '1234567890' })), 'already-exists');
      await save('partners', 'partner-b', partner(), 0, 'foreign', 'b');
      await save('partners', 'manual-review', partner({ code: 'NO-REG', registrationNumber: '' }));
      assert.equal((await call('list', { kind: 'partners', search: '재사용' })).records.length, 2);
      await reject(call('list', { kind: 'partners' }, 'member'), 'permission-denied');
      await reject(save('partners', 'invalid', partner({ email: 'not-an-email' })), 'invalid-argument');
      await reject(save('partners', 'invalid', partner({ country: 'KOR' })), 'invalid-argument');
    });
    await t.test('search pagination preserves same-name items without foreign company rows', async () => {
      await reset();
      const batch = db.batch();
      for (let i = 0; i < 55; i++) batch.set(db.doc(`companies/a/erpItems/item-${String(i).padStart(3, '0')}`), { ...item(), name: '동명 품목', nameKey: '동명 품목', codeKey: String(i), companyId: 'a', revision: 1 });
      await batch.commit();
      const first = await call('list', { kind: 'items', search: '동명' });
      assert.equal(first.records.length, 50); assert.ok(first.nextCursor);
      const second = await call('list', { kind: 'items', search: '동명', cursor: first.nextCursor });
      assert.equal(second.records.length, 5); assert.equal(second.nextCursor, null);
      assert.equal(new Set([...first.records, ...second.records].map(row => row.id)).size, 55);
      assert.equal((await call('list', { kind: 'items', search: '없는품목' })).records.length, 0);
    });
    await t.test('stock distinguishes missing balances and zero, aggregates warehouses and redacts cost', async () => {
      await reset(); await save('items', 'item-a', item());
      const empty = await call('inventory', { itemId: 'item-a' });
      assert.equal(empty.status, 'UNINITIALIZED'); assert.equal(empty.quantity, null); assert.equal(empty.value, null);
      await save('warehouses', 'warehouse-a', warehouse());
      await save('warehouses', 'warehouse-b', warehouse({ code: 'WH-02', name: '외부 창고' }));
      await db.doc('companies/a/erpInventory/balance-a').set({ companyId: 'a', itemId: 'item-a', warehouseId: 'warehouse-a', quantity: 0, value: 0, currency: 'KRW' });
      const zero = await call('inventory', { itemId: 'item-a' });
      assert.equal(zero.status, 'RECORDED'); assert.equal(zero.quantity, 0);
      await db.doc('companies/a/erpInventory/balance-b').set({ companyId: 'a', itemId: 'item-a', warehouseId: 'warehouse-b', quantity: 12.5, value: 15000, currency: 'KRW' });
      const stock = await call('inventory', { itemId: 'item-a' });
      assert.equal(stock.quantity, 12.5); assert.equal(stock.value, 15000); assert.equal(stock.warehouses.length, 2);
      await reject(save('items', 'item-a', item({ unit: 'BOX' }), 1), 'failed-precondition');
      await save('items', 'item-a', item({ purchasePrice: 9999, salePrice: 18000, active: false }), 1);
      const preserved = await call('inventory', { itemId: 'item-a' });
      assert.equal(preserved.quantity, 12.5); assert.equal(preserved.value, 15000); assert.equal(preserved.item.active, false);
      await reject(call('inventory', { itemId: 'item-a' }, 'member'), 'permission-denied');
      await reject(call('list', { kind: 'items' }, 'member'), 'permission-denied');
      await reject(call('inventory', { itemId: 'item-a' }, 'foreign', 'b'), 'not-found');
      await db.doc('companies/a/erpInventory/balance-b').update({ companyId: 'b' });
      await reject(call('inventory', { itemId: 'item-a' }), 'failed-precondition');
    });
    await t.test('archive retains stock and audit while foreign master IDs cannot be overwritten', async () => {
      await reset(); await save('items', 'foreign-only', item(), 0, 'foreign', 'b');
      await reject(save('items', 'foreign-only', item(), 1), 'aborted');
      await save('warehouses', 'warehouse-a', warehouse());
      await save('warehouses', 'warehouse-a', warehouse({ active: false }), 1);
      assert.equal((await db.doc('companies/a/erpWarehouses/warehouse-a').get()).data().active, false);
      assert.equal((await db.collection('companies/a/erpAudit').get()).size, 2);
    });
  } finally { await deleteApp(app); }
});
