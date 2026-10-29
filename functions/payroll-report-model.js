const PAYROLL_MONEY_FIELDS = Object.freeze([
  'monthlyGross', 'basePay', 'nonTaxable', 'pension', 'health', 'longTerm',
  'employment', 'incomeTax', 'localTax', 'totalInsurance', 'totalDeductions', 'netPay',
]);

function fail(message) { throw new Error(message); }
function identifier(value, label, maximum = 128) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\\/\u0000-\u001f\u007f]/.test(value)) fail(`Invalid payroll ${label}.`);
  return value;
}
function text(value, maximum = 200) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('Invalid payroll text.');
  return value;
}
function dateOnly(value) {
  const valueText = text(value, 10);
  if (!valueText) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valueText) || new Date(valueText + 'T00:00:00Z').toISOString().slice(0, 10) !== valueText) fail('Invalid payroll employment date.');
  return valueText;
}
function period(year, month) {
  if (!Number.isInteger(year) || year < 2000 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) fail('Invalid payroll period.');
}
function approvedTime(record) {
  if (typeof record.approvedAtIso === 'string') {
    const value = Date.parse(record.approvedAtIso);
    if (Number.isFinite(value)) return value;
  }
  if (typeof record.approvedAt === 'string') {
    const value = Date.parse(record.approvedAt);
    if (Number.isFinite(value)) return value;
  }
  const timestamp = record.approvedAt;
  if (timestamp && typeof timestamp.toMillis === 'function') return timestamp.toMillis();
  if (timestamp && Number.isFinite(timestamp.seconds)) return timestamp.seconds * 1000 + Math.floor((timestamp.nanoseconds || 0) / 1e6);
  return 0;
}
function money(value, field) {
  if (!Number.isSafeInteger(value) || (field !== 'netPay' && value < 0)) fail(`Invalid payroll amount: ${field}.`);
  return value;
}
function normalizeAmounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Payroll amounts are required.');
  const amounts = Object.fromEntries(PAYROLL_MONEY_FIELDS.map(field => [field, money(value[field], field)]));
  if (amounts.basePay + amounts.nonTaxable !== amounts.monthlyGross ||
      amounts.pension + amounts.health + amounts.longTerm + amounts.employment !== amounts.totalInsurance ||
      amounts.totalInsurance + amounts.incomeTax + amounts.localTax !== amounts.totalDeductions ||
      amounts.monthlyGross - amounts.totalDeductions !== amounts.netPay) fail('Payroll amounts do not reconcile.');
  return amounts;
}

/** Whitelist identities; a legacy report may use current identity, never current pay. */
function normalizePayrollIdentity(value, companyId) {
  identifier(companyId, 'company ID');
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.companyId !== companyId) fail('Payroll row belongs to another company.');
  const name = text(value.name, 100);
  if (!name.trim()) fail('Payroll employee name is required.');
  return {
    userId: identifier(value.userId, 'employee ID'), companyId, name,
    employeeNumber: text(value.employeeNumber, 80), joinDate: dateOnly(value.joinDate), resignDate: dateOnly(value.resignDate),
    position: text(value.position, 100), divisionName: text(value.divisionName, 120), teamName: text(value.teamName, 120),
  };
}

/** Whitelist identities and values; never look up another company's employee. */
function normalizePayrollRow(value, companyId) {
  const identity = normalizePayrollIdentity(value, companyId);
  const calculation = value.calculation;
  if (!calculation || !Number.isSafeInteger(calculation.dependents) || calculation.dependents < 1 ||
      !Number.isSafeInteger(calculation.children) || calculation.children < 0 || calculation.children >= calculation.dependents) fail('Invalid payroll deduction counts.');
  const tableSource = text(calculation.tableSource, 80);
  if (!tableSource) fail('Payroll tax source is required.');
  return {
    ...identity,
    amounts: normalizeAmounts(value.amounts),
    calculation: { dependents: calculation.dependents, children: calculation.children, tableSource },
  };
}

function sumPayrollRows(rows) {
  if (!Array.isArray(rows)) fail('Payroll rows are required.');
  const sums = Object.fromEntries(PAYROLL_MONEY_FIELDS.map(field => [field, 0]));
  for (const row of rows) {
    const amounts = normalizeAmounts(row.amounts);
    for (const field of PAYROLL_MONEY_FIELDS) {
      sums[field] += amounts[field];
      if (!Number.isSafeInteger(sums[field])) fail('Payroll totals exceed the supported range.');
    }
  }
  return sums;
}

