import officialTaxTable from '../data/withholdingTaxTable2026.json' with { type: 'json' };
import { createPayrollCalculator, parseTaxTableWorkbook, validateUploadedTaxTable } from '../../../functions/payroll-calculation.mjs';
export type { TaxTable, TaxBracket, CanonicalTaxTable, TaxValidation, TaxTableStatus } from '../../../functions/payroll-calculation.mjs';

export const payrollCalculator = createPayrollCalculator(officialTaxTable);
export const getTaxTableStatus = payrollCalculator.getTaxTableStatus;
export { parseTaxTableWorkbook, validateUploadedTaxTable };
