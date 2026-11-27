const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp, GeoPoint } = require('firebase-admin/firestore');
const { readLedger, ledgerFingerprint, prepareBackup, verifyBackupInTransaction } = require('../erp-bootstrap-backup');

// Keeps native field types and missing ancestor documents. Only this test's isolated map is used.
function memoryDatabase() {
  const data = new Map();
  let tick = 0;
  let failWrites = false;
  const descendants = path => [...new Set([...data.keys()].filter(k => k.startsWith(path + '/'))
    .map(k => k.slice(path.length + 1).split('/')[0]))];
  const doc = path => ({
    path, id: path.split('/').at(-1), collection: name => col(path + '/' + name),
    get: async () => snapshot(path), listCollections: async () => descendants(path).map(name => col(path + '/' + name)),
    toProto: () => ({ referenceValue: 'projects/demo/databases/(default)/documents/' + path }),
  });
  const col = path => ({
    id: path.split('/').at(-1), path, doc: id => doc(path + '/' + id),
    listDocuments: async () => descendants(path).map(id => doc(path + '/' + id)),
    get: async () => ({ docs: descendants(path).map(id => snapshot(path + '/' + id)).filter(snap => snap.exists) }),
  });
  function snapshot(path) {
    const entry = data.get(path);
    return { ref: doc(path), id: path.split('/').at(-1), exists: !!entry, data: () => entry?.data,
      createTime: entry?.created, updateTime: entry?.updated };
  }
  function store(path, fields) {
    const time = Timestamp.fromMillis(++tick * 1000);
    data.set(path, { data: fields, created: data.get(path)?.created || time, updated: time });
  }
  const db = {
    doc, getAll: async (...refs) => Promise.all(refs.map(r => r.get())),
    runTransaction: async fn => {
      const staged = [];
      const out = await fn({ get: ref => ref.get(), getAll: db.getAll,
        create: (ref, value) => staged.push([ref.path, value]) });
      for (const [path] of staged) {
        if (data.has(path)) throw Error('document already exists');
        if (failWrites && path.includes('/restoredLedger/')) throw Error('injected replica failure');
      }
      for (const [path, value] of staged) store(path, value);
      return out;
    },
  };
  return { db, store, data, failReplica: () => { failWrites = true; }, resume: () => { failWrites = false; } };
}

function fixture() {
  const env = memoryDatabase(), parent = env.db.doc('companies/testco');
  function row(name, fields) { env.store(parent.path + '/' + name, { companyId: parent.id, ...fields }); }
  row('erpInventory/b', { itemId: 'part', warehouseId: 'hq', quantity: 2.5, value: 500 });
  row('erpItems/set', { itemType: 'BUNDLE', components: [{ itemId: 'part', quantityScaled: 20000 }, { itemId: 'part2', quantityScaled: 10000 }] });
  row('erpItems/part', { itemType: 'STOCK', pendingOpening: { status: 'PENDING_COST', quantity: 7, basisDate: '2026-01-01' } });
  row('erpReceipts/open', { type: 'OPENING_RECEIVABLE', amountMinor: 1000, date: '2026-01-01', currency: 'KRW', partnerId: 'p', documentNo: 'o1' });
  row('erpReceipts/paid', { type: 'RECEIPT', amountMinor: 400, date: '2026-01-03', currency: 'KRW', partnerId: 'p' });
  row('erpMonthCloses/close', { closed: true, archivedAt: Timestamp.fromMillis(7750), objectPath: 'erp/archives/close.pdf' });
  row('erpApprovals/a', { status: 'APPROVED', source: parent.collection('erpInventory').doc('b'), checksum: Buffer.from('test'), location: new GeoPoint(37, 127) });
  // This path has no intermediate document at erpDocuments/missing.
  row('erpDocuments/missing/versions/old', { revision: 1 });
  env.store('companies/other/erpInventory/x', { companyId: 'other', quantity: 12 });
  return { ...env, parent, row, options: { db: env.db, parent, jobId: 'opening-test', actorId: 'admin-test' } };
}

