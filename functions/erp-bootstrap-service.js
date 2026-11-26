const { createHash } = require('node:crypto');
const { posix } = require('node:path');
const { TextDecoder } = require('node:util');
const { Parser } = require('saxen');
const yauzl = require('yauzl');
const readExcelModule = require('read-excel-file/node');
const readExcelFile = typeof readExcelModule === 'function' ? readExcelModule : readExcelModule.default;
const { authorizeContext, fail } = require('./security-context');
const { erpMaster: master } = require('./erp-service');
const M = require('./erp-ledger-model');
const { decimal, round, safe, HEADERS } = require('./erp-import-schema');
const { currencies, minor } = require('./erp-finance-model');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_INFLATED = 12 * 1024 * 1024;
const MAX_ROWS = 500;
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CONFIRM_PHRASE = '기존 ERP 삭제 후 이관';
const NS = {
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main': 's',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'p',
  'http://www.w3.org/XML/1998/namespace': 'xml',
};

const EXTRA_HEADERS = {
  차용이관: ['행번호', '품목코드', '품목명', '창고코드', '창고명', '차용수량', '평가금액', '원소유거래처코드', '원소유거래처명', '판매거래처코드', '판매거래처명', '기준일', '참조번호', '비고'],
  거래처이관: ['행번호', '거래처코드', '거래처명', '거래처유형', '국가코드', '사업자등록번호', '담당자', '이메일', '연락처', '주소', '비고'],
  기초미수이관: ['행번호', '기준일', '거래처코드', '거래처명', '통화', '미수잔액', '문서번호', '비고'],
};

const ALLOWED_SHEETS = ['작성안내', '이관입력', '참고데이터', '차용이관', '거래처이관', '기초미수이관'];

const ERP_COLLECTIONS = [
  'erpItems', 'erpWarehouses', 'erpPartners', 'erpKeys', 'erpInventory',
  'erpImports', 'erpBootstrapJobs', 'erpMovements', 'erpDocuments', 'erpState', 'erpImportReceipts',
  'erpCorrections', 'erpMovementLinks', 'erpIssuedDocuments', 'erpIssueCounters',
  'erpIssueAllocations', 'erpPrintSettings', 'erpReceipts', 'erpReceiptJobs',
  'erpSettlements', 'erpSettlementJobs', 'erpCustodyLots', 'erpBorrowings',
  'erpCustodyJobs', 'erpApprovals', 'erpChangeHistory', 'erpReviewConfirmations',
  'erpReviewInbox', 'erpReviewState', 'erpMonthCloses', 'erpCloseMonths',
  'erpClosePlans', 'erpCloseChecklists', 'erpGovernance',
];

const hash = value => master.hash(JSON.stringify(value));
const invalid = message => fail('invalid-argument', message);

