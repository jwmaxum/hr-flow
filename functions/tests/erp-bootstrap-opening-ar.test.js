const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { paymentEvents, summarize } = require('../erp-finance-model');
const { settlementReport } = require('../erp-settlement-model');
const { monthSnapshot, purchaseEvents } = require('../erp-dashboard-service');
const { createErpBootstrapService, parseBootstrapFile, CONFIRM_PHRASE } = require('../erp-bootstrap-service');

test('OPENING_RECEIVABLE populates opening and balance without inflating period sales', () => {
  const paid = [
    {
      id: 'openar_1',
      type: 'OPENING_RECEIVABLE',
      date: '2026-11-06',
      partnerId: 'p_hbt',
      partnerName: '(주)에이치비티',
      currency: 'KRW',
      amountMinor: 32367700,
      documentNo: 'OPEN-AR-20261106-114',
      notes: '11/6 기초 미수채권',
    },
    {
      id: 'rcpt_1',
      type: 'RECEIPT',
      date: '2026-11-20',
      partnerId: 'p_hbt',
      partnerName: '(주)에이치비티',
      currency: 'KRW',
      amountMinor: 10000000,
      method: 'BANK',
      reference: 'BANK-001',
      notes: '부분 입금',
    },
  ];
  const events = paymentEvents(paid);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'OPENING_RECEIVABLE');
  assert.equal(events[0].gross, 32367700);
  assert.equal(events[0].supply, 0);
  assert.equal(events[0].tax, 0);

  // Full period summary: opening = 32,367,700, sales = 0, receipts = 10,000,000, balance = 22,367,700
  const rows = summarize(events, '2026-11-01', '2026-11-30');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].opening, 32367700);
  assert.equal(rows[0].sales, 0);
  assert.equal(rows[0].tax, 0);
  assert.equal(rows[0].billed, 0);
  assert.equal(rows[0].receipts, 10000000);
  assert.equal(rows[0].balance, 22367700);

  // Settlement report treats opening receivable as allocatable document
  const settle = settlementReport({ events, paid, settlements: [] }, '2026-11-30');
  assert.equal(settle.documents.length, 1);
  assert.equal(settle.documents[0].openingReceivable, true);
  assert.equal(settle.documents[0].billed, 32367700);
  assert.equal(settle.documents[0].balance, 32367700);
  assert.equal(settle.summaries[0].balance, 22367700);
  assert.deepEqual(settle.totals, [{ currency: 'KRW', balance: 22367700, refundDue: 0 }]);

  // Monthly dashboard snapshot must NOT count opening AR as November sales, but MUST show outstanding balance
  const snap = monthSnapshot({ movements: [], events, paid, settlements: [] }, purchaseEvents([]), '2026-11', '2026-11-26');
  assert.equal(snap.salesKRW, 0);
  assert.equal(snap.sales.length, 0);
  const krw = snap.currencies.find(c => c.currency === 'KRW');
  assert.equal(krw.sales, 0);
  assert.equal(krw.salesGross, 0);
  assert.equal(krw.receipts, 10000000);
  assert.equal(krw.outstanding, 22367700);

  // Cancelling an OPENING_RECEIVABLE via CANCEL receipt entry must fail
  assert.throws(() => paymentEvents([
    paid[0],
    { id: 'c1', type: 'CANCEL', sourceId: 'openar_1', partnerId: 'p_hbt', currency: 'KRW', amountMinor: 32367700, date: '2026-11-21', method: 'OTHER', notes: '취소' },
  ]), /수금 취소 연결/);
});

function cloneDoc(val) {
  if (val === null || val === undefined || typeof val !== 'object') return val;
  if (typeof val.toMillis === 'function') return val;
  if (Array.isArray(val)) return val.map(cloneDoc);
  return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, cloneDoc(v)]));
}

