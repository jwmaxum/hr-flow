// Shared value-only payroll import contract. No SDK, I/O or current-pay lookup.
export const MAX_IMPORT_ROWS = 2000;
export const HEADER_FIELDS = Object.freeze([
  ['직원로그인ID', 'employeeLoginId', 'text', false], ['과거직원코드', 'archiveCode', 'text', false],
  ['성명', 'name', 'text', true], ['사번', 'employeeNumber', 'text', false],
  ['입사일', 'joinDate', 'date', false], ['퇴사일', 'resignDate', 'date', false],
  ['직급', 'position', 'text', false], ['본부', 'divisionName', 'text', false], ['팀', 'teamName', 'text', false],
  ['지급합계', 'monthlyGross', 'money', true], ['비과세액', 'nonTaxable', 'money', true],
  ['국민연금', 'pension', 'money', true], ['건강보험', 'health', 'money', true],
  ['장기요양보험', 'longTerm', 'money', true], ['고용보험', 'employment', 'money', true],
  ['소득세', 'incomeTax', 'money', true], ['지방소득세', 'localTax', 'money', true],
  ['기타공제', 'otherDeductions', 'money', false], ['공제합계', 'totalDeductions', 'money', false],
  ['차인지급액', 'netPay', 'money', false],
].map(([header, key, kind, required]) => Object.freeze({ header, label: header, key, kind, required })));
export const CSV_TEMPLATE = '\uFEFF' + HEADER_FIELDS.map(field => field.header).join(',') + '\r\n';
export const EDITABLE_AMOUNT_KEYS = Object.freeze(['monthlyGross', 'nonTaxable', 'pension', 'health', 'longTerm', 'employment', 'incomeTax', 'localTax', 'otherDeductions']);
const SIGNED_COMPONENTS = Object.freeze(['pension', 'health', 'longTerm', 'employment', 'incomeTax', 'localTax', 'otherDeductions']);
const empty = value => value === undefined || value === null || typeof value === 'string' && value.trim() === '';
const maxMoney = BigInt(Number.MAX_SAFE_INTEGER);

export class PayrollImportValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PayrollImportValidationError';
    this.code = 'invalid-argument';
    if (details.row !== undefined) this.row = details.row;
    if (details.column !== undefined) this.column = details.column;
  }
}
function fail(message, details) { throw new PayrollImportValidationError(message, details); }
function safeInteger(value, label) {
  if (value > maxMoney || value < -maxMoney) fail(`${label} 금액이 정확하게 저장할 수 있는 범위를 초과했습니다.`);
  return Number(value);
}
export function parsePayrollMoney(value, label = '금액', options = {}) {
  if (empty(value)) {
    if (options.optional) return 0;
    fail(`${label}을 입력해 주세요. 금액이 없으면 0을 입력합니다.`);
  }
  let parsed;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && !/\p{Cc}/u.test(value)) {
    const text = value.trim();
    if (text.length > 30 || !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) fail(`${label}은 원 단위 정수로 입력해 주세요.`);
    parsed = Number(text.replaceAll(',', ''));
  } else fail(`${label}은 원 단위 정수로 입력해 주세요.`);
  if (!Number.isSafeInteger(parsed) || !options.signed && parsed < 0) fail(`${label}의 부호와 정수 금액 범위를 확인해 주세요.`);
  return Object.is(parsed, -0) ? 0 : parsed;
}

export function completePayrollAmounts(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('급여 금액 입력 내용을 확인해 주세요.');
  const monthlyGross = parsePayrollMoney(value.monthlyGross, '지급합계');
  const nonTaxable = parsePayrollMoney(value.nonTaxable, '비과세액');
  if (nonTaxable > monthlyGross) fail('비과세액은 지급합계를 초과할 수 없습니다.');
  const amounts = { monthlyGross, basePay: monthlyGross - nonTaxable, nonTaxable };
  for (const key of SIGNED_COMPONENTS) {
    const label = HEADER_FIELDS.find(field => field.key === key).header;
    amounts[key] = parsePayrollMoney(value[key], label, { signed: true, optional: key === 'otherDeductions' });
  }
  amounts.totalInsurance = safeInteger(['pension', 'health', 'longTerm', 'employment'].reduce((sum, key) => sum + BigInt(amounts[key]), 0n), '보험료 합계');
  amounts.totalDeductions = safeInteger(['totalInsurance', 'incomeTax', 'localTax', 'otherDeductions'].reduce((sum, key) => sum + BigInt(amounts[key]), 0n), '공제합계');
  amounts.netPay = safeInteger(BigInt(monthlyGross) - BigInt(amounts.totalDeductions), '차인지급액');
  if (options.validateTotals) {
    for (const key of ['totalDeductions', 'netPay']) {
      if (empty(value[key])) continue;
      const label = HEADER_FIELDS.find(field => field.key === key).header;
      if (parsePayrollMoney(value[key], label, { signed: true }) !== amounts[key]) fail(`${label}이 지급·공제 항목의 합계와 일치하지 않습니다.`);
    }
  }
  return amounts;
}