function xmlRead(xml, onOpen, onClose = () => {}) {
  if (/\u0000|<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || /<\?xml[^>]*encoding\s*=\s*["'](?!utf-?8["'])[^"']+["']/i.test(xml)) {
    invalid('외부 선언이 없는 UTF-8 XLSX를 사용해 주세요.');
  }
  const parser = new Parser();
  parser.ns(NS);
  parser.on('error', () => invalid('XLSX XML 구조를 확인해 주세요.'));
  parser.on('warn', () => invalid('XLSX XML 속성이 올바르지 않습니다.'));
  parser.on('openTag', (name, getAttrs, decode) => {
    const attrs = Object.fromEntries(Object.entries(getAttrs()).map(([k, v]) => [k, decode(v)]));
    onOpen(name, attrs);
  });
  parser.on('closeTag', name => onClose(name));
  parser.parse(xml);
}

async function unzip(buffer) {
  return new Promise((resolve, reject) => {
    let zip, current, settled = false, declared = 0, actual = 0, count = 0, tags = 0;
    const files = new Map(), names = new Set();
    const stop = error => {
      if (settled) return;
      settled = true;
      current?.destroy();
      zip?.close();
      reject(error?.code === 'invalid-argument' ? error : new Error('XLSX 압축 내용을 읽지 못했습니다.'));
    };
    yauzl.fromBuffer(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, opened) => {
      if (error) return stop(error);
      zip = opened;
      zip.on('error', stop);
      zip.on('end', () => { if (!settled) { settled = true; resolve(files); } });
      zip.on('entry', entry => {
        (async () => {
          const name = entry.fileName, lower = name.toLowerCase();
          if (++count > 256 || name.length > 256 || names.has(lower) || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
            (declared += entry.uncompressedSize) > MAX_INFLATED || entry.generalPurposeBitFlag & 0x2041 || ![0, 8].includes(entry.compressionMethod) ||
            (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) {
            invalid('XLSX 압축 항목·중복·암호화·크기 제한을 확인해 주세요.');
          }
          names.add(lower);
          if (/(?:^|\/)(?:embeddings|externallinks|activex|ctrlprops|drawings|media|querytables|pivotcache|pivottables|customxml|macrosheets|dialogsheets)(?:\/|$)|(?:vbaproject|connections)\./i.test(name)) {
            invalid('매크로·외부 연결·삽입 개체를 제거해 주세요.');
          }
          if (name.endsWith('/')) {
            if (entry.uncompressedSize || entry.compressedSize) invalid('올바른 XLSX 폴더가 아닙니다.');
            zip.readEntry();
            return;
          }
          if (!/\.(xml|rels)$/i.test(name)) invalid('XLSX에 허용하지 않는 파일이 포함되어 있습니다.');
          const chunks = [];
          await new Promise((done, rejectStream) => zip.openReadStream(entry, (err, stream) => {
            if (err) return rejectStream(err);
            current = stream;
            stream.on('error', rejectStream);
            stream.on('data', chunk => {
              actual += chunk.length;
              if (actual > MAX_INFLATED) { stream.destroy(new Error('inflate limit')); return; }
              chunks.push(chunk);
            });
            stream.on('end', done);
          }));
          current = null;
          const xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          tags += (xml.match(/</g) || []).length;
          if (tags > 600000) invalid('XLSX XML 항목이 너무 많습니다.');
          xmlRead(xml, (tag, attrs) => {
            const local = tag.split(':').at(-1);
            if (['externalReference', 'externalLink', 'oleObject', 'control', 'calculatedColumnFormula', 'totalsRowFormula'].includes(local)) {
              invalid('외부 연결·계산 열·개체가 없는 양식을 사용해 주세요.');
            }
            if (local === 'Relationship' && (attrs.TargetMode?.toLowerCase() === 'external' || /^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(attrs.Target || ''))) {
              invalid('외부 파일·주소 연결은 허용하지 않습니다.');
            }
            if (Object.values(attrs).some(v => /macroenabled|vbaproject|activex|macrosheet/i.test(v))) {
              invalid('매크로 형식은 허용하지 않습니다.');
            }
          });
          files.set(name, xml);
          if (!settled) zip.readEntry();
        })().catch(stop);
      });
      zip.readEntry();
    });
  });
}

function inspectBootstrapSheets(files) {
  if (!files.has('xl/workbook.xml') || !files.has('xl/_rels/workbook.xml.rels') || !files.has('[Content_Types].xml')) {
    invalid('표준 XLSX 통합문서가 아닙니다.');
  }
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
    if (!rel || !rel.Type?.endsWith('/worksheet') || used.has(attrs.name) || (attrs.state && attrs.state !== 'visible')) {
      invalid('숨김·중복 또는 잘못된 시트 연결을 확인해 주세요.');
    }
    const target = rel.Target?.startsWith('/') ? rel.Target.slice(1) : posix.normalize(`xl/${rel.Target}`);
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(target) || !files.has(target) || sheets.some(s => s.target === target)) {
      invalid('시트 경로를 확인해 주세요.');
    }
    used.add(attrs.name);
    sheets.push({ name: attrs.name, target });
  });
  if (sheets.length < 2 || sheets.length > 6 || sheets.some(s => !ALLOWED_SHEETS.includes(s.name)) || !used.has('작성안내') || !used.has('이관입력')) {
    invalid('통합 이관 양식의 허용 시트(작성안내·이관입력·차용이관·거래처이관·기초미수이관)만 사용해 주세요.');
  }
  const maxColBySheet = {
    작성안내: 5,
    이관입력: HEADERS.OPENING.length,
    차용이관: EXTRA_HEADERS.차용이관.length,
    거래처이관: EXTRA_HEADERS.거래처이관.length,
    기초미수이관: EXTRA_HEADERS.기초미수이관.length,
  };
  for (const sheet of sheets) {
    let cell = '', column = 0, row = 0, cells = 0, parentRow = 0;
    const addresses = new Set();
    const maxInputCol = maxColBySheet[sheet.name] || 0;
    xmlRead(files.get(sheet.target), (tag, attrs) => {
      const local = tag.split(':').at(-1);
      if (['worksheet', 'sheetData', 'row', 'c', 'f', 'v', 'is', 't', 'dimension'].includes(local) && tag !== `s:${local}`) {
        invalid('시트 셀의 XML 네임스페이스가 올바르지 않습니다.');
      }
      if (tag === 's:row') parentRow = +attrs.r;
      if (tag === 's:row' && attrs.r && (!/^\d+$/.test(attrs.r) || +attrs.r > MAX_ROWS + 20)) {
        invalid(`시트의 최대 행(${MAX_ROWS + 20})을 초과했습니다.`);
      }
      if (tag === 's:c') {
        const match = /^([A-Z]{1,2})([1-9]\d{0,3})$/.exec(attrs.r || '');
        if (!match) invalid('셀 주소를 확인해 주세요.');
        cell = attrs.r;
        row = +match[2];
        column = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
        if (++cells > (MAX_ROWS + 20) * 32 || row > MAX_ROWS + 20 || column > 32 || row !== parentRow || addresses.has(cell)) {
          invalid('셀 범위 또는 중복 셀을 확인해 주세요.');
        }
        addresses.add(cell);
        if (attrs.t === 'e' && maxInputCol && column <= maxInputCol) invalid(`${sheet.name}!${cell}: 오류 셀을 수정해 주세요.`);
      }
      if (tag === 's:f') {
        if (!cell) invalid('셀 밖의 수식은 허용하지 않습니다.');
        if (maxInputCol && column <= maxInputCol) invalid(`${sheet.name}!${cell}: 입력 영역에는 수식 대신 값을 입력해 주세요.`);
      }
    }, tag => { if (tag === 's:c') cell = ''; });
  }
}

function cellText(raw) {
  if (raw == null) return '';
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'object' && 'n' in raw) return String(raw.n);
  return String(raw).normalize('NFC').trim();
}

function cellDate(raw, label) {
  if (raw instanceof Date && Number.isFinite(raw.getTime())) {
    return M.date(raw.toISOString().slice(0, 10));
  }
  return M.date(cellText(raw), label);
}

