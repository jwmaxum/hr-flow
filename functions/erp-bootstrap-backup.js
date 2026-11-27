const { createHash } = require('node:crypto');
const { fail } = require('./security-context');
const { salesEvents, paymentEvents, summarize } = require('./erp-finance-model');

const BACKUPS = 'erpBootstrapBackups';
const LEDGER_COLLECTIONS = Object.freeze([
  'erpApprovals', 'erpAudit', 'erpBorrowings', 'erpChangeHistory', 'erpCloseChecklists',
  'erpCloseMonths', 'erpClosePlans', 'erpCorrections', 'erpCustodyJobs', 'erpCustodyLots',
  'erpDocuments', 'erpGovernance', 'erpImportReceipts', 'erpImports', 'erpInventory',
  'erpIssueAllocations', 'erpIssueCounters', 'erpIssuedDocuments', 'erpItems', 'erpKeys',
  'erpMonthCloses', 'erpMovementLinks', 'erpMovements', 'erpPartners', 'erpPrintSettings',
  'erpReceiptJobs', 'erpReceipts', 'erpReviewConfirmations', 'erpReviewInbox', 'erpReviewState',
  'erpSettlementJobs', 'erpSettlements', 'erpState', 'erpWarehouses',
]);
const mismatch = () => fail('failed-precondition', '원장과 백업 복원본이 일치하지 않아 이관을 중단했습니다.');
const changed = () => fail('failed-precondition', '미리보기 이후 기존 ERP 원장이 변경되었습니다. 다시 검증해 주세요.');
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sha = text => createHash('sha256').update(text).digest('hex');

// Type tags prevent a string or user-supplied map from matching a native Firestore value.
function canonical(value) {
  if (value === null) return ['null'];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : String(value)];
  if (['string', 'boolean', 'bigint'].includes(typeof value)) return [typeof value, String(value)];
  if (Array.isArray(value)) return ['array', value.map(canonical)];
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')];
  if (value instanceof Date) return ['time', Math.floor(value.getTime() / 1000), value.getUTCMilliseconds() * 1000000];
  if (typeof value?.toDate === 'function' && Number.isInteger(value.seconds)) return ['time', value.seconds, value.nanoseconds];
  if (Number.isFinite(value?.latitude) && Number.isFinite(value?.longitude) && typeof value.isEqual === 'function') {
    return ['geo', value.latitude, value.longitude];
  }
  if (typeof value?.path === 'string' && typeof value.collection === 'function' && typeof value.toProto === 'function') {
    return ['ref', value.toProto().referenceValue];
  }
  if (typeof value?.toArray === 'function' && typeof value.isEqual === 'function') return ['vector', canonical(value.toArray())];
  if (value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return ['map', Object.keys(value).sort(cmp).map(key => [key, canonical(value[key])])];
  }
  fail('failed-precondition', '확인할 수 없는 문서 자료형이 있어 원본을 보존했습니다.');
}
const digest = value => sha(JSON.stringify(canonical(value)));
const ordered = rows => [...rows].sort((a, b) => cmp(a.path, b.path));
const ledgerFingerprint = rows => digest(ordered(rows).map(row => [row.path, row.digest || digest(row.data)]));
const versionFingerprint = rows => digest(ordered(rows).map(row => [row.path, row.createTime || null, row.updateTime || null]));

// The Admin SDK decodes both Firestore integer and double as JS Number. Compare the
// original wire representations too, so precision loss or a changed number type
// cannot produce a verified restore. This read-only hook is covered by the SDK emulator test.
function numericFingerprint(doc) {
  if (typeof doc.toDocumentProto !== 'function') {
    if (doc.ref.firestore) fail('failed-precondition', 'Firestore 숫자 형식 검증을 사용할 수 없습니다.');
    return null;
  }
  const entries = [];
  function walk(value, path) {
    if (Object.hasOwn(value, 'integerValue')) entries.push([path, 'integer', String(value.integerValue)]);
    else if (Object.hasOwn(value, 'doubleValue')) entries.push([path, 'double', Object.is(value.doubleValue, -0) ? '-0' : String(value.doubleValue)]);
    else if (value.arrayValue) (value.arrayValue.values || []).forEach((child, i) => walk(child, [...path, i]));
    else if (value.mapValue) {
      const fields = value.mapValue.fields || {};
      for (const name of Object.keys(fields).sort(cmp)) walk(fields[name], [...path, name]);
    }
  }
  walk({ mapValue: { fields: doc.toDocumentProto().fields } }, []);
  return digest(entries);
}

