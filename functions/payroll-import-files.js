const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const yauzl = require('yauzl');
const Papa = require('papaparse');
const excelModule = require('read-excel-file/node');
const readExcelFile = typeof excelModule === 'function' ? excelModule : excelModule.default;
const { MAX_IMPORT_ROWS, parsePayrollMatrix, PayrollImportValidationError } = require('./payroll-import-schema.mjs');

const MAX_SOURCE_BYTES = 3 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 12 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 256;
const MAX_XML_TAGS = 500000;
const CSV_MIME = 'text/csv';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const failure = message => new PayrollImportValidationError(message);
const decodeUtf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function sourceInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['name', 'mimeType', 'base64'].includes(key))) throw failure('원자료 파일 입력 형식을 확인해 주세요.');
  if (typeof value.name !== 'string' || value.name.length > 500 || typeof value.mimeType !== 'string' || value.mimeType.length > 160 || typeof value.base64 !== 'string') throw failure('원자료 파일의 이름·형식·내용을 확인해 주세요.');
  const name = value.name.split(/[\\/]/).at(-1).replace(/\p{Cc}/gu, '').trim().normalize('NFC');
  if (!name || name.length > 180 || !/\.(csv|xlsx)$/i.test(name)) throw failure('원자료는 표준 양식의 .csv 또는 .xlsx 파일이어야 합니다.');
  if (!value.base64 || value.base64.length > 4 * Math.ceil(MAX_SOURCE_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64)) throw failure('원자료 파일은 3MB 이하의 올바른 파일이어야 합니다.');
  const buffer = Buffer.from(value.base64, 'base64');
  if (!buffer.length || buffer.length > MAX_SOURCE_BYTES || buffer.toString('base64') !== value.base64) throw failure('원자료 파일은 3MB 이하의 올바른 파일이어야 합니다.');
  const xlsx = /\.xlsx$/i.test(name);
  const suppliedType = value.mimeType.trim().toLowerCase();
  const allowed = xlsx ? ['', XLSX_MIME, 'application/octet-stream', 'application/zip'] : ['', CSV_MIME, 'application/csv', 'application/vnd.ms-excel', 'application/octet-stream', 'text/plain'];
  if (!allowed.includes(suppliedType)) throw failure('원자료 파일의 확장자와 형식이 일치하지 않습니다.');
  if (xlsx && (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50)) throw failure('암호화되지 않은 올바른 .xlsx 파일을 사용해 주세요.');
  if (!xlsx && buffer.subarray(0, 2).toString() === 'PK') throw failure('CSV 파일에는 UTF-8 문자 자료만 사용할 수 있습니다.');
  return { buffer, name, mimeType: xlsx ? XLSX_MIME : CSV_MIME, xlsx };
}