// Minimal in-memory Firestore double to test ADMIN authorization, tenant isolation, reset & batch commit
function createMockFirestore() {
  const store = new Map();
  const makeSnap = (ref, val) => ({
    id: ref.id,
    ref,
    exists: val !== undefined,
    data: () => (val === undefined ? undefined : cloneDoc(val)),
  });
  const docRef = docPath => {
    const parts = docPath.split('/');
    return {
      path: docPath,
      id: parts.at(-1),
      collection: name => colRef(`${docPath}/${name}`),
      async get() { return makeSnap(this, store.get(docPath)); },
    };
  };
  const colRef = colPath => ({
    path: colPath,
    id: colPath.split('/').at(-1),
    doc(id) {
      const resolved = id || `auto_${Math.random().toString(36).slice(2, 12)}`;
      return docRef(`${colPath}/${resolved}`);
    },
    limit(n) {
      return {
        async get() {
          const prefix = `${colPath}/`;
          const docs = [];
          for (const [k, v] of store.entries()) {
            if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
              docs.push(makeSnap(docRef(k), v));
              if (docs.length >= n) break;
            }
          }
          return { empty: docs.length === 0, size: docs.length, docs };
        },
      };
    },
    async get() { return this.limit(10000).get(); },
  });
  const db = {
    store,
    collection: name => colRef(name),
    doc: docPath => docRef(docPath),
    async runTransaction(fn) {
      const tx = {
        get: ref => ref.get(),
        create: (ref, data) => { if (store.has(ref.path)) throw Object.assign(new Error('exists'), { code: 'already-exists' }); store.set(ref.path, cloneDoc(data)); },
        set: (ref, data) => store.set(ref.path, cloneDoc(data)),
        update: (ref, patch) => store.set(ref.path, { ...store.get(ref.path), ...cloneDoc(patch) }),
        delete: ref => store.delete(ref.path),
      };
      return fn(tx);
    },
    batch() {
      const ops = [];
      return {
        set: (ref, data) => ops.push(() => store.set(ref.path, cloneDoc(data))),
        delete: ref => ops.push(() => store.delete(ref.path)),
        async commit() { for (const op of ops) op(); },
      };
    },
    async recursiveDelete(col) {
      const prefix = `${col.path}/`;
      for (const k of [...store.keys()]) {
        if (k.startsWith(prefix)) store.delete(k);
      }
    },
  };
  return db;
}