function cellNumber(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && 'n' in raw) return raw.n;
  if (typeof raw === 'number') return raw;
  return String(raw).replaceAll(',', '').trim();
}

function partnerTypeOf(value) {
  const s = cellText(value);
  if (['BOTH', '매입/매출', '매입·매출'].includes(s)) return 'BOTH';
  if (['SUPPLIER', '매입', '매입처'].includes(s)) return 'SUPPLIER';
  if (['CUSTOMER', '매출', '매출처'].includes(s)) return 'CUSTOMER';
  invalid(`거래처 유형 '${s}'을(를) 확인해 주세요. (BOTH/SUPPLIER/CUSTOMER)`);
}

function parseBootstrapMatrix(workbook) {
  const byName = new Map(workbook.map(entry => [entry.sheet, entry.data || []]));
  const guide = byName.get('작성안내') || [];
  const companyLabel = M.text(cellText(guide[4]?.[1]), '대상 회사명', 120, true);
  const basisDate = cellDate(guide[5]?.[1], '재고 기준일');
  const defaultWarehouseCode = M.text(cellText(guide[6]?.[1]) || 'WH-HQ', '기본 창고코드', 60, true);
  const defaultWarehouseName = M.text(cellText(guide[7]?.[1]) || '본사창고', '기본 창고명', 120, true);

  const warehouseValidated = master.validate('warehouses', {
    code: defaultWarehouseCode,
    name: defaultWarehouseName,
    address: '',
    notes: '기초 통합 이관 기본창고',
    active: true,
  });
    const warehouse = {
    id: `w_${hash(warehouseValidated.codeKey)}`,
    ...warehouseValidated,
  };

  // 1. Parse 거래처이관 (optional)
  const partners = [];
  const partnerByCode = new Map();
  const partnerKeyOwners = new Set();
  const partnerSheet = byName.get('거래처이관');
  if (partnerSheet) {
    const hdr = (partnerSheet[0] || []).slice(0, EXTRA_HEADERS.거래처이관.length).map(cellText);
    if (hdr.join('|') !== EXTRA_HEADERS.거래처이관.join('|')) invalid('거래처이관 시트 머리글이 표준 양식과 다릅니다.');
    for (let i = 1; i < partnerSheet.length; i++) {
      const r = partnerSheet[i] || [];
      if (r.slice(0, EXTRA_HEADERS.거래처이관.length).every(c => cellText(c) === '')) continue;
      if (partners.length >= MAX_ROWS) invalid(`거래처는 최대 ${MAX_ROWS}개처까지 이관할 수 있습니다.`);
      const code = M.text(cellText(r[1]), `거래처이관 ${i + 1}행 코드`, 60, true);
      const name = M.text(cellText(r[2]), `거래처이관 ${i + 1}행 거래처명`, 120, true);
      const type = partnerTypeOf(r[3]);
      const country = M.text(cellText(r[4]) || 'KR', `거래처이관 ${i + 1}행 국가코드`, 2, true).toUpperCase();
      const registrationNumber = M.text(cellText(r[5]), `거래처이관 ${i + 1}행 등록번호`, 80);
      const contactName = M.text(cellText(r[6]), `거래처이관 ${i + 1}행 담당자`, 100);
      const email = M.text(cellText(r[7]), `거래처이관 ${i + 1}행 이메일`, 254);
      const phone = M.text(cellText(r[8]), `거래처이관 ${i + 1}행 연락처`, 50);
      const address = M.text(cellText(r[9]), `거래처이관 ${i + 1}행 주소`, 300);
      const notes = M.text(cellText(r[10]), `거래처이관 ${i + 1}행 비고`, 500);
      const validated = master.validate('partners', {
        code, name, type, country, registrationNumber, contactName, email, phone, address, notes, active: true,
      });
      const keys = master.keys('partners', validated);
      for (const k of keys) {
        if (partnerKeyOwners.has(k)) invalid(`거래처이관 ${i + 1}행(${code} ${name}): 중복된 거래처 코드 또는 등록번호입니다.`);
        partnerKeyOwners.add(k);
      }
      const record = { id: `p_${hash(['code', validated.codeKey])}`, ...validated, keys };
      partners.push(record);
      partnerByCode.set(validated.codeKey, record);
    }
  }

  // 2. Parse 이관입력 (required, row 9 header -> index 8, data from row 10 -> index 9)
  const openingSheet = byName.get('이관입력') || [];
  const openHdr = (openingSheet[8] || []).slice(0, HEADERS.OPENING.length).map(cellText);
  if (openHdr.join('|') !== HEADERS.OPENING.join('|')) invalid('이관입력 시트 9행 머리글이 표준 양식과 다릅니다.');
  const items = [];
  const itemByCode = new Map();
  const seenRowNos = new Set();
  for (let i = 9; i < openingSheet.length; i++) {
    const r = openingSheet[i] || [];
    if (r.slice(0, HEADERS.OPENING.length).every(c => cellText(c) === '')) continue;
    if (items.length >= MAX_ROWS) invalid(`기초재고 품목은 최대 ${MAX_ROWS}행까지 이관할 수 있습니다.`);
    const sourceRow = i + 1;
    const rowNo = decimal(cellNumber(r[0]), 0, `이관입력 ${sourceRow}행 행번호`, 999999);
    if (!rowNo || seenRowNos.has(rowNo)) invalid(`이관입력 ${sourceRow}행: 중복되거나 잘못된 행번호입니다.`);
    seenRowNos.add(rowNo);

    const code = M.text(cellText(r[1]), `이관입력 ${sourceRow}행 품목코드`, 60, true);
    const name = M.text(cellText(r[2]), `이관입력 ${sourceRow}행 품목명`, 120, true);
    const specification = M.text(cellText(r[3]), `이관입력 ${sourceRow}행 규격`, 160);
    const unit = M.text(cellText(r[4]), `이관입력 ${sourceRow}행 단위`, 20, true);
    const taxType = M.text(cellText(r[5]), `이관입력 ${sourceRow}행 과세구분`, 10, true);
    const account = M.text(cellText(r[6]) || '상품', `이관입력 ${sourceRow}행 계정과목`, 60);
    const group = M.text(cellText(r[7]), `이관입력 ${sourceRow}행 그룹명`, 80);
    const whCode = M.text(cellText(r[8]) || defaultWarehouseCode, `이관입력 ${sourceRow}행 창고코드`, 60, true);
    if (master.normalize(whCode) !== warehouse.codeKey) {
      invalid(`이관입력 ${sourceRow}행: 통합 이관은 기본 창고(${defaultWarehouseCode})로 통일해 주세요.`);
    }
    const qtyRaw = cellNumber(r[10]);
    if (qtyRaw === null) invalid(`이관입력 ${sourceRow}행: 기초수량을 입력해 주세요.`);
    const quantityScaled = decimal(qtyRaw, 4, `이관입력 ${sourceRow}행 기초수량`, 1e12);
    const priceMode = M.text(cellText(r[11]), `이관입력 ${sourceRow}행 금액입력방식`, 10, true);
    if (!['단가', '금액'].includes(priceMode)) invalid(`이관입력 ${sourceRow}행: 금액입력방식은 단가 또는 금액이어야 합니다.`);
    const priceRaw = cellNumber(r[12]);
    const amountRaw = cellNumber(r[13]);
    const currency = M.text(cellText(r[14]) || 'KRW', `이관입력 ${sourceRow}행 통화`, 3, true).toUpperCase();
    if (currency !== 'KRW') invalid(`이관입력 ${sourceRow}행: 기초재고 통화는 KRW만 지원합니다.`);
    const notes = M.text(cellText(r[15]), `이관입력 ${sourceRow}행 비고`, 500);

    let priceScaled = null;
    let value = 0;
    let purchasePrice = 0;
    if (priceMode === '단가') {
      if (priceRaw === null || amountRaw !== null) invalid(`이관입력 ${sourceRow}행: 단가 방식은 기초단가만 입력해 주세요.`);
      priceScaled = decimal(priceRaw, 4, `이관입력 ${sourceRow}행 기초단가`, 1e13);
      value = safe(round(BigInt(quantityScaled) * BigInt(priceScaled), 100000000n), '기초금액');
      purchasePrice = priceScaled / 10000;
    } else {
      if (amountRaw === null || priceRaw !== null) invalid(`이관입력 ${sourceRow}행: 금액 방식은 기초금액만 입력해 주세요.`);
      value = decimal(amountRaw, 0, `이관입력 ${sourceRow}행 기초금액`, 9e12);
      if (quantityScaled === 0 && value !== 0) invalid(`이관입력 ${sourceRow}행: 수량이 0이면 금액도 0이어야 합니다.`);
      purchasePrice = quantityScaled > 0 ? Math.round((value * 10000) / quantityScaled) : 0;
    }
    const validated = master.validate('items', {
      code, name, specification, unit, purchasePrice, salePrice: 0, taxType, group, notes, active: true, itemType: 'STOCK', components: [],
    });
    if (itemByCode.has(validated.codeKey)) invalid(`이관입력 ${sourceRow}행(${code}): 중복된 품목코드입니다.`);
    const item = {
      id: `i_${hash(validated.codeKey)}`,
      ...validated,
      keys: master.keys('items', validated),
      opening: { sourceRow, rowNo, quantityScaled, priceMode, priceScaled, value, account, notes },
    };
    items.push(item);
    itemByCode.set(validated.codeKey, item);
  }
  if (!items.length) invalid('이관입력 시트에 등록할 품목이 없습니다.');

  // 3. Parse 차용이관 (optional — negative stock represented as customer custody borrowing)
  const borrowings = [];
  const borrowSheet = byName.get('차용이관');
  if (borrowSheet) {
    const hdr = (borrowSheet[0] || []).slice(0, EXTRA_HEADERS.차용이관.length).map(cellText);
    if (hdr.join('|') !== EXTRA_HEADERS.차용이관.join('|')) invalid('차용이관 시트 머리글이 표준 양식과 다릅니다.');
    for (let i = 1; i < borrowSheet.length; i++) {
      const r = borrowSheet[i] || [];
      if (r.slice(0, EXTRA_HEADERS.차용이관.length).every(c => cellText(c) === '')) continue;
      if (borrowings.length >= MAX_ROWS) invalid(`차용 이관은 최대 ${MAX_ROWS}건까지 가능합니다.`);
      const code = M.text(cellText(r[1]), `차용이관 ${i + 1}행 품목코드`, 60, true);
      const item = itemByCode.get(master.normalize(code));
      if (!item) invalid(`차용이관 ${i + 1}행: 품목코드(${code})가 이관입력 시트에 없습니다.`);
      const whCode = M.text(cellText(r[3]) || defaultWarehouseCode, `차용이관 ${i + 1}행 창고코드`, 60, true);
      if (master.normalize(whCode) !== warehouse.codeKey) invalid(`차용이관 ${i + 1}행: 기본 창고(${defaultWarehouseCode})와 일치해야 합니다.`);
      const quantityScaled = decimal(cellNumber(r[5]), 4, `차용이관 ${i + 1}행 차용수량`, 1e12);
      if (!quantityScaled) invalid(`차용이관 ${i + 1}행: 차용수량은 0보다 커야 합니다.`);
      const evaluationValue = decimal(cellNumber(r[6]) ?? 0, 0, `차용이관 ${i + 1}행 평가금액`, 9e12);
      const ownerCode = M.text(cellText(r[7]), `차용이관 ${i + 1}행 원소유거래처코드`, 60, true);
      const buyerCode = M.text(cellText(r[9]), `차용이관 ${i + 1}행 판매거래처코드`, 60, true);
      const owner = partnerByCode.get(master.normalize(ownerCode));
      const buyer = partnerByCode.get(master.normalize(buyerCode));
      if (!owner || !buyer) invalid(`차용이관 ${i + 1}행: 원소유(${ownerCode}) 또는 판매(${buyerCode}) 거래처가 거래처이관 시트에 없습니다.`);
      const date = cellText(r[11]) ? cellDate(r[11], `차용이관 ${i + 1}행 기준일`) : basisDate;
      const reference = M.text(cellText(r[12]) || `OPEN-BORROW-${basisDate.replaceAll('-', '')}-${code}`, `차용이관 ${i + 1}행 참조번호`, 100, true);
      const notes = M.text(cellText(r[13]) || '기초 마이너스 재고(매출완료 후 당사 보관분 차용 판매) 이관', `차용이관 ${i + 1}행 비고`, 500);
      borrowings.push({
        rowNo: i,
        itemId: item.id,
        code: item.code,
        name: item.name,
        unit: item.unit,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        ownerPartnerId: owner.id,
        ownerName: owner.name,
        buyerPartnerId: buyer.id,
        buyerName: buyer.name,
        quantityScaled,
        evaluationValue,
        date,
        reference,
        notes,
      });
    }
  }

  // 4. Parse 기초미수이관 (optional — opening AR balances, VAT inclusive)
  const receivables = [];
  const seenArDoc = new Set();
  const arSheet = byName.get('기초미수이관');
  if (arSheet) {
    const hdr = (arSheet[0] || []).slice(0, EXTRA_HEADERS.기초미수이관.length).map(cellText);
    if (hdr.join('|') !== EXTRA_HEADERS.기초미수이관.join('|')) invalid('기초미수이관 시트 머리글이 표준 양식과 다릅니다.');
    for (let i = 1; i < arSheet.length; i++) {
      const r = arSheet[i] || [];
      if (r.slice(0, EXTRA_HEADERS.기초미수이관.length).every(c => cellText(c) === '')) continue;
      if (receivables.length >= MAX_ROWS) invalid(`기초미수는 최대 ${MAX_ROWS}건까지 이관할 수 있습니다.`);
      const date = cellDate(r[1], `기초미수이관 ${i + 1}행 기준일`);
      const partnerCode = M.text(cellText(r[2]), `기초미수이관 ${i + 1}행 거래처코드`, 60, true);
      const partner = partnerByCode.get(master.normalize(partnerCode));
      if (!partner) invalid(`기초미수이관 ${i + 1}행: 거래처코드(${partnerCode})가 거래처이관 시트에 없습니다.`);
      const currency = M.text(cellText(r[4]) || 'KRW', `기초미수이관 ${i + 1}행 통화`, 3, true).toUpperCase();
      if (!currencies.includes(currency)) invalid(`기초미수이관 ${i + 1}행: 지원 통화(${currencies.join('/')})를 입력해 주세요.`);
      const amountMinor = minor(String(cellNumber(r[5]) ?? ''), currency);
      if (!amountMinor) invalid(`기초미수이관 ${i + 1}행: 미수잔액은 0보다 커야 합니다.`);
      const documentNo = M.text(cellText(r[6]) || `OPEN-AR-${date.replaceAll('-', '')}-${partner.code}`, `기초미수이관 ${i + 1}행 문서번호`, 100, true);
      const docKey = master.normalize(documentNo);
      if (seenArDoc.has(docKey)) invalid(`기초미수이관 ${i + 1}행: 중복된 미수 문서번호(${documentNo})입니다.`);
      seenArDoc.add(docKey);
      const notes = M.text(cellText(r[7]) || '기초 미수채권 이관 (부가세 포함)', `기초미수이관 ${i + 1}행 비고`, 500);
      receivables.push({
        rowNo: i,
        date,
        partnerId: partner.id,
        partnerCode: partner.code,
        partnerName: partner.name,
        currency,
        amountMinor,
        documentNo,
        notes,
      });
    }
  }

  const positiveItems = items.filter(it => it.opening.quantityScaled > 0);
  const ownedQuantity = positiveItems.reduce((sum, it) => sum + it.opening.quantityScaled, 0) / 10000;
  const ownedValue = positiveItems.reduce((sum, it) => sum + it.opening.value, 0);
  const borrowedQuantity = borrowings.reduce((sum, b) => sum + b.quantityScaled, 0) / 10000;
  const borrowedValue = borrowings.reduce((sum, b) => sum + b.evaluationValue, 0);
  const receivableTotalsMap = new Map();
  for (const ar of receivables) {
    receivableTotalsMap.set(ar.currency, M.signed((receivableTotalsMap.get(ar.currency) || 0) + ar.amountMinor));
  }
  const receivableTotals = [...receivableTotalsMap.entries()].map(([currency, amountMinor]) => ({ currency, amountMinor }));

  return {
    companyLabel,
    basisDate,
    warehouse,
    partners,
    items,
    borrowings,
    receivables,
    summary: {
      warehouseCode: warehouse.code,
      warehouseName: warehouse.name,
      basisDate,
      totalItems: items.length,
      positiveItems: positiveItems.length,
      zeroItems: items.length - positiveItems.length,
      ownedQuantity,
      ownedValue,
      borrowingCount: borrowings.length,
      borrowedQuantity,
      borrowedValue,
      netBookQuantity: (positiveItems.reduce((sum, it) => sum + it.opening.quantityScaled, 0) - borrowings.reduce((sum, b) => sum + b.quantityScaled, 0)) / 10000,
      netBookValue: ownedValue - borrowedValue,
      partnerCount: partners.length,
      receivableCount: receivables.length,
      receivableTotals,
    },
  };
}

