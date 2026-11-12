const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseErpFile } = require('../erp-import-files');
const { amounts, decimal, round } = require('../erp-import-schema');
const { workbook, opening, movement, cell } = require('./erp-import-fixtures.cjs');
const invalid = promise => assert.rejects(promise, error => error.code === 'invalid-argument');

test('both delivered templates remain compatible and never import reference/mock data', async () => {
  for (const [type, name] of [['OPENING','기초재고_이관_입력양식.xlsx'], ['MOVEMENTS','거래별_입출고_입력양식.xlsx']]) {
    const result = await parseErpFile({ name, mimeType: '', base64: fs.readFileSync(path.join(__dirname,'../assets/erp',name)).toString('base64') }, type);
    assert.equal(result.rows.length, 0); assert.ok(result.errors.length);
  }
});
test('actual XLSX values preserve leading zero codes, decimals, zero and explicit book value', async () => {
  const parsed = await parseErpFile(await workbook('OPENING', [opening({ 10: 0, 12: 0 }), opening({ 0: 2, 1: '0002', 10: 3, 11: '금액', 12: null, 13: 100 })]), 'OPENING');
  assert.equal(parsed.errors.length, 0); assert.equal(parsed.rows[0].code, '0001'); assert.equal(parsed.rows[0].quantityScaled, 0);
  assert.equal(parsed.rows[1].openingValue, 100); assert.equal(parsed.rows[1].quantityScaled, 30000);
});
test('blank, negative, numeric code, duplicate, invalid unit/date/amount and unsupported currency fail with source rows', async () => {
  for (const patch of [{ 10: null }, { 10: -1 }, { 1: 1 }, { 4: '' }, { 12: -1 }, { 13: 20 }, { 14: 'USD' }, { 10: 0, 11: '금액', 12: null, 13: 5 }, { 10: 1, 12: 0 }]) {
    const result = await parseErpFile(await workbook('OPENING', [opening(patch)]), 'OPENING');
    assert.ok(result.errors.some(error => error.row === 10), JSON.stringify(patch));
  }
  const duplicate = await parseErpFile(await workbook('OPENING', [opening(), opening()]), 'OPENING');
  assert.ok(duplicate.errors.some(error => error.row === 11));
  const date = await parseErpFile(await workbook('MOVEMENTS', [movement({ 0: '2026-02-30' })]), 'MOVEMENTS'); assert.ok(date.errors.length);
});
test('input/header/guide formulas are rejected while reference formulas and caches cannot change calculations', async () => {
  for (const address of ['A9','K10']) await invalid(parseErpFile(await workbook('OPENING', [opening()], { modifySheet: xml => cell(xml, address, { formula: '1+1', cached: 2 }) }), 'OPENING'));
  await invalid(parseErpFile(await workbook('OPENING', [opening()], { modifyZip: async zip => zip.file('xl/worksheets/sheet1.xml', cell(await zip.file('xl/worksheets/sheet1.xml').async('string'), 'B6', { formula: 'TODAY()', cached: 45000 })) }), 'OPENING'));
  const result = await parseErpFile(await workbook('OPENING', [opening()], { modifySheet: xml => cell(xml, 'Q10', { formula: '999999', cached: 999999 }) }), 'OPENING');
  assert.equal(result.errors.length, 0); assert.equal(result.rows[0].openingValue, 1000);
});
test('compressed active content, external targets, entity declarations, bad paths and huge expanded files fail closed', async () => {
  for (const modifyZip of [
    zip => zip.file('xl/vbaProject.bin', Buffer.from('bad')),
    zip => zip.file('xl/media/image.png', Buffer.from('bad')),
    zip => zip.file('custom.xml', '<!DOCTYPE x [<!ENTITY a "bad">]><x/>'),
    zip => zip.file('custom.xml', 'x'.repeat(13 * 1024 * 1024)),
    zip => zip.file('xl/_rels/evil.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="a" Target="https://example.invalid" TargetMode="External"/></Relationships>'),
    async zip => zip.file('xl/workbook.xml', (await zip.file('xl/workbook.xml').async('string')).replace('name="이관입력"', 'name="침입"')),
  ]) await invalid(parseErpFile(await workbook('OPENING', [opening()], { modifyZip }), 'OPENING'));
  await invalid(parseErpFile(await workbook('OPENING', [opening()], { modifySheet: xml => xml.replace('r="K10"', 'r="K999"') }), 'OPENING'));
  await invalid(parseErpFile(await workbook('OPENING', [opening()], { modifySheet: xml => xml.replace('<x:c r="K10"', '<x:c xmlns:x="https://invalid.example" r="K10"') }), 'OPENING'));
  await invalid(parseErpFile(await workbook('OPENING', [opening()], { modifySheet: xml => cell(xml, 'Q10', { formula: '1+1', cached: 2 }).replace('<x:f>1+1</x:f>', '<x:f t="array" ref="A10:Q10">1+1</x:f>') }), 'OPENING'));
});
test('fixed-point currency, VAT inclusive/exclusive and moving average rounding are exact', async () => {
  const result = await parseErpFile(await workbook('MOVEMENTS', [movement({ 11: 3, 12: 9.99, 13: 'USD', 14: 1350, 15: '영세', 16: 0 })]), 'MOVEMENTS');
  assert.equal(result.errors.length, 0); assert.deepEqual(amounts(result.rows[0]), { supply: 29.97, tax: 0, total: 29.97, value: 40460 });
  const included = await parseErpFile(await workbook('MOVEMENTS', [movement({ 11: 1, 12: 11000, 17: '세금포함' })]), 'MOVEMENTS');
  assert.deepEqual(amounts(included.rows[0]), { supply: 10000, tax: 1000, total: 11000, value: 10000 });
  assert.equal(round(100n, 3n), 33n); assert.equal(round(201n, 2n), 101n);
  assert.equal(decimal({ n: '0.0001' }, 4, '수량'), 1);
  assert.throws(() => decimal('0.00001', 4, '수량')); assert.throws(() => decimal('1e10', 4, '수량'));
});
test('full 200-row template parses all rows within a bounded input area', async () => {
  const source = await workbook('OPENING', Array.from({ length: 200 }, (_, i) => opening({ 0: i + 1, 1: `I-${i}` })));
  const result = await parseErpFile(source, 'OPENING'); assert.equal(result.errors.length, 0); assert.equal(result.rows.length, 200);
});