test('immutable archive restores all six business controls, orphan descendants and native fields; repeat is idempotent', async () => {
  const f = fixture();
  const active = await readLedger({ parent: f.parent });
  const result = await prepareBackup(f.options);
  assert.equal(result.reconciliation.documentCount, 8);
  assert.deepEqual(Object.values(result.reconciliation.checks).map(x => x.count), [1, 1, 1, 1, 1, 1]);
  const backup = f.parent.collection('erpBootstrapBackups').doc(result.id);
  const clone = backup.collection('restoredLedger').doc('testco');
  assert.equal(ledgerFingerprint(await readLedger({ parent: clone })), ledgerFingerprint(active));
  const approval = (await clone.collection('erpApprovals').doc('a').get()).data();
  assert.equal(approval.source.path, 'companies/testco/erpInventory/b');
  assert(approval.checksum.equals(Buffer.from('test')));
  assert(approval.location.isEqual(new GeoPoint(37, 127)));
  assert.equal((await clone.collection('erpMonthCloses').doc('close').get()).data().archivedAt.toMillis(), 7750);
  assert.equal((await clone.collection('erpDocuments').doc('missing').collection('versions').doc('old').get()).data().revision, 1);
  assert.equal((await f.db.doc('companies/other/erpInventory/x').get()).data().quantity, 12);
  const n = f.data.size;
  assert.deepEqual(await prepareBackup(f.options), result);
  assert.equal(f.data.size, n);
  const confirmed = await f.db.runTransaction(tx => verifyBackupInTransaction({ tx, parent: f.parent, jobId: 'opening-test', backupId: result.id }));
  assert.equal(ledgerFingerprint(confirmed), result.fingerprint);
  await assert.rejects(f.db.runTransaction(tx => verifyBackupInTransaction({ tx, parent: f.parent, jobId: 'other-job', backupId: result.id })), /원장과 백업/);
  f.row('erpInventory/b', { itemId: 'part', quantity: 3, value: 500 });
  await assert.rejects(f.db.runTransaction(tx => verifyBackupInTransaction({ tx, parent: f.parent, jobId: 'opening-test', backupId: result.id })), /원장이 변경/);
  assert.equal((await clone.collection('erpInventory').doc('b').get()).data().quantity, 2.5);
});

test('interrupted clone leaves no verified manifest, preserves source and resumes without overwriting archive', async () => {
  const f = fixture(), before = ledgerFingerprint(await readLedger({ parent: f.parent }));
  f.failReplica();
  await assert.rejects(prepareBackup(f.options), /injected/);
  assert.equal((await f.parent.collection('erpBootstrapBackups').get()).docs.length, 0);
  assert.equal(before, ledgerFingerprint(await readLedger({ parent: f.parent })));
  f.resume();
  const r = await prepareBackup(f.options);
  const backup = f.parent.collection('erpBootstrapBackups').doc(r.id);
  f.store(backup.path + '/archive/testco/erpInventory/b', { companyId: 'testco', quantity: 44 });
  await assert.rejects(prepareBackup(f.options), /일치하지/);
  assert.equal((await f.parent.collection('erpInventory').doc('b').get()).data().quantity, 2.5);
});

test('scope, tenant changes and new table types stop a reset before a verified manifest is created', async () => {
  const f = fixture();
  await assert.rejects(prepareBackup({ ...f.options, expectedFingerprint: 'stale' }), /원장이 변경/);
  await assert.rejects(prepareBackup({ ...f.options, collections: ['erpItems'] }), /백업 대상/);
  f.row('erpInventory/b', { companyId: 'other' });
  await assert.rejects(prepareBackup(f.options), /회사 연결/);
  f.store('companies/testco/erpNewTable/x', { companyId: 'testco' });
  await assert.rejects(prepareBackup(f.options), /미등록/);
});

test('real Firestore restores and reconciles a nested company ledger, native timestamp, bytes and document reference',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
    assert.match(process.env.FIRESTORE_EMULATOR_HOST, /^127\.0\.0\.1:\d+$/);
    const { Firestore } = require('@google-cloud/firestore');
    const { randomUUID } = require('node:crypto');
    const db = new Firestore({ projectId: 'demo-bootstrap-protection-test', ignoreUndefinedProperties: false });
    const company = db.collection('companies').doc('clone-' + randomUUID());
    const item = company.collection('erpItems').doc('unit');
    const set = company.collection('erpItems').doc('set');
    const nested = company.collection('erpDocuments').doc('missing').collection('versions').doc('v1');
    const approval = company.collection('erpApprovals').doc('approval');
    const at = new Timestamp(1700000012, 345678000);
    const receipt = company.collection('erpReceipts').doc('open');
    try {
      const input = db.batch();
      input.create(item, { companyId: company.id, itemType: 'STOCK', pendingOpening: { status: 'PENDING_COST', quantity: 2 } });
      input.create(set, { companyId: company.id, itemType: 'BUNDLE', components: [{ itemId: 'unit', quantityScaled: 10000 }, { itemId: 'part2', quantityScaled: 10000 }] });
      input.create(company.collection('erpInventory').doc('stock'), { companyId: company.id, itemId: 'unit', warehouseId: 'w', quantity: 2, value: 100 });
      input.create(receipt, { companyId: company.id, type: 'OPENING_RECEIVABLE', partnerId: 'p', documentNo: 'doc', currency: 'KRW', amountMinor: 1234, date: '2026-01-01' });
      input.create(company.collection('erpMonthCloses').doc('jan'), { companyId: company.id, sealed: at });
      input.create(approval, { companyId: company.id, source: item, data: Buffer.from('fixture'), at });
      input.create(nested, { revision: 1, companyId: company.id });
      await input.commit();
      const opts = { db, parent: company, jobId: 'pilot', actorId: 'admin' };
      const { id, reconciliation } = await prepareBackup(opts);
      assert.equal(reconciliation.documentCount, 7);
      assert.deepEqual(Object.values(reconciliation.checks).map(check => check.count), [1, 1, 1, 1, 1, 1]);
      const backup = company.collection('erpBootstrapBackups').doc(id);
      const restored = backup.collection('restoredLedger').doc(company.id);
      const copy = (await restored.collection('erpApprovals').doc('approval').get()).data();
      assert(copy.at.isEqual(at)); assert(copy.source.isEqual(item)); assert(copy.data.equals(Buffer.from('fixture')));
      const deep = await restored.collection('erpDocuments').doc('missing').collection('versions').doc('v1').get();
      assert.equal(deep.data().revision, 1);
      assert.equal((await prepareBackup(opts)).id, id);
      await db.runTransaction(tx => verifyBackupInTransaction({ tx, parent: company, jobId: 'pilot', backupId: id }));
      await receipt.update({ amountMinor: 999 });
      await assert.rejects(db.runTransaction(tx => verifyBackupInTransaction({ tx, parent: company, jobId: 'pilot', backupId: id })), /원장이 변경/);
      assert.equal((await restored.collection('erpReceipts').doc('open').get()).data().amountMinor, 1234);
    } finally {
      await db.recursiveDelete(company);
      await db.terminate();
    }
  });

