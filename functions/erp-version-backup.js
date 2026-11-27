const { FieldPath, Query } = require('@google-cloud/firestore');
const { salesEvents, paymentEvents, summarize } = require('./erp-finance-model');
const { fail } = require('./security-context');

const PAGE_SIZE = 32;
const REFERENCE_NAME_MIN_ID = '__id-9223372036854775808__';
const controls = new Set(['erpBootstrapBackups', 'erpBootstrapJobs', 'erpLedgerVersions']);

module.exports = function versionBackup({ LEDGER_COLLECTIONS, cmp, digest, sha, numericFingerprint, childDoc, saveRows, mismatch, changed }) {
  const emptyHash = digest('erp-version-source-v2');
  const checkNames = ['inventory', 'receivables', 'bundles', 'pendingCosts', 'monthCloses', 'approvals'];

  async function presentCollections(root) {
    const children = await root.listCollections();
    const seen = new Set(children.map(ref => ref.id));
    for (const name of seen) {
      if (/^erp[A-Z]/.test(name) && !controls.has(name) && !LEDGER_COLLECTIONS.includes(name)) {
        fail('failed-precondition', '미등록 ERP 컬렉션이 있어 전체 이관을 중단했습니다.');
      }
    }
    return LEDGER_COLLECTIONS.filter(name => seen.has(name));
  }

  // Use the same kindless descendant query and name bounds as the pinned Admin
  // SDK's recursiveDelete implementation. This includes children of missing
  // documents without listing every individual document's subcollections.
  async function ledgerPage({ db, root, collection, lastPath = '', pageSize = PAGE_SIZE }) {
    if (!LEDGER_COLLECTIONS.includes(collection) || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 128 ||
        (lastPath && !lastPath.startsWith(collection + '/'))) mismatch();
    const name = FieldPath.documentId();
    const QueryOptions = root.collection(collection)._queryOptions.constructor;
    let query = new Query(db, QueryOptions.forKindlessAllDescendants(root._resourcePath, collection))
      .where(name, '>=', collection + '/' + REFERENCE_NAME_MIN_ID)
      .where(name, '<', collection + String.fromCharCode(0) + '/' + REFERENCE_NAME_MIN_ID)
      .orderBy(name).select(name).limit(pageSize);
    if (lastPath) query = query.startAfter(childDoc(root, lastPath));
    const listed = await query.get();
    if (!listed.size) return { rows: [], done: true };
    const snaps = await db.getAll(...listed.docs.map(doc => doc.ref));
    const byPath = new Map(snaps.map(doc => [doc.ref.path, doc]));
    const rows = listed.docs.map(listedDoc => {
      const doc = byPath.get(listedDoc.ref.path);
      if (!doc?.exists) changed();
      const path = doc.ref.path.slice(root.path.length + 1);
      if (!doc.ref.path.startsWith(root.path + '/') || !path.startsWith(collection + '/')) mismatch();
      const data = doc.data();
      if ((data.companyId !== undefined && data.companyId !== root.id) ||
          (data.tenantId !== undefined && data.tenantId !== root.id)) {
        fail('failed-precondition', '백업 대상 문서의 회사 연결을 확인해 주세요.');
      }
      return { path, ref: doc.ref, data, digest: digest(data), numericFingerprint: numericFingerprint(doc),
        fields: doc.toDocumentProto().fields, createTime: doc.createTime, updateTime: doc.updateTime };
    });
    return { rows, done: listed.size < pageSize };
  }

  function extend(hash, row) {
    return digest([hash, row.path, row.digest, row.numericFingerprint, row.createTime, row.updateTime]);
  }

  async function checkFence(companyRef, sourceVersion, sourceRevision, tx) {
    const { activeVersion, writeRevision } = require('./erp-version-routing');
    const company = tx ? await tx.get(companyRef) : await companyRef.get();
    if (!company.exists || company.get('status') !== 'ACTIVE' ||
        activeVersion(company.data()) !== sourceVersion || writeRevision(company.data()) !== sourceRevision) changed();
  }

  function checkRoot(companyRef, sourceRoot, sourceVersion) {
    const { ledgerParent } = require('./erp-version-routing');
    if (ledgerParent(companyRef, sourceVersion).path !== sourceRoot.path || sourceRoot.id !== companyRef.id) mismatch();
  }

  function add(a, b) {
    const sum = a + b;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(sum)) {
      fail('failed-precondition', '원장 대사 수량 또는 금액 범위를 확인해 주세요.');
    }
    return sum;
  }

  const financeKeys = ['type', 'direction', 'bundleParentId', 'partnerId', 'partnerName', 'currency', 'supply', 'tax',
    'documentNo', 'date', 'operationType', 'sourceId', 'refundSupply', 'refundTax', 'amountMinor', 'reference'];

  // Full payloads live only for the current page. Keep just the financial keys
  // needed to resolve cancellations and sales returns in the shared AR model.
  async function inspectVersion({ db, companyRef, sourceRoot, sourceVersion, sourceRevision }) {
    checkRoot(companyRef, sourceRoot, sourceVersion);
    await checkFence(companyRef, sourceVersion, sourceRevision);
    const names = await presentCollections(sourceRoot);
    const checks = Object.fromEntries(checkNames.map(key => [key, { count: 0, digest: digest([]) }]));
    const movements = [], receipts = [];
    let documentCount = 0, fingerprint = emptyHash, maxMasterRevision = 0;
    let ownedScaled = 0, inventoryValue = 0, pendingScaled = 0, pendingUnknownCount = 0, monthCloseCount = 0, approvalCount = 0;
    function remember(key, row) {
      checks[key].count++;
      checks[key].digest = digest([checks[key].digest, row.path, row.digest]);
    }
    for (const collection of names) {
      let lastPath = '';
      for (;;) {
        const { rows, done } = await ledgerPage({ db, root: sourceRoot, collection, lastPath });
        for (const row of rows) {
          documentCount++;
          fingerprint = extend(fingerprint, row);
          const parts = row.path.split('/');
          const top = parts.length === 2, data = row.data;
          if (top && ['erpItems', 'erpPartners', 'erpWarehouses'].includes(collection)) {
            const revision = data.revision ?? 0;
            if (!Number.isSafeInteger(revision) || revision < 0) mismatch();
            maxMasterRevision = Math.max(maxMasterRevision, revision);
          }
          if (collection === 'erpInventory') {
            remember('inventory', row);
            if (top) {
              ownedScaled = add(ownedScaled, Math.round((data.quantity ?? 0) * 10000));
              inventoryValue = add(inventoryValue, data.value ?? 0);
            }
          }
          if (top && collection === 'erpItems') {
            if (data.itemType === 'BUNDLE') remember('bundles', row);
            if (data.pendingOpening?.status === 'PENDING_COST') {
              remember('pendingCosts', row);
              if (data.pendingOpening.quantity == null) pendingUnknownCount++;
              else pendingScaled = add(pendingScaled, Math.round(data.pendingOpening.quantity * 10000));
            }
          }
          if (['erpMonthCloses', 'erpCloseMonths', 'erpClosePlans', 'erpCloseChecklists', 'erpGovernance'].includes(collection)) {
            remember('monthCloses', row);
            if (top && collection === 'erpMonthCloses') monthCloseCount++;
          }
          if (['erpApprovals', 'erpChangeHistory', 'erpReviewConfirmations', 'erpAudit'].includes(collection)) {
            remember('approvals', row);
            if (top && collection === 'erpApprovals') approvalCount++;
          }
          if (top && (collection === 'erpReceipts' || collection === 'erpMovements')) {
            const compact = { id: parts[1], partnerName: '' };
            for (const key of financeKeys) if (Object.hasOwn(data, key)) compact[key] = data[key];
            (collection === 'erpReceipts' ? receipts : movements).push(compact);
          }
        }
        if (done) break;
        lastPath = rows.at(-1).path;
      }
    }
    const report = summarize([...salesEvents(movements), ...paymentEvents(receipts)], '0001-01-01', '9999-12-31')
      .map(row => [row.partnerId, row.currency, row.balance]).sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
    checks.receivables = { count: report.length, digest: digest(report) };
    const money = new Map();
    for (const [, currency, balance] of report) money.set(currency, add(money.get(currency) || 0, balance));
    await checkFence(companyRef, sourceVersion, sourceRevision);
    if (digest(await presentCollections(sourceRoot)) !== digest(names)) changed();
    return { documentCount, fingerprint, maxMasterRevision, metrics: { inventoryQuantity: ownedScaled / 10000, inventoryValue,
      receivableTotals: [...money].sort((a,b) => cmp(a[0],b[0])).map(([currency, amountMinor]) => ({currency,amountMinor})),
      bundleCount: checks.bundles.count, pendingQuantity: pendingScaled / 10000, pendingUnknownCount, monthCloseCount, approvalCount },
      reconciliation: { verified: true, documentCount, checks } };
  }

  // Preserve the Firestore wire values. Writing snapshot.data() through the JS
  // serializer could turn a double 1.0 into int64 1, or round a large int64.
  // Keep the exact wire fields in the pinned SDK's transactional Write queue.
  // The transaction also reads the company fence so tenant deletion, source
  // edits or a version switch cannot race a late archive write.
  async function writeNative(db, target, rows, verifyScope) {
    let pending = [], size = 0;
    async function flush() {
      if (!pending.length) return;
      const refs = pending.map(row => childDoc(target, row.path));
      await db.runTransaction(async tx => {
        await verifyScope(tx);
        const snapshots = await tx.getAll(...refs);
        const known = new Map(snapshots.map(doc => [doc.ref.path, doc]));
        pending.forEach((row, i) => {
          const snap = known.get(refs[i].path);
          if (snap?.exists) {
            if (digest(snap.data()) !== row.digest || numericFingerprint(snap) !== row.numericFingerprint) mismatch();
          } else {
            if (!Array.isArray(tx._writeBatch?._ops)) {
              fail('failed-precondition', 'Firestore 원본 형식을 보존할 수 없어 백업을 중단했습니다.');
            }
            tx._writeBatch._ops.push({ docPath: refs[i].path, op: () => ({
              update: { name: refs[i].toProto().referenceValue, fields: row.fields }, currentDocument: { exists: false }
            }) });
          }
        });
      });
      pending = []; size = 0;
    }
    for (const row of rows) {
      const bytes = Buffer.byteLength(JSON.stringify(row.fields), 'utf8') + Buffer.byteLength(row.path) + 1024;
      if (size + bytes > 3000000) await flush();
      pending.push(row); size += bytes;
    }
    await flush();
  }

  async function verifiedCopies(db, target, rows) {
    const snapshots = await db.getAll(...rows.map(row => childDoc(target, row.path)));
    const byPath = new Map(snapshots.map(doc => [doc.ref.path, doc]));
    return rows.map(row => {
      const snap = byPath.get(target.path + '/' + row.path);
      if (!snap?.exists || digest(snap.data()) !== row.digest || numericFingerprint(snap) !== row.numericFingerprint) mismatch();
      return { ...row, fields: snap.toDocumentProto().fields };
    });
  }

  function confirmed(data, companyRef, sourceVersion, sourceRevision, jobId, backupId, expectedFingerprint) {
    if (!data || data.schema !== 2 || data.id !== backupId || data.companyId !== companyRef.id ||
        data.jobId !== jobId || data.sourceVersion !== sourceVersion || data.sourceRevision !== sourceRevision ||
        data.status !== 'VERIFIED' || data.reconciliation?.verified !== true || data.fingerprint !== expectedFingerprint) mismatch();
    return { id: data.id, fingerprint: data.fingerprint, counts: data.counts, reconciliation: data.reconciliation };
  }

  async function prepareVersionBackup({ db, companyRef, sourceRoot, sourceVersion, sourceRevision, jobId, actorId,
    expectedFingerprint, expectedInspection, deadlineMs = Infinity, now = () => new Date(), currentMillis = Date.now }) {
    checkRoot(companyRef, sourceRoot, sourceVersion);
    await checkFence(companyRef, sourceVersion, sourceRevision);
    const id = sha(JSON.stringify(['erp-backup-v2', companyRef.id, sourceVersion, sourceRevision, jobId, expectedFingerprint]));
    const backup = companyRef.collection('erpBootstrapBackups').doc(id);
    const manifest = await backup.get();
    if (manifest.exists) return confirmed(manifest.data(), companyRef, sourceVersion, sourceRevision, jobId, id, expectedFingerprint);
    const inspected = expectedInspection || await inspectVersion({ db, companyRef, sourceRoot, sourceVersion, sourceRevision });
    if (inspected.fingerprint !== expectedFingerprint || !inspected.reconciliation?.verified) changed();
    const archive = backup.collection('archive').doc(companyRef.id), restored = backup.collection('restoredLedger').doc(companyRef.id);
    const verifyScope = tx => checkFence(companyRef, sourceVersion, sourceRevision, tx);
    const progress = backup.collection('progress').doc('copy');
    const names = await presentCollections(sourceRoot);
    const initial = { page: 0, index: 0, lastPath: '', count: 0, hash: emptyHash,
      counts: Object.fromEntries(LEDGER_COLLECTIONS.map(key => [key, 0])) };
    let cursor = (await progress.get()).data() || initial;
    while (cursor.index < names.length) {
      if (currentMillis() >= deadlineMs) return { pending: true, id, copied: cursor.count, total: inspected.documentCount };
      const collection = names[cursor.index];
      const { rows, done } = await ledgerPage({ db, root: sourceRoot, collection, lastPath: cursor.lastPath });
      if (rows.length) {
        await writeNative(db, archive, rows, verifyScope);
        await saveRows(db, rows.map(row => ({ ref: backup.collection('sourceVersions').doc(sha(row.path)),
          data: { path: row.path, createTime: row.createTime, updateTime: row.updateTime } })), verifyScope);
        const archived = await verifiedCopies(db, archive, rows);
        await writeNative(db, restored, archived, verifyScope);
        await verifiedCopies(db, restored, archived);
      }
      const next = { page: cursor.page + 1, index: done ? cursor.index + 1 : cursor.index, lastPath: done ? '' : rows.at(-1).path,
        count: cursor.count + rows.length, hash: rows.reduce(extend, cursor.hash), counts: {...cursor.counts, [collection]: cursor.counts[collection] + rows.length} };
      cursor = await db.runTransaction(async tx => {
        const stored = (await tx.get(progress)).data() || initial;
        await checkFence(companyRef, sourceVersion, sourceRevision, tx);
        if (stored.page !== cursor.page) return stored;
        tx.set(progress, next);
        return next;
      });
    }
    if (cursor.hash !== expectedFingerprint || cursor.count !== inspected.documentCount ||
        digest(await presentCollections(sourceRoot)) !== digest(names)) changed();
    return db.runTransaction(async tx => {
      await checkFence(companyRef, sourceVersion, sourceRevision, tx);
      const existing = await tx.get(backup);
      const facts = existing.exists ? existing.data() : {schema: 2, status:'VERIFIED', id, companyId:companyRef.id,
        jobId, sourceVersion, sourceRevision, fingerprint:cursor.hash, counts:cursor.counts, reconciliation:inspected.reconciliation,
        createdBy:actorId, verifiedAt:now().toISOString()};
      const result = confirmed(facts, companyRef, sourceVersion, sourceRevision, jobId, id, expectedFingerprint);
      if (!existing.exists) tx.create(backup, facts);
      return result;
    });
  }

  async function verifyVersionBackup({ tx, companyRef, sourceVersion, sourceRevision, jobId, backupId, expectedFingerprint }) {
    await checkFence(companyRef, sourceVersion, sourceRevision, tx);
    const doc = await tx.get(companyRef.collection('erpBootstrapBackups').doc(backupId));
    return confirmed(doc.data(), companyRef, sourceVersion, sourceRevision, jobId, backupId, expectedFingerprint);
  }
  return { inspectVersion, prepareVersionBackup, verifyVersionBackup, presentCollections, ledgerPage };
};
