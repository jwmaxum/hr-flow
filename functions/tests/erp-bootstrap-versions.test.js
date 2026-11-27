const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldPath } = require('firebase-admin/firestore');
const { createErpBootstrapService, CONFIRM_PHRASE } = require('../erp-bootstrap-service');
const { workbook, opening, cell } = require('./erp-import-fixtures.cjs');

const COMPANY_NAME = '대용량 검증 회사';
const LARGE_AUDIT_BYTES = 600 * 1024;
const TRANSACTION_SIZE = 10 * 1024 * 1024;

function openingRowXml(index, notes) {
  const rowNumber = index + 10;
  const values = opening({ 0: index + 1, 1: 'SKU-' + index, 2: '품목 ' + index, 15: notes });
  const cells = values.map((value, columnIndex) => {
    if (value == null) return '';
    const address = String.fromCharCode(65 + columnIndex) + rowNumber;
    if (typeof value === 'number') return `<x:c r="${address}"><x:v>${value}</x:v></x:c>`;
    return `<x:c r="${address}" t="inlineStr"><x:is><x:t>${value}</x:t></x:is></x:c>`;
  });
  return `<x:row r="${rowNumber}">${cells.join('')}</x:row>`;
}

// Replace the template's styled blank rows with as many actual Excel rows as the test requires.
async function buildOpeningWorkbook(company, itemCount) {
  return workbook('OPENING', [], {
    company,
    modifyZip: async zip => {
      const guidePath = 'xl/worksheets/sheet1.xml';
      const originalGuide = await zip.file(guidePath).async('string');
      const warehouseGuide = cell(originalGuide, 'B7', 'WH-01');
      zip.file(guidePath, cell(warehouseGuide, 'B8', '본사 창고'));
    },
    modifySheet: xml => {
      const firstDataRow = xml.indexOf('<x:row r="10"');
      const endOfRows = xml.indexOf('</x:sheetData>', firstDataRow);
      assert.ok(firstDataRow > 0 && endOfRows > firstDataRow);
      const notes = '대용량검증'.repeat(98);
      const rows = Array.from({ length: itemCount }, (_, index) => openingRowXml(index, notes));
      return xml.slice(0, firstDataRow) + rows.join('') + xml.slice(endOfRows);
    },
  });
}

async function measureLedger(ledger) {
  const pageSize = 200;
  const totals = { units: 0, inventoryValue: 0, documents: 0, jsonBytes: 0 };
  for (const collection of await ledger.listCollections()) {
    let lastId;
    while (true) {
      let query = collection.orderBy(FieldPath.documentId()).limit(pageSize);
      if (lastId) query = query.startAfter(lastId);
      const page = await query.get();
      for (const record of page.docs) {
        const data = record.data();
        totals.jsonBytes += Buffer.byteLength(JSON.stringify(data));
        totals.documents++;
        if (collection.id === 'erpInventory') {
          totals.units += data.quantity;
          totals.inventoryValue += data.value;
        }
      }
      if (page.size < pageSize) break;
      lastId = page.docs.at(-1).id;
    }
  }
  return totals;
}

