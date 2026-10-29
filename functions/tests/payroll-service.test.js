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
const { createHash } = require('node:crypto');
const { HEADER_FIELDS } = require('../payroll-import-schema.mjs');
const sourceFile = (rows, name = '과거급여.csv') => ({ name, mimeType: 'text/csv', base64: Buffer.from('\uFEFF' + HEADER_FIELDS.map(field => field.header).join(',') + '\r\n' + rows.map(row => HEADER_FIELDS.map(field => {
  const value = row[field.key] ?? row.amounts?.[field.key] ?? '';
  return '"' + String(value).replaceAll('"', '""') + '"';
}).join(',')).join('\r\n')).toString('base64') });
const historic = (extra = {}) => ({ employeeLoginId: 'MEMBER@A.TEST', name: '과거 이름', amounts: {
  monthlyGross: 2500000, nonTaxable: 200000, pension: 100000, health: 80000, longTerm: 10000, employment: 20000,
  incomeTax: -30000, localTax: -3000, otherDeductions: 17000 }, ...extra });
function privateBucket(faults) {
  const objects = new Map(); let generation = 0;
  const missing = () => Object.assign(new Error('Synthetic missing private source'), { code: 404 });
  return { objects, file(path, options = {}) { return {
    async save(bytes, config) {
      assert.equal(config.preconditionOpts.ifGenerationMatch, 0); assert.equal(objects.has(path), false);
      const metadata = { ...structuredClone(config.metadata), generation: String(++generation), size: String(bytes.length) };
      objects.set(path, { bytes: Buffer.from(bytes), metadata });
      if (faults.onSourceSave) await faults.onSourceSave(path, objects.get(path));
    },
    async getMetadata() { const entry = objects.get(path); if (!entry || options.generation && entry.metadata.generation !== options.generation) throw missing(); return [structuredClone(entry.metadata)]; },
    async download() { const entry = objects.get(path); if (!entry || options.generation && entry.metadata.generation !== options.generation) throw missing();
      if (faults.onSourceDownload) await faults.onSourceDownload(path, entry); return [Buffer.from(entry.bytes)]; },
    async delete(config) { const entry = objects.get(path); if (!entry && config.ignoreNotFound) return;
      if (!entry || options.generation && entry.metadata.generation !== options.generation || config.ifGenerationMatch && entry.metadata.generation !== config.ifGenerationMatch) throw missing();
      objects.delete(path);
    },
  }; }, async deleteFiles({ prefix }) { for (const path of objects.keys()) if (path.startsWith(prefix)) objects.delete(path); } };
}

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
  const bucket = privateBucket(faults);
  const manage = createPayrollService({ db, auth, now, bucket,
    renderMonthlyPdf: async (record, branding) => { monthly.push({ record, branding }); if (faults.onMonthly) await faults.onMonthly(); return faults.pdf; },
    renderAnnualPdf: async (report, branding) => { annual.push({ report, branding }); if (faults.onAnnual) await faults.onAnnual(); return faults.pdf; },
  });
  const call = (uid, action, data = {}) => manage(request(uid, action, data));
  const preview = (month = 10, uid = 'admin') => call(uid, 'preview', { year: 2026, month });
  const approve = async (month = 10, uid = 'admin') => {
    const value = await preview(month, uid);
    return call(uid, 'approve', { year: 2026, month, expectedFingerprint: value.fingerprint });
  };
  const importDraft = (month = 1, rows = [historic()], uid = 'admin') => call(uid, 'importSource', { year: 2020, month, reason: '과거 원자료 검토\n담당 확인', source: sourceFile(rows) });
  return { call, manage, preview, approve, faults, authCalls, monthly, annual, profile, bucket, importDraft };
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
      for (const extra of [{ companyId: 'b' }, { rows: [] }, { annualSalary: 1 }, { divisionId: 'db' }, { scope: 'FILTERED' },
        { rrn: '600101-1******' }, { birthDate: '1960-01-01' }, { pensionAgeExempt: true }, { age: 70 }]) {
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
    await t.test('only valid saved HR rrn birth information changes pension while missing or ambiguous detail keeps the existing default', async () => {
      for (const [rrn, expectedPension] of [
        ['600101-1******', 0], ['6001015XXXXXX', 0], ['000101-3******', 109250],
        ['600101-*******', 109250], ['600101', 109250], ['660230-1******', 109250],
        ['600101-?******', 109250], [null, 109250],
      ]) {
        const f = await fixture();
        await db.doc('UserProfile/member').update({ ...(rrn !== null ? { rrn } : {}),
          // Per-document/nested dates are deliberately not registered HR DOBs.
          birthDate: '1960-01-01', personalInfo: { rrn: '600101-1******', birthDate: '1960-01-01' } });
        const { record } = await f.approve(); const stored = (await db.doc(`payroll_records/${record.id}`).get()).data();
        const row = stored.rows.find(value => value.userId === 'member');
        assert.equal(row.amounts.pension, expectedPension, 'saved HR birth source must determine pension');
        assert.equal(row.amounts.health, 82680); assert.equal(row.amounts.longTerm, 10860); assert.equal(row.amounts.employment, 20700);
        assert.equal(row.amounts.incomeTax, 29160); assert.equal(row.amounts.localTax, 2910);
        assert.equal(row.amounts.totalInsurance, expectedPension + 114240); assert.equal(row.amounts.netPay, 2353690 - expectedPension);
        for (const field of ['rrn', 'birthDate', 'personalInfo', 'dateOfBirth']) assert.equal(JSON.stringify(stored).includes(field), false);
        if (rrn !== null) assert.equal(JSON.stringify(stored).includes(rrn), false);
      }
    });
    await t.test('saved HR age eligibility uses the selected payroll month and distinguishes first-day from later birthdays', async () => {
      const f = await fixture();
      await db.doc('UserProfile/member').update({ rrn: '661101-1******' });
      await db.doc('UserProfile/sub').update({ rrn: '661102-2******' });
      const amounts = async month => {
        const { record } = await f.approve(month);
        return (await db.doc(`payroll_records/${record.id}`).get()).data().rows;
      };
      const october = await amounts(10), november = await amounts(11), december = await amounts(12);
      const pension = (rows, uid) => rows.find(row => row.userId === uid).amounts.pension;
      assert.equal(pension(october, 'member'), 109250); assert.equal(pension(october, 'sub'), 109250);
      assert.equal(pension(november, 'member'), 0); assert.equal(pension(november, 'sub'), 109250);
      assert.equal(pension(december, 'member'), 0); assert.equal(pension(december, 'sub'), 0);
    });
    await t.test('saved HR birth edits invalidate a changed preview but cannot recalculate approved PDF history or expose private birth data', async () => {
      const f = await fixture(); const originalRrn = '600101-1******';
      await db.doc('UserProfile/member').update({ rrn: originalRrn });
      const pending = await f.preview(11);
      const { record } = await f.approve(10);
      await db.doc('UserProfile/member').update({ rrn: '900101-1******' });
      await denied(f.call('admin', 'approve', { year: 2026, month: 11, expectedFingerprint: pending.fingerprint }), 'aborted');
      await f.call('admin', 'monthlyPdf', { id: record.id });
      await f.call('admin', 'annualPdf', { year: 2026, employeeId: 'member' });
      assert.equal(f.monthly[0].record.rows.find(row => row.userId === 'member').amounts.pension, 0);
      assert.equal(f.annual[0].report.months.find(value => value.month === 10).row.amounts.pension, 0);
      const result = await f.approve(11); const latest = (await db.doc(`payroll_records/${result.record.id}`).get()).data();
      assert.equal(latest.rows.find(row => row.userId === 'member').amounts.pension, 109250);
      const listed = await f.call('admin', 'list', { year: 2026 });
      const exposed = JSON.stringify({ monthly: f.monthly[0], annual: f.annual[0], listed, approved: result, preview: pending });
      for (const field of ['rrn', 'birthDate', 'dateOfBirth', 'personalInfo', originalRrn, '900101-1******']) assert.equal(exposed.includes(field), false);
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
    await t.test('saved payroll applies the under-1000 final withholding exclusion after child credit and preserves zero tax in approved PDFs', async () => {
      const f = await fixture();
      await db.doc('UserProfile/member').update({ annualSalary: 2280000 * 12, nonTaxable: 0, dependents: 2, childrenUnder20: 1 });
      const { record } = await f.approve(); const stored = (await db.doc(`payroll_records/${record.id}`).get()).data();
      const row = stored.rows.find(value => value.userId === 'member');
      assert.equal(row.amounts.monthlyGross, 2280000);
      assert.equal(row.calculation.dependents, 2); assert.equal(row.calculation.children, 1);
      // The table's 21,520 minus child credit 20,830 is 690, so final wage withholding is zero.
      assert.equal(row.amounts.incomeTax, 0); assert.equal(row.amounts.localTax, 0);
      assert.equal(row.amounts.totalDeductions, row.amounts.totalInsurance);
      assert.equal(row.amounts.netPay, row.amounts.monthlyGross - row.amounts.totalDeductions);
      for (const field of ['incomeTax', 'localTax', 'totalDeductions', 'netPay']) {
        assert.equal(stored.sums[field], stored.rows.reduce((sum, value) => sum + value.amounts[field], 0));
      }
      assert.equal(stored.sums.totalDeductions, stored.sums.totalInsurance + stored.sums.incomeTax + stored.sums.localTax);
      await db.doc('UserProfile/member').update({ childrenUnder20: 0 });
      await f.call('admin', 'monthlyPdf', { id: record.id });
      await f.call('admin', 'annualPdf', { year: 2026, employeeId: 'member' });
      const monthly = f.monthly[0].record.rows.find(value => value.userId === 'member').amounts;
      const annual = f.annual[0].report.months.find(value => value.month === 10).row.amounts;
      assert.equal(monthly.incomeTax, 0); assert.equal(monthly.localTax, 0);
      assert.equal(annual.incomeTax, 0); assert.equal(annual.localTax, 0);
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
    await t.test('historical imports use exact saved values, scoped login mapping and namespaced former employees', async () => {
      const f = await fixture();
      await db.doc('UserProfile/member').update({ joinDate: '2025-01-01', rrn: '600101-1******' });
      const archive = historic({ employeeLoginId: '', archiveCode: 'Former-001', name: '퇴사 원본 이름' });
      const { draft } = await f.importDraft(1, [historic(), archive]);
      assert.equal(draft.companyId, 'a'); assert.equal(draft.status, 'PENDING'); assert.equal(draft.draftVersion, 1);
      assert.equal(draft.rows[0].userId, 'member'); assert.equal(draft.rows[0].name, '과거 이름');
      for (const field of ['joinDate', 'divisionName', 'teamName', 'position']) assert.equal(draft.rows[0][field], '');
      assert.deepEqual(draft.rows[0].calculation, { mode: 'IMPORTED', tableSource: 'imported-source' });
      assert.equal(draft.rows[0].amounts.incomeTax, -30000); assert.equal(draft.rows[0].amounts.otherDeductions, 17000);
      assert.equal(draft.rows[0].amounts.totalDeductions, 194000); assert.equal(draft.rows[0].amounts.netPay, 2306000);
      const expected = 'archive_' + createHash('sha256').update(JSON.stringify(['a', 'former-001'])).digest('hex');
      assert.equal(draft.rows[1].userId, expected); assert.equal((await db.collection('payroll_records').get()).size, 0);
      assert.equal((await db.doc('UserProfile/' + expected).get()).exists, false);
      assert.equal(draft.source.storagePath, undefined); assert.equal(draft.source.generation, undefined);
      const b = await f.importDraft(1, [archive], 'foreignAdmin'); assert.notEqual(b.draft.rows[0].userId, expected);
      const lists = await f.call('admin', 'listDrafts', { year: 2020 }); assert.equal(lists.drafts.length, 1);
      assert.equal(lists.drafts[0].rows, undefined); assert.equal(lists.drafts[0].companyId, 'a');
      const encoded = JSON.stringify(draft); for (const value of ['rrn', '600101', 'personalInfo', 'storagePath']) assert.equal(encoded.includes(value), false);
    });
    await t.test('import validation rejects foreign or ambiguous logins, PII, chronology and future periods without retaining source blobs', async () => {
      const f = await fixture();
      for (const row of [historic({ employeeLoginId: 'foreign@b.test' }), historic({ employeeLoginId: '', archiveCode: '660101-1234567' }),
        historic({ joinDate: '2020-02-01' }), historic({ joinDate: '2019-01-01', resignDate: '2018-01-01' })]) {
        await denied(f.importDraft(1, [row]), 'invalid-argument'); assert.equal(f.bucket.objects.size, 0);
      }
      await db.doc('UserProfile/duplicate').set(f.profile('중복 로그인', 'MEMBER', 'a', { email: 'MEMBER@A.TEST' }));
      await denied(f.importDraft(), 'invalid-argument'); assert.equal(f.bucket.objects.size, 0);
      await denied(f.call('admin', 'importSource', { year: 2026, month: 11, reason: '미래 자료', source: sourceFile([historic()]) }), 'invalid-argument');
      for (const reason of ['x', '  ', '사유\u0000주입']) await denied(f.call('admin', 'importSource', { year: 2020, month: 1, reason, source: sourceFile([historic()]) }), 'invalid-argument');
      assert.equal((await db.collection('payroll_drafts').get()).size, 0);
    });
    await t.test('draft mutations retain every saved version and only accept the same verified roster', async () => {
      const f = await fixture(); const { draft } = await f.importDraft();
      const rows = draft.rows.map(row => ({ userId: row.userId, amounts: { ...row.amounts, incomeTax: -40000, totalDeductions: 184000, netPay: 2316000 } }));
      const changed = await f.call('admin', 'updateDraft', { id: draft.id, expectedDraftVersion: 1, reason: '환급 정정\n재확인', rows });
      assert.equal(changed.draft.draftVersion, 2); assert.equal(changed.draft.rows[0].calculation.mode, 'ADJUSTED');
      await denied(f.call('admin', 'updateDraft', { id: draft.id, expectedDraftVersion: 1, reason: '오래된 저장', rows }), 'aborted');
      await denied(f.call('admin', 'updateDraft', { id: draft.id, expectedDraftVersion: 2, reason: '타사 주입', rows: [{ ...rows[0], userId: 'foreignMember' }] }), 'invalid-argument');
      const versions = await f.call('admin', 'listDraftVersions', { id: draft.id });
      assert.deepEqual(versions.versions.map(value => value.draftVersion), [2, 1]); assert(versions.versions.every(value => value.companyId === 'a'));
      const original = await f.call('admin', 'getDraftVersion', { id: draft.id, draftVersion: 1 });
      assert.equal(original.draft.readonly, true); assert.equal(original.draft.rows[0].amounts.incomeTax, -30000);
      assert.equal(original.draft.rows[0].calculation.mode, 'IMPORTED');
      const cancelled = await f.call('admin', 'cancelDraft', { id: draft.id, expectedDraftVersion: 2, reason: '검토 취소 사유' });
      assert.equal(cancelled.draft.status, 'CANCELLED'); assert.equal(cancelled.draft.draftVersion, 3);
      await denied(f.call('admin', 'approveDraft', { id: draft.id, expectedDraftVersion: 3 }), 'aborted');
      assert.equal((await db.collection('payroll_records').get()).size, 0);
    });
    await t.test('first approval is atomic, idempotent and records private source provenance without recalculation', async () => {
      const f = await fixture(); const { draft } = await f.importDraft();
      const result = await f.call('admin', 'approveDraft', { id: draft.id, expectedDraftVersion: 1 });
      assert.equal(result.revision, 1); assert.equal(result.record.origin, 'IMPORT');
      const id = payrollRecordId('a', 2020, 1), root = (await db.doc('payroll_records/' + id).get()).data();
      const archive = (await db.doc(`payroll_records/${id}/revisions/r000001`).get()).data();
      assert.deepEqual(archive.snapshot, root); assert.equal(archive.recordId, id); assert.equal(root.rows[0].amounts.incomeTax, -30000);
      assert.equal(root.totalGross, root.sums.monthlyGross); assert.equal(root.divisionId, 'ALL');
      const again = await f.call('admin', 'approveDraft', { id: draft.id, expectedDraftVersion: 1 });
      assert.equal(again.idempotent, true); assert.equal(again.revision, 1);
      assert.equal((await db.doc('payroll_records/' + id).collection('revisions').get()).size, 1);
      await f.call('admin', 'monthlyPdf', { id, revision: 1 }); await f.call('admin', 'annualPdf', { year: 2020, employeeId: 'member' });
      assert.equal(f.monthly[0].record.rows[0].amounts.incomeTax, -30000); assert.equal(f.annual[0].report.sums.incomeTax, -30000);
      const source = await f.call('admin', 'sourceDownload', { recordId: id, revision: 1 });
      assert.equal(createHash('sha256').update(Buffer.from(source.base64, 'base64')).digest('hex'), draft.source.sha256);
      assert.equal(source.filename, '과거급여.csv'); assert.equal(source.mimeType, 'text/csv');
    });
    await t.test('correction retains exact original live approval, isolates pending work and uses only active amounts in annual reports', async () => {
      const f = await fixture(); const { record } = await f.approve(); const reference = db.doc('payroll_records/' + record.id);
      const original = (await reference.get()).data();
      const { draft } = await f.call('admin', 'startCorrection', { recordId: record.id, reason: '기존 급여 정정' });
      const rows = draft.rows.map(row => ({ userId: row.userId, amounts: row.userId === 'member' ?
        { ...row.amounts, incomeTax: -30000, totalDeductions: row.amounts.totalDeductions - row.amounts.incomeTax - 30000, netPay: row.amounts.netPay + row.amounts.incomeTax + 30000 } : row.amounts }));
      const changed = await f.call('admin', 'updateDraft', { id: draft.id, expectedDraftVersion: 1, reason: '원천세 환급 정정', rows });
      assert.deepEqual((await reference.get()).data(), original); assert.equal(changed.draft.diff.changed.length, 1);
      const field = changed.draft.diff.changed[0].fields.find(value => value.field === 'incomeTax');
      assert.deepEqual(field, { field: 'incomeTax', before: 29160, after: -30000 });
      const result = await f.call('admin', 'approveDraft', { id: draft.id, expectedDraftVersion: 2 }); assert.equal(result.revision, 2);
      const old = (await reference.collection('revisions').doc('r000001').get()).data(); assert.deepEqual(old.snapshot, original);
      await f.call('admin', 'monthlyPdf', { id: record.id, revision: 1 }); await f.call('admin', 'monthlyPdf', { id: record.id, revision: 2 });
      assert.equal(f.monthly[0].record.rows.find(row => row.userId === 'member').amounts.incomeTax, 29160);
      assert.equal(f.monthly[1].record.rows.find(row => row.userId === 'member').amounts.incomeTax, -30000);
      await f.call('admin', 'annualPdf', { year: 2026, employeeId: 'member' }); assert.equal(f.annual[0].report.sums.incomeTax, -30000);
      const versions = await f.call('admin', 'listRevisions', { id: record.id });
      assert.deepEqual(versions.revisions.map(row => [row.revision, row.active]), [[2, true], [1, false]]);
      assert(versions.revisions.every(row => row.companyId === 'a' && row.pdfAvailable));
    });
    await t.test('competing drafts cannot overwrite a newer approval and stale state is explicit', async () => {
      const f = await fixture(); const a = await f.importDraft(), b = await f.importDraft();
      const results = await Promise.allSettled([a.draft, b.draft].map(draft => f.call('admin', 'approveDraft', { id: draft.id, expectedDraftVersion: 1 })));
      assert.equal(results.filter(row => row.status === 'fulfilled').length, 1); assert.equal(results.find(row => row.status === 'rejected').reason.code, 'aborted');
      const loser = results[0].status === 'rejected' ? a.draft : b.draft;
      const stale = await f.call('admin', 'getDraft', { id: loser.id }); assert.equal(stale.draft.stale, true);
      const id = payrollRecordId('a', 2020, 1); assert.equal((await db.doc(`payroll_records/${id}/revisions/r000001`).get()).exists, true);
      assert.equal((await db.doc('payroll_records/' + id).collection('revisions').get()).size, 1);
    });
    await t.test('legacy backups survive old-site deletion and replacement imports never resurrect removed employee amounts', async () => {
      const f = await fixture(); await legacy(9);
      const { draft } = await f.call('admin', 'importSource', { year: 2026, month: 9, reason: '옛 집계 상세 보완', source: sourceFile([historic()]) });
      assert.deepEqual(draft.diff.totals.before, { monthlyGross: 1000000, netPay: 900000 });
      const { record } = await f.call('admin', 'approveDraft', { id: draft.id, expectedDraftVersion: 1 });
      await db.doc('payroll_records/legacy-9').delete();
      const revisions = await f.call('admin', 'listRevisions', { id: record.id });
      const backedUp = revisions.revisions.find(row => row.kind === 'LEGACY'); assert.equal(backedUp.legacyRecordId, 'legacy-9'); assert.equal(backedUp.pdfAvailable, false);
      const replacement = await f.call('admin', 'importSource', { year: 2026, month: 9, reason: '대상자 원본 교체', source: sourceFile([historic({ employeeLoginId: '', archiveCode: 'another-worker', name: '다른 직원' })]) });
      assert.equal(replacement.draft.diff.removed[0].userId, 'member');
      await f.call('admin', 'approveDraft', { id: replacement.draft.id, expectedDraftVersion: 1 });
      await f.call('admin', 'annualPdf', { year: 2026, employeeId: 'member' });
      assert.equal(f.annual[0].report.sums.monthlyGross, 0); assert.equal(f.annual[0].report.availableMonths, 0);
      await f.call('admin', 'monthlyPdf', { id: record.id, revision: 1 }); assert.equal(f.monthly[0].record.rows[0].userId, 'member');
    });
    await t.test('all draft, history and source APIs enforce organization ownership and active admin sessions', async () => {
      const f = await fixture(); const { draft } = await f.importDraft();
      const { record } = await f.call('admin', 'approveDraft', { id: draft.id, expectedDraftVersion: 1 });
      for (const [action, input] of [['getDraft', { id: draft.id }], ['listDraftVersions', { id: draft.id }],
        ['getDraftVersion', { id: draft.id, draftVersion: 1 }], ['updateDraft', { id: draft.id, expectedDraftVersion: 2, reason: '타사 수정', rows: [] }],
        ['approveDraft', { id: draft.id, expectedDraftVersion: 1 }], ['cancelDraft', { id: draft.id, expectedDraftVersion: 2, reason: '타사 취소' }],
        ['startCorrection', { recordId: record.id, reason: '타사 정정' }], ['listRevisions', { id: record.id }],
        ['getRevision', { id: record.id, revision: 1 }], ['monthlyPdf', { id: record.id, revision: 1 }],
        ['sourceDownload', { draftId: draft.id }], ['sourceDownload', { recordId: record.id, revision: 1 }]]) {
        await denied(f.call('foreignAdmin', action, input), 'not-found');
        for (const uid of ['member', 'sub', 'platform', 'retired', 'suspendedEmployee']) await denied(f.call(uid, action, input), 'permission-denied');
      }
      assert.equal((await f.call('foreignAdmin', 'listDrafts', { year: 2020 })).drafts.length, 0);
      f.faults.revoked = true; await denied(f.call('admin', 'getDraft', { id: draft.id }), 'unauthenticated');
    });
    await t.test('source bytes, generations, post-read authorization and immutable manifests fail closed', async () => {
      const f = await fixture(); const { draft } = await f.importDraft(); const [path, entry] = [...f.bucket.objects.entries()][0];
      const bytes = Buffer.from(entry.bytes); entry.bytes[0] ^= 1;
      await denied(f.call('admin', 'sourceDownload', { draftId: draft.id }), 'failed-precondition'); entry.bytes = bytes;
      entry.metadata.metadata.companyId = 'b'; await denied(f.call('admin', 'sourceDownload', { draftId: draft.id }), 'failed-precondition'); entry.metadata.metadata.companyId = 'a';
      f.faults.onSourceDownload = () => db.doc('UserProfile/admin').update({ companyId: 'b' });
      await denied(f.call('admin', 'sourceDownload', { draftId: draft.id }), 'permission-denied');
      await db.doc('UserProfile/admin').update({ companyId: 'a' }); f.faults.onSourceDownload = null;
      await db.doc('payroll_drafts/' + draft.id).update({ 'source.storagePath': path.replace('companies/a/', 'companies/b/') });
      await denied(f.call('admin', 'sourceDownload', { draftId: draft.id }), 'failed-precondition');
    });
    await t.test('source writes are cleaned up on failed transactions and retained after committed drafts', async () => {
      const f = await fixture(); f.faults.onSourceSave = () => db.doc('UserProfile/admin').update({ companyId: 'b' });
      await denied(f.importDraft(), 'permission-denied'); assert.equal(f.bucket.objects.size, 0); assert.equal((await db.collection('payroll_drafts').get()).size, 0);
      const g = await fixture(); const id = payrollRecordId('a', 2020, 1);
      await db.doc('payroll_records/' + id).set({ companyId: 'b', year: 2020, month: 1 });
      await denied(g.importDraft(), 'failed-precondition'); assert.equal(g.bucket.objects.size, 0);
      assert.equal((await db.doc('payroll_records/' + id).get()).data().companyId, 'b');
      const h = await fixture(); h.faults.rejectVerificationAt = 4;
      await denied(h.importDraft(), 'unauthenticated');
      const committed = await db.collection('payroll_drafts').get();
      assert.equal(committed.size, 1); assert.equal(h.bucket.objects.size, 1, 'a committed draft must retain its referenced source despite a late authentication failure');
    });
    await t.test('explicit old PDF remains stable while promotion changes the current approved projection', async () => {
      const f = await fixture(); const { record } = await f.approve();
      const { draft } = await f.call('admin', 'startCorrection', { recordId: record.id, reason: '동시 발급 정정' });
      f.faults.onMonthly = async () => { f.faults.onMonthly = null; await f.call('admin', 'approveDraft', { id: draft.id, expectedDraftVersion: 1 }); };
      await f.call('admin', 'monthlyPdf', { id: record.id, revision: 1 });
      assert.equal(f.monthly[0].record.revision, 1);
      const next = await f.call('admin', 'startCorrection', { recordId: record.id, reason: '현행 발급 정정' });
      f.faults.onMonthly = async () => { f.faults.onMonthly = null; await f.call('admin', 'approveDraft', { id: next.draft.id, expectedDraftVersion: 1 }); };
      await denied(f.call('admin', 'monthlyPdf', { id: record.id }), 'aborted');
    });
    await t.test('existing company deletion removes all payroll drafts, revisions and source bytes while preserving another company', async () => {
      const f = await fixture(); const a = await f.importDraft(), b = await f.importDraft(1, [historic({ employeeLoginId: '', archiveCode: 'former-b' })], 'foreignAdmin');
      const { record } = await f.call('admin', 'approveDraft', { id: a.draft.id, expectedDraftVersion: 1 });
      const correction = await f.call('admin', 'startCorrection', { recordId: record.id, reason: '삭제 회귀용 정정' });
      await f.call('admin', 'approveDraft', { id: correction.draft.id, expectedDraftVersion: 1 });
      const { createAdminSecurityService } = require('../admin-security-service');
      const admin = createAdminSecurityService({ db, now, bucket: f.bucket, auth: { async updateUser() {}, async revokeRefreshTokens() {}, async deleteUsers() { return { failureCount: 0 }; } } });
      await admin.deleteCompany(request('platform', 'deleteCompany', { companyId: 'a' }));
      assert.equal((await db.doc('payroll_records/' + record.id).get()).exists, false);
      assert.equal((await db.doc(`payroll_records/${record.id}/revisions/r000001`).get()).exists, false);
      assert.equal((await db.doc(`payroll_records/${record.id}/revisions/r000002`).get()).exists, false);
      for (const id of [a.draft.id, correction.draft.id]) {
        assert.equal((await db.doc('payroll_drafts/' + id).get()).exists, false);
        assert.equal((await db.doc(`payroll_drafts/${id}/versions/v000001`).get()).exists, false);
        assert.equal((await db.doc(`payroll_drafts/${id}/baseline/original`).get()).exists, false);
      }
      assert.equal((await db.doc('payroll_drafts/' + b.draft.id).get()).exists, true);
      assert.equal(f.bucket.objects.size, 1); assert([...f.bucket.objects.keys()].every(path => path.startsWith('companies/b/')));
      assert.equal((await db.doc('companies/a').get()).data().status, 'DELETED');
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
