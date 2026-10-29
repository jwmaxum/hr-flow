const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePayrollIdentity, normalizePayrollRow, sumPayrollRows, validatePayrollRecord, buildAnnualPayrollReport,
} = require('../payroll-report-model');
const { renderMonthlyPayrollPdf, renderAnnualPayrollPdf } = require('../payroll-pdf');
const { editableAmounts } = require('../payroll-workflow');

function row(id = 'employee-a', patch = {}) {
  return {
    userId: id, companyId: 'company-a', name: `검증직원 ${id}`, employeeNumber: '2026001',
    joinDate: '2026-01-02', resignDate: '', position: '팀원', divisionName: '검증본부', teamName: '검증팀',
    amounts: { monthlyGross: 2500000, basePay: 2300000, nonTaxable: 200000,
      pension: 109250, health: 82680, longTerm: 10860, employment: 20700,
      incomeTax: 29160, localTax: 2910, totalInsurance: 223490, totalDeductions: 255560, netPay: 2244440 },
    calculation: { dependents: 1, children: 0, tableSource: 'uploaded' }, ...patch,
  };
}
function record(month = 1, rows = [row()], patch = {}) {
  return { id: `record-${month}`, schemaVersion: 2, scope: 'COMPANY', companyId: 'company-a', year: 2026, month,
    approvedAtIso: `2026-${String(month).padStart(2, '0')}-25T01:00:00.000Z`, approvedByName: '검증관리자', revision: 1,
    rows, sums: sumPayrollRows(rows), taxTable: { source: 'uploaded', version: '2026-03', fileName: '검증세액표.xlsx' }, ...patch };
}
const branding = { companyName: '급여 검증 주식회사', address: '서울특별시 검증로 123', representative: '검증대표' };

test('snapshot whitelist clones values and excludes unrelated personal or credential fields', () => {
  const input = row('employee-a', { residentNumber: 'synthetic-private-field', password: 'synthetic-unused-field' });
  const result = normalizePayrollRow(input, 'company-a');
  assert.equal(result.amounts.monthlyGross, 2500000);
  assert.equal(Object.hasOwn(result, 'residentNumber'), false);
  assert.equal(Object.hasOwn(result, 'password'), false);
  input.amounts.monthlyGross = 1;
  assert.equal(result.amounts.monthlyGross, 2500000);
  assert.equal(Object.hasOwn(normalizePayrollIdentity(row(), 'company-a'), 'amounts'), false);
});

test('cross-company row/record injection and unsafe identity paths fail closed', () => {
  assert.throws(() => normalizePayrollRow(row(), 'company-b'));
  assert.throws(() => validatePayrollRecord(record(), 'company-b'));
  for (const userId of ['', '../foreign', 'other\\user', 'user\nforeign']) assert.throws(() => normalizePayrollRow(row(userId), 'company-a'));
  assert.throws(() => validatePayrollRecord(record(1, [row('x'), row('x')]), 'company-a'));
});

test('snapshot amounts and totals must reconcile exactly as safe integers', () => {
  for (const patch of [{ netPay: 1 }, { totalInsurance: 0 }, { monthlyGross: Infinity }, { incomeTax: -1 }, { basePay: 1.5 }]) {
    assert.throws(() => normalizePayrollRow(row('x', { amounts: { ...row().amounts, ...patch } }), 'company-a'));
  }
  assert.throws(() => validatePayrollRecord({ ...record(), sums: { ...record().sums, netPay: 1 } }, 'company-a'));
  const high = row('high', { amounts: { monthlyGross: 2e12, basePay: 2e12, nonTaxable: 0, pension: 0, health: 0, longTerm: 0, employment: 0,
    incomeTax: 0, localTax: 0, totalInsurance: 0, totalDeductions: 0, netPay: 2e12 } });
  assert.equal(normalizePayrollRow(high, 'company-a').amounts.netPay, 2e12);
});

test('imported and manually adjusted saved amounts permit refunds and other deductions without invented family counts', () => {
  const amounts = editableAmounts({ monthlyGross: 2500000, nonTaxable: 200000, pension: 100000, health: 80000, longTerm: 10000,
    employment: 20000, incomeTax: -30000, localTax: -3000, otherDeductions: 17000 });
  assert.equal(amounts.totalInsurance, 210000); assert.equal(amounts.totalDeductions, 194000); assert.equal(amounts.netPay, 2306000);
  for (const mode of ['IMPORTED', 'ADJUSTED']) {
    const calculation = { mode, tableSource: mode === 'IMPORTED' ? 'imported-source' : 'manual-correction', dependents: 999, children: 999 };
    const saved = normalizePayrollRow(row('historical', { amounts, calculation }), 'company-a');
    assert.equal(saved.amounts.incomeTax, -30000); assert.equal(saved.calculation.dependents, undefined); assert.equal(saved.calculation.children, undefined);
    assert.equal(validatePayrollRecord(record(1, [saved], { year: 2020 }), 'company-a').year, 2020);
  }
  assert.throws(() => normalizePayrollRow(row('calculated', { amounts }), 'company-a'));
  assert.throws(() => normalizePayrollRow(row('forged', { amounts, calculation: { mode: 'IMPORTED', tableSource: 'uploaded' } }), 'company-a'));
});

