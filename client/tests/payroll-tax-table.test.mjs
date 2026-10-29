import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import official from '../src/data/withholdingTaxTable2026.json' with { type: 'json' };
import { validateUploadedTaxTable, parseTaxTableWorkbook, getTaxTableStatus } from '../src/utils/payrollTaxTable.ts';
import { calculateIncomeTax } from '../src/utils/payroll.ts';

const workbook = () => [{ data: [
  ['월급여액(천원)', null, '공제대상 가족'],
  ['4,500만원 이하', null, '설명문'],
  [4500, null, '설명문'], [7000, null, '설명문'],
  ...official.brackets.map(row => [row.min, row.max, ...row.taxes]),
  [10000, null, ...official.taxAt10Million],
  ...[14000, 28000, 30000, 45000, 87000].map(value => [value, null, '구간별 법정 산식']),
] }];

test('the browser and server official datasets are byte-identical and Node24 CommonJS can require the shared calculator', () => {
  const client = readFileSync(new URL('../src/data/withholdingTaxTable2026.json', import.meta.url));
  const server = readFileSync(new URL('../../functions/data/withholdingTaxTable2026.json', import.meta.url));
  assert.equal(client.equals(server), true);
  const require = createRequire(import.meta.url);
  const { createPayrollCalculator } = require('../../functions/payroll-calculation.mjs');
  assert.deepEqual(createPayrollCalculator(official).calculateIncomeTax(2_300_000, 1, 0), calculateIncomeTax(2_300_000, 1, 0));
});

test('the strict parser skips law captions and retains the actual 4.5m and 7m salary rows and high-income base', () => {
  const result = parseTaxTableWorkbook(workbook());
  assert.deepEqual(result.brackets, official.brackets);
  assert.deepEqual(result.taxAt10Million, official.taxAt10Million);
  assert.equal(result.brackets.length, 646);
  assert.equal(calculateIncomeTax(4_500_000, 1, 0, result).incomeTax, 262_840);
  assert.equal(calculateIncomeTax(7_000_000, 1, 0, result).incomeTax, 732_700);
});

test('the exact legacy parser failure is diagnosed by both broken salary bands and never partially mixes sources', () => {
  const damaged = structuredClone(official);
  for (const min of [4500, 7000]) Object.assign(damaged.brackets.find(row => row.min === min), { max: null, taxes: Array(11).fill(0) });
  damaged.brackets.push({ min: 10000, max: null, taxes: [...official.taxAt10Million] });
  for (const min of [14000, 28000, 30000, 45000, 87000]) damaged.brackets.push({ min, max: null, taxes: Array(11).fill(0) });
  const validation = validateUploadedTaxTable(damaged);
  assert.equal(validation.valid, false);
  assert.match(validation.reason, /4,500.*7,000/);
  assert.equal(getTaxTableStatus(damaged).source, 'official-2026');
  assert.equal(calculateIncomeTax(2_300_000, 1, 0, damaged).tableSource, 'official-2026');
});

test('complete legacy tables can carry the exact five zero-valued formula-caption artifacts without treating them as tax rows', () => {
  const legacy = { brackets: structuredClone(official.brackets) };
  legacy.brackets.push({ min: 10000, max: null, taxes: [...official.taxAt10Million] });
  for (const min of [14000, 28000, 30000, 45000, 87000]) legacy.brackets.push({ min, max: null, taxes: Array(11).fill(0) });
  const result = validateUploadedTaxTable(legacy);
  assert.equal(result.valid, true);
  assert.equal(result.table.legacyFormulaRows, 5);
  assert.equal(result.table.brackets.length, 646);
  assert.equal(calculateIncomeTax(10_000_000, 1, 0, result.table).tableSource, 'uploaded');
  legacy.brackets.at(-1).taxes[0] = 1;
  assert.equal(validateUploadedTaxTable(legacy).valid, false);
});

test('missing, overlapping, conflicting, partial, malformed and sparse uploaded data are rejected', () => {
  const gap = structuredClone(official); gap.brackets.splice(50, 1);
  const overlap = structuredClone(official); overlap.brackets[50].max += 1;
  const conflict = structuredClone(official); conflict.brackets.push({ ...conflict.brackets[50], taxes: Array(11).fill(9) });
  const invalidTax = structuredClone(official); invalidTax.brackets[50].taxes[1] = NaN;
  const sparse = structuredClone(official); sparse.brackets[50].taxes = new Array(11);
  for (const value of [null, {}, { brackets: [] }, { brackets: [official.brackets[50]] }, gap, overlap, conflict, invalidTax, sparse]) assert.equal(validateUploadedTaxTable(value).valid, false);
  assert.throws(() => parseTaxTableWorkbook([{ data: [[2300, 2310, ...Array(11).fill(0)]] }]), /전체/);
});

test('identical duplicated sheets are accepted but conflicting duplicates and malformed numeric strings are rejected', () => {
  const sheets = workbook(); sheets.push(structuredClone(sheets[0]));
  assert.equal(parseTaxTableWorkbook(sheets).brackets.length, 646);
  sheets[1].data.find(row => row[0] === 2300)[2] += 1;
  assert.throws(() => parseTaxTableWorkbook(sheets), /중복/);
  const malformed = workbook(); malformed[0].data.find(row => row[0] === 2300)[2] = '29,160oops';
  assert.throws(() => parseTaxTableWorkbook(malformed), /정수 세액/);
  const missingBase = workbook(); missingBase[0].data = missingBase[0].data.filter(row => row[0] !== 10000);
  assert.throws(() => parseTaxTableWorkbook(missingBase), /1,000만원/);
});

test('numeric commas and legal blank tax cells parse, metadata is bounded and absent optional fields never create undefined snapshot values', () => {
  const sheets = workbook();
  const row = sheets[0].data.find(value => value[0] === 2300);
  row[0] = '2,300'; row[1] = '2,310'; row[2] = '29,160'; row[12] = '-';
  const result = parseTaxTableWorkbook(sheets);
  assert.equal(result.brackets.find(value => value.min === 2300).taxes[0], 29160);
  assert.equal(result.brackets.find(value => value.min === 2300).taxes[10], 0);
  assert.equal(validateUploadedTaxTable({ ...official, fileName: 'x'.repeat(500) }).table.fileName.length, 240);
  assert.deepEqual(JSON.parse(JSON.stringify(getTaxTableStatus(null))), getTaxTableStatus(null));
  assert.throws(() => parseTaxTableWorkbook(new Array(17).fill({ data: [] })), /시트/);
  assert.throws(() => parseTaxTableWorkbook([{ data: new Array(20001).fill([]) }]), /행 수/);
});