async function parseBootstrapFile(source) {
  if (!source || typeof source !== 'object' || Object.keys(source).some(k => !['name', 'mimeType', 'base64'].includes(k)) ||
    typeof source.name !== 'string' || source.name.length > 180 || /[\\/\p{Cc}]/u.test(source.name) || !/\.xlsx$/i.test(source.name) ||
    !['', MIME, 'application/octet-stream', 'application/zip'].includes(source.mimeType) || typeof source.base64 !== 'string' ||
    source.base64.length > 4 * Math.ceil(MAX_BYTES / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.base64)) {
    invalid('3MB 이하의 통합 이관 .xlsx 파일을 선택해 주세요.');
  }
  const buffer = Buffer.from(source.base64, 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES || buffer.toString('base64') !== source.base64 || buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    invalid('암호화되지 않은 올바른 XLSX 파일을 사용해 주세요.');
  }
  try {
    inspectBootstrapSheets(await unzip(buffer));
    const sheetsMeta = await readExcelFile(buffer, { getSheets: true });
    const sheetNames = sheetsMeta.map(s => typeof s === 'string' ? s : s.sheet || s.name);
    const workbook = await readExcelFile(buffer, { sheets: sheetNames, trim: false, parseNumber: value => ({ n: value }) });
    const parsed = parseBootstrapMatrix(workbook);
    return {
      ...parsed,
      source: {
        kind: 'BOOTSTRAP',
        name: source.name,
        mimeType: MIME,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
      },
    };
  } catch (error) {
    if (error.code === 'invalid-argument') throw error;
    invalid('통합 이관 XLSX를 읽지 못했습니다. 시트 구성·날짜·숫자 형식을 확인해 주세요.');
  }
}

