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

test('monthly and partner reports embed Korean fonts and paginate complete financial tables',async()=>{
  const {renderFinanceReportPdf}=require('../erp-finance-pdf'),fixtures=require('./erp-finance-export-fixtures.cjs');
  for(const kind of ['monthly','statement'])for(const long of [false,true]){
    const report=fixtures[kind](long?105:4,long),bytes=await renderFinanceReportPdf(report),raw=bytes.toString('latin1');
    assert.match(raw,/\/FontFile3/);assert.match(raw,/\/PrintScaling \/None/);assert.match(raw,/\/MediaBox \[0 0 841\.89 595\.28\]/);
    const pages=Number(/\/Type \/Pages\s*\/Count (\d+)/.exec(raw)?.[1]);assert.ok(pages>=1&&pages<150);if(long)assert.ok(pages>3);
    assert.equal(raw.includes('/URI'),false);assert.equal(raw.includes('/JavaScript'),false);
  }
});
test('financial export limits fail explicitly instead of truncating a PDF or accepting a large payload',async()=>{
  const {createFinanceExportHandler,finalize}=require('../erp-finance-export'),d={companyId:'a',companyName:'a',month:'2026-11',from:'2026-11-01',asOf:'2026-11-12',snapshot:'a'.repeat(64),currencies:[],trend:[],partners:[],sales:[],purchases:[],assets:Array.from({length:2001},()=>({closingQuantity:1,closingValue:1})),inventoryValue:2001,pendingCount:0};
  const api=createFinanceExportHandler({now:()=>new Date('2026-11-13T00:00:00Z'),dashboard:async()=>d,context:async()=>{},renderPdf:async()=>{throw Error('must not render');}});
  await assert.rejects(api({}, {action:'dashboardExport',month:d.month,format:'PDF',snapshot:d.snapshot,companyId:'a'},{id:'a'}),e=>e.code==='resource-exhausted');
  assert.throws(()=>finalize({notes:['x'.repeat(6*1024*1024)]}),e=>e.code==='resource-exhausted');
});
