export interface TaxBracket { min: number; max: number | null; taxes: number[] }
export interface UploadedTaxTable { schemaVersion?: number; brackets?: TaxBracket[]; taxAt10Million?: number[]; effectiveFrom?: string; updateDate?: string; fileName?: string }
export type TaxTable = UploadedTaxTable | null;
export interface CanonicalTaxTable extends UploadedTaxTable { schemaVersion: number; brackets: Array<{ min: number; max: number; taxes: number[] }>; legacyFormulaRows?: number }
export type TaxValidation = { valid: true; table: CanonicalTaxTable } | { valid: false; reason: string };
export interface PayrollPeriod { year: number; month: number }
export interface PayrollEmployee { currentVal?: number; annualSalary?: number; salaryType?: 'ANNUAL' | 'MONTHLY'; isSeveranceIncluded?: boolean; dependents?: number; childrenUnder20?: number; nonTaxable?: number; rrn?: string }
export interface TaxTableStatus { source: 'uploaded' | 'official-2026'; valid: boolean; reason: string | null; bracketCount: number; fileName?: string; updateDate?: string; effectiveFrom?: string; highIncomeSource: 'uploaded' | 'official-2026' }
export interface PayrollResult { monthlyGross: number; pension: number; health: number; longTerm: number; employment: number; totalInsurance: number; incomeTax: number; localTax: number; totalDeductions: number; netPay: number; nonTaxable: number; dependents: number; children: number; isSeveranceIncluded: false; salaryBasis: 'ANNUAL' | 'MONTHLY'; metadata: { tableSource: 'uploaded' | 'official-2026'; tableStatus: TaxTableStatus; period: PayrollPeriod; policyPeriodSupported: boolean; pensionBase: number; pensionRate: number; pensionAgeStatus: 'COVERED' | 'AGE_EXEMPT' | 'BIRTH_DATE_UNAVAILABLE'; healthRate: number; longTermRate: number; employmentRate: number; calculationVersion: string } }
export interface PayrollCalculator { calculateIncomeTax(taxableIncome: number, dependents: number, children: number, table?: TaxTable): { incomeTax: number; tableSource: 'uploaded' | 'official-2026' }; calculateNetPay(employee: PayrollEmployee, table?: TaxTable, period?: PayrollPeriod): PayrollResult | null; getDeductionCounts(employee: PayrollEmployee): { dependents: number; children: number }; validateUploadedTaxTable(value: unknown): TaxValidation; parseTaxTableWorkbook(value: unknown): CanonicalTaxTable; getTaxTableStatus(value: unknown): TaxTableStatus }
export function createPayrollCalculator(officialData: unknown): PayrollCalculator;
export function validateUploadedTaxTable(value: unknown): TaxValidation;
export function parseTaxTableWorkbook(value: unknown): CanonicalTaxTable;
export function getDeductionCounts(employee: PayrollEmployee): { dependents: number; children: number };
