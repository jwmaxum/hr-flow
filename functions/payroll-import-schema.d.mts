export const MAX_IMPORT_ROWS: 2000;
export type PayrollImportAmountKey = 'monthlyGross' | 'nonTaxable' | 'pension' | 'health' | 'longTerm' | 'employment' | 'incomeTax' | 'localTax' | 'otherDeductions';
export interface PayrollImportAmounts { monthlyGross: number; basePay: number; nonTaxable: number; pension: number; health: number; longTerm: number; employment: number; incomeTax: number; localTax: number; otherDeductions: number; totalInsurance: number; totalDeductions: number; netPay: number }
export interface PayrollImportSourceRow { employeeLoginId: string; archiveCode: string; name: string; employeeNumber: string; joinDate: string; resignDate: string; position: string; divisionName: string; teamName: string; amounts: PayrollImportAmounts }
export type ImportPayrollAmounts = PayrollImportAmounts;
export type ImportPayrollSourceRow = PayrollImportSourceRow;
export interface PayrollImportHeaderField { readonly header: string; readonly label: string; readonly key: string; readonly kind: 'text' | 'date' | 'money'; readonly required: boolean }
export const HEADER_FIELDS: ReadonlyArray<PayrollImportHeaderField>;
export const CSV_TEMPLATE: string;
export const EDITABLE_AMOUNT_KEYS: ReadonlyArray<PayrollImportAmountKey>;
export class PayrollImportValidationError extends Error { code: 'invalid-argument'; row?: number; column?: string; constructor(message: string, details?: { row?: number; column?: string }); }
export function parsePayrollMoney(value: unknown, label?: string, options?: { signed?: boolean; optional?: boolean }): number;
export function completePayrollAmounts(value: unknown, options?: { validateTotals?: boolean }): PayrollImportAmounts;
export function parsePayrollMatrix(value: unknown): PayrollImportSourceRow[];
