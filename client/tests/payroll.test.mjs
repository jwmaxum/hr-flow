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

test('bonus increases monthly gross, taxable income, four major insurances, and income tax appropriately', () => {
  const withoutBonus = calculateNetPay({ annualSalary: 30_000_000, nonTaxable: 200_000 }, null, { year: 2026, month: 10 });
  const withBonus = calculateNetPay({ annualSalary: 30_000_000, nonTaxable: 200_000, bonus: 1_000_000 }, null, { year: 2026, month: 10 });
  assert.ok(withoutBonus && withBonus);
  assert.equal(withoutBonus.monthlyGross, 2_500_000);
  assert.equal(withBonus.monthlyGross, 3_500_000);
  assert.equal(withBonus.bonus, 1_000_000);
  assert.equal(withBonus.nonTaxable, 200_000);
  assert.equal(withBonus.basePay, 3_300_000);
  assert.ok(withBonus.incomeTax > withoutBonus.incomeTax);
  assert.ok(withBonus.totalInsurance > withoutBonus.totalInsurance);
  assert.equal(withBonus.monthlyGross - withBonus.totalDeductions, withBonus.netPay);
});

test('irregular worker with 3.3% business withholding exempts 4 major insurances and deducts 3% income + 0.3% local tax', () => {
  const irregular = calculateNetPay({
    annualSalary: 36_000_000,
    salaryType: 'IRREGULAR',
    withholdingTaxRate: '3.3'
  }, null, { year: 2026, month: 10 });
  assert.ok(irregular);
  assert.equal(irregular.monthlyGross, 3_000_000);
  assert.equal(irregular.nonTaxable, 0);
  assert.equal(irregular.pension, 0);
  assert.equal(irregular.health, 0);
  assert.equal(irregular.longTerm, 0);
  assert.equal(irregular.employment, 0);
  assert.equal(irregular.totalInsurance, 0);
  assert.equal(irregular.incomeTax, 90_000); // 3,000,000 * 3%
  assert.equal(irregular.localTax, 9_000); // 90,000 * 10%
  assert.equal(irregular.totalDeductions, 99_000); // 3.3%
  assert.equal(irregular.netPay, 2_901_000);
  assert.equal(irregular.isIrregular, true);
  assert.equal(irregular.withholdingTaxRate, '3.3');
  assert.equal(irregular.salaryBasis, 'IRREGULAR');
});

test('irregular worker with 8.8% other income withholding and bonus calculates accurately', () => {
  const irregular = calculateNetPay({
    annualSalary: 24_000_000,
    salaryType: 'IRREGULAR',
    withholdingTaxRate: '8.8',
    bonus: 500_000
  }, null, { year: 2026, month: 10 });
  assert.ok(irregular);
  assert.equal(irregular.monthlyGross, 2_500_000); // 2,000,000 base + 500,000 bonus
  assert.equal(irregular.bonus, 500_000);
  assert.equal(irregular.totalInsurance, 0);
  assert.equal(irregular.incomeTax, 200_000); // 2,500,000 * 8%
  assert.equal(irregular.localTax, 20_000); // 200,000 * 10%
  assert.equal(irregular.totalDeductions, 220_000); // 8.8%
  assert.equal(irregular.netPay, 2_280_000);
  assert.equal(irregular.isIrregular, true);
  assert.equal(irregular.withholdingTaxRate, '8.8');
});

test('irregular worker 3.3% small-tax exemption (Art. 86) and 8.8% minimum taxable threshold (Art. 84)', () => {
  // 3.3% 소액부징수: 지급액 33,000원 -> 소득세 990원 (< 1,000원) => 면제 0원
  const smallBusiness = calculateNetPay({
    annualSalary: 33_000 * 12,
    salaryType: 'IRREGULAR',
    withholdingTaxRate: '3.3',
  }, null, { year: 2026, month: 11 });
  assert.ok(smallBusiness);
  assert.equal(smallBusiness.totalInsurance, 0);
  assert.equal(smallBusiness.incomeTax, 0);
  assert.equal(smallBusiness.localTax, 0);
  assert.equal(smallBusiness.netPay, 33_000);

  // 8.8% 과세최저한: 지급액 125,000원 -> 기타소득금액 50,000원 (<= 50,000원) => 면제 0원
  const exemptOther = calculateNetPay({
    annualSalary: 125_000 * 12,
    salaryType: 'IRREGULAR',
    withholdingTaxRate: '8.8',
  }, null, { year: 2026, month: 11 });
  assert.ok(exemptOther);
  assert.equal(exemptOther.totalInsurance, 0);
  assert.equal(exemptOther.incomeTax, 0);
  assert.equal(exemptOther.localTax, 0);
  assert.equal(exemptOther.netPay, 125_000);

  // 8.8% 과세최저한 초과: 지급액 130,000원 -> 소득세 10,400원, 지방소득세 1,040원
  const taxedOther = calculateNetPay({
    annualSalary: 130_000 * 12,
    salaryType: 'IRREGULAR',
    withholdingTaxRate: '8.8',
  }, null, { year: 2026, month: 11 });
  assert.ok(taxedOther);
  assert.equal(taxedOther.totalInsurance, 0);
  assert.equal(taxedOther.incomeTax, 10_400);
  assert.equal(taxedOther.localTax, 1_040);
  assert.equal(taxedOther.netPay, 130_000 - 11_440);

  // 기본급 0원 + 상여금(일시금) 단독 지급 비정규직 3.3%
  const bonusOnly = calculateNetPay({
    annualSalary: 0,
    bonus: 1_000_000,
    salaryType: 'IRREGULAR',
    withholdingTaxRate: '3.3',
  }, null, { year: 2026, month: 11 });
  assert.ok(bonusOnly);
  assert.equal(bonusOnly.monthlyGross, 1_000_000);
  assert.equal(bonusOnly.totalInsurance, 0);
  assert.equal(bonusOnly.incomeTax, 30_000);
  assert.equal(bonusOnly.localTax, 3_000);
  assert.equal(bonusOnly.netPay, 967_000);
});
