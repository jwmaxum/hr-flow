import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateNetPay } from '../src/utils/payroll.ts';

const salary = { annualSalary: 30_000_000, nonTaxable: 200_000, dependents: 1, childrenUnder20: 0 };
const calculate = (rrn, month = 10, extra = {}) => calculateNetPay({ ...salary, rrn, ...extra }, null, { year: 2026, month });

test('registered age60 loss excludes pension while retaining tax and other insurance amounts', () => {
  const covered = calculate('900101-1******'), exempt = calculate('600101-1******');
  assert.equal(covered.pension, 109_250);
  assert.equal(exempt.pension, 0);
  assert.equal(exempt.metadata.pensionRate, 0);
  assert.equal(exempt.metadata.pensionBase, 0);
  assert.equal(exempt.metadata.pensionAgeStatus, 'AGE_EXEMPT');
  for (const field of ['monthlyGross', 'nonTaxable', 'health', 'longTerm', 'employment', 'incomeTax', 'localTax']) assert.equal(exempt[field], covered[field]);
  assert.equal(exempt.totalDeductions, 146_310);
  assert.equal(exempt.netPay, 2_353_690);
  assert.equal(exempt.netPay - covered.netPay, covered.pension);
});

test('selected payroll month uses NPS monthly coverage including first-day birthday boundary', () => {
  for (const [rrn, month, pension] of [
    ['661001-1******', 9, 109_250], ['661001-1******', 10, 0],
    ['661002-1******', 10, 109_250], ['661002-1******', 11, 0],
    ['661031-1******', 10, 109_250], ['661031-1******', 11, 0],
    ['661101-1******', 10, 109_250], ['661101-1******', 11, 0],
    ['661102-1******', 11, 109_250], ['661102-1******', 12, 0],
    ['660101-1******', 3, 0], ['661231-1******', 12, 109_250],
    ['671001-1******', 10, 109_250], ['651231-1******', 3, 0],
  ]) assert.equal(calculate(rrn, month).pension, pension, `${rrn.slice(0, 6)} month ${month}`);
});

test('missing, masked century, malformed and future birth information defaults under60', () => {
  for (const rrn of [undefined, null, '', 600101, [], {}, '600101', '600101-*******', '600101-9*****', '600230-1******',
    '661301-1******', '660000-1******', '660101-1*****', '660101-1******extra', '990101-3******', '1960-01-01', 'x'.repeat(100)]) {
    const result = calculate(rrn);
    assert.equal(result.pension, 109_250);
    assert.equal(result.metadata.pensionAgeStatus, 'BIRTH_DATE_UNAVAILABLE');
  }
  // Certificate and nested HR data are not the registered top-level HR field.
  const result = calculate(undefined, 10, { birthDate: '1960-01-01', certificate: { birthDate: '1960-01-01' }, personalInfo: { rrn: '600101-1******' } });
  assert.equal(result.pension, 109_250);
});

test('only birth and century digits are needed; private trailing digits need not be retained', () => {
  for (const rrn of ['6001011', '600101-1', '6001011******', ' 600101 - 1****** ', '600101-1xxxxxx', '600101-1••••••', '600101-5123456', '600101-6123456']) {
    assert.equal(calculate(rrn).pension, 0);
  }
  for (const rrn of ['000101-3******', '000229-4******', '000101-7******', '000101-8******']) {
    assert.equal(calculate(rrn).pension, 109_250);
    assert.equal(calculate(rrn).metadata.pensionAgeStatus, 'COVERED');
  }
  assert.equal(calculate('000229-1******').metadata.pensionAgeStatus, 'BIRTH_DATE_UNAVAILABLE');
  assert.equal(calculate('640229-1******').pension, 0);
});

test('family withholding and age exclusion reconcile together across high-income bands', () => {
  for (const income of [10_000_001, 14_000_000, 28_000_001, 30_000_000, 45_000_001, 87_000_001]) {
    const base = { annualSalary: income * 12, nonTaxable: 0, dependents: 44, childrenUnder20: 2 };
    const covered = calculate('900101-1******', 10, base), exempt = calculate('600101-1******', 10, base);
    assert.equal(exempt.incomeTax, covered.incomeTax);
    assert.equal(exempt.netPay - covered.netPay, covered.pension);
    assert.equal(exempt.monthlyGross - exempt.totalDeductions, exempt.netPay);
    assert.equal(exempt.totalInsurance, exempt.health + exempt.longTerm + exempt.employment);
  }
});

test('child-credit remainders below KRW1000 are not withheld and local tax follows zero national withholding', () => {
  const result = calculate(undefined, 10, { annualSalary: 2_280_000 * 12, nonTaxable: 0, dependents: 2, childrenUnder20: 1 });
  assert.equal(result.incomeTax, 0);
  assert.equal(result.localTax, 0);
  assert.equal(result.totalDeductions, result.totalInsurance);
  assert.equal(result.netPay, result.monthlyGross - result.totalInsurance);
});
