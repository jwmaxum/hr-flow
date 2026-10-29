/** Approved payroll values. The server creates snapshots and resolves annual history. */
export interface PayrollAmounts {
  monthlyGross: number; basePay: number; nonTaxable: number;
  pension: number; health: number; longTerm: number; employment: number;
  incomeTax: number; localTax: number; totalInsurance: number; totalDeductions: number; netPay: number;
}
export interface PayrollIdentity {
  userId: string; companyId: string; name: string;
  employeeNumber: string; joinDate: string; resignDate: string; position: string;
  divisionName: string; teamName: string;
}
export interface PayrollSnapshotRow extends PayrollIdentity {
  amounts: PayrollAmounts;
  calculation: { dependents: number; children: number; tableSource: string };
}
export interface PayrollSnapshotRecord {
  id?: string; schemaVersion: 2; scope: 'COMPANY'; companyId: string; year: number; month: number;
  rows: PayrollSnapshotRow[]; sums: PayrollAmounts; approvedAtIso: string; approvedByName: string;
  revision: number; taxTable: { source: string; version: string; fileName: string };
}
export interface AnnualPayrollMonth {
  month: number; status: 'APPROVED' | 'MISSING' | 'LEGACY'; row: PayrollSnapshotRow | null;
  recordId?: string; approvedAtIso?: string;
}
export interface AnnualPayrollReport {
  companyId: string; year: number; employeeId: string; employee: PayrollIdentity | null;
  months: AnnualPayrollMonth[]; sums: PayrollAmounts; availableMonths: number; missingMonths: number[]; legacyMonths: number[];
  legacyAfterSnapshotMonths: number[];
}
export interface PayrollPdfFile { filename: string; mimeType: 'application/pdf'; base64: string }
export interface PayrollRecordSummary {
  id: string; companyId: string; year: number; month: number;
  schemaVersion?: number; legacy: boolean; employeeCount: number;
  approvedAtIso: string; approvedByName: string; revision?: number;
  totalGross: number; totalNet: number; totalDeductions?: number;
  sums?: PayrollAmounts; taxTable?: { source: string; version: string; fileName: string };
}
export interface PayrollListResult { records: PayrollRecordSummary[]; employees: PayrollIdentity[] }