test('signed saved-value reconciliation uses exact integers even when intermediate numbers would lose precision', () => {
  const maximum = Number.MAX_SAFE_INTEGER;
  const values = { monthlyGross: 100, nonTaxable: 0, pension: maximum, health: 2, longTerm: -maximum, employment: 0,
    incomeTax: 0, localTax: 0, otherDeductions: 0 };
  const amounts = editableAmounts(values); assert.equal(amounts.totalInsurance, 2); assert.equal(amounts.netPay, 98);
  const saved = row('exact', { amounts, calculation: { mode: 'ADJUSTED', tableSource: 'manual-correction' } });
  assert.equal(normalizePayrollRow(saved, 'company-a').amounts.totalInsurance, 2);
  assert.throws(() => normalizePayrollRow({ ...saved, amounts: { ...amounts, totalInsurance: 1, totalDeductions: 1, netPay: 99 } }, 'company-a'));
  assert.throws(() => editableAmounts({ ...values, totalDeductions: 1, netPay: 99 }));
  assert.throws(() => editableAmounts({ ...values, pension: maximum, health: maximum, longTerm: 0 }));
  const old = record(); delete old.rows[0].amounts.otherDeductions; delete old.sums.otherDeductions;
  assert.equal(validatePayrollRecord(old, 'company-a').sums.otherDeductions, 0);
});

test('saved historical source metadata excludes private object paths and PDF accepts refunds and other deductions', async () => {
  const amounts = editableAmounts({ monthlyGross: 2500000, nonTaxable: 200000, pension: 0, health: 0, longTerm: 0, employment: 0,
    incomeTax: -30000, localTax: -3000, otherDeductions: 17000 });
  const saved = row('former', { amounts, calculation: { mode: 'IMPORTED', tableSource: 'imported-source' } });
  const input = record(1, [saved], { year: 2020, origin: 'IMPORT', reason: '과거 원본\n검토 완료', source: { name: '2020원본.csv',
    mimeType: 'text/csv', size: 1234, sha256: 'a'.repeat(64), storagePath: 'private-source-path', generation: '123' } });
  const checked = validatePayrollRecord(input, 'company-a'); assert.equal(checked.source.storagePath, undefined);
  assert.equal(checked.source.generation, undefined); assert.equal(checked.rows[0].amounts.netPay, 2516000);
  const monthly = await renderMonthlyPayrollPdf(checked, branding); assert.equal(monthly.subarray(0, 8).toString(), '%PDF-1.7');
  const annual = await renderAnnualPayrollPdf(buildAnnualPayrollReport([input], 'company-a', 2020, 'former'), branding);
  assert.equal(annual.subarray(0, 8).toString(), '%PDF-1.7');
});

test('monthly snapshots retain zero optional identity fields but reject malformed dates and incomplete details', () => {
  const bare = row('bare', { employeeNumber: undefined, joinDate: '', position: undefined });
  const result = validatePayrollRecord(record(1, [bare]), 'company-a');
  assert.equal(result.rows[0].employeeNumber, ''); assert.equal(result.rows[0].position, '');
  assert.throws(() => normalizePayrollRow(row('x', { joinDate: '2026-02-30' }), 'company-a'));
  for (const patch of [{ schemaVersion: 1 }, { scope: 'FILTERED' }, { rows: [] }, { year: 2026, month: 13 }, { approvedAtIso: 'invalid', approvedAt: undefined }]) {
    assert.throws(() => validatePayrollRecord({ ...record(), ...patch }, 'company-a'));
  }
});

test('annual report contains all twelve months and never infers unavailable months from current salary', () => {
  const result = buildAnnualPayrollReport([record(), { companyId: 'company-a', year: 2026, month: 2, approvedAtIso: '2026-02-25T00:00:00Z', totalGross: 9999999 }], 'company-a', 2026, 'employee-a');
  assert.equal(result.months.length, 12); assert.equal(result.availableMonths, 1);
  assert.equal(result.months[0].status, 'APPROVED'); assert.equal(result.months[1].status, 'LEGACY'); assert.equal(result.months[2].status, 'MISSING');
  assert.equal(result.months[1].row, null); assert.equal(result.months[2].row, null);
  assert.equal(result.sums.netPay, row().amounts.netPay);
  assert.deepEqual(result.legacyMonths, [2]);
  assert.equal(Object.hasOwn(result.employee, 'amounts'), false);
});