test('manageErpBootstrap enforces ADMIN + tenant isolation, wipes only company ERP, and commits bootstrap package idempotently', async () => {
  const pkgPath = path.resolve(__dirname, '../../outputs/sgnplanet-20261112/에스지앤플래닛_ERP_통합이관_20261112.xlsx');
  if (!fs.existsSync(pkgPath)) return; // Skip when local untracked workbook is absent (e.g. CI)

  const db = createMockFirestore();
  const future = { toMillis: () => Date.parse('2028-01-01T00:00:00Z') };
  db.store.set('companies/sgn', { status: 'ACTIVE', accessUntil: future });
  db.store.set('companies/other', { status: 'ACTIVE', accessUntil: future });
  db.store.set('UserProfile/admin1', { uid: 'admin1', role: 'ADMIN', companyId: 'sgn', status: 'ACTIVE', name: '관리자' });
  db.store.set('UserProfile/sub1', { uid: 'sub1', role: 'SUB_ADMIN', companyId: 'sgn', status: 'ACTIVE', erpAccess: 'MANAGER' });
  db.store.set('UserProfile/foreign', { uid: 'foreign', role: 'ADMIN', companyId: 'other', status: 'ACTIVE' });
  // Pre-existing legacy ERP item in sgn (must be deleted) + HR doc (must survive) + other company ERP item (must survive)
  db.store.set('companies/sgn/erpItems/legacy_item', { companyId: 'sgn', code: 'SG-OLD-001', name: '기존품목' });
  db.store.set('companies/other/erpItems/keep_item', { companyId: 'other', code: 'OTHER-001', name: '타사품목' });

  const now = () => new Date('2026-11-26T06:00:00Z');
  const service = createErpBootstrapService({ db, now });
  const source = {
    name: path.basename(pkgPath),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: fs.readFileSync(pkgPath).toString('base64'),
  };
  const req = (uid, companyId, data) => ({
    auth: { uid, token: { auth_time: Math.floor(now().getTime() / 1000) } },
    data: { companyId, ...data },
  });

  // SUB_ADMIN (even ERP MANAGER) and cross-tenant ADMIN must be denied
  await assert.rejects(() => service(req('sub1', 'sgn', { action: 'preview', id: 'boot-1', source })), e => e.code === 'permission-denied');
  await assert.rejects(() => service(req('foreign', 'sgn', { action: 'preview', id: 'boot-1', source })), e => e.code === 'permission-denied');

  // Preview succeeds for company ADMIN and does NOT delete legacy_item yet
  const previewRes = await service(req('admin1', 'sgn', { action: 'preview', id: 'boot-1', source }));
  const job = previewRes.bootstrap;
  assert.equal(job.status, 'PENDING');
  assert.equal(job.summary.warehouseName, '본사창고');
  assert.equal(job.summary.totalItems, 106);
  assert.equal(job.summary.positiveItems, 53);
  assert.equal(job.summary.ownedQuantity, 55058);
  assert.equal(job.summary.ownedValue, 938403000);
  assert.equal(job.summary.borrowingCount, 3);
  assert.equal(job.summary.borrowedQuantity, 384);
  assert.equal(job.summary.borrowedValue, 1414460);
  assert.equal(job.summary.netBookValue, 936988540);
  assert.equal(job.summary.partnerCount, 150);
  assert.equal(job.summary.receivableCount, 12);
  assert.deepEqual(job.summary.receivableTotals, [{ currency: 'KRW', amountMinor: 1156379200 }]);
  assert.equal(db.store.has('companies/sgn/erpItems/legacy_item'), true);

  // Wrong confirmation phrase must fail
  await assert.rejects(() => service(req('admin1', 'sgn', { action: 'commit', id: 'boot-1', fingerprint: job.fingerprint, confirmPhrase: '잘못된문구' })), e => e.code === 'failed-precondition');

  // Commit wipes legacy_item, preserves other company & UserProfile, writes fresh data
  const commitRes = await service(req('admin1', 'sgn', { action: 'commit', id: 'boot-1', fingerprint: job.fingerprint, confirmPhrase: CONFIRM_PHRASE }));
  assert.equal(commitRes.idempotent, false);
  assert.equal(commitRes.bootstrap.status, 'COMMITTED');
  assert.equal(db.store.has('companies/sgn/erpItems/legacy_item'), false);
  assert.equal(db.store.has('companies/other/erpItems/keep_item'), true);
  assert.equal(db.store.has('UserProfile/admin1'), true);

  // Verify exact counts in Firestore store
  const countPrefix = prefix => [...db.store.keys()].filter(k => k.startsWith(prefix)).length;
  assert.equal(countPrefix('companies/sgn/erpWarehouses/'), 1);
  assert.equal(countPrefix('companies/sgn/erpItems/'), 106);
  assert.equal(countPrefix('companies/sgn/erpInventory/'), 106);
  assert.equal(countPrefix('companies/sgn/erpMovements/'), 106);
  assert.equal(countPrefix('companies/sgn/erpPartners/'), 150);
  assert.equal(countPrefix('companies/sgn/erpCustodyLots/'), 3);
  assert.equal(countPrefix('companies/sgn/erpBorrowings/'), 3);
  assert.equal(countPrefix('companies/sgn/erpReceipts/'), 12);

  // Idempotent commit returns idempotent: true
  const again = await service(req('admin1', 'sgn', { action: 'commit', id: 'boot-1', fingerprint: job.fingerprint, confirmPhrase: CONFIRM_PHRASE }));
  assert.equal(again.idempotent, true);

  // Verify parser also validates standalone
  const direct = await parseBootstrapFile(source);
  assert.equal(direct.summary.netBookValue, 936988540);
});
