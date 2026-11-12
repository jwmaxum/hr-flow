const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('../../client/node_modules/jszip');
const files = { OPENING: '기초재고_이관_입력양식.xlsx', MOVEMENTS: '거래별_입출고_입력양식.xlsx' };
const escape = text => String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function cell(xml, address, value) {
  const pattern = new RegExp(`<((?:[\\w.-]+:)?)c\\b(?=[^>]*\\br="${address}")[^>]*?(?:\\/>|>[\\s\\S]*?<\\/(?:[\\w.-]+:)?c>)`);
  const match = pattern.exec(xml); if (!match) throw new Error(`Fixture cell ${address} missing`);
  const p = match[1];
  const content = value == null ? `<${p}c r="${address}"/>` : typeof value === 'number' ? `<${p}c r="${address}"><${p}v>${value}</${p}v></${p}c>` :
    value && typeof value === 'object' && value.formula ? `<${p}c r="${address}"><${p}f>${escape(value.formula)}</${p}f><${p}v>${value.cached || 0}</${p}v></${p}c>` :
      `<${p}c r="${address}" t="inlineStr"><${p}is><${p}t>${escape(value)}</${p}t></${p}is></${p}c>`;
  return xml.replace(pattern, content);
}
function column(index) { let result = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result; return result; }
async function workbook(type, rows, options = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(__dirname, '../assets/erp', files[type])));
  let guide = await zip.file('xl/worksheets/sheet1.xml').async('string');
  guide = cell(guide, 'B5', options.company || '합성 ERP 회사'); guide = cell(guide, 'B6', options.basisDate || '2026-11-01');
  zip.file('xl/worksheets/sheet1.xml', guide);
  let data = await zip.file('xl/worksheets/sheet2.xml').async('string');
  rows.forEach((row, i) => row.forEach((value, j) => { data = cell(data, `${column(j)}${i + 10}`, value); }));
  if (options.modifySheet) data = options.modifySheet(data);
  zip.file('xl/worksheets/sheet2.xml', data);
  if (options.modifyZip) await options.modifyZip(zip);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { name: options.name || files[type], mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: buffer.toString('base64') };
}
const opening = (patch = {}) => Object.assign([1,'0001','합성 품목','규격','EA','과세','상품','기본','WH-01','본사 창고',10,'단가',100,null,'KRW',''], patch);
const movement = (patch = {}) => Object.assign(['2026-11-02',1,'입고','IN-001',1,'0001','합성 품목','규격','EA','WH-01','본사 창고',10,200,'KRW',1,'과세',0.1,'세금별도','PT-01','합성 거래처','KR','123-45-67890','','','','',''], patch);
module.exports = { workbook, opening, movement, cell, JSZip };