function importText(value, label, required = false, maximum = 120) {
  if (empty(value)) {
    if (required) fail(`${label}을 입력해 주세요.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > maximum || /\p{Cc}/u.test(value)) fail(`${label}의 문자와 길이를 확인해 주세요.`);
  const text = value.trim().normalize('NFC');
  if (/^[=+@-]/.test(text)) fail(`${label}에는 수식으로 해석될 수 있는 문자를 맨 앞에 사용할 수 없습니다.`);
  return text;
}
function importDate(value, label) {
  if (empty(value)) return '';
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()) || value.getUTCHours() || value.getUTCMinutes() || value.getUTCSeconds() || value.getUTCMilliseconds()) fail(`${label}은 YYYY-MM-DD 날짜로 입력해 주세요.`);
    const date = value.toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`${label}은 YYYY-MM-DD 날짜로 입력해 주세요.`);
    return date;
  }
  const text = importText(value, label, true, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text + 'T00:00:00Z') : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== text) fail(`${label}은 실제 존재하는 YYYY-MM-DD 날짜로 입력해 주세요.`);
  return text;
}

export function parsePayrollMatrix(matrix) {
  if (!Array.isArray(matrix) || !matrix.length || matrix.length > MAX_IMPORT_ROWS + 1) fail(`급여 원자료는 머리글과 최대 ${MAX_IMPORT_ROWS}명의 자료로 구성해 주세요.`);
  const header = matrix[0];
  if (!Array.isArray(header) || header.length !== HEADER_FIELDS.length || HEADER_FIELDS.some((field, index) => header[index] !== field.header)) {
    fail('원자료의 머리글·순서가 표준 양식과 다릅니다. 제공된 양식을 사용해 주세요.');
  }
  const rows = [], identities = new Set();
  for (let index = 1; index < matrix.length; index++) {
    const cells = matrix[index], rowNumber = index + 1;
    if (!Array.isArray(cells) || cells.length > HEADER_FIELDS.length) fail(`${rowNumber}행의 열 개수가 표준 양식과 다릅니다.`, { row: rowNumber });
    if (Array.from({ length: HEADER_FIELDS.length }, (_, column) => cells[column]).every(empty)) continue;
    try {
      const record = {};
      for (let column = 0; column < HEADER_FIELDS.length; column++) {
        const field = HEADER_FIELDS[column], value = cells[column];
        if (field.kind === 'date') record[field.key] = importDate(value, field.header);
        else if (field.kind === 'text') record[field.key] = importText(value, field.header, field.required, field.key === 'employeeLoginId' ? 254 : field.key === 'name' ? 100 : field.key === 'employeeNumber' ? 80 : 120);
        else record[field.key] = value;
      }
      record.employeeLoginId = record.employeeLoginId.toLowerCase();
      record.archiveCode = record.archiveCode.toLowerCase();
      if (Boolean(record.employeeLoginId) === Boolean(record.archiveCode)) fail('직원로그인ID와 과거직원코드 중 하나만 입력해 주세요.');
      if (record.employeeLoginId && !/^[^\s@,;"<>\\/]+@[^\s@,;"<>\\/]+\.[^\s@,;"<>\\/]+$/.test(record.employeeLoginId)) fail('직원로그인ID는 전체 이메일 형식으로 입력해 주세요.');
      if (record.archiveCode && !/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,79}$/u.test(record.archiveCode)) fail('과거직원코드는 문자·숫자로 시작하고 80자 이내로 입력해 주세요.');
      if (/^\d{6}-?\d{7}$/.test(record.archiveCode)) fail('주민등록번호를 과거직원코드로 사용하지 마세요. 회사 내 별도 코드를 입력해 주세요.');
      if (record.joinDate && record.resignDate && record.joinDate > record.resignDate) fail('퇴사일은 입사일보다 빠를 수 없습니다.');
      const identity = record.employeeLoginId ? 'login:' + record.employeeLoginId : 'archive:' + record.archiveCode;
      if (identities.has(identity)) fail('같은 직원로그인ID 또는 과거직원코드가 중복되었습니다.');
      identities.add(identity);
      const amounts = completePayrollAmounts(record, { validateTotals: true });
      rows.push(Object.fromEntries([...HEADER_FIELDS.filter(field => field.kind !== 'money').map(field => [field.key, record[field.key]]), ['amounts', amounts]]));
    } catch (error) {
      if (error instanceof PayrollImportValidationError) fail(`${rowNumber}행: ${error.message}`, { row: rowNumber, ...(error.column ? { column: error.column } : {}) });
      throw error;
    }
  }
  if (!rows.length) fail('가져올 직원별 급여 자료가 없습니다.');
  return rows;
}
