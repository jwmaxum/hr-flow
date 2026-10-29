const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { deflateRawSync, crc32 } = require('node:zlib');
const { parsePayrollSourceFile, MAX_SOURCE_BYTES, MAX_UNCOMPRESSED_BYTES, MAX_ZIP_ENTRIES } = require('../payroll-import-files');
const { HEADER_FIELDS, CSV_TEMPLATE, EDITABLE_AMOUNT_KEYS, parsePayrollMoney, completePayrollAmounts,
  parsePayrollMatrix, PayrollImportValidationError } = require('../payroll-import-schema.mjs');

const headers = HEADER_FIELDS.map(field => field.header);
const sourceValues = patch => ({ employeeLoginId: 'member@company.test', archiveCode: '', name: '합성 직원',
  employeeNumber: 'E-001', joinDate: '2020-01-01', resignDate: '', position: '직원', divisionName: '합성 본부', teamName: '합성 팀',
  monthlyGross: '2500000', nonTaxable: '200000', pension: '109250', health: '82680', longTerm: '10860', employment: '20700',
  incomeTax: '29160', localTax: '2910', otherDeductions: '', totalDeductions: '255560', netPay: '2244440', ...patch });
const row = patch => { const value = sourceValues(patch); return HEADER_FIELDS.map(field => value[field.key]); };
const csv = rows => '\uFEFF' + rows.map(cells => cells.map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',')).join('\r\n') + '\r\n';
const file = (bytes, name = '원자료.csv', mimeType = 'text/csv') => ({ name, mimeType, base64: Buffer.from(bytes).toString('base64') });
const invalid = promise => assert.rejects(promise, error => error instanceof PayrollImportValidationError && error.code === 'invalid-argument');
const invalidCall = action => assert.throws(action, error => error instanceof PayrollImportValidationError && error.code === 'invalid-argument');
const xmlEscape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Test-only ZIP construction permits corrupt central metadata and bombs that
// regular archive writers intentionally cannot create. CRC is Node24 built-in.
function zip(entries) {
  let offset = 0;
  const locals = [], central = [];
  for (const item of entries) {
    const name = Buffer.from(item.name), value = Buffer.from(item.value ?? ''), compressed = item.store ? value : deflateRawSync(value);
    const local = Buffer.alloc(30), record = Buffer.alloc(46);
    const crc = crc32(value), size = item.size ?? value.length, flags = item.flags ?? 0, method = item.store ? 0 : 8;
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(item.attributes ?? 0, 38); record.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed); central.push(record, name); offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function sheet(matrix, overrides = {}) {
  const body = matrix.map((cells, r) => `<row r="${r + 1}">${cells.map((value, c) => {
    const reference = String.fromCharCode(65 + c) + (r + 1), altered = overrides[reference];
    if (altered !== undefined) return `<c r="${reference}">${altered}</c>`;
    return `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(value ?? '')}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:T${matrix.length}"/><sheetData>${body}</sheetData></worksheet>`;
}
function workbookEntries(worksheet = sheet([headers, row()])) {
  return [
    { name: '[Content_Types].xml', value: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' },
    { name: '_rels/.rels', value: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', value: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="급여원자료" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', value: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', value: worksheet },
  ];
}
const xlsx = entries => file(zip(entries ?? workbookEntries()), '원자료.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

test('standard CSV contract and shared arithmetic preserve explicit zeros, actual amounts and refunds', async () => {
  assert.equal(HEADER_FIELDS.length, 20); assert.equal(new Set(headers).size, 20);
  assert.equal(CSV_TEMPLATE, '\uFEFF' + headers.join(',') + '\r\n');
  assert(EDITABLE_AMOUNT_KEYS.includes('otherDeductions'));
  const bytes = Buffer.from(csv([headers, row()]));
  const parsed = await parsePayrollSourceFile(file(bytes, 'C:\\fakepath\\원자료.CSV', 'application/octet-stream'));
  assert.equal(parsed.source.name, '원자료.CSV'); assert.equal(parsed.source.mimeType, 'text/csv');
  assert.equal(parsed.source.size, bytes.length); assert.equal(parsed.source.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert(parsed.buffer.equals(bytes)); assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].amounts.basePay, 2300000); assert.equal(parsed.rows[0].amounts.netPay, 2244440);
  const imported = parsePayrollMatrix([headers, row({ pension: '0', incomeTax: '-66,480', localTax: '-6,630', totalDeductions: '41,130', netPay: '2,458,870' })])[0];
  assert.equal(imported.amounts.pension, 0); assert.equal(imported.amounts.incomeTax, -66480); assert.equal(imported.amounts.localTax, -6630);
  assert.equal(imported.amounts.totalInsurance, 114240); assert.equal(imported.amounts.netPay, 2458870);
  const arbitrary = parsePayrollMatrix([headers, row({ pension: '50', totalDeductions: '', netPay: '' })])[0];
  assert.equal(arbitrary.amounts.pension, 50, 'Historical values are not recalculated with current rules.');
});

test('money parsing rejects missing, fractional, imprecise, exponential, formula and unsafe values', () => {
  for (const value of [undefined, null, '', ' ', '-', '—', '1.0', '1e3', '=10', '@100', '+1+1', '1,00', true, {}, [], NaN, Infinity,
    Number.MAX_SAFE_INTEGER + 1, '9007199254740993', '1.0000000000000001', '\t1', '1\n']) invalidCall(() => parsePayrollMoney(value));
  invalidCall(() => parsePayrollMoney(-1)); assert.equal(parsePayrollMoney('-1', '환급', { signed: true }), -1);
  assert.equal(parsePayrollMoney('+1,000'), 1000); assert.equal(parsePayrollMoney('', '기타공제', { optional: true }), 0);
  assert.equal(parsePayrollMoney('0'), 0); assert.equal(parsePayrollMoney('-0'), 0);
  const amount = completePayrollAmounts({ ...sourceValues(), totalDeductions: '1', netPay: '1' });
  assert.equal(amount.totalDeductions, 255560, 'UI completion derives new totals instead of retaining stale totals.');
  invalidCall(() => completePayrollAmounts({ ...sourceValues(), totalDeductions: '1' }, { validateTotals: true }));
  invalidCall(() => completePayrollAmounts({ ...sourceValues(), monthlyGross: 1, nonTaxable: 2 }));
  invalidCall(() => completePayrollAmounts({ ...sourceValues(), pension: Number.MAX_SAFE_INTEGER, health: 1 }));
  invalidCall(() => completePayrollAmounts({ ...sourceValues(), pension: -Number.MAX_SAFE_INTEGER, health: 0, longTerm: 0, employment: 0, incomeTax: 0, localTax: 0 }));
});

test('employee identifiers are explicit, canonical and unique without using resident numbers', () => {
  const parsed = parsePayrollMatrix([headers, row({ employeeLoginId: 'MEMBER@COMPANY.TEST' }), row({ employeeLoginId: '', archiveCode: 'ARCHIVE-002', name: '과거 합성 직원' })]);
  assert.equal(parsed[0].employeeLoginId, 'member@company.test'); assert.equal(parsed[1].archiveCode, 'archive-002');
  for (const patch of [{ employeeLoginId: '', archiveCode: '' }, { archiveCode: 'old-1' }, { employeeLoginId: 'not-email' },
    { employeeLoginId: '', archiveCode: '660101-1234567' }, { employeeLoginId: '', archiveCode: '6601011234567' },
    { employeeLoginId: '', archiveCode: '..:' }, { employeeLoginId: '', archiveCode: '=code' }, { name: '' }, { name: '-formula' }, { name: '@formula' }]) {
    invalidCall(() => parsePayrollMatrix([headers, row(patch)]));
  }
  invalidCall(() => parsePayrollMatrix([headers, row(), row({ employeeLoginId: 'MEMBER@COMPANY.TEST' })]));
  invalidCall(() => parsePayrollMatrix([headers, row({ employeeLoginId: '', archiveCode: 'old-1' }), row({ employeeLoginId: '', archiveCode: 'OLD-1' })]));
});

test('headers, row shape, required zeros, date values and provided totals fail closed', () => {
  invalidCall(() => parsePayrollMatrix([])); invalidCall(() => parsePayrollMatrix([headers]));
  invalidCall(() => parsePayrollMatrix([[...headers.slice(0, 19), headers[0]], row()]));
  invalidCall(() => parsePayrollMatrix([[...headers].reverse(), row()]));
  invalidCall(() => parsePayrollMatrix([headers, [...row(), 'unexpected']]));
  const sparse = row(); delete sparse[12]; invalidCall(() => parsePayrollMatrix([headers, sparse]));
  invalidCall(() => parsePayrollMatrix([headers, row({ health: '', totalDeductions: '', netPay: '' })]));
  invalidCall(() => parsePayrollMatrix([headers, row({ netPay: 1 })]));
  for (const value of ['2026-02-30', '26-01-01', '2026/01/01', new Date(NaN), new Date('2020-01-01T01:00:00Z')]) invalidCall(() => parsePayrollMatrix([headers, row({ joinDate: value })]));
  invalidCall(() => parsePayrollMatrix([headers, row({ resignDate: '2019-01-01' })]));
  assert.equal(parsePayrollMatrix([headers, row({ joinDate: new Date('2020-01-01T00:00:00Z') })])[0].joinDate, '2020-01-01');
  try { parsePayrollMatrix([headers, row({ name: '=SYNTHETIC_PRIVATE_FORMULA' })]); assert.fail(); }
  catch (failure) { assert.equal(failure.row, 2); assert(!failure.message.includes('SYNTHETIC_PRIVATE_FORMULA')); }
});

test('CSV handles proper quoting and rejects malformed UTF8, quotes, controls, formulas and oversized sources', async () => {
  const parsed = await parsePayrollSourceFile(file(Buffer.from(csv([headers, row({ name: '합성, "직원"' })]))));
  assert.equal(parsed.rows[0].name, '합성, "직원"');
  await invalid(parsePayrollSourceFile(file(Buffer.from([0xff, 0xfe, 0x00]))));
  await invalid(parsePayrollSourceFile(file(Buffer.from('"unclosed'))));
  await invalid(parsePayrollSourceFile(file(Buffer.from(csv([headers, row({ name: 'bad\nname' })])))));
  await invalid(parsePayrollSourceFile(file(Buffer.from(csv([headers, row({ name: '=SUM(1,2)' })])))));
  await invalid(parsePayrollSourceFile(file(Buffer.from(csv([headers, row({ name: '\u0000' })])))));
  await invalid(parsePayrollSourceFile(file(Buffer.alloc(MAX_SOURCE_BYTES + 1, 65))));
  await invalid(parsePayrollSourceFile(file(Buffer.from(csv([headers, ...Array.from({ length: 2001 }, (_, i) => row({ employeeLoginId: `e${i}@company.test` }))])))));
  await invalid(parsePayrollSourceFile({ ...file(Buffer.from('a')), extra: 'forged' }));
  await invalid(parsePayrollSourceFile({ ...file(Buffer.from('a')), base64: '%%%=' }));
  await invalid(parsePayrollSourceFile({ ...file(Buffer.from('a')), base64: 'YQ=' }));
  await invalid(parsePayrollSourceFile(file(Buffer.from('a'), 'wrong.xls', 'text/csv')));
  await invalid(parsePayrollSourceFile(file(Buffer.from('a'), 'wrong.csv', 'application/pdf')));
});

test('actual server XLSX reader returns whitelisted values and preserves numeric raw precision', async () => {
  const parsed = await parsePayrollSourceFile(xlsx([{ name: 'xl/', value: '', store: true }, ...workbookEntries()]));
  assert.equal(parsed.rows[0].name, '합성 직원'); assert.equal(parsed.rows[0].amounts.netPay, 2244440);
  assert.equal(parsed.source.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const numeric = await parsePayrollSourceFile(xlsx(workbookEntries(sheet([headers, row()], { J2: '<v>2500000</v>' }))));
  assert.equal(numeric.rows[0].amounts.monthlyGross, 2500000);
  for (const value of ['1.0000000000000001', '9007199254740993', '1E+3']) await invalid(parsePayrollSourceFile(xlsx(workbookEntries(sheet([headers, row()], { J2: `<v>${value}</v>` })))));
  await invalid(parsePayrollSourceFile(file(Buffer.from('not-zip'), 'wrong.xlsx', 'application/octet-stream')));
  await invalid(parsePayrollSourceFile(file(zip(workbookEntries()), 'wrong.csv', 'text/csv')));
  const broken = workbookEntries(); broken[2].value = '<workbook><sheets><sheet name="SYNTHETIC_PRIVATE_NO_RELATION" sheetId="1"/></sheets></workbook>';
  await invalid(parsePayrollSourceFile(xlsx(broken)));
});

test('XLSX formulas, external targets, macro parts, embedded objects and declarations are rejected before cached values', async () => {
  for (const altered of ['<f>1+1</f><v>2</v>', '<x:f xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">1+1</x:f><v>2</v>']) {
    await invalid(parsePayrollSourceFile(xlsx(workbookEntries(sheet([headers, row()], { J2: altered })))));
  }
  for (const name of ['xl/vbaProject.bin', 'xl/embeddings/object1.bin', 'xl/externalLinks/externalLink1.xml', 'xl/connections.xml', 'xl/drawings/drawing1.xml', 'xl/activeX/control1.xml', 'xl/macrosheets/sheet1.xml']) {
    await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name, value: '<data/>' }])));
  }
  for (const relationship of ['TargetMode="External" Target="https://example.test/"', 'TargetMode="Exter&#110;al" Target="file:///private"', 'Target="https://example.test/"']) {
    await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: 'xl/worksheets/_rels/sheet1.xml.rels', value: `<Relationships><Relationship ${relationship}/></Relationships>` }])));
  }
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: 'docProps/custom.xml', value: '<!DOCTYPE a [<!ENTITY e SYSTEM "file:///private">]><a>&e;</a>' }])));
  const macros = workbookEntries(); macros[0].value += ' macroEnabled'; await invalid(parsePayrollSourceFile(xlsx(macros)));
  const named = workbookEntries(); named[2].value = named[2].value.replace('</workbook>', '<definedNames><definedName name="_xlnm.Auto_Open">malicious</definedName></definedNames></workbook>');
  await invalid(parsePayrollSourceFile(xlsx(named)));
  const errorCell = sheet([headers, row()]).replace('<c r="R2" t="inlineStr"><is><t></t></is></c>', '<c r="R2" t="e"><v>#N/A</v></c>');
  await invalid(parsePayrollSourceFile(xlsx(workbookEntries(errorCell))));
});