function validatePayrollRecord(value, companyId) {
  identifier(companyId, 'company ID');
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.companyId !== companyId) fail('Payroll record belongs to another company.');
  period(value.year, value.month);
  if (value.schemaVersion !== 2 || value.scope !== 'COMPANY' || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 2000) fail('Detailed approved payroll data is required.');
  const rows = value.rows.map(row => normalizePayrollRow(row, companyId));
  if (new Set(rows.map(row => row.userId)).size !== rows.length) fail('A payroll snapshot contains duplicate employees.');
  const sums = sumPayrollRows(rows);
  if (!value.sums || PAYROLL_MONEY_FIELDS.some(field => value.sums[field] !== sums[field])) fail('Payroll snapshot totals do not match its rows.');
  const time = approvedTime(value);
  if (!Number.isFinite(time) || time <= 0) fail('Payroll approval date is required.');
  const revision = value.revision === undefined ? 1 : value.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) fail('Invalid payroll snapshot revision.');
  const taxTable = value.taxTable && typeof value.taxTable === 'object' && !Array.isArray(value.taxTable) ? value.taxTable : {};
  return {
    ...(value.id ? { id: identifier(value.id, 'record ID', 256) } : {}),
    schemaVersion: 2, scope: 'COMPANY', companyId, year: value.year, month: value.month, rows, sums,
    approvedAtIso: new Date(time).toISOString(), approvedByName: text(value.approvedByName, 100), revision,
    taxTable: { source: text(taxTable.source, 80), version: text(taxTable.version, 100), fileName: text(taxTable.fileName, 240) },
  };
}

function compareApproved(a, b) {
  return approvedTime(a) - approvedTime(b) || (a.revision || 1) - (b.revision || 1) || String(a.id || '').localeCompare(String(b.id || ''));
}

/** One final approved snapshot per month. No value is inferred from live pay settings. */
function buildAnnualPayrollReport(records, companyId, year, employeeId) {
  identifier(companyId, 'company ID'); identifier(employeeId, 'employee ID'); period(year, 1);
  if (!Array.isArray(records)) fail('Payroll history is required.');
  const scoped = records.filter(record => record && record.companyId === companyId && record.year === year);
  const months = [];
  const legacyAfterSnapshotMonths = [];
  let employee = null;
  let employeeSource = null;
  for (let month = 1; month <= 12; month++) {
    const candidates = scoped.filter(record => record.month === month).sort(compareApproved);
    const detailed = candidates.filter(record => record.schemaVersion === 2);
    const latest = detailed.at(-1) || candidates.at(-1);
    if (!latest) { months.push({ month, status: 'MISSING', row: null }); continue; }
    if (latest.schemaVersion !== 2) { months.push({ month, status: 'LEGACY', row: null }); continue; }
    const record = validatePayrollRecord(latest, companyId);
    if (candidates.some(item => item.schemaVersion !== 2 && compareApproved(item, latest) > 0)) legacyAfterSnapshotMonths.push(month);
    const row = record.rows.find(item => item.userId === employeeId);
    if (!row) { months.push({ month, status: 'MISSING', row: null }); continue; }
    months.push({ month, status: 'APPROVED', row, recordId: record.id || '', approvedAtIso: record.approvedAtIso });
    if (!employeeSource || compareApproved(record, employeeSource) > 0) { employee = normalizePayrollIdentity(row, companyId); employeeSource = record; }
  }
  // Retain a historical identity even when its latest full-month approval omits
  // this employee. Its old amounts still do not enter any monthly/annual total.
  if (!employee) {
    for (const value of [...scoped].sort(compareApproved).reverse()) {
      if (value.schemaVersion !== 2) continue;
      const record = validatePayrollRecord(value, companyId);
      const row = record.rows.find(item => item.userId === employeeId);
      if (row) { employee = normalizePayrollIdentity(row, companyId); break; }
    }
  }
  const approved = months.filter(item => item.status === 'APPROVED');
  return {
    companyId, year, employeeId, employee, months,
    sums: sumPayrollRows(approved.map(item => item.row)),
    availableMonths: approved.length,
    missingMonths: months.filter(item => item.status === 'MISSING').map(item => item.month),
    legacyMonths: months.filter(item => item.status === 'LEGACY').map(item => item.month),
    legacyAfterSnapshotMonths,
  };
}

module.exports = { PAYROLL_MONEY_FIELDS, normalizePayrollIdentity, normalizePayrollRow, sumPayrollRows, validatePayrollRecord, buildAnnualPayrollReport };