async function commitBatches(db, ops) {
  for (let i = 0; i < ops.length; i += 350) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + 350)) {
      batch.set(op.ref, op.data);
    }
    await batch.commit();
  }
}

async function deleteCollectionDocs(db, colRef) {
  if (typeof db.recursiveDelete === 'function') {
    await db.recursiveDelete(colRef);
    return;
  }
  while (true) {
    const snap = await colRef.limit(350).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
  }
}

function expose(job) {
  return {
    id: job.id,
    companyId: job.companyId,
    status: job.status,
    companyLabel: job.companyLabel,
    basisDate: job.basisDate,
    source: job.source,
    summary: job.summary,
    fingerprint: job.fingerprint,
    borrowings: job.borrowings.map(b => ({
      code: b.code, name: b.name, warehouseName: b.warehouseName,
      quantity: b.quantityScaled / 10000, evaluationValue: b.evaluationValue,
      ownerName: b.ownerName, buyerName: b.buyerName, date: b.date,
    })),
    receivables: job.receivables.map(r => ({
      date: r.date, partnerCode: r.partnerCode, partnerName: r.partnerName,
      currency: r.currency, amountMinor: r.amountMinor, documentNo: r.documentNo,
    })),
    createdAt: job.createdAt,
    committedAt: job.committedAt || null,
  };
}