test('paged version backup resumes, retains orphan and exact Firestore numeric types, and rejects later ledger changes',
  { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
    assert.match(process.env.FIRESTORE_EMULATOR_HOST, /^127\.0\.0\.1:\d+$/);
    const { Firestore } = require('@google-cloud/firestore');
    const { randomUUID } = require('node:crypto');
    const { inspectVersion, prepareVersionBackup, verifyVersionBackup, ledgerPage } = require('../erp-bootstrap-backup');
    const { ledgerParent } = require('../erp-version-routing');
    const db = new Firestore({ projectId: 'demo-erp-version-backup-integration' });
    const company = db.collection('companies').doc('replica-' + randomUUID());
    const sourceVersion = 'activeVersion1', sourceRevision = 7;
    const sourceRoot = ledgerParent(company, sourceVersion);
    try {
      await company.create({ status:'ACTIVE', erpActiveLedgerVersion: sourceVersion, erpLedgerWriteRevision: sourceRevision });
      const input = db.batch();
      for (let i = 0; i < 65; i++) input.create(sourceRoot.collection('erpItems').doc('i' + i), {
        companyId:company.id, name:'합성', revision:i + 1, itemType:i === 0 ? 'BUNDLE' : 'STOCK',
        ...(i === 1 ? {pendingOpening:{status:'PENDING_COST',quantity:7}} : {})
      });
      input.create(sourceRoot.collection('erpInventory').doc('w'),{companyId:company.id,quantity:2.5,value:500});
      input.create(sourceRoot.collection('erpReceipts').doc('r'),{companyId:company.id,type:'OPENING_RECEIVABLE',
        documentNo:'opening',date:'2026-01-01',partnerId:'p',currency:'KRW',amountMinor:123});
      await input.commit();
      const deep = sourceRoot.collection('erpDocuments').doc('missing').collection('detail').doc('v');
      await db.request('commit', { database:db.formattedName, writes:[{update:{name:deep.toProto().referenceValue,
        fields:{exact:{doubleValue:1},large:{integerValue:'9007199254740993'}}},currentDocument:{exists:false}}] }, 'test-native-data');
      const source = { db, companyRef:company, sourceRoot, sourceVersion, sourceRevision };
      const before = await inspectVersion(source);
      assert.equal(before.documentCount,68);
      assert.equal(before.maxMasterRevision,65);
      assert.equal(before.metrics.inventoryQuantity,2.5);
      assert.equal(before.metrics.pendingQuantity,7);
      assert.deepEqual(before.metrics.receivableTotals,[{currency:'KRW',amountMinor:123}]);
      const options = {...source, jobId:'test-job', actorId:'admin-test',expectedInspection:before,expectedFingerprint:before.fingerprint};
      let clockTick = 0;
      const partial = await prepareVersionBackup({...options,deadlineMs:1,currentMillis:()=>clockTick++});
      assert.equal(partial.pending,true);
      assert.ok(partial.copied > 0 && partial.copied < before.documentCount);
      await company.update({status:'DELETING'});
      await assert.rejects(prepareVersionBackup(options),/원장이 변경/);
      await company.update({status:'ACTIVE'});
      const verified = await prepareVersionBackup(options);
      assert.equal(verified.reconciliation.documentCount,68);
      assert.equal(verified.id,partial.id);
      const clone = company.collection('erpBootstrapBackups').doc(verified.id).collection('restoredLedger').doc(company.id);
      const page = await ledgerPage({db,root:clone,collection:'erpDocuments'});
      assert.equal(page.rows.length,1);
      assert.equal(page.rows[0].path,'erpDocuments/missing/detail/v');
      assert.equal(page.rows[0].fields.exact.doubleValue,1);
      assert.equal(String(page.rows[0].fields.large.integerValue),'9007199254740993');
      assert.equal((await prepareVersionBackup(options)).id,verified.id);
      const verify = () => db.runTransaction(tx=>verifyVersionBackup({...options,tx,backupId:verified.id}));
      assert.equal((await verify()).id,verified.id);
      await company.update({erpLedgerWriteRevision:8});
      await assert.rejects(verify(),/원장이 변경/);
    } finally {
      await db.recursiveDelete(company);
      await db.terminate();
    }
  });
