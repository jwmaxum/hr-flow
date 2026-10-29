import { payrollCalculator } from './payrollTaxTable.ts';
export type { PayrollEmployee, PayrollPeriod, PayrollResult, TaxTable, TaxBracket } from '../../../functions/payroll-calculation.mjs';

export const MEAL_ALLOWANCE_DEFAULT = 200000;
export const getDeductionCounts = payrollCalculator.getDeductionCounts;
export const calculateIncomeTax = payrollCalculator.calculateIncomeTax;
// annualSalary/currentVal stay the stored annual equivalent even when the UI
// displays a monthly wage. Retirement pay is always outside wages.
export const calculateNetPay = payrollCalculator.calculateNetPay;