async function inGroups(values, size, process) {
  for (let i = 0; i < values.length; i += size) await Promise.all(values.slice(i, i + size).map(process));
}

function checkedScope(collections) {
  const names = [...new Set(collections)].sort(cmp);
  if (names.length !== LEDGER_COLLECTIONS.length || names.some((name, i) => name !== LEDGER_COLLECTIONS[i])) {
    fail('failed-precondition', '백업 대상 ERP 컬렉션 구성을 확인해 주세요.');
  }
  return names;
}

async function readLedger({ tx, parent, collections = LEDGER_COLLECTIONS }) {
  const names = checkedScope(collections);
  // Unknown future ERP tables must be reviewed before an existing company can be reset.
  if (parent.listCollections) {
    const children = await parent.listCollections();
    const controls = new Set([BACKUPS, 'erpBootstrapJobs', 'erpLedgerVersions']);
    if (children.some(ref => /^erp[A-Z]/.test(ref.id) && !names.includes(ref.id) && !controls.has(ref.id))) {
      fail('failed-precondition', '미등록 ERP 컬렉션이 있어 전체 이관을 중단했습니다.');
    }
  }
  const rows = [];
  let level = names.map(name => parent.collection(name));
  while (level.length) {
    const parents = [];
    await inGroups(level, 12, async col => {
      const snap = tx ? await tx.get(col) : await col.get();
      for (const doc of snap.docs) {
        const data = doc.data();
        const path = doc.ref.path.slice(parent.path.length + 1);
        if ((data.companyId !== undefined && data.companyId !== parent.id) ||
            (data.tenantId !== undefined && data.tenantId !== parent.id)) {
          fail('failed-precondition', '백업 대상 문서의 회사 연결을 확인해 주세요.');
        }
        rows.push({ path, ref: doc.ref, data, digest: digest(data), numericFingerprint: numericFingerprint(doc),
          createTime: doc.createTime || null, updateTime: doc.updateTime || null });
      }
      // listDocuments includes missing parents of existing subcollections.
      parents.push(...(col.listDocuments ? await col.listDocuments() : snap.docs.map(doc => doc.ref)));
    });
    level = [];
    await inGroups(parents, 32, async ref => {
      if (ref.listCollections) level.push(...await ref.listCollections());
    });
  }
  return ordered(rows);
}

function reconciliationOf(rows) {
  const docs = name => rows.filter(row => row.path.startsWith(name + '/') && row.path.split('/').length === 2);
  const asRecords = name => docs(name).map(row => ({ ...row.data, id: row.path.split('/')[1] }));
  const report = summarize([...salesEvents(asRecords('erpMovements')), ...paymentEvents(asRecords('erpReceipts'))],
    '0001-01-01', '9999-12-31').map(row => [row.partnerId, row.currency, row.balance])
    .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  const items = docs('erpItems');
  const paths = (...names) => rows.filter(row => names.includes(row.path.split('/')[0])).map(row => [row.path, row.digest]);
  const projections = {
    inventory: paths('erpInventory'),
    receivables: report,
    bundles: items.filter(row => row.data.itemType === 'BUNDLE').map(row => [row.path, row.data.components || []]),
    pendingCosts: items.filter(row => row.data.pendingOpening?.status === 'PENDING_COST').map(row => [row.path, row.data.pendingOpening]),
    monthCloses: paths('erpMonthCloses', 'erpCloseMonths', 'erpClosePlans', 'erpCloseChecklists', 'erpGovernance'),
    approvals: paths('erpApprovals', 'erpChangeHistory', 'erpReviewConfirmations', 'erpAudit'),
  };
  const checks = Object.fromEntries(Object.entries(projections).map(([key, value]) => [key, { count: value.length, digest: digest(value) }]));
  return { verified: true, documentCount: rows.length, checks };
}

function childDoc(root, path) {
  const parts = path.split('/');
  let ref = root;
  for (let i = 0; i < parts.length; i += 2) ref = ref.collection(parts[i]).doc(parts[i + 1]);
  return ref;
}

