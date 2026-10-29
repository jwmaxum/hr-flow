const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createPayrollService, payrollRecordId, MAX_PDF_BYTES } = require('../payroll-service');
const officialTable = require('../data/withholdingTaxTable2026.json');

// Fixed, local demo project: this suite never uses production credentials or data.
if (!/^(127\.0\.0\.1|localhost):8080$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('Payroll service tests require the local Firestore emulator on port 8080.');
}
process.env.METADATA_SERVER_DETECTION = 'none';
const app = initializeApp({ projectId: 'demo-payroll-service' }, 'payroll-service-tests');
const db = getFirestore(app, '(default)');
const instant = new Date('2026-10-29T03:00:00.000Z');
const seconds = Math.floor(instant.getTime() / 1000);
const now = () => new Date(instant);
const future = Timestamp.fromMillis(instant.getTime() + 86400000);
const request = (uid, action, data = {}) => ({ ...(uid ? { auth: { uid, token: { auth_time: seconds - 30 } } } : {}),
  rawRequest: { headers: { authorization: `Bearer test-${uid}` } }, data: { action, ...data } });
const denied = (promise, code) => assert.rejects(promise, error => error.code === code);
const fakePdf = Buffer.from('%PDF-test');

async function fixture() {
  for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
  const profile = (name, role = 'MEMBER', companyId = 'a', extra = {}) => ({ name, role, companyId, status: 'ACTIVE',
    annualSalary: 30000000, isSeveranceIncluded: false, nonTaxable: 200000, dependents: 1, children: 0,
    joinDate: '2020-01-02', divisionId: companyId === 'a' ? 'da' : 'db', teamId: companyId === 'a' ? 'ta' : 'tb', ...extra });
  const writes = [
    ['companies/a', { nameKo: '가 회사', nameEn: 'A', address: 'A 주소', representative: 'A 대표', status: 'ACTIVE', accessUntil: future }],
    ['companies/b', { nameKo: '나 회사', nameEn: 'B', status: 'ACTIVE', accessUntil: future }],
    ['companies/expired', { nameKo: 'Expired', status: 'ACTIVE', accessUntil: Timestamp.fromMillis(instant.getTime() - 1) }],
    ['companies/suspended', { nameKo: 'Suspended', status: 'SUSPENDED', accessUntil: future }],
    ['UserProfile/admin', profile('관리자', 'ADMIN')],
    ['UserProfile/sub', profile('팀장', 'SUB_ADMIN')],
    ['UserProfile/member', profile('직원', 'MEMBER', 'a', { uid: 'foreignMember', personalInfo: { rrn: 'SYNTHETIC_PRIVATE_VALUE' }, email: 'member@a.test' })],
    ['UserProfile/suspendedEmployee', profile('업무정지 직원', 'MEMBER', 'a', { status: 'SUSPENDED' })],
    ['UserProfile/zero', profile('급여 0원 직원', 'MEMBER', 'a', { annualSalary: 0 })],
    ['UserProfile/pending', profile('초기 비밀번호 관리자', 'ADMIN', 'a', { annualSalary: 0, mustChangePassword: true })],
    ['UserProfile/retired', profile('퇴사자', 'ADMIN', 'a', { status: 'RESIGNED' })],
    ['UserProfile/future', profile('입사 예정자', 'MEMBER', 'a', { joinDate: '2027-01-01' })],
    ['UserProfile/foreignAdmin', profile('타사 관리자', 'ADMIN', 'b')],
    ['UserProfile/foreignMember', profile('타사 직원', 'MEMBER', 'b')],
    ['UserProfile/expired', profile('Expired admin', 'ADMIN', 'expired')],
    ['UserProfile/suspended', profile('Suspended company admin', 'ADMIN', 'suspended')],
    ['UserProfile/platform', { name: 'Platform operator', role: 'SUPER_ADMIN', companyId: 'PLATFORM', status: 'ACTIVE' }],
    ['divisions/da', { companyId: 'a', name: 'A 본부' }], ['divisions/db', { companyId: 'b', name: 'B 본부' }],
    ['teams/ta', { companyId: 'a', name: 'A 팀' }], ['teams/tb', { companyId: 'b', name: 'B 팀' }],
  ];
  await Promise.all(writes.map(([path, value]) => db.doc(path).set(value)));
  const faults = { revoked: false, onMonthly: null, onAnnual: null, pdf: fakePdf };
  const authCalls = [], monthly = [], annual = [];
  const auth = { async verifyIdToken(token, checkRevoked) {
    authCalls.push(checkRevoked);
    if (faults.revoked || faults.rejectVerificationAt === authCalls.length || !token.startsWith('test-')) throw new Error('synthetic authentication failure');
    return { uid: token.slice(5) };
  } };
  const manage = createPayrollService({ db, auth, now,
    renderMonthlyPdf: async (record, branding) => { monthly.push({ record, branding }); if (faults.onMonthly) await faults.onMonthly(); return faults.pdf; },
    renderAnnualPdf: async (report, branding) => { annual.push({ report, branding }); if (faults.onAnnual) await faults.onAnnual(); return faults.pdf; },
  });
  const call = (uid, action, data = {}) => manage(request(uid, action, data));
  const preview = (month = 10, uid = 'admin') => call(uid, 'preview', { year: 2026, month });
  const approve = async (month = 10, uid = 'admin') => {
    const value = await preview(month, uid);
    return call(uid, 'approve', { year: 2026, month, expectedFingerprint: value.fingerprint });
  };
  return { call, manage, preview, approve, faults, authCalls, monthly, annual, profile };
}

