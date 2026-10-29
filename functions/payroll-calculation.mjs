// One deterministic implementation for the browser estimate and server approval.
// No SDK, network, environment, Node-only import or top-level await.
// 2026 withholding: Income Tax Act Enforcement Decree, Appendix 2 (2026-03-01).
// https://www.law.go.kr/LSW/flDownload.do?bylClsCd=110201&flSeq=161861245&gubun=
// NPS 2026: employee 4.75%; July base limits 410,000~6,590,000 KRW.
// https://ma.nps.or.kr/pnsinfo/ntpsklg/getOHAF0038M0.do?menuId=MN24001113
// NHIS 2026: employee 3.595%; long-term care 13.14% of health premium.
// https://edi.nhis.or.kr/portal/images/popup/20251204_pop01longdesc.html
const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const taxArray = value => Array.isArray(value) && value.length === 11 && Array.from(value).every(integer);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = reason => ({ valid: false, reason });
const tenWon = value => Math.max(0, Math.floor(value / 10) * 10);
const formulaBoundaries = [14000, 28000, 30000, 45000, 87000];

export function validateUploadedTaxTable(value) {
  if (!object(value) || !Array.isArray(value.brackets) || !value.brackets.length || value.brackets.length > 5000) return fail('급여 구간이 포함된 전체 간이세액표가 필요합니다.');
  const rows = new Map();
  const invalidRanges = [];
  let base = value.taxAt10Million;
  let legacyFormulaRows = 0;
  if (base !== undefined && !taxArray(base)) return fail('1,000만원 기준 세액은 공제대상 가족 1~11명의 정수 세액이어야 합니다.');
  for (const row of value.brackets) {
    if (!object(row) || !integer(row.min) || !taxArray(row.taxes)) return fail('세액표의 급여 구간 또는 11개 정수 세액이 올바르지 않습니다.');
    if (row.min === 10000 && row.max === null) {
      if (base && base.some((tax, index) => tax !== row.taxes[index])) return fail('1,000만원 기준 세액이 중복되어 서로 다릅니다.');
      base = row.taxes; continue;
    }
    // The old importer stored the law's five high-income formula captions as
    // zero-valued, unbounded rows. They are not lookup brackets or tax overrides.
    if (row.max === null && formulaBoundaries.includes(row.min) && row.taxes.every(tax => tax === 0)) { legacyFormulaRows += 1; continue; }
    if (!integer(row.max) || row.min < 770 || row.max > 10000 || row.max <= row.min) { invalidRanges.push(row.min); continue; }
    const prior = rows.get(row.min);
    if (prior && (prior.max !== row.max || prior.taxes.some((tax, index) => tax !== row.taxes[index]))) return fail('같은 급여 하한에 서로 다른 세액표 구간이 중복되어 있습니다.');
    rows.set(row.min, { min: row.min, max: row.max, taxes: [...row.taxes] });
  }
  if (invalidRanges.length) return fail(`월급여 ${[...new Set(invalidRanges)].map(value => value.toLocaleString('en-US') + '천원').join(', ')} 구간의 상한·하한이 올바르지 않습니다.`);
  const brackets = [...rows.values()].sort((a, b) => a.min - b.min);
  if (brackets[0]?.min !== 770 || brackets.at(-1)?.max !== 10000) return fail('전체 770~10,000천원 급여 구간이 필요합니다. 일부 구간만 등록할 수 없습니다.');
  for (let index = 1; index < brackets.length; index += 1) if (brackets[index - 1].max !== brackets[index].min) return fail('세액표에 누락되거나 겹치는 급여 구간이 있습니다.');
  const metadata = {};
  for (const [key, length] of [['effectiveFrom', 10], ['updateDate', 40], ['fileName', 240]]) if (typeof value[key] === 'string') metadata[key] = value[key].slice(0, length);
  return { valid: true, table: { schemaVersion: 1, ...metadata, brackets, ...(base ? { taxAt10Million: [...base] } : {}), ...(legacyFormulaRows ? { legacyFormulaRows } : {}) } };
}

