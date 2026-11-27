import { payrollCalculator } from './payrollTaxTable.ts';
import type { PayrollResult } from '../../../functions/payroll-calculation.mjs';
export type { PayrollEmployee, PayrollPeriod, PayrollResult, TaxTable, TaxBracket } from '../../../functions/payroll-calculation.mjs';

export { getPayrollPeriod } from '../../../functions/payroll-calculation.mjs';

export const MEAL_ALLOWANCE_DEFAULT = 200000;
export const getDeductionCounts = payrollCalculator.getDeductionCounts;
export const calculateIncomeTax = payrollCalculator.calculateIncomeTax;
// annualSalary/currentVal stay the stored annual equivalent even when the UI
// displays a monthly wage. Retirement pay is always outside wages.
export const calculateNetPay = payrollCalculator.calculateNetPay;

const ratePercent = new Intl.NumberFormat('ko-KR', { style: 'percent', maximumFractionDigits: 4 });
const roundedCarePercent = new Intl.NumberFormat('ko-KR', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function insuranceDetailNote({ metadata }: PayrollResult): string {
  const pension = metadata.pensionAgeStatus === 'AGE_EXEMPT'
    ? '국민연금 0원 (귀속월 기준 만 60세 의무가입 제외)'
    : `국민연금 ${ratePercent.format(metadata.pensionRate)}${metadata.pensionAgeStatus === 'BIRTH_DATE_UNAVAILABLE' ? ' (생년월일 미입력으로 만 60세 미만 적용)' : ''}`;
  const ratio = `${ratePercent.format(metadata.longTermIncomeRate)} ÷ ${ratePercent.format(metadata.healthRate * 2)}`;
  const care = metadata.roundsLongTermRatio
    ? `장기요양보험은 건강보험료 × ${roundedCarePercent.format(metadata.longTermRate)} (${ratio}, 비율의 소수점 다섯째 자리에서 반올림)`
    : `장기요양보험은 건강보험료 × (${ratio}), 비율 반올림 없이 계산`;
  const employment = metadata.employmentRate ? `고용보험 ${ratePercent.format(metadata.employmentRate)}` : '고용보험 제외 (0원)';
  return `근로자 부담 기준 · ${pension} · 건강보험 ${ratePercent.format(metadata.healthRate)} · ${employment}. ${care}.`;
}