function uploadedTable(tax = 12340) {
  const value = structuredClone(officialTable);
  value.fileName = 'synthetic-2026.xlsx'; value.updateDate = '2026-10-29';
  value.brackets.find(row => row.min === 2300).taxes[0] = tax;
  return value;
}
async function legacy(month = 9) {
  await db.doc(`payroll_records/legacy-${month}`).set({ companyId: 'a', year: 2026, month, totalGross: 1000000,
    totalNet: 900000, employeeCount: 1, approvedBy: 'admin', approvedByName: '옛 관리자', approvedAt: Timestamp.fromDate(instant) });
}

test('server-approved payroll, PDF privacy, tenant separation and immutable financial history', async t => {
  try {
    await t.test('authorization rejects missing, mismatched, revoked, inactive and non-company-admin sessions', async () => {
      const f = await fixture();
      await denied(f.call(null, 'list', { year: 2026 }), 'unauthenticated');
      const noBearer = request('admin', 'list', { year: 2026 }); delete noBearer.rawRequest.headers.authorization;
      await denied(f.manage(noBearer), 'unauthenticated');
      const mismatch = request('admin', 'list', { year: 2026 }); mismatch.rawRequest.headers.authorization = 'Bearer test-foreignAdmin';
      await denied(f.manage(mismatch), 'unauthenticated');
      for (const uid of ['member', 'sub', 'platform', 'retired', 'expired', 'suspended', 'suspendedEmployee']) {
        await denied(f.call(uid, 'list', { year: 2026 }), 'permission-denied');
      }
      await denied(f.call('pending', 'list', { year: 2026 }), 'failed-precondition');
      await db.doc('UserProfile/admin').update({ sessionValidAfter: seconds - 10 });
      await denied(f.preview(), 'unauthenticated');
      await db.doc('UserProfile/admin').update({ sessionValidAfter: seconds - 60 });
      f.faults.revoked = true; await denied(f.preview(), 'unauthenticated');
      assert(f.authCalls.length > 0 && f.authCalls.every(Boolean));
    });
    await t.test('strict action inputs reject tenant, amount and filtering injection', async () => {
      const f = await fixture();
      for (const extra of [{ companyId: 'b' }, { rows: [] }, { annualSalary: 1 }, { divisionId: 'db' }, { scope: 'FILTERED' }]) {
        await denied(f.call('admin', 'preview', { year: 2026, month: 10, ...extra }), 'invalid-argument');
      }
      await denied(f.call('admin', 'approve', { year: 2026, month: 10 }), 'invalid-argument');
      await denied(f.call('admin', 'approve', { year: 2026, month: 10, expectedFingerprint: '0'.repeat(64) }), 'aborted');
      for (const data of [{ year: '2026', month: 10 }, { year: 2026, month: 0 }, { year: 2026, month: 13 }]) {
        await denied(f.call('admin', 'preview', data), 'invalid-argument');
      }
      await denied(f.call('admin', 'monthlyPdf', { id: '../foreign' }), 'invalid-argument');
      await denied(f.call('admin', 'annualPdf', { year: 2026, employeeId: 'foreign/member' }), 'invalid-argument');
      assert.equal((await db.collection('payroll_records').get()).size, 0);
    });
    await t.test('preview and approval compute all saved company employees, zero rows and compatibility aliases', async () => {
      const f = await fixture(); const preview = await f.preview();
      assert.equal(preview.employeeCount, 6); assert.equal(preview.zeroCount, 2); assert.equal(preview.totalGross, 10000000);
      assert.equal(preview.taxTable.source, 'official-2026');
      assert.equal((await db.collection('payroll_records').get()).size, 0, 'preview cannot write financial history');
      const result = await f.call('admin', 'approve', { year: 2026, month: 10, expectedFingerprint: preview.fingerprint });
      const id = payrollRecordId('a', 2026, 10); assert.equal(result.record.id, id);
      const stored = (await db.doc(`payroll_records/${id}`).get()).data();
      assert.equal(stored.scope, 'COMPANY'); assert.equal(stored.divisionId, 'ALL'); assert.equal(stored.divisionName, '전체 본부');
      assert.equal(stored.totalGross, stored.sums.monthlyGross); assert.equal(stored.totalNet, stored.sums.netPay);
      assert.equal(stored.totalDeductions, stored.sums.totalDeductions); assert.equal(stored.totalInsurance, stored.sums.totalInsurance);
      assert.equal(stored.totalTax, stored.sums.incomeTax + stored.sums.localTax); assert.equal(stored.employeeCount, 6);
      assert.equal(stored.approvedBy, 'admin'); assert.equal(stored.approvedAt.toMillis(), instant.getTime());
      assert.equal(stored.calculationBasis, 'FULL_MONTH_SAVED_SETTINGS'); assert.equal(stored.employmentProration, 'NOT_APPLIED');
      assert.deepEqual(stored.rows.map(row => row.userId).sort(), ['admin', 'member', 'pending', 'sub', 'suspendedEmployee', 'zero']);
      const row = stored.rows.find(row => row.userId === 'member');
      assert.equal(row.amounts.monthlyGross, 2500000); assert.equal(row.amounts.basePay, 2300000); assert.equal(row.amounts.nonTaxable, 200000);
      assert.equal(row.amounts.incomeTax, 29160); assert.equal(row.amounts.localTax, 2910);
      assert.equal(row.divisionName, 'A 본부'); assert.equal(row.teamName, 'A 팀'); assert.equal(row.employeeNumber, '');
      assert.equal(row.personalInfo, undefined); assert.equal(row.email, undefined); assert.equal(row.uid, undefined);
      assert(Object.values(stored.rows.find(value => value.userId === 'zero').amounts).every(value => value === 0));
      assert.equal(result.record.rows, undefined); assert.equal(result.record.legacy, false);
    });
    await t.test('preview fingerprint rejects changed saved settings, identities, eligibility, organization and tax tables', async () => {
      const f = await fixture();
      for (const mutation of [
        () => db.doc('UserProfile/member').update({ annualSalary: 36000000 }),
        () => db.doc('UserProfile/member').update({ name: '이름 변경' }),
        () => db.doc('UserProfile/future').update({ joinDate: '2026-10-31' }),
        () => db.doc('teams/ta').update({ name: '팀 이름 변경' }),
        () => db.doc('system_config/tax_table').set(uploadedTable()),
      ]) {
        const preview = await f.preview(); await mutation();
        await denied(f.call('admin', 'approve', { year: 2026, month: 10, expectedFingerprint: preview.fingerprint }), 'aborted');
      }
      assert.equal((await db.collection('payroll_records').get()).size, 0);
      await f.approve();
    });
    await t.test('server uses complete validated uploaded table and records actual source', async () => {
      const f = await fixture(); await db.doc('system_config/tax_table').set(uploadedTable());
      const preview = await f.preview(); assert.equal(preview.taxTable.source, 'uploaded'); assert.equal(preview.taxTable.fileName, 'synthetic-2026.xlsx');
      const { record } = await f.approve();
      const stored = (await db.doc(`payroll_records/${record.id}`).get()).data();
      const row = stored.rows.find(value => value.userId === 'member');
      assert.equal(row.amounts.incomeTax, 12340); assert.equal(row.calculation.tableSource, 'uploaded');
      assert.equal(stored.taxTable.uploadedInvalid, false); assert.equal(stored.taxTable.highIncomeSource, 'uploaded');
    });
    await t.test('reordered tax document fields preserve the same preview fingerprint and approval', async () => {
      const f = await fixture(); const table = uploadedTable(); await db.doc('system_config/tax_table').set(table);
      const before = await f.preview();
      const reordered = Object.fromEntries(Object.entries(table).reverse().map(([key, value]) => [key,
        key === 'brackets' ? value.map(row => Object.fromEntries(Object.entries(row).reverse())) : value]));
      await db.doc('system_config/tax_table').set(reordered);
      const after = await f.preview(); assert.equal(after.fingerprint, before.fingerprint);
      const { record } = await f.call('admin', 'approve', { year: 2026, month: 10, expectedFingerprint: before.fingerprint });
      assert.equal(record.taxTable.source, 'uploaded');
    });
    await t.test('malformed uploaded table falls back as one whole official table with visible reason', async () => {
      const f = await fixture(); const broken = uploadedTable(); broken.brackets.find(row => row.min === 4500).max = null;
      broken.brackets.find(row => row.min === 7000).max = null; await db.doc('system_config/tax_table').set(broken);
      const preview = await f.preview(); assert.equal(preview.taxTable.source, 'official-2026'); assert.equal(preview.taxTable.uploadedInvalid, true);
      assert.match(preview.taxTable.fallbackReason, /4,500/); assert.match(preview.taxTable.fallbackReason, /7,000/);
      const { record } = await f.approve(); const stored = (await db.doc(`payroll_records/${record.id}`).get()).data();
      assert.equal(stored.rows.find(row => row.userId === 'member').amounts.incomeTax, 29160);
      assert(stored.rows.every(row => row.calculation.tableSource === 'official-2026'));
      assert.equal(record.taxTable.uploadedInvalid, true); assert.match(record.taxTable.fallbackReason, /4,500/);
    });
    await t.test('legacy severance settings require explicit review and supported saved financial inputs', async () => {
      const f = await fixture();
      await db.doc('UserProfile/member').update({ isSeveranceIncluded: true });
      await assert.rejects(f.preview(), error => error.code === 'failed-precondition' && error.message.includes('기존 퇴직급여 포함'));
      await db.doc('UserProfile/member').update({ isSeveranceIncluded: false });
      for (const annualSalary of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await db.doc('UserProfile/member').update({ annualSalary }); await denied(f.preview(), 'failed-precondition');
      }
      await db.doc('UserProfile/member').update({ annualSalary: 30000000, joinDate: '2026-02-30' }); await denied(f.preview(), 'failed-precondition');
      await db.doc('UserProfile/member').update({ joinDate: '2020-01-02' });
      for (const period of [{ year: 2025, month: 10 }, { year: 2026, month: 2 }, { year: 2027, month: 10 }]) {
        await denied(f.call('admin', 'preview', period), 'failed-precondition');
      }
      assert.equal((await db.collection('payroll_records').get()).size, 0);
    });
    await t.test('concurrent and repeated approval cannot overwrite the canonical monthly snapshot', async () => {
      const f = await fixture(); const preview = await f.preview();
      const outcomes = await Promise.allSettled([1, 2].map(() => f.call('admin', 'approve', { year: 2026, month: 10, expectedFingerprint: preview.fingerprint })));
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(value => value.status === 'rejected').reason.code, 'already-exists');
      await denied(f.preview(), 'already-exists'); assert.equal((await db.collection('payroll_records').get()).size, 1);
    });
    await t.test('Auth revocation during approval computation prevents the transaction write', async () => {
      const f = await fixture(); const preview = await f.preview(); f.authCalls.length = 0; f.faults.rejectVerificationAt = 2;
      await denied(f.call('admin', 'approve', { year: 2026, month: 10, expectedFingerprint: preview.fingerprint }), 'unauthenticated');
      assert.equal((await db.collection('payroll_records').get()).size, 0);
    });
    await t.test('list returns only own-company summaries and whitelisted identities, including former employees', async () => {
      const f = await fixture(); await f.approve(); await f.approve(10, 'foreignAdmin'); await legacy();
      await db.doc('UserProfile/member').update({ companyId: 'b', name: '타사 전입 이름', annualSalary: 120000000 });
      const result = await f.call('admin', 'list', { year: 2026 });
      assert.equal(result.records.length, 2); assert(result.records.every(value => value.companyId === 'a' && !('rows' in value)));
      assert.equal(result.records.find(value => value.legacy).totalGross, 1000000);
      const former = result.employees.find(value => value.userId === 'member'); assert.equal(former.name, '직원'); assert.equal(former.companyId, 'a');
      assert.equal(result.employees.some(value => value.userId === 'foreignMember' || value.userId === 'foreignAdmin'), false);
      const encoded = JSON.stringify(result); for (const field of ['annualSalary', 'personalInfo', 'rrn', 'email', 'SYNTHETIC_PRIVATE_VALUE']) assert.equal(encoded.includes(field), false);
      const b = await f.call('foreignAdmin', 'list', { year: 2026 }); assert(b.records.every(value => value.companyId === 'b'));
    });
    await t.test('monthly PDF uses saved amounts and stored company branding after live salary changes', async () => {
      const f = await fixture(); const { record } = await f.approve();
      await db.doc('UserProfile/member').update({ annualSalary: 120000000 });
      const result = await f.call('admin', 'monthlyPdf', { id: record.id });
      assert.equal(Buffer.from(result.base64, 'base64').toString(), '%PDF-test'); assert.equal(result.mimeType, 'application/pdf');
      assert.equal(result.filename, '2026년_10월_급여대장.pdf');
      assert.equal(f.monthly[0].record.rows.find(row => row.userId === 'member').amounts.monthlyGross, 2500000);
      assert.equal(f.monthly[0].branding.companyName, '가 회사'); assert.equal(f.monthly[0].branding.address, 'A 주소');
      await denied(f.call('foreignAdmin', 'monthlyPdf', { id: record.id }), 'permission-denied');
      await legacy(); await denied(f.call('admin', 'monthlyPdf', { id: 'legacy-9' }), 'failed-precondition');
      assert.equal(f.monthly.length, 1);
    });
    await t.test('annual PDF preserves historical amounts, explicitly marks legacy and missing months', async () => {
      const f = await fixture(); await f.approve(); await legacy();
      await db.doc('UserProfile/member').update({ companyId: 'b', name: '현재 타사 이름', annualSalary: 120000000 });
      const file = await f.call('admin', 'annualPdf', { year: 2026, employeeId: 'member' });
      assert.equal(file.filename, '2026년_직원_급여명세서.pdf');
      const report = f.annual[0].report; assert.equal(report.employee.name, '직원'); assert.equal(report.employee.companyId, 'a');
      assert.equal(report.availableMonths, 1); assert.deepEqual(report.legacyMonths, [9]);
      assert.equal(report.months.find(value => value.month === 10).row.amounts.monthlyGross, 2500000);
      assert.equal(report.months.find(value => value.month === 9).row, null); assert.equal(report.months.find(value => value.month === 1).row, null);
      assert.equal(report.sums.monthlyGross, 2500000);
      await denied(f.call('admin', 'annualPdf', { year: 2026, employeeId: 'foreignMember' }), 'not-found');
      await denied(f.call('foreignAdmin', 'annualPdf', { year: 2026, employeeId: 'admin' }), 'not-found');
      assert.equal(f.annual.length, 1);
    });
    await t.test('legacy-only annual PDF uses current scoped identity but never fills historic amounts', async () => {
      const f = await fixture(); await legacy();
      await f.call('admin', 'annualPdf', { year: 2026, employeeId: 'member' }); const report = f.annual[0].report;
      assert.equal(report.employee.name, '직원'); assert.equal(report.availableMonths, 0); assert.deepEqual(report.legacyMonths, [9]);
      assert(report.months.every(value => value.row === null)); assert.equal(report.employee.annualSalary, undefined);
    });
    await t.test('company switch, role removal, account suspension, token revocation or record mutation during PDF generation blocks return', async () => {
      for (const [mutate, code] of [
        [() => db.doc('UserProfile/admin').update({ companyId: 'b' }), 'permission-denied'],
        [() => db.doc('UserProfile/admin').update({ role: 'MEMBER' }), 'permission-denied'],
        [() => db.doc('UserProfile/admin').update({ status: 'SUSPENDED' }), 'permission-denied'],
        [() => db.doc('companies/a').update({ status: 'SUSPENDED' }), 'permission-denied'],
      ]) {
        const f = await fixture(); const { record } = await f.approve(); f.faults.onMonthly = mutate;
        await denied(f.call('admin', 'monthlyPdf', { id: record.id }), code);
      }
      const f = await fixture(); const { record } = await f.approve();
      f.faults.onMonthly = async () => { f.faults.revoked = true; };
      await denied(f.call('admin', 'monthlyPdf', { id: record.id }), 'unauthenticated');
      f.faults.revoked = false; f.faults.onMonthly = () => db.doc(`payroll_records/${record.id}`).update({ approvedByName: 'changed' });
      await denied(f.call('admin', 'monthlyPdf', { id: record.id }), 'aborted');
      f.faults.onMonthly = () => db.doc(`payroll_records/${record.id}`).delete();
      await denied(f.call('admin', 'monthlyPdf', { id: record.id }), 'not-found');
    });
    await t.test('annual PDF aborts when its history or identity changes during rendering', async () => {
      const f = await fixture(); await f.approve();
      f.faults.onAnnual = () => legacy();
      await denied(f.call('admin', 'annualPdf', { year: 2026, employeeId: 'member' }), 'aborted');
      const g = await fixture(); await legacy();
      g.faults.onAnnual = () => db.doc('UserProfile/member').update({ companyId: 'b' });
      await denied(g.call('admin', 'annualPdf', { year: 2026, employeeId: 'member' }), 'aborted');
    });
    await t.test('corrupt nested cross-company payroll rows fail closed before rendering or listing', async () => {
      const f = await fixture(); const { record } = await f.approve(); const ref = db.doc(`payroll_records/${record.id}`);
      const stored = (await ref.get()).data(); stored.rows[0].companyId = 'b'; await ref.set(stored);
      await denied(f.call('admin', 'monthlyPdf', { id: record.id }), 'failed-precondition');
      await denied(f.call('admin', 'annualPdf', { year: 2026, employeeId: 'member' }), 'failed-precondition');
      await denied(f.call('admin', 'list', { year: 2026 }), 'failed-precondition');
      assert.equal(f.monthly.length + f.annual.length, 0);
    });
    await t.test('invalid and oversized renderer output never becomes a successful download', async () => {
      const f = await fixture(); const { record } = await f.approve(); f.faults.pdf = Buffer.from('not-pdf');
      await denied(f.call('admin', 'monthlyPdf', { id: record.id }), 'internal');
      f.faults.pdf = Buffer.alloc(MAX_PDF_BYTES + 1, 0); fakePdf.copy(f.faults.pdf);
      await denied(f.call('admin', 'monthlyPdf', { id: record.id }), 'resource-exhausted');
    });
    await t.test('large company snapshot exceeds storage budget without writing partial payroll history', async () => {
      const f = await fixture(); const long = '실측 검증용 한글 이름'.repeat(12);
      const division = '본부'.repeat(60), team = '팀'.repeat(120);
      await db.doc('divisions/da').update({ name: division }); await db.doc('teams/ta').update({ name: team });
      for (let start = 0; start < 800; start += 400) {
        const batch = db.batch();
        for (let i = start; i < start + 400; i++) batch.set(db.doc(`UserProfile/large-${i}`), f.profile(long, 'MEMBER', 'a', { employeeNumber: '번호'.repeat(40), position: '직급'.repeat(50) }));
        await batch.commit();
      }
      const preview = await f.preview(); assert.equal(preview.employeeCount, 806);
      await denied(f.call('admin', 'approve', { year: 2026, month: 10, expectedFingerprint: preview.fingerprint }), 'resource-exhausted');
      assert.equal((await db.collection('payroll_records').get()).size, 0);
    });
  } finally { await deleteApp(app); }
});
