import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateNetPay, getPayrollPeriod, insuranceDetailNote } from '../src/utils/payroll.ts';

const employee = { annualSalary: 36_000_000, nonTaxable: 0, rrn: '900101-1******' };
const note = (year, month, overrides = {}) =>
  insuranceDetailNote(calculateNetPay({ ...employee, ...overrides }, null, { year, month }));

test('payroll details describe the insurance formula actually used for the selected month', () => {
  const october = note(2026, 10);
  assert.match(october, /국민연금 4\.75%/);
  assert.match(october, /건강보험료 × \(0\.9448% ÷ 7\.19%\), 비율 반올림 없이/);
  assert.doesNotMatch(october, /13\.14%/);
  assert.match(note(2026, 11), /건강보험료 × 13\.14%/);
  const january = note(2027, 1);
  assert.match(january, /국민연금 5%/);
  assert.match(january, /건강보험 3\.595%/);
  assert.match(january, /건강보험료 × 13\.90% \(0\.9994% ÷ 7\.19%/);
});

test('individual insurance exclusions remain visible with the selected rates', () => {
  const excluded = note(2027, 1, { rrn: '600101-1******', employmentInsuranceIncluded: false });
  assert.match(excluded, /국민연금 0원/);
  assert.match(excluded, /고용보험 제외 \(0원\)/);
  assert.match(excluded, /건강보험료 × 13\.90%/);
});

test('a reopened payroll workspace defaults to the new Korean insurance month at midnight', t => {
  const now = t.mock.method(Date, 'now', () => Date.UTC(2026, 11, 31, 14, 59, 59));
  assert.deepEqual(getPayrollPeriod(), { year: 2026, month: 12 });
  now.mock.mockImplementation(() => Date.UTC(2026, 11, 31, 15));
  assert.deepEqual(getPayrollPeriod(), { year: 2027, month: 1 });
  assert.match(insuranceDetailNote(calculateNetPay(employee, null, getPayrollPeriod())), /국민연금 5%/);
});