// ERP_BOOTSTRAP_LOAD=1 runs the large rehearsal. CI exercises the same flow with three items.
test('versioned bootstrap keeps the active ledger, requires fresh repair consent, and switches once to verified upload contents', async t => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(localhost|127\.0\.0\.1):\d+$/);
  const largeLedger = process.env.ERP_BOOTSTRAP_LOAD === '1';
  const itemCount = largeLedger ? 3200 : 3;
  const auditRowCount = largeLedger ? 20 : 2;
  const suffix = randomUUID();
  const app = initializeApp({ projectId: 'demo-erp-version-load' }, 'version-load-' + suffix);
  t.after(() => deleteApp(app));
  const db = getFirestore(app);
  const companyId = 'version-' + suffix;
  const adminUid = 'admin-' + suffix;
  const company = db.collection('companies').doc(companyId);
  const originalStock = company.collection('erpInventory').doc('original-stock');
  const now = new Date('2026-11-27T04:00:00Z');
  const service = createErpBootstrapService({ db, now: () => new Date(now) });
  const ledgerForVersion = id => company.collection('erpLedgerVersions').doc(id).collection('ledger').doc(companyId);
  const activeVersion = async () => (await company.get()).get('erpActiveLedgerVersion');

  function request(data, authenticationAgeSeconds = 0) {
    return {
      auth: {
        uid: adminUid,
        token: {
          auth_time: Math.floor(now.getTime() / 1000) - authenticationAgeSeconds,
          firebase: { sign_in_provider: 'password' },
        },
      },
      data: { companyId, ...data },
    };
  }

  async function submitUntilDecision(data) {
    let response;
    do {
      response = await service(request(data));
    } while (response.pending && !response.stageMismatch && !response.bootstrap.stageConflict);
    return response;
  }

  await company.set({
    nameKo: COMPANY_NAME,
    status: 'ACTIVE',
    accessUntil: Timestamp.fromDate(new Date('2030-01-01Z')),
  });
  await db.doc('UserProfile/' + adminUid).set({ uid: adminUid, companyId, role: 'ADMIN', status: 'ACTIVE' });
  const auditNotes = largeLedger ? 'a'.repeat(LARGE_AUDIT_BYTES) : '기존 감사 기록';
  for (let index = 0; index < auditRowCount; index++) {
    await company.collection('erpAudit').doc('audit-' + index).set({ companyId, notes: auditNotes });
  }
  await originalStock.set({
    companyId, itemId: 'old', warehouseId: 'main', quantity: 7, value: 700, currency: 'KRW',
  });

  const source = await buildOpeningWorkbook(COMPANY_NAME, itemCount);
  const preview = await service(request({ action: 'preview', id: 'migration', source }));
  const job = preview.bootstrap;
  assert.equal(job.summary.totalItems, itemCount);
  assert.equal(job.comparison.previous.inventoryQuantity, 7);
  assert.equal(job.comparison.incoming.inventoryQuantity, itemCount * 10);
  assert.equal(job.stage.status, 'VERIFIED');
  assert.equal(await activeVersion(), undefined);

  // Damage only the staging version. The large and small cases cover different mismatch modes.
  const candidateInventory = ledgerForVersion(job.stage.versionId).collection('erpInventory');
  if (largeLedger) {
    await candidateInventory.doc('unexpected').set({
      companyId, itemId: 'extra', warehouseId: 'other', quantity: 77, value: 100,
    });
  } else {
    const firstItem = await candidateInventory.limit(1).get();
    await firstItem.docs[0].ref.update({ quantity: 77, value: 12345 });
  }

  const resetConsent = {
    action: 'commit',
    id: job.id,
    fingerprint: job.fingerprint,
    confirmPhrase: CONFIRM_PHRASE,
    resetExisting: true,
    warningAccepted: true,
  };
  now.setSeconds(now.getSeconds() + 2);
  const mismatch = await submitUntilDecision(resetConsent);
  const repairChallenge = mismatch.bootstrap.stageConflict?.challenge;
  assert.ok(repairChallenge);
  assert.equal(await activeVersion(), undefined);
  assert.equal((await originalStock.get()).get('value'), 700);

  const repairConsent = { ...resetConsent, repairStage: true, repairChallenge, repairWarningAccepted: true };
  const rejectionCodes = ['permission-denied', 'failed-precondition', 'unauthenticated', 'invalid-argument'];
  const rejectsRepair = call => assert.rejects(call, error => rejectionCodes.includes(error.code));
  await rejectsRepair(service(request(repairConsent, 5)));
  now.setSeconds(now.getSeconds() + 3);
  await rejectsRepair(service(request({ ...repairConsent, repairWarningAccepted: false })));
  await rejectsRepair(service(request({ ...repairConsent, repairChallenge: 'wrong' })));

  const committed = await submitUntilDecision(repairConsent);
  assert.equal(committed.bootstrap.status, 'COMMITTED');
  assert.equal(committed.bootstrap.backup.reconciliation.verified, true);
  const activeId = await activeVersion();
  assert.ok(activeId && activeId !== job.stage.versionId);
  const activeLedger = ledgerForVersion(activeId);
  assert.equal((await activeLedger.collection('erpInventory').doc('unexpected').get()).exists, false);
  assert.equal((await originalStock.get()).exists, true);

  const totals = await measureLedger(activeLedger);
  assert.equal(totals.units, itemCount * 10);
  assert.equal(totals.inventoryValue, itemCount * 1000);
  if (largeLedger) {
    assert.ok(totals.jsonBytes > TRANSACTION_SIZE);
    assert.ok(auditRowCount * LARGE_AUDIT_BYTES > TRANSACTION_SIZE);
  }
  const repeated = await submitUntilDecision(repairConsent);
  assert.equal(repeated.idempotent, true);
  assert.equal(await activeVersion(), activeId);
  t.diagnostic(JSON.stringify({
    inputItems: itemCount,
    activeDocuments: totals.documents,
    activeJsonBytes: totals.jsonBytes,
    sourceAuditBytes: largeLedger ? auditRowCount * LARGE_AUDIT_BYTES : undefined,
    units: totals.units,
    inventoryValue: totals.inventoryValue,
  }));
});