function cell(value, emptyZero = false, boundary = false) {
  if (value === null || value === undefined || typeof value === 'string' && ['', '-'].includes(value.trim())) return emptyZero ? 0 : null;
  if (typeof value === 'number') return integer(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = boundary ? value.trim().replace(/\s*천원$/, '').trim() : value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) return null;
  const number = Number(text.replaceAll(',', ''));
  return integer(number) ? number : null;
}

export function parseTaxTableWorkbook(workbook) {
  if (!Array.isArray(workbook) || !workbook.length || workbook.length > 16) throw new Error('세액표 엑셀의 시트 구성을 확인해 주세요.');
  const brackets = [];
  let taxAt10Million;
  let count = 0;
  for (const sheet of workbook) {
    if (!object(sheet) || !Array.isArray(sheet.data)) throw new Error('세액표 엑셀의 행 구성을 확인해 주세요.');
    count += sheet.data.length;
    if (count > 20000) throw new Error('세액표 엑셀의 행 수가 허용 범위를 초과했습니다.');
    for (const row of sheet.data) {
      if (!Array.isArray(row)) throw new Error('세액표 엑셀의 행 형식이 올바르지 않습니다.');
      const min = cell(row[0], false, true), max = cell(row[1], false, true);
      const baseRow = min === 10000 && (row[1] === null || row[1] === undefined || typeof row[1] === 'string' && ['', '-', '천원'].includes(row[1].trim()));
      // Do not coerce captions such as '4,500만원 이하' or an unbounded note
      // into lookup rows. Whole-table coverage below detects missing real rows.
      if (min === null || min < 770 || min > 10000 || !baseRow && (max === null || max <= min)) continue;
      const taxes = [];
      for (let index = 2; index <= 12; index += 1) {
        const tax = cell(row[index], true);
        if (tax === null) throw new Error('세액표에는 정수 세액, 쉼표 숫자 또는 빈 셀만 사용할 수 있습니다.');
        taxes.push(tax);
      }
      if (baseRow) {
        if (taxAt10Million && taxAt10Million.some((tax, index) => tax !== taxes[index])) throw new Error('1,000만원 기준 세액이 시트별로 서로 다릅니다.');
        taxAt10Million = taxes;
      } else brackets.push({ min, max, taxes });
    }
  }
  const validated = validateUploadedTaxTable({ brackets, taxAt10Million });
  if (!validated.valid) throw new Error(validated.reason);
  if (!validated.table.taxAt10Million) throw new Error('1,000만원 기준 세액 행을 포함한 전체 국세청 엑셀을 선택해 주세요.');
  return validated.table;
}