test('repeated month approvals select one latest modern snapshot instead of adding every revision', () => {
  const first = record();
  const secondRow = row('employee-a', { name: '변경 후 성명' });
  const second = record(1, [secondRow], { id: 'revision-2', revision: 2, approvedAtIso: '2026-01-26T00:00:00Z' });
  const otherCompany = record(1, [row('foreign', { companyId: 'company-b' })], { companyId: 'company-b' });
  const result = buildAnnualPayrollReport([first, second, otherCompany, record(12, [row()], { year: 2025 })], 'company-a', 2026, 'employee-a');
  assert.equal(result.availableMonths, 1); assert.equal(result.sums.netPay, row().amounts.netPay);
  assert.equal(result.months[0].recordId, 'revision-2'); assert.equal(result.employee.name, '변경 후 성명');
});

test('a later legacy aggregate cannot hide an existing detailed month and exposes an explicit warning', () => {
  const result = buildAnnualPayrollReport([record(), { id: 'legacy-later', companyId: 'company-a', year: 2026, month: 1,
    approvedAtIso: '2026-01-28T00:00:00Z', totalGross: 1 }], 'company-a', 2026, 'employee-a');
  assert.equal(result.months[0].status, 'APPROVED'); assert.deepEqual(result.legacyAfterSnapshotMonths, [1]);
  assert.equal(result.sums.monthlyGross, 2500000);
});

test('a newer complete snapshot omitting an employee does not resurrect an older employee amount', () => {
  const latest = record(1, [row('different')], { approvedAtIso: '2026-01-28T00:00:00Z' });
  const result = buildAnnualPayrollReport([record(), latest], 'company-a', 2026, 'employee-a');
  assert.equal(result.months[0].status, 'MISSING'); assert.equal(result.availableMonths, 0); assert.equal(result.sums.netPay, 0);
  assert.equal(result.employee.userId, 'employee-a');
});

test('corrupt approved detail is rejected rather than silently replaced with legacy or current settings', () => {
  const invalid = record(1, [row()], { sums: { ...record().sums, netPay: 0 } });
  assert.throws(() => buildAnnualPayrollReport([invalid], 'company-a', 2026, 'employee-a'));
  assert.throws(() => buildAnnualPayrollReport([record(1, [row('x', { companyId: 'company-b' })])], 'company-a', 2026, 'x'));
});

test('PDF ledger embeds Korean fonts, exact A4 landscape pages and actual-size print preference', async () => {
  const bytes = await renderMonthlyPayrollPdf(record(), branding);
  const text = bytes.toString('latin1');
  assert.equal(bytes.subarray(0, 8).toString(), '%PDF-1.7');
  assert.match(text, /\/MediaBox \[0 0 841\.89 595\.28\]/);
  assert.match(text, /\/ToUnicode/); assert.match(text, /\/PrintScaling \/None/);
  assert.equal((text.match(/\/Type \/Page\b/g) || []).length, 1);
});

test('PDF ledger paginates a full company and repeats headers without dropping final employee or totals', async () => {
  const rows = Array.from({ length: 37 }, (_, index) => row(`employee-${String(index).padStart(3, '0')}`));
  const bytes = await renderMonthlyPayrollPdf(record(10, rows), branding);
  assert.ok((bytes.toString('latin1').match(/\/Type \/Page\b/g) || []).length > 1);
  assert.ok(bytes.length < 10 * 1024 * 1024);
});

test('annual PDF supports mixed approved/legacy/missing months with no fabricated figures', async () => {
  const report = buildAnnualPayrollReport([record(), record(3), { companyId: 'company-a', year: 2026, month: 2 }], 'company-a', 2026, 'employee-a');
  const bytes = await renderAnnualPayrollPdf(report, branding);
  assert.equal(bytes.subarray(0, 8).toString(), '%PDF-1.7');
  assert.match(bytes.toString('latin1'), /\/ToUnicode/);
  const invalid = structuredClone(report); invalid.months[1].row = row();
  await assert.rejects(renderAnnualPayrollPdf(invalid, branding));
  await assert.rejects(renderAnnualPayrollPdf({ ...report, companyId: 'foreign' }, branding));
});

test('legacy-only annual PDF may use scoped identity only and still does not create pay values', async () => {
  const report = buildAnnualPayrollReport([{ companyId: 'company-a', year: 2026, month: 1 }], 'company-a', 2026, 'employee-a');
  assert.equal(report.employee, null);
  report.employee = normalizePayrollIdentity(row(), 'company-a');
  const bytes = await renderAnnualPayrollPdf(report, branding);
  assert.equal(bytes.subarray(0, 8).toString(), '%PDF-1.7');
  assert.equal(report.availableMonths, 0);
  assert.equal(report.months.filter(item => item.row !== null).length, 0);
});
