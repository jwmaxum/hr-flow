import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateIncomeTax, calculateNetPay, getDeductionCounts } from '../src/utils/payroll.ts';
import official from '../src/data/withholdingTaxTable2026.json' with { type: 'json' };

test('official 2026 table distinguishes dependents in the reported 2.3 million won bracket', () => {
  assert.equal(calculateIncomeTax(2_300_000, 1, 0).incomeTax, 29_160);
  assert.equal(calculateIncomeTax(2_300_000, 4, 0).incomeTax, 9_180);
  assert.equal(calculateIncomeTax(2_300_000, 4, 2).incomeTax, 0);
});

test('employees with the same gross pay receive different net pay when deductions differ', () => {
  const salary = { annualSalary: 30_000_000, nonTaxable: 200_000 };
  const single = calculateNetPay({ ...salary, dependents: 1, childrenUnder20: 0 });
  const family = calculateNetPay({ ...salary, dependents: 4, childrenUnder20: 2 });
  assert.ok(single && family);
  assert.equal(single.incomeTax, 29_160);
  assert.equal(family.incomeTax, 0);
  assert.equal(family.netPay - single.netPay, 32_070);
});

test('children are counted among dependents, including for existing inconsistent records', () => {
  assert.deepEqual(getDeductionCounts({ dependents: 1, childrenUnder20: 3 }), { dependents: 4, children: 3 });
});

test('an absent or malformed uploaded table uses the complete official table', () => {
  const malformed = { brackets: [{ min: 2300, max: 2310, taxes: [999] }] };
  assert.deepEqual(calculateIncomeTax(2_300_000, 1, 0, malformed), {
    incomeTax: 29_160,
    tableSource: 'official-2026'
  });
});

test('a complete valid uploaded table overrides the bundled bracket', () => {
  const uploaded = structuredClone(official);
  uploaded.brackets.find(row => row.min === 2300).taxes = Array(11).fill(5_000);
  assert.deepEqual(calculateIncomeTax(2_300_000, 1, 0, uploaded), {
    incomeTax: 5_000,
    tableSource: 'uploaded'
  });
});

test('legacy included flags never divide wages by thirteen and monthly UI values remain annual equivalents', () => {
  const excluded = calculateNetPay({ annualSalary: 39_000_000, isSeveranceIncluded: false }, null, { year: 2026, month: 10 });
  const legacy = calculateNetPay({ annualSalary: 39_000_000, isSeveranceIncluded: true, salaryType: 'MONTHLY' }, null, { year: 2026, month: 10 });
  assert.equal(legacy.monthlyGross, 3_250_000);
  assert.equal(legacy.netPay, excluded.netPay);
  assert.equal(legacy.isSeveranceIncluded, false);
  assert.equal(legacy.salaryBasis, 'MONTHLY');
});

test('2026 employee pension limits change in July and the standard base drops sub-thousand won', () => {
  const employee = { annualSalary: 120_000_000, nonTaxable: 0 };
  assert.equal(calculateNetPay(employee, null, { year: 2026, month: 6 }).pension, 302_570);
  assert.equal(calculateNetPay(employee, null, { year: 2026, month: 7 }).pension, 313_020);
  assert.equal(calculateNetPay({ annualSalary: 1_200_000, nonTaxable: 0 }, null, { year: 2026, month: 6 }).pension, 19_000);
  assert.equal(calculateNetPay({ annualSalary: 1_200_000, nonTaxable: 0 }, null, { year: 2026, month: 7 }).pension, 19_470);
  const result = calculateNetPay({ annualSalary: 27_611_988, nonTaxable: 0 }, null, { year: 2026, month: 10 });
  assert.equal(result.metadata.pensionBase, 2_300_000);
});

test('income and local withholding drop amounts below ten won and reproduce the reference general-worker total', () => {
  const result = calculateNetPay({ annualSalary: 30_000_000, nonTaxable: 200_000 }, null, { year: 2026, month: 10 });
  assert.equal(result.incomeTax, 29_160);
  assert.equal(result.localTax, 2_910);
  assert.equal(result.totalDeductions, 255_560);
  assert.equal(result.netPay, 2_244_440);
  assert.equal(calculateIncomeTax(10_000_001, 1, 0).incomeTax % 10, 0);
});

test('uploaded high-income base is honored instead of silently taking the bundled base', () => {
  const uploaded = structuredClone(official);
  uploaded.taxAt10Million = uploaded.taxAt10Million.map(tax => tax + 100_000);
  assert.equal(calculateIncomeTax(10_000_000, 1, 0, uploaded).incomeTax, 1_607_400);
  assert.equal(calculateIncomeTax(14_000_000, 1, 0, uploaded).incomeTax, 3_004_400);
  assert.equal(calculateIncomeTax(14_000_000, 1, 0, uploaded).tableSource, 'uploaded');
  delete uploaded.taxAt10Million;
  assert.equal(calculateIncomeTax(14_000_000, 1, 0, uploaded).tableSource, 'official-2026');
});

test('unsupported historical/future periods are flagged and invalid dates are rejected', () => {
  const person = { annualSalary: 30_000_000 };
  for (const period of [{ year: 2025, month: 10 }, { year: 2027, month: 1 }, { year: 2026, month: 2 }]) assert.equal(calculateNetPay(person, null, period).metadata.policyPeriodSupported, false);
  assert.equal(calculateNetPay(person, null, { year: 2026, month: 3 }).metadata.policyPeriodSupported, true);
  for (const period of [{ year: 2026, month: 0 }, { year: NaN, month: 1 }, { year: 2026, month: 13 }]) assert.throws(() => calculateNetPay(person, null, period), /연도와 월/);
  const future = { ...structuredClone(official), effectiveFrom: '2026-11-01' };
  assert.equal(calculateNetPay(person, future, { year: 2026, month: 10 }).metadata.policyPeriodSupported, false);
  assert.equal(calculateNetPay(person, future, { year: 2026, month: 11 }).metadata.policyPeriodSupported, true);
  assert.equal(calculateNetPay(person, { ...future, effectiveFrom: '2026-00-00' }, { year: 2026, month: 11 }).metadata.policyPeriodSupported, false);
});

test('invalid salary inputs cannot produce NaN totals and non-taxable pay cannot exceed gross', () => {
  for (const salary of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(calculateNetPay({ annualSalary: salary }), null);
  const result = calculateNetPay({ annualSalary: 1_200_000, nonTaxable: 200_000 }, null, { year: 2026, month: 10 });
  assert.equal(result.nonTaxable, 100_000);
  assert.equal(result.monthlyGross - result.nonTaxable, 0);
  assert.equal(calculateNetPay({ annualSalary: 30_000_000, nonTaxable: NaN }).nonTaxable, 200_000);
  assert.throws(() => calculateIncomeTax(NaN, 1, 0), /월급여/);
});

test('the legal formula handles incomes above the tabulated ten million won limit', () => {
  assert.equal(calculateIncomeTax(10_000_000, 1, 0).incomeTax, 1_507_400);
  assert.equal(calculateIncomeTax(12_000_000, 1, 0).incomeTax, 2_218_400);
  assert.equal(calculateIncomeTax(10_000_000, 12, 0).incomeTax, 930_840);
  for (const [income, tax] of [[14_000_000, 2_904_400], [28_000_000, 8_118_000], [30_000_000, 8_902_000], [45_000_000, 14_902_000], [87_000_000, 32_542_000], [100_000_000, 38_392_000]]) {
    assert.equal(calculateIncomeTax(income, 1, 0).incomeTax, tax);
  }
});