const wholeCount = (value, minimum) => Number.isFinite(value) ? Math.max(minimum, Math.trunc(value)) : minimum;
export function getDeductionCounts(employee) {
  // Existing childrenUnder20 records represent eligible children aged 8~20.
  const children = wholeCount(employee.childrenUnder20, 0);
  return { dependents: Math.max(wholeCount(employee.dependents, 1), children + 1), children };
}
function periodOf(period) {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const chosen = period ?? { year: kst.getUTCFullYear(), month: kst.getUTCMonth() + 1 };
  if (!Number.isInteger(chosen.year) || !Number.isInteger(chosen.month) || chosen.year < 1900 || chosen.year > 9999 || chosen.month < 1 || chosen.month > 12) throw new Error('급여 계산 연도와 월을 확인해 주세요.');
  return { year: chosen.year, month: chosen.month };
}
function pensionAgeStatus(employee, period) {
  // Read only the registered HR field, never a certificate's birthDate or
  // an inferred century. The remaining six private digits may stay masked.
  if (typeof employee.rrn !== 'string' || employee.rrn.length > 40) return 'BIRTH_DATE_UNAVAILABLE';
  const match = /^(\d{2})(\d{2})(\d{2})-?([0-9])(?:[0-9*xX•]{6})?$/.exec(employee.rrn.trim().replace(/\s/g, ''));
  if (!match) return 'BIRTH_DATE_UNAVAILABLE';
  const century = { 0: 1800, 1: 1900, 2: 1900, 3: 2000, 4: 2000, 5: 1900, 6: 1900, 7: 2000, 8: 2000, 9: 1800 }[match[4]];
  const year = century + Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const birth = `${year}-${match[2]}-${match[3]}`;
  const parsed = new Date(birth + 'T00:00:00Z');
  const monthEnd = new Date(Date.UTC(period.year, period.month, 0)).toISOString().slice(0, 10);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== birth || birth > monthEnd) return 'BIRTH_DATE_UNAVAILABLE';
  // NPS premiums cover the month containing the day before loss of status.
  // Age-60 status is lost on the 60th birthday: only a loss on the first
  // excludes that month. Otherwise the following month is the first exempt.
  // NPS 2026 business guide pp.16,49; Civil Act Arts.158-160.
  return period.year > year + 60 || period.year === year + 60 &&
    (period.month > month || period.month === month && day === 1) ? 'AGE_EXEMPT' : 'COVERED';
}
// Apply the extra-family deduction to the complete monthly tax. In the
// high-income bands, clamping this base before adding the band supplement
// loses part of that deduction. Clamp only the final tax in tenWon().
const familyTax = (taxes, dependents) => dependents <= 11 ? taxes[dependents - 1] : taxes[10] - (taxes[9] - taxes[10]) * (dependents - 11);
function highIncomeTax(income, dependents, baseTaxes) {
  const base = familyTax(baseTaxes, dependents);
  if (income === 10000000) return base;
  if (income <= 14000000) return base + 25000 + (income - 10000000) * .98 * .35;
  if (income <= 28000000) return base + 1397000 + (income - 14000000) * .98 * .38;
  if (income <= 30000000) return base + 6610600 + (income - 28000000) * .98 * .4;
  if (income <= 45000000) return base + 7394600 + (income - 30000000) * .4;
  if (income <= 87000000) return base + 13394600 + (income - 45000000) * .42;
  return base + 31034600 + (income - 87000000) * .45;
}

