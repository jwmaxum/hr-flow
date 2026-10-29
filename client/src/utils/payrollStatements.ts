/** Approved payroll values. The server creates snapshots and resolves annual history. */
export interface PayrollAmounts {
  monthlyGross: number; basePay: number; nonTaxable: number;
  pension: number; health: number; longTerm: number; employment: number;
  incomeTax: number; localTax: number; otherDeductions?: number; totalInsurance: number; totalDeductions: number; netPay: number;
}
export interface PayrollIdentity {
  userId: string; companyId: string; name: string;
  employeeNumber: string; joinDate: string; resignDate: string; position: string;
  divisionName: string; teamName: string;
}
export interface PayrollSnapshotRow extends PayrollIdentity {
  amounts: PayrollAmounts;
  calculation: { mode?: 'CALCULATED'; dependents: number; children: number; tableSource: string } |
    { mode: 'IMPORTED' | 'ADJUSTED'; tableSource: string };
}
export interface PayrollSnapshotRecord {
  id?: string; schemaVersion: 2; scope: 'COMPANY'; companyId: string; year: number; month: number;
  rows: PayrollSnapshotRow[]; sums: PayrollAmounts; approvedAtIso: string; approvedByName: string;
  revision: number; taxTable: { source: string; version: string; fileName: string };
  origin?: 'CALCULATED' | 'IMPORT' | 'CORRECTION'; reason?: string; source?: PayrollSourceMetadata;
  sourceDraftId?: string; dataHash?: string; previousHash?: string;
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
  origin?: 'CALCULATED' | 'IMPORT' | 'CORRECTION'; reason?: string; source?: PayrollSourceMetadata;
  sourceDraftId?: string; dataHash?: string; previousHash?: string;
}
export interface PayrollListResult { records: PayrollRecordSummary[]; employees: PayrollIdentity[] }

export interface PayrollSourceMetadata { name: string; mimeType: string; size: number; sha256: string }
export interface PayrollSourceInput { name: string; mimeType: string; base64: string }
export interface PayrollSourceFile { filename: string; mimeType: string; base64: string; sha256: string; size?: number }
export type PayrollSourceSelector = { draftId: string } | { recordId: string; revision?: number };
export type PayrollDraftStatus = 'PENDING' | 'APPROVED' | 'CANCELLED';
export type PayrollAmountComponents = Pick<PayrollAmounts,
  'monthlyGross' | 'nonTaxable' | 'pension' | 'health' | 'longTerm' | 'employment' | 'incomeTax' | 'localTax'> & { otherDeductions?: number };
export interface PayrollDraftRowUpdate { userId: string; amounts: PayrollAmountComponents | PayrollAmounts }
export interface PayrollDiffPerson { userId: string; name: string }
export interface PayrollDiffField { field: string; before: number | string | null; after: number | string | null }
export interface PayrollDraftDiff {
  added: PayrollDiffPerson[]; removed: PayrollDiffPerson[];
  changed: Array<PayrollDiffPerson & { fields: PayrollDiffField[] }>;
  totals: { before: Partial<PayrollAmounts> | null; after: PayrollAmounts };
}
export interface PayrollDraft {
  id: string; companyId: string; year: number; month: number; status: PayrollDraftStatus;
  draftVersion: number; kind: 'IMPORT' | 'CORRECTION'; reason: string;
  rows: PayrollSnapshotRow[]; sums: PayrollAmounts; employeeCount?: number; source?: PayrollSourceMetadata;
  baseRevision: number; baseRecordId: string; baseFingerprint: string;
  createdAtIso: string; createdByName: string; updatedAtIso: string; updatedByName: string;
  stale: boolean; diff: PayrollDraftDiff; approvedRevision?: number; approvedAtIso?: string;
}
export type PayrollDraftSummary = Omit<PayrollDraft, 'rows' | 'diff'> & { diff?: PayrollDraftDiff };
export interface PayrollDraftVersion {
  companyId: string; draftVersion: number; status: PayrollDraftStatus; reason: string;
  updatedAtIso: string; updatedByName: string; sums: PayrollAmounts;
}
export type PayrollDraftVersionSummary = PayrollDraftVersion;
export type PayrollRevision = (PayrollRecordSummary & {
  kind: 'APPROVED'; revision: number; pdfAvailable: true;
}) | (PayrollRecordSummary & { kind: 'LEGACY'; pdfAvailable: false });
export type PayrollRevisionSummary = PayrollRevision;