function characters(value) {
  return value.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_match, code) => {
    const point = code[0].toLowerCase() === 'x' ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
    if (!Number.isSafeInteger(point) || point <= 0 || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) throw failure('원자료 XML 문자 형식이 올바르지 않습니다.');
    return String.fromCodePoint(point);
  });
}
function validateWorksheet(xml) {
  const rowTags = xml.match(/<(?:[\w.-]+:)?row\b[^>]*>/g) || [];
  const cellTags = xml.match(/<(?:[\w.-]+:)?c\b[^>]*>/g) || [];
  if (rowTags.length > MAX_IMPORT_ROWS + 1 || cellTags.length > (MAX_IMPORT_ROWS + 1) * 20) throw failure('원자료의 행·열 수가 표준 양식 한도를 초과했습니다.');
  for (const tag of rowTags) {
    const row = /\br\s*=\s*["'](\d+)["']/.exec(tag);
    if (row && (Number(row[1]) < 1 || Number(row[1]) > MAX_IMPORT_ROWS + 1)) throw failure('원자료의 행 번호가 표준 양식 한도를 초과했습니다.');
  }
  for (const tag of cellTags) {
    if (/\bt\s*=\s*["']e["']/i.test(tag)) throw failure('오류 셀을 포함하지 않은 값 전용 XLSX를 사용해 주세요.');
    const reference = /\br\s*=\s*["']([A-Za-z]+)(\d+)["']/.exec(tag);
    if (!reference || !/^[A-T]$/i.test(reference[1]) || Number(reference[2]) < 1 || Number(reference[2]) > MAX_IMPORT_ROWS + 1) throw failure('원자료의 셀 위치가 표준 양식 범위를 벗어났습니다.');
  }
  for (const dimension of xml.matchAll(/<(?:[\w.-]+:)?dimension\b[^>]*\bref\s*=\s*["']([^"']+)["']/g)) {
    if (!/^[A-T](?:[1-9]\d{0,3})(?::[A-T](?:[1-9]\d{0,3}))?$/i.test(dimension[1]) || dimension[1].split(':').some(ref => Number(ref.match(/\d+$/)[0]) > MAX_IMPORT_ROWS + 1)) throw failure('원자료의 시트 범위가 표준 양식 한도를 초과했습니다.');
  }
}

// A real bounded stream pass is completed before read-excel-file sees the ZIP.
// No JSZip private size fields or claimed compressed metadata are trusted.
async function validateXlsx(buffer) {
  return new Promise((resolve, reject) => {
    let zip, stream, settled = false, entries = 0, declared = 0, inflated = 0, tags = 0, worksheets = 0;
    const names = new Set();
    const stop = error => {
      if (settled) return;
      settled = true;
      if (stream) stream.destroy();
      if (zip) zip.close();
      reject(error instanceof PayrollImportValidationError ? error : failure('원자료 XLSX 압축 내용이 올바르지 않습니다.'));
    };
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, opened) => {
      if (error) { stop(error); return; }
      zip = opened;
      zip.on('error', stop);
      zip.on('end', () => {
        if (settled) return;
        if (worksheets !== 1 || !names.has('[content_types].xml') || !names.has('xl/workbook.xml')) { stop(failure('원자료 XLSX는 급여 자료 시트 한 개로 구성해 주세요.')); return; }
        settled = true; resolve();
      });
      zip.on('entry', entry => {
        if (settled) return;
        const run = async () => {
          entries += 1;
          const name = entry.fileName.toLowerCase();
          if (entries > MAX_ZIP_ENTRIES || entry.fileName.length > 256 || names.has(name)) throw failure('원자료 XLSX의 압축 항목 수·이름·중복을 확인해 주세요.');
          names.add(name);
          if (entry.generalPurposeBitFlag & 0x2041 || ![0, 8].includes(entry.compressionMethod) || (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) throw failure('암호화되거나 지원하지 않는 압축 형식의 XLSX는 사용할 수 없습니다.');
          if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || (declared += entry.uncompressedSize) > MAX_UNCOMPRESSED_BYTES) throw failure('원자료 XLSX의 압축 해제 크기는 12MB 이하여야 합니다.');
          if (/(?:^|\/)(?:embeddings|externallinks|activex|ctrlprops|drawings|media|querytables|pivotcache|pivottables|customxml|macrosheets|dialogsheets)(?:\/|$)|(?:vbaproject|connections|calcchain)\./i.test(name)) throw failure('매크로·외부 연결·개체·수식이 없는 값 전용 XLSX를 사용해 주세요.');
          if (name.endsWith('/')) {
            if (entry.uncompressedSize !== 0 || entry.compressedSize !== 0) throw failure('원자료 XLSX 폴더 항목에 파일 내용을 포함할 수 없습니다.');
            if (!settled) zip.readEntry(); return;
          }
          if (!/\.(?:xml|rels)$/.test(name)) throw failure('개체나 실행 내용을 포함하지 않은 값 전용 XLSX를 사용해 주세요.');
          const chunks = [];
          await new Promise((done, fail) => {
            zip.openReadStream(entry, (err, openedStream) => {
              if (err) { fail(err); return; }
              stream = openedStream;
              openedStream.on('error', fail);
              openedStream.on('data', chunk => {
                inflated += chunk.length;
                if (inflated > MAX_UNCOMPRESSED_BYTES) { openedStream.destroy(failure('원자료 XLSX의 실제 압축 해제 크기가 12MB를 초과했습니다.')); return; }
                chunks.push(chunk);
              });
              openedStream.on('end', done);
            });
          });
          stream = null;
          const xml = decodeUtf8(Buffer.concat(chunks));
          if (/\u0000|<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || /<\?xml[^>]*encoding\s*=\s*["'](?!utf-?8["'])[^"']+["']/i.test(xml)) throw failure('원자료 XLSX XML은 외부 선언이 없는 UTF-8 형식이어야 합니다.');
          tags += (xml.match(/</g) || []).length;
          if (tags > MAX_XML_TAGS) throw failure('원자료 XLSX의 XML 항목 수가 허용 범위를 초과했습니다.');
          if (/<(?:[\w.-]+:)?(?:f|formula|formula1|formula2|calculatedColumnFormula|totalsRowFormula|definedNames?|externalLink|externalReferences|oleObject|controls?)\b/i.test(xml)) throw failure('수식·외부 연결·개체를 제거하고 값만 붙여넣은 XLSX를 사용해 주세요.');
          if (name === '[content_types].xml' && /macroenabled|macrosheet|vbaproject|oleobject|activex/i.test(characters(xml))) throw failure('매크로 또는 포함 개체가 있는 XLSX는 사용할 수 없습니다.');
          if (name.endsWith('.rels')) {
            const decoded = characters(xml);
            if (/\bTargetMode\s*=\s*["']\s*External\s*["']/i.test(decoded) || /\bTarget\s*=\s*["']\s*(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(decoded)) throw failure('외부 파일·주소 연결이 있는 XLSX는 사용할 수 없습니다.');
          }
          if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) { worksheets += 1; validateWorksheet(xml); }
          if (name === 'xl/sharedstrings.xml' && (xml.match(/<(?:[\w.-]+:)?si\b/g) || []).length > (MAX_IMPORT_ROWS + 1) * 20) throw failure('원자료 XLSX의 문자열 수가 허용 범위를 초과했습니다.');
          if (!settled) zip.readEntry();
        };
        run().catch(stop);
      });
      zip.readEntry();
    });
  });
}

async function parsePayrollSourceFile(source) {
  const input = sourceInput(source);
  let matrix;
  if (input.xlsx) {
    await validateXlsx(input.buffer);
    try {
      const workbook = await readExcelFile(input.buffer, { trim: false, parseNumber: value => value });
      if (!Array.isArray(workbook) || workbook.length !== 1) throw failure('원자료 XLSX는 급여 자료 시트 한 개로 구성해 주세요.');
      matrix = workbook[0].data;
    } catch (error) {
      if (error instanceof PayrollImportValidationError) throw error;
      throw failure('원자료 XLSX를 읽지 못했습니다. 값 전용 표준 양식인지 확인해 주세요.');
    }
  } else {
    let text;
    try { text = decodeUtf8(input.buffer); } catch { throw failure('CSV 파일은 UTF-8 형식으로 저장해 주세요.'); }
    if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw failure('CSV 파일에 사용할 수 없는 제어 문자가 있습니다.');
    const result = Papa.parse(text, { delimiter: ',', dynamicTyping: false, header: false, skipEmptyLines: 'greedy', fastMode: false, preview: MAX_IMPORT_ROWS + 2 });
    if (result.errors.length || result.meta.truncated) throw failure('CSV의 따옴표·행 수·표준 양식 구성을 확인해 주세요.');
    matrix = result.data;
  }
  const rows = parsePayrollMatrix(matrix);
  return { rows, source: { name: input.name, mimeType: input.mimeType, size: input.buffer.length,
    sha256: createHash('sha256').update(input.buffer).digest('hex') }, buffer: input.buffer };
}

module.exports = { parsePayrollSourceFile, MAX_SOURCE_BYTES, MAX_UNCOMPRESSED_BYTES, MAX_ZIP_ENTRIES };