export function createPayrollCalculator(officialData) {
  const checked = validateUploadedTaxTable(officialData);
  if (!checked.valid || !checked.table.taxAt10Million) throw new Error('공식 근로소득 간이세액표 구성을 확인할 수 없습니다.');
  const official = checked.table;
  const resolve = value => {
    const result = validateUploadedTaxTable(value);
    return result.valid ? { table: result.table, uploaded: true, reason: null } : { table: official, uploaded: false, reason: value == null ? null : result.reason };
  };
  function getTaxTableStatus(value) {
    const chosen = resolve(value);
    const details = {};
    for (const key of ['fileName', 'updateDate']) if (object(value) && typeof value[key] === 'string') details[key] = value[key].slice(0, key === 'fileName' ? 240 : 40);
    const effectiveFrom = chosen.uploaded ? chosen.table.effectiveFrom : official.effectiveFrom;
    return { source: chosen.uploaded ? 'uploaded' : 'official-2026', valid: chosen.uploaded, reason: chosen.reason,
      bracketCount: chosen.table.brackets.length, ...details, ...(effectiveFrom ? { effectiveFrom } : {}),
      highIncomeSource: chosen.uploaded && chosen.table.taxAt10Million ? 'uploaded' : 'official-2026' };
  }
  function calculateIncomeTax(income, dependents, children, table) {
    if (!Number.isFinite(income) || income < 0) throw new Error('과세대상 월급여를 확인해 주세요.');
    if (income < 770000) return { incomeTax: 0, tableSource: 'official-2026' };
    const family = getDeductionCounts({ dependents, childrenUnder20: children });
    const chosen = resolve(table);
    let base, tableSource = chosen.uploaded ? 'uploaded' : 'official-2026';
    if (income >= 10000000) {
      base = highIncomeTax(income, family.dependents, chosen.table.taxAt10Million ?? official.taxAt10Million);
      if (!chosen.table.taxAt10Million) tableSource = 'official-2026';
    } else {
      const bracket = chosen.table.brackets.find(row => income / 1000 >= row.min && income / 1000 < row.max);
      if (!bracket) throw new Error('근로소득 간이세액표의 급여 구간을 찾을 수 없습니다.');
      base = familyTax(bracket.taxes, family.dependents);
    }
    const childCredit = family.children === 0 ? 0 : family.children === 1 ? 20830 : 45830 + (family.children - 2) * 33330;
    const withholding = tenWon(base - childCredit);
    // Income Tax Act Art.86: ordinary wage withholding below KRW1,000 is
    // not collected, including a small remainder after the child credit.
    return { incomeTax: withholding < 1000 ? 0 : withholding, tableSource };
  }
  function calculateNetPay(employee, table, period) {
    const salary = employee.currentVal ?? employee.annualSalary ?? 0;
    if (!Number.isFinite(salary) || salary <= 0 || !Number.isSafeInteger(Math.floor(salary))) return null;
    const selected = periodOf(period);
    const { dependents, children } = getDeductionCounts(employee);
    const monthlyGross = Math.floor(salary / 12);
    const nonTaxable = Math.min(monthlyGross, Math.max(0, Number.isFinite(employee.nonTaxable) ? Math.floor(employee.nonTaxable) : 200000));
    const taxableIncome = Math.max(0, monthlyGross - nonTaxable);
    const july = selected.year > 2026 || selected.year === 2026 && selected.month >= 7;
    const pensionBase = Math.min(july ? 6590000 : 6370000, Math.max(july ? 410000 : 400000, Math.floor(taxableIncome / 1000) * 1000));
    const ageStatus = pensionAgeStatus(employee, selected);
    const pensionRate = ageStatus === 'AGE_EXEMPT' ? 0 : .0475;
    const pension = taxableIncome > 0 ? tenWon(pensionBase * pensionRate) : 0;
    const health = tenWon(taxableIncome * .03595), longTerm = tenWon(health * .1314), employment = tenWon(taxableIncome * .009);
    const totalInsurance = pension + health + longTerm + employment;
    const { incomeTax, tableSource } = calculateIncomeTax(taxableIncome, dependents, children, table);
    const localTax = tenWon(incomeTax * .1), totalDeductions = totalInsurance + incomeTax + localTax;
    const tableStatus = getTaxTableStatus(table);
    const effective = tableStatus.effectiveFrom;
    const selectedDate = `${selected.year}-${String(selected.month).padStart(2, '0')}-01`;
    const effectiveTime = effective ? Date.parse(effective + 'T00:00:00Z') : NaN;
    const effectiveKnown = !effective || /^2026-\d{2}-\d{2}$/.test(effective) && Number.isFinite(effectiveTime) && new Date(effectiveTime).toISOString().slice(0, 10) === effective && effective <= selectedDate;
    return { monthlyGross, pension, health, longTerm, employment, totalInsurance, incomeTax, localTax, totalDeductions,
      netPay: monthlyGross - totalDeductions, nonTaxable, dependents, children,
      isSeveranceIncluded: false, salaryBasis: employee.salaryType === 'MONTHLY' ? 'MONTHLY' : 'ANNUAL',
      metadata: { tableSource, tableStatus, period: selected, policyPeriodSupported: selected.year === 2026 && selected.month >= 3 && effectiveKnown,
        pensionBase: ageStatus === 'AGE_EXEMPT' ? 0 : pensionBase, pensionRate, pensionAgeStatus: ageStatus,
        healthRate: .03595, longTermRate: .1314, employmentRate: .009, calculationVersion: '2026-03-separate-age60-v2' } };
  }
  return { calculateIncomeTax, calculateNetPay, getDeductionCounts, validateUploadedTaxTable, parseTaxTableWorkbook, getTaxTableStatus };
}