// All writes are create-only. A retry can continue a partial archive but cannot rewrite one.
async function saveRows(db, entries, verifyScope) {
  let group = [], bytes = 0;
  async function flush() {
    if (!group.length) return;
    const pending = group;
    group = []; bytes = 0;
    await db.runTransaction(async tx => {
      if (verifyScope) await verifyScope(tx);
      const docs = tx.getAll ? await tx.getAll(...pending.map(x => x.ref)) : await Promise.all(pending.map(x => tx.get(x.ref)));
      pending.forEach((entry, i) => {
        if (docs[i].exists) {
          if (digest(docs[i].data()) !== digest(entry.data)) mismatch();
        } else tx.create(entry.ref, entry.data);
      });
    });
  }
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(canonical(entry.data))) + Buffer.byteLength(entry.ref.path) + 256;
    if (group.length >= 100 || bytes + size > 3500000) await flush();
    group.push(entry); bytes += size;
  }
  await flush();
}

async function readBack(db, root, template) {
  const rows = [];
  for (let start = 0; start < template.length; start += 64) {
    const group = template.slice(start, start + 64);
    const refs = group.map(row => childDoc(root, row.path));
    const snaps = db.getAll ? await db.getAll(...refs) : await Promise.all(refs.map(ref => ref.get()));
    snaps.forEach((snap, i) => {
      if (!snap.exists) mismatch();
      const data = snap.data();
      const fingerprint = digest(data);
      const numbers = numericFingerprint(snap);
      if (fingerprint !== group[i].digest || numbers !== group[i].numericFingerprint) mismatch();
      rows.push({ path: group[i].path, ref: snap.ref, data, digest: fingerprint, numericFingerprint: numbers });
    });
  }
  return rows;
}

async function prepareBackup({ db, parent, jobId, actorId, collections = LEDGER_COLLECTIONS, now = () => new Date(), expectedFingerprint }) {
  const scope = checkedScope(collections);
  const source = await db.runTransaction(tx => readLedger({ tx, parent, collections: scope }), { readOnly: true });
  const fingerprint = ledgerFingerprint(source);
  if (expectedFingerprint && expectedFingerprint !== fingerprint) changed();
  const versions = versionFingerprint(source);
  const id = sha(JSON.stringify(['erp-backup-v1', parent.id, jobId, fingerprint, versions]));
  const backup = parent.collection(BACKUPS).doc(id);
  const archive = backup.collection('archive').doc(parent.id);
  const clone = backup.collection('restoredLedger').doc(parent.id);
  const result = reconciliationOf(source);
  await saveRows(db, source.flatMap(row => [
    { ref: childDoc(archive, row.path), data: row.data },
    { ref: backup.collection('sourceVersions').doc(sha(row.path)), data: { path: row.path, createTime: row.createTime, updateTime: row.updateTime } },
  ]));
  const archived = await readBack(db, archive, source);
  await saveRows(db, archived.map(row => ({ ref: childDoc(clone, row.path), data: row.data })));
  const restored = await readBack(db, clone, archived);
  const cloneReconciliation = reconciliationOf(restored);
  if (ledgerFingerprint(restored) !== fingerprint || digest(cloneReconciliation) !== digest(result)) mismatch();
  const counts = Object.fromEntries(scope.map(name => [name, 0]));
  for (const row of restored) counts[row.path.split('/')[0]]++;
  const facts = { schema: 1, id, companyId: parent.id, jobId, status: 'VERIFIED', fingerprint, versions, counts, reconciliation: cloneReconciliation };
  await db.runTransaction(async tx => {
    const existing = await tx.get(backup);
    if (!existing.exists) tx.create(backup, { ...facts, createdBy: actorId, verifiedAt: now().toISOString() });
    else {
      const { createdBy, verifiedAt, ...old } = existing.data();
      if (!createdBy || !verifiedAt || digest(old) !== digest(facts)) mismatch();
    }
  });
  return { id, fingerprint, counts, reconciliation: cloneReconciliation };
}

async function verifyBackupInTransaction({ tx, parent, jobId, backupId, collections = LEDGER_COLLECTIONS }) {
  const manifest = (await tx.get(parent.collection(BACKUPS).doc(backupId))).data();
  if (!manifest || manifest.schema !== 1 || manifest.status !== 'VERIFIED' || manifest.companyId !== parent.id ||
      manifest.id !== backupId || manifest.jobId !== jobId || !manifest.reconciliation?.verified) mismatch();
  const rows = await readLedger({ tx, parent, collections });
  if (ledgerFingerprint(rows) !== manifest.fingerprint || versionFingerprint(rows) !== manifest.versions) changed();
  return rows;
}

module.exports = { LEDGER_COLLECTIONS, readLedger, ledgerFingerprint, versionFingerprint, prepareBackup, verifyBackupInTransaction,
  ...require('./erp-version-backup')({ LEDGER_COLLECTIONS, cmp, digest, sha, numericFingerprint, childDoc, saveRows, mismatch, changed }) };