test('ZIP preflight bounds entries, declared and real inflated bytes, sheet count, cell positions and active content', async () => {
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: 'xl/worksheets/sheet2.xml', value: sheet([headers, row()]) }])));
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { ...workbookEntries()[0] }])));
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: '../outside.xml', value: '<a/>' }])));
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: 'xl\\outside.xml', value: '<a/>' }])));
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), ...Array.from({ length: MAX_ZIP_ENTRIES }, (_, i) => ({ name: `docProps/extra${i}.xml`, value: '<a/>' }))])));
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: 'docProps/large.xml', value: '<a/>', size: MAX_UNCOMPRESSED_BYTES + 1 }])));
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: 'docProps/lying.xml', value: 'A'.repeat(MAX_UNCOMPRESSED_BYTES + 1), size: 100 }])));
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: 'docProps/secret.xml', value: '<a/>', flags: 1 }])));
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: 'docProps/link.xml', value: '<a/>', attributes: 0xa000 << 16 >>> 0 }])));
  await invalid(parsePayrollSourceFile(xlsx([...workbookEntries(), { name: 'extra/', value: '<a/>' }])));
  await invalid(parsePayrollSourceFile(xlsx(workbookEntries(sheet([headers, row()]).replace('r="A2"', 'r="A1000000"')))));
  await invalid(parsePayrollSourceFile(xlsx(workbookEntries(sheet([headers, row()]).replace('ref="A1:T2"', 'ref="A1:XFD1048576"')))));
});
