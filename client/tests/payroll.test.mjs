import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateIncomeTax, calculateNetPay, getDeductionCounts } from '../src/utils/payroll.ts';
import { getPayrollPeriod } from '../../functions/payroll-calculation.mjs';
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

test('insurance month switches the long-term care ratio in November and employee pension in January', () => {
  const employee = { annualSalary: 1_700_000 * 12, nonTaxable: 0 };
  const calculate = (year, month) => calculateNetPay(employee, null, { year, month });
  for (const [year, month, care, pension, multiplier] of [
    [2026, 10, 8_030, 80_750, 9448 / 71900],
    [2026, 11, 8_020, 80_750, .1314],
    [2026, 12, 8_020, 80_750, .1314],
    [2027, 1, 8_490, 85_000, .139],
    [2027, 12, 8_490, 85_000, .139]
  ]) {
    const result = calculate(year, month);
    assert.equal(result.health, 61_110);
    assert.equal(result.longTerm, care);
    assert.equal(result.pension, pension);
    assert.equal(result.metadata.longTermRate, multiplier);
    assert.equal(result.metadata.roundsLongTermRatio, !(year === 2026 && month === 10));
    assert.equal(result.metadata.longTermIncomeRate, year === 2026 ? .009448 : .009994);
    assert.equal(result.metadata.pensionRate, year === 2026 ? .0475 : .05);
  }
  const october = calculate(2026, 10), november = calculate(2026, 11);
  assert.equal(november.netPay - october.netPay, 10);
  assert.notEqual(october.metadata.calculationVersion, november.metadata.calculationVersion);
  assert.notEqual(november.metadata.calculationVersion, calculate(2027, 1).metadata.calculationVersion);
});

test('the default payroll period switches at midnight in Korea and explicit settlement months stay fixed', t => {
  let instant = Date.UTC(2026, 11, 31, 14, 59, 59);
  t.mock.method(Date, 'now', () => instant);
  const employee = { annualSalary: 1_700_000 * 12, nonTaxable: 0 };
  assert.deepEqual(getPayrollPeriod(), { year: 2026, month: 12 });
  assert.equal(calculateNetPay(employee).pension, 80_750);
  instant += 1000;
  assert.deepEqual(getPayrollPeriod(), { year: 2027, month: 1 });
  assert.equal(calculateNetPay(employee).pension, 85_000);
  assert.equal(calculateNetPay(employee, null, { year: 2026, month: 10 }).longTerm, 8_030);
});

test('ten-won truncation preserves exact ratio boundaries; published pension limits and exemptions survive the 2027 change', () => {
  const employee = { annualSalary: 2_781_642 * 12, nonTaxable: 0 };
  const november = calculateNetPay(employee, null, { year: 2026, month: 11 });
  const january = { year: 2027, month: 1 };
  const nextYear = calculateNetPay(employee, null, january);
  assert.equal(november.health, 100_000);
  assert.equal(november.longTerm, 13_140);
  assert.equal(nextYear.health, 100_000);
  assert.equal(nextYear.longTerm, 13_900);
  assert.equal(calculateNetPay({ ...employee, annualSalary: 1_200_000 }, null, january).pension, 20_500);
  assert.equal(calculateNetPay({ ...employee, annualSalary: 120_000_000 }, null, january).pension, 329_500);
  const exempt = calculateNetPay({ ...employee, rrn: '670101-1******' }, null, january);
  assert.equal(exempt.pension, 0);
  assert.equal(exempt.longTerm, 13_900);
  assert.equal(calculateNetPay({ ...employee, salaryType: 'IRREGULAR' }, null, january).totalInsurance, 0);
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
  for (const period of [{ year: 2025, month: 10 }, { year: 2028, month: 1 }, { year: 2026, month: 2 }]) assert.equal(calculateNetPay(person, null, period).metadata.policyPeriodSupported, false);
  assert.equal(calculateNetPay(person, null, { year: 2026, month: 3 }).metadata.policyPeriodSupported, true);
  assert.equal(calculateNetPay(person, null, { year: 2027, month: 6 }).metadata.policyPeriodSupported, true);
  const july = calculateNetPay(person, null, { year: 2027, month: 7 });
  assert.equal(july.metadata.policyPeriodSupported, false);
  assert.equal(july.metadata.policyPeriodReason, 'PENSION_LIMITS_PENDING');
  for (const period of [{ year: 2026, month: 0 }, { year: NaN, month: 1 }, { year: 2026, month: 13 }]) assert.throws(() => calculateNetPay(person, null, period), /연도와 월/);
  const future = { ...structuredClone(official), effectiveFrom: '2026-11-01' };
  assert.equal(calculateNetPay(person, future, { year: 2026, month: 10 }).metadata.policyPeriodSupported, false);
  assert.equal(calculateNetPay(person, future, { year: 2026, month: 11 }).metadata.policyPeriodSupported, true);
  assert.equal(calculateNetPay(person, { ...future, effectiveFrom: '2026-00-00' }, { year: 2026, month: 11 }).metadata.policyPeriodSupported, false);
  const nextYear = { ...future, effectiveFrom: '2027-02-01' };
  assert.equal(calculateNetPay(person, nextYear, { year: 2027, month: 1 }).metadata.policyPeriodReason, 'TAX_TABLE_EFFECTIVE_DATE');
  assert.equal(calculateNetPay(person, nextYear, { year: 2027, month: 2 }).metadata.policyPeriodSupported, true);
});

test('invalid salary inputs cannot produce NaN totals and non-taxable pay cannot exceed gross', () => {
  for (const salary of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(calculateNetPay({ annualSalary: salary }), null);
  assert.throws(() => calculateNetPay({ annualSalary: 12, bonus: Number.MAX_SAFE_INTEGER }), /합계 범위/);
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

test('regular employee employment insurance defaults to included and can be exempted for executives/representatives', () => {
  const included = calculateNetPay({ annualSalary: 30_000_000, nonTaxable: 200_000 }, null, { year: 2026, month: 11 });
  const explicitIncluded = calculateNetPay({ annualSalary: 30_000_000, nonTaxable: 200_000, employmentInsuranceIncluded: true }, null, { year: 2026, month: 11 });
  const exempted = calculateNetPay({ annualSalary: 30_000_000, nonTaxable: 200_000, employmentInsuranceIncluded: false }, null, { year: 2026, month: 11 });
  assert.ok(included && explicitIncluded && exempted);
  assert.equal(included.employment, 20_700);
  assert.equal(included.employmentInsuranceIncluded, true);
  assert.equal(included.metadata.employmentRate, 0.009);
  assert.equal(explicitIncluded.netPay, included.netPay);

  assert.equal(exempted.employment, 0);
  assert.equal(exempted.employmentInsuranceIncluded, false);
  assert.equal(exempted.metadata.employmentRate, 0);
  assert.equal(exempted.pension, included.pension);
  assert.equal(exempted.health, included.health);
  assert.equal(exempted.longTerm, included.longTerm);
  assert.equal(exempted.incomeTax, included.incomeTax);
  assert.equal(exempted.localTax, included.localTax);
  assert.equal(exempted.totalInsurance, included.totalInsurance - included.employment);
  assert.equal(exempted.totalDeductions, included.totalDeductions - included.employment);
  assert.equal(exempted.netPay, included.netPay + included.employment);
});