function createErpBootstrapService({ db, now = () => new Date() }) {
  async function authorizeAdmin(request, reader = db) {
    const user = await authorizeContext({ db, request, reader, now, roles: ['ADMIN'] });
    if (request.data?.companyId !== user.companyId) {
      fail('permission-denied', '현재 로그인한 회사의 ADMIN만 초기화·통합 이관을 실행할 수 있습니다.');
    }
    return user;
  }

  return async request => {
    const input = request.data;
    if (!input || typeof input !== 'object' || !['preview', 'commit', 'cancel'].includes(input.action)) {
      fail('invalid-argument', '통합 이관 요청을 확인해 주세요.');
    }
    const fields = {
      preview: ['action', 'companyId', 'id', 'source'],
      commit: ['action', 'companyId', 'id', 'fingerprint', 'confirmPhrase'],
      cancel: ['action', 'companyId', 'id'],
    };
    M.exactObject(input, fields[input.action]);
    const user = await authorizeAdmin(request);
    const companyId = user.companyId;
    const parent = db.collection('companies').doc(companyId);
    const id = master.identifier(input.id);
    const jobRef = parent.collection('erpBootstrapJobs').doc(id);

    if (input.action === 'preview') {
      const parsed = await parseBootstrapFile(input.source);
      const fingerprint = hash({
        schema: 1,
        companyId,
        sha256: parsed.source.sha256,
        summary: parsed.summary,
        warehouse: parsed.warehouse.codeKey,
        itemCount: parsed.items.length,
        partnerCount: parsed.partners.length,
        borrowingCount: parsed.borrowings.length,
        receivableCount: parsed.receivables.length,
      });
      const job = {
        id,
        companyId,
        type: 'BOOTSTRAP',
        status: 'PENDING',
        companyLabel: parsed.companyLabel,
        basisDate: parsed.basisDate,
        source: parsed.source,
        warehouse: parsed.warehouse,
        partners: parsed.partners,
        items: parsed.items,
        borrowings: parsed.borrowings,
        receivables: parsed.receivables,
        summary: parsed.summary,
        fingerprint,
        rows: [],
        preview: { errors: [] },
        createdAt: now().toISOString(),
        createdBy: user.uid,
        committedAt: null,
      };
      if (Buffer.byteLength(JSON.stringify(job)) > 850000) {
        fail('resource-exhausted', '통합 이관 파일 크기가 제한을 초과했습니다.');
      }
      await db.runTransaction(async tx => {
        await authorizeAdmin(request, tx);
        const existing = await tx.get(jobRef);
        if (existing.exists) {
          const old = existing.data();
          master.verifyTenant(old, companyId);
          if (old.type !== 'BOOTSTRAP' || old.fingerprint !== fingerprint) {
            fail('already-exists', '이미 사용 중인 이관 요청 번호입니다. 새로 검증해 주세요.');
          }
          return;
        }
        tx.create(jobRef, job);
      });
      return { bootstrap: expose(job) };
    }

    if (input.action === 'cancel') {
      return db.runTransaction(async tx => {
        await authorizeAdmin(request, tx);
        const snap = await tx.get(jobRef);
        if (!snap.exists) fail('not-found', '이관 미리보기 자료를 찾을 수 없습니다.');
        const old = snap.data();
        master.verifyTenant(old, companyId);
        if (old.type !== 'BOOTSTRAP') fail('failed-precondition', '통합 이관 미리보기만 취소할 수 있습니다.');
        if (old.status === 'COMMITTED') fail('failed-precondition', '이미 확정된 이관은 취소할 수 없습니다.');
        tx.update(jobRef, { status: 'CANCELLED', cancelledAt: now().toISOString(), cancelledBy: user.uid });
        return { bootstrap: expose({ ...old, status: 'CANCELLED' }) };
      });
    }

    // action === 'commit'
    if (input.confirmPhrase !== CONFIRM_PHRASE) {
      fail('failed-precondition', `확인 문구("${CONFIRM_PHRASE}")를 정확히 입력해 주세요.`);
    }
    const snap = await jobRef.get();
    if (!snap.exists) fail('not-found', '이관 미리보기 자료를 찾을 수 없습니다.');
    const job = snap.data();
    master.verifyTenant(job, companyId);
    if (job.type !== 'BOOTSTRAP') fail('failed-precondition', '통합 이관 미리보기 자료가 아닙니다.');
    if (job.status === 'COMMITTED') return { bootstrap: expose(job), idempotent: true };
    if (job.status !== 'PENDING' || input.fingerprint !== job.fingerprint) {
      fail('failed-precondition', '확인한 미리보기 지문으로 다시 시도해 주세요.');
    }

    // Re-verify ADMIN right before destructive wipe
    await authorizeAdmin(request);

    // 1. Delete existing company-scoped ERP collections ONLY
    for (const name of ERP_COLLECTIONS) {
      await deleteCollectionDocs(db, parent.collection(name));
    }

    // 2. Stage all fresh normalized ERP records
    const at = now().toISOString();
    const ops = [];
    const wh = job.warehouse;
    const whData = {
      code: wh.code, name: wh.name, address: wh.address || '', notes: wh.notes || '', active: true,
      codeKey: wh.codeKey, nameKey: wh.nameKey, companyId, revision: 1,
      createdAt: at, createdBy: user.uid, updatedAt: at, updatedBy: user.uid,
    };
    ops.push({ ref: parent.collection('erpWarehouses').doc(wh.id), data: whData });
    for (const key of master.keys('warehouses', whData)) {
      ops.push({ ref: parent.collection('erpKeys').doc(key), data: { recordId: wh.id, kind: 'warehouses', companyId } });
    }

    for (const p of job.partners) {
      const { id: pId, keys: pKeys, ...rest } = p;
      const pData = {
        ...rest, companyId, revision: 1,
        createdAt: at, createdBy: user.uid, updatedAt: at, updatedBy: user.uid,
      };
      ops.push({ ref: parent.collection('erpPartners').doc(pId), data: pData });
      for (const key of pKeys) {
        ops.push({ ref: parent.collection('erpKeys').doc(key), data: { recordId: pId, kind: 'partners', companyId } });
      }
    }

    for (const it of job.items) {
      const { id: itemId, keys: iKeys, opening, ...rest } = it;
      const iData = {
        ...rest, companyId, revision: 1,
        createdAt: at, createdBy: user.uid, updatedAt: at, updatedBy: user.uid,
      };
      ops.push({ ref: parent.collection('erpItems').doc(itemId), data: iData });
      for (const key of iKeys) {
        ops.push({ ref: parent.collection('erpKeys').doc(key), data: { recordId: itemId, kind: 'items', companyId } });
      }
      const invId = hash([itemId, wh.id]);
      const movId = hash(['opening', itemId, wh.id]);
      const qty = opening.quantityScaled / 10000;
      ops.push({
        ref: parent.collection('erpInventory').doc(invId),
        data: {
          companyId, itemId, warehouseId: wh.id, quantity: qty, value: opening.value,
          currency: 'KRW', openingImportId: job.id, updatedAt: at, importId: job.id,
        },
      });
      ops.push({
        ref: parent.collection('erpMovements').doc(movId),
        data: {
          companyId, importId: job.id, type: 'OPENING', sourceRow: opening.sourceRow, rowNo: opening.rowNo,
          date: job.basisDate, order: 0, direction: '기초', documentNo: 'OPENING',
          itemId, code: iData.code, name: iData.name, specification: iData.specification || '', unit: iData.unit,
          taxType: iData.taxType, account: opening.account || '상품', group: iData.group || '',
          warehouseId: wh.id, warehouseCode: wh.code, warehouseName: wh.name,
          quantityScaled: opening.quantityScaled, priceMode: opening.priceMode, priceScaled: opening.priceScaled,
          supply: opening.value, tax: 0, total: opening.value, value: opening.value, cost: 0,
          currency: 'KRW', exchangeRateScaled: 10000, taxRateScaled: 0, priceBasis: '세금별도',
          sourceKind: 'BOOTSTRAP', partnerId: null, partnerName: '',
          afterQuantity: qty, afterValue: opening.value, notes: opening.notes || '',
          createdAt: at, createdBy: user.uid, committedAt: at,
        },
      });
    }

    let maxCustodyDate = null;
    for (const b of job.borrowings) {
      const lotId = `held_open_${hash([job.id, b.itemId, b.warehouseId, b.rowNo]).slice(0, 24)}`;
      const loanId = `loan_open_${hash([job.id, b.itemId, b.warehouseId, b.rowNo]).slice(0, 24)}`;
      if (!maxCustodyDate || b.date > maxCustodyDate) maxCustodyDate = b.date;
      ops.push({
        ref: parent.collection('erpCustodyLots').doc(lotId),
        data: {
          companyId, itemId: b.itemId, code: b.code, name: b.name, unit: b.unit,
          warehouseId: b.warehouseId, warehouseName: b.warehouseName,
          ownerPartnerId: b.ownerPartnerId, ownerName: b.ownerName,
          availableQuantityScaled: 0, borrowedQuantityScaled: b.quantityScaled, deliveredQuantityScaled: 0,
          sourceMovementId: '', date: b.date, lastDate: b.date, reference: b.reference, notes: b.notes,
          revision: 1, createdBy: user.uid, createdAt: at, updatedAt: at,
        },
      });
      ops.push({
        ref: parent.collection('erpBorrowings').doc(loanId),
        data: {
          companyId, lotId, itemId: b.itemId, code: b.code, name: b.name, unit: b.unit,
          warehouseId: b.warehouseId, warehouseName: b.warehouseName,
          ownerPartnerId: b.ownerPartnerId, ownerName: b.ownerName,
          buyerPartnerId: b.buyerPartnerId, buyerName: b.buyerName,
          quantityScaled: b.quantityScaled, outstandingQuantityScaled: b.quantityScaled,
          evaluationValue: b.evaluationValue, outstandingValue: b.evaluationValue,
          returnedQuantityScaled: 0, repaidQuantityScaled: 0, sourceMovementId: '',
          date: b.date, lastDate: b.date, reference: b.reference, notes: b.notes,
          revision: 1, createdBy: user.uid, createdAt: at, updatedAt: at,
        },
      });
    }

    let maxReceivableDate = null;
    for (const ar of job.receivables) {
      const arId = `openar_${hash([job.id, ar.documentNo]).slice(0, 24)}`;
      if (!maxReceivableDate || ar.date > maxReceivableDate) maxReceivableDate = ar.date;
      ops.push({
        ref: parent.collection('erpReceipts').doc(arId),
        data: {
          companyId, type: 'OPENING_RECEIVABLE', date: ar.date,
          partnerId: ar.partnerId, partnerName: ar.partnerName,
          currency: ar.currency, amountMinor: ar.amountMinor,
          documentNo: ar.documentNo, reference: ar.documentNo, method: 'OTHER',
          notes: ar.notes, sourceKind: 'BOOTSTRAP',
          createdAt: at, createdBy: user.uid, committedAt: at,
        },
      });
    }

    ops.push({
      ref: parent.collection('erpState').doc('ledger'),
      data: { companyId, basisDate: job.basisDate, revision: 1, lastDate: null, lastOrder: null, updatedAt: at },
    });
    if (maxCustodyDate) {
      ops.push({
        ref: parent.collection('erpState').doc('custody'),
        data: { companyId, revision: 1, lastDate: maxCustodyDate, updatedAt: at },
      });
    }
    if (maxReceivableDate) {
      ops.push({
        ref: parent.collection('erpState').doc('receivables'),
        data: { companyId, revision: 1, lastDate: maxReceivableDate, updatedAt: at },
      });
    }
    ops.push({
      ref: parent.collection('erpGovernance').doc('control'),
      data: { companyId, revision: 1, closedThrough: '', lastClosedMonth: '', updatedAt: at },
    });

    const committedJob = {
      ...job,
      status: 'COMMITTED',
      committedAt: at,
      committedBy: user.uid,
    };
    ops.push({ ref: jobRef, data: committedJob });
    ops.push({
      ref: parent.collection('erpAudit').doc(),
      data: {
        companyId, actorId: user.uid, action: 'ERP_BOOTSTRAP_COMMIT',
        importId: job.id, summary: job.summary, at,
      },
    });

    await commitBatches(db, ops);
    return { bootstrap: expose(committedJob), idempotent: false };
  };
}

module.exports = { createErpBootstrapService, parseBootstrapFile, CONFIRM_PHRASE, ERP_COLLECTIONS };
