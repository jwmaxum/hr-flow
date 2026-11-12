const { createHash } = require('node:crypto');
const { posix } = require('node:path');
const { TextDecoder } = require('node:util');
const { Parser } = require('saxen');
const yauzl = require('yauzl');
const readExcelFile = require('read-excel-file/node').default;
const { fail } = require('./security-context');
const { HEADERS, SHEETS, parseMatrix } = require('./erp-import-schema');
const MAX_BYTES = 3 * 1024 * 1024, MAX_INFLATED = 12 * 1024 * 1024;
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const NS = { 'http://schemas.openxmlformats.org/spreadsheetml/2006/main': 's',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'p' };
function invalid(message) { fail('invalid-argument', message); }
function xmlRead(xml, onOpen, onClose = () => {}) {
  if (/\u0000|<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || /<\?xml[^>]*encoding\s*=\s*["'](?!utf-?8["'])[^"']+["']/i.test(xml)) invalid('외부 선언이 없는 UTF-8 XLSX를 사용해 주세요.');
  const parser = new Parser(); parser.ns(NS);
  parser.on('error', () => invalid('XLSX XML 구조를 확인해 주세요.'));
  parser.on('warn', () => invalid('XLSX XML 속성이 올바르지 않습니다.'));
  parser.on('openTag', (name, getAttrs, decode) => {
    const attrs = Object.fromEntries(Object.entries(getAttrs()).map(([key, value]) => [key, decode(value)]));
    onOpen(name, attrs);
  });
  parser.on('closeTag', name => onClose(name)); parser.parse(xml);
}
async function unzip(buffer) {
  // Reuses the payroll parser's bounded streaming approach, with ERP-specific XML rules.
  return new Promise((resolve, reject) => {
    let zip, current, settled = false, declared = 0, actual = 0, count = 0, tags = 0;
    const files = new Map(), names = new Set();
    const stop = error => { if (settled) return; settled = true; current?.destroy(); zip?.close(); reject(error?.code === 'invalid-argument' ? error : new Error('XLSX 압축 내용을 읽지 못했습니다.')); };
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, opened) => {
      if (error) return stop(error); zip = opened; zip.on('error', stop);
      zip.on('end', () => { if (!settled) { settled = true; resolve(files); } });
      zip.on('entry', entry => {
        (async () => {
          const name = entry.fileName, lower = name.toLowerCase();
          if (++count > 256 || name.length > 256 || names.has(lower) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
            (declared += entry.uncompressedSize) > MAX_INFLATED || entry.generalPurposeBitFlag & 0x2041 || ![0,8].includes(entry.compressionMethod) ||
            (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) invalid('XLSX 압축 항목·중복·암호화·크기 제한을 확인해 주세요.');
          names.add(lower);
          if (/(?:^|\/)(?:embeddings|externallinks|activex|ctrlprops|drawings|media|querytables|pivotcache|pivottables|customxml|macrosheets|dialogsheets)(?:\/|$)|(?:vbaproject|connections)\./i.test(name)) invalid('매크로·외부 연결·삽입 개체를 제거해 주세요.');
          if (name.endsWith('/')) { if (entry.uncompressedSize || entry.compressedSize) invalid('올바른 XLSX 폴더가 아닙니다.'); zip.readEntry(); return; }
          if (!/\.(xml|rels)$/i.test(name)) invalid('XLSX에 허용하지 않는 파일이 포함되어 있습니다.');
          const chunks = [];
          await new Promise((done, rejectStream) => zip.openReadStream(entry, (err, stream) => {
            if (err) return rejectStream(err); current = stream; stream.on('error', rejectStream);
            stream.on('data', chunk => { actual += chunk.length; if (actual > MAX_INFLATED) { stream.destroy(new Error('inflate limit')); return; } chunks.push(chunk); });
            stream.on('end', done);
          }));
          current = null;
          const xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          tags += (xml.match(/</g) || []).length;
          if (tags > 500000) invalid('XLSX XML 항목이 너무 많습니다.');
          xmlRead(xml, (tag, attrs) => {
            const local = tag.split(':').at(-1);
            if (['externalReference','externalLink','oleObject','control','definedName','calculatedColumnFormula','totalsRowFormula'].includes(local)) invalid('외부 연결·정의된 이름·계산 열·개체가 없는 양식을 사용해 주세요.');
            if (local === 'Relationship' && (attrs.TargetMode?.toLowerCase() === 'external' || /^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(attrs.Target || ''))) invalid('외부 파일·주소 연결은 허용하지 않습니다.');
            if (Object.values(attrs).some(value => /macroenabled|vbaproject|activex|macrosheet/i.test(value))) invalid('매크로 형식은 허용하지 않습니다.');
          });
          files.set(name, xml); if (!settled) zip.readEntry();
        })().catch(stop);
      }); zip.readEntry();
    });
  });
}
function inspectSheets(files, type) {
  if (!files.has('xl/workbook.xml') || !files.has('xl/_rels/workbook.xml.rels') || !files.has('[Content_Types].xml')) invalid('표준 XLSX 통합문서가 아닙니다.');
  const relationships = new Map();
  xmlRead(files.get('xl/_rels/workbook.xml.rels'), (tag, attrs) => {
    if (tag !== 'p:Relationship') return;
    if (relationships.has(attrs.Id)) invalid('중복 시트 연결이 있습니다.');
    relationships.set(attrs.Id, attrs);
  });
  const sheets = [], used = new Set();
  xmlRead(files.get('xl/workbook.xml'), (tag, attrs) => {
    if (tag !== 's:sheet') return;
    const rel = relationships.get(attrs['r:id']);
    if (!rel || !rel.Type?.endsWith('/worksheet') || used.has(attrs.name) || attrs.state && attrs.state !== 'visible') invalid('숨김·중복 또는 잘못된 시트 연결을 확인해 주세요.');
    const target = rel.Target?.startsWith('/') ? rel.Target.slice(1) : posix.normalize(`xl/${rel.Target}`);
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(target) || !files.has(target) || sheets.some(s => s.target === target)) invalid('시트 경로를 확인해 주세요.');
    used.add(attrs.name); sheets.push({ name: attrs.name, target });
  });
  const allowed = ['작성안내', SHEETS[type], type === 'OPENING' ? '참고데이터' : '작성예시'];
  if (sheets.length < 2 || sheets.length > 3 || sheets.some(s => !allowed.includes(s.name)) || !used.has('작성안내') || !used.has(SHEETS[type]) ||
    [...files.keys()].filter(name => /^xl\/worksheets\/[^/]+\.xml$/.test(name)).length !== sheets.length) invalid('원본 양식의 작성안내·입력·참고 시트만 사용해 주세요.');
  for (const sheet of sheets) {
    let cell = '', column = 0, row = 0, cells = 0, parentRow = 0;
    const addresses = new Set();
    xmlRead(files.get(sheet.target), (tag, attrs) => {
      const local = tag.split(':').at(-1);
      if (['worksheet','sheetData','row','c','f','v','is','t','dimension'].includes(local) && tag !== `s:${local}`) invalid('시트 셀의 XML 네임스페이스가 올바르지 않습니다.');
      if (tag === 's:row') parentRow = +attrs.r;
      if (tag === 's:row' && attrs.r && (!/^\d+$/.test(attrs.r) || +attrs.r > 209)) invalid('시트의 최대 행은 209입니다.');
      if (tag === 's:dimension' && !/^[A-Z]{1,2}[1-9]\d{0,2}(?::[A-Z]{1,2}[1-9]\d{0,2})?$/.test(attrs.ref || '')) invalid('시트 크기 제한을 확인해 주세요.');
      if (tag === 's:c') {
        const match = /^([A-Z]{1,2})([1-9]\d{0,2})$/.exec(attrs.r || '');
        if (!match) invalid('셀 주소를 확인해 주세요.');
        cell = attrs.r; row = +match[2]; column = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
        if (++cells > 209 * 32 || row > 209 || column > 32 || row !== parentRow || addresses.has(cell)) invalid('셀 범위 또는 중복 셀을 확인해 주세요.');
        addresses.add(cell);
        if (attrs.t === 'e' && sheet.name === SHEETS[type] && column <= HEADERS[type].length) invalid(`${sheet.name}!${cell}: 오류 셀을 수정해 주세요.`);
      }
      if (tag === 's:f') {
        if (!cell) invalid('셀 밖의 수식은 허용하지 않습니다.');
        const inputFormula = (sheet.name === SHEETS[type] && column <= HEADERS[type].length) || (sheet.name === '작성안내' && ['B5','B6'].includes(cell));
        const ranges = attrs.ref ? attrs.ref.split(':') : [];
        if (ranges.some(ref => !/^[A-Z]{1,2}[1-9]\d{0,2}$/.test(ref))) invalid('배열 수식 범위를 확인해 주세요.');
        const crossesInput = sheet.name === SHEETS[type] && ranges.some(ref => [...ref.replace(/\d+/g, '')].reduce((n,c) => n * 26 + c.charCodeAt(0) - 64, 0) <= HEADERS[type].length);
        if (inputFormula || crossesInput) invalid(`${sheet.name}!${cell}: 입력 영역에는 수식 대신 값을 입력해 주세요.`);
      }
    }, tag => { if (tag === 's:c') cell = ''; });
  }
}
async function parseErpFile(source, type) {
  if (!Object.hasOwn(HEADERS, type)) invalid('업로드 유형을 선택해 주세요.');
  if (!source || typeof source !== 'object' || Object.keys(source).some(key => !['name','mimeType','base64'].includes(key)) ||
    typeof source.name !== 'string' || source.name.length > 180 || /[\\/\p{Cc}]/u.test(source.name) || !/\.xlsx$/i.test(source.name) ||
    !['', MIME, 'application/octet-stream', 'application/zip'].includes(source.mimeType) || typeof source.base64 !== 'string' ||
    source.base64.length > 4 * Math.ceil(MAX_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.base64)) invalid('3MB 이하의 표준 .xlsx 파일을 선택해 주세요.');
  const buffer = Buffer.from(source.base64, 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES || buffer.toString('base64') !== source.base64 || buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) invalid('암호화되지 않은 올바른 XLSX를 사용해 주세요.');
  try {
    inspectSheets(await unzip(buffer), type);
    const workbook = await readExcelFile(buffer, { trim: false, parseNumber: value => ({ n: value }) });
    return { ...parseMatrix(workbook, type), source: { name: source.name, mimeType: MIME, size: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex') }, buffer };
  } catch (error) { if (error.code === 'invalid-argument') throw error; invalid('XLSX를 읽지 못했습니다. 파일의 압축·날짜·표준 양식 구성을 확인해 주세요.'); }
}
module.exports = { parseErpFile, MAX_BYTES, MIME };
