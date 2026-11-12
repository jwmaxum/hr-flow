const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inflateSync } = require('node:zlib');
const { renderErpDocumentPdf } = require('../erp-document-pdf');
const { sealPng, snapshot } = require('./erp-document-pdf-fixtures.cjs');

function streams(bytes) {
  return [...bytes.toString('latin1').matchAll(/\d+ 0 obj\b([\s\S]*?)stream\r?\n([\s\S]*?)\r?\nendstream/g)].flatMap(match => {
    if (!/\/FlateDecode\b/.test(match[1])) return [];
    try { return [inflateSync(Buffer.from(match[2], 'latin1')).toString('latin1')]; } catch { return []; }
  });
}
test('ERP A4 PDFs embed Korean fonts, preserve configured seal dimensions and produce both statement copies', async () => {
  for (const kind of ['PROFORMA', 'INVOICE', 'STATEMENT']) {
    const pdf = await renderErpDocumentPdf(snapshot(kind), { seal: sealPng() }), raw = pdf.toString('latin1');
    assert.ok(pdf.length > 10000 && pdf.length < 5 * 1024 * 1024); assert.match(raw, /\/PrintScaling \/None/); assert.match(raw, /\/FontFile3/);
    assert.match(raw, kind === 'STATEMENT' ? /\/MediaBox \[0 0 841\.89 595\.28\]/ : /\/MediaBox \[0 0 595\.28 841\.89\]/);
    const matrices = streams(pdf).flatMap(stream => [...stream.matchAll(/([-\d.]+) 0 0 ([-\d.]+) [-\d.]+ [-\d.]+ cm\s*\/I\d+ Do/g)]);
    assert.equal(matrices.length, kind === 'STATEMENT' ? 2 : 1);
    for (const matrix of matrices) { assert.ok(Math.abs(Math.abs(Number(matrix[1])) - 28 * 72 / 25.4) < .001); assert.ok(Math.abs(Math.abs(Number(matrix[2])) - 18 * 72 / 25.4) < .001); }
    if (kind === 'STATEMENT') assert.ok(/\/Count 2\b/.test(raw), 'A short statement should have one page per copy');
  }
});
test('long item names, many rows and maximum seal sizes paginate with embedded fonts', async () => {
  for (const kind of ['PROFORMA', 'INVOICE', 'STATEMENT']) {
    const pdf = await renderErpDocumentPdf(snapshot(kind, 36, true), { seal: sealPng() });
    const count = Number(/\/Type \/Pages\s*\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]);
    assert.ok(count > 1 && count <= 60, `${kind}: ${count}`);
  }
});
test('draft PDFs never apply the seal, while issued PDFs require the archived image', async () => {
  const data = { ...snapshot(), draft: true, number: 'DRAFT' }, pdf = await renderErpDocumentPdf(data, {});
  assert.equal(streams(pdf).some(stream => /\/I\d+ Do/.test(stream)), false);
  await assert.rejects(renderErpDocumentPdf(snapshot(), {}), /requires the frozen seal/);
});
