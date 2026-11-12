const { fail } = require('./security-context');
const MAX_ROWS = 200;
const HEADERS = {
  OPENING: ['행번호','품목코드','품목명','규격','단위','과세구분','계정과목','그룹명','창고코드','창고명','기초수량','금액입력방식','기초단가','기초금액','통화','비고'],
  MOVEMENTS: ['거래일','처리순서','구분','거래번호','행번호','품목코드','품목명','규격','단위','창고코드','창고명','수량','단가','통화','적용환율','부가세구분','부가세율','단가기준','거래처코드','거래처명','국가코드','등록번호','담당자','이메일','연락처','주소','비고'],
};
const SHEETS = { OPENING: '이관입력', MOVEMENTS: '거래입력' };
const empty = value => value == null || value === '';
function text(value, label, max = 120, required = false) {
  if (empty(value) && !required) return '';
  if (typeof value !== 'string' || value.length > max || /\p{Cc}/u.test(value) || required && !value.trim()) fail('invalid-argument', `${label}: ${required ? '필수 ' : ''}텍스트 값을 확인해 주세요. 코드는 텍스트로 입력합니다.`);
  return value.trim().normalize('NFC');
}
function decimal(value, scale, label, maximum = 1e13) {
  const raw = value && typeof value === 'object' && Object.hasOwn(value, 'n') ? value.n : value;
  if (typeof raw !== 'string' && typeof raw !== 'number') fail('invalid-argument', `${label}: 숫자를 입력해 주세요. 공란은 0으로 처리하지 않습니다.`);
  const input = String(raw).trim();
  if (input.length > 40 || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(input)) fail('invalid-argument', `${label}: 0 이상의 숫자를 입력해 주세요.`);
  const [whole, fraction = ''] = input.replaceAll(',', '').split('.');
  if (fraction.replace(/0+$/, '').length > scale) fail('invalid-argument', `${label}: 소수점 ${scale}자리 이하로 입력해 주세요.`);
  const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction.slice(0, scale) + '0'.repeat(scale)).slice(0, scale) || '0');
  if (result > BigInt(maximum)) fail('invalid-argument', `${label}: 허용 범위를 초과했습니다.`);
  return Number(result);
}
function date(value, label) {
  const result = value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : value;
  const parsed = typeof result === 'string' ? new Date(`${result}T00:00:00Z`) : new Date(NaN);
  if (typeof result !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) fail('invalid-argument', `${label}: 2000~2099년의 실제 날짜를 입력해 주세요.`);
  return result;
}
function safe(value, label = '금액') {
  if (value < 0n || value > 9000000000000n) fail('invalid-argument', `${label} 합계의 허용 범위를 초과했습니다.`);
  return Number(value);
}
function round(numerator, denominator) { return (numerator * 2n + denominator) / (denominator * 2n); }
function amounts(row) {
  if (row.type === 'OPENING') return { value: row.openingValue };
  const digits = ['KRW', 'JPY'].includes(row.currency) ? 0 : 2, unit = 10n ** BigInt(digits);
  const product = BigInt(row.quantityScaled) * BigInt(row.priceScaled) * unit;
  const base = round(product, 100000000n), rate = BigInt(row.taxRateScaled);
  const supply = row.priceBasis === '세금포함' ? round(product * 1000000n, 100000000n * (1000000n + rate)) : base;
  const tax = row.priceBasis === '세금포함' ? base - supply : round(supply * rate, 1000000n);
  return { supply: safe(supply) / Number(unit), tax: safe(tax) / Number(unit), total: safe(supply + tax) / Number(unit),
    value: safe(round(supply * BigInt(row.exchangeRateScaled), unit * 1000000n)) };
}
function parseMatrix(workbook, type) {
  if (!Object.hasOwn(HEADERS, type)) fail('invalid-argument', '업로드 유형을 선택해 주세요.');
  const sheet = workbook.find(s => s.sheet === SHEETS[type]), guide = workbook.find(s => s.sheet === '작성안내');
  if (!sheet || !guide) fail('invalid-argument', '작성안내와 지정된 입력 시트를 유지해 주세요.');
  if (HEADERS[type].some((header, i) => sheet.data[8]?.[i] !== header)) fail('invalid-argument', `${SHEETS[type]} 9행의 표준 머리글을 변경하지 마세요.`);
  const errors = [], rows = [];
  let basisDate = '', companyLabel = '';
  try { basisDate = date(guide.data[5]?.[1], '작성안내 B6 기준일'); companyLabel = text(guide.data[4]?.[1], '작성안내 B5 회사명', 120, true); }
  catch (error) { errors.push({ row: 6, sheet: '작성안내', message: error.message }); }
  const rowNumbers = new Set();
  for (let index = 9; index < Math.max(sheet.data.length, 9); index++) {
    const c = (sheet.data[index] || []).slice(0, HEADERS[type].length);
    if (c.every(empty)) continue;
    if (index >= 209) fail('invalid-argument', '파일당 입력은 10~209행, 최대 200행입니다. 파일을 나눠 주세요.');
    try {
      const opening = type === 'OPENING', start = opening ? 1 : 5;
      const row = { type, sourceRow: index + 1, rowNo: decimal(c[opening ? 0 : 4], 0, '행번호', 999999),
        code: text(c[start], '품목코드', 60, true), name: text(c[start + 1], '품목명', 120, true),
        specification: text(c[start + 2], '규격', 160), unit: text(c[start + 3], '단위', 20, true),
        warehouseCode: text(c[opening ? 8 : 9], '창고코드', 60), warehouseName: text(c[opening ? 9 : 10], '창고명', 120),
        quantityScaled: decimal(c[opening ? 10 : 11], 4, '수량', 1000000000000),
        notes: text(c[opening ? 15 : 26], '비고', 500), currency: text(c[opening ? 14 : 13], '통화', 3, true),
        taxType: text(c[opening ? 5 : 15], '과세구분', 10, true) };
      if (row.rowNo < 1 || !['과세', '영세', '면세'].includes(row.taxType)) fail('invalid-argument', '행번호 또는 과세구분을 확인해 주세요.');
      if (opening) {
        row.date = basisDate; row.order = 0; row.documentNo = ''; row.direction = '기초';
        row.account = text(c[6], '계정과목', 80); row.group = text(c[7], '그룹명', 80);
        if (!['단가', '금액'].includes(c[11]) || row.currency !== 'KRW') fail('invalid-argument', '기초재고는 단가/금액 방식과 KRW를 사용합니다.');
        if (c[11] === '단가') {
          if (!empty(c[13])) fail('invalid-argument', '단가 방식에서는 기초금액을 비워 주세요.');
          row.priceScaled = decimal(c[12], 4, '기초단가');
          row.openingValue = safe(round(BigInt(row.quantityScaled) * BigInt(row.priceScaled), 100000000n));
        } else {
          if (!empty(c[12])) fail('invalid-argument', '금액 방식에서는 기초단가를 비워 주세요.');
          row.openingValue = decimal(c[13], 0, '기초금액', 9000000000000);
        }
        if (!row.quantityScaled && row.openingValue) fail('invalid-argument', '수량 0의 기초금액은 0이어야 합니다.');
        if (row.quantityScaled && !row.openingValue && !row.notes) fail('invalid-argument', '무상 재고의 근거를 비고에 입력해 주세요.');
      } else {
        row.date = date(c[0], '거래일'); row.order = decimal(c[1], 0, '처리순서', 999999);
        row.direction = text(c[2], '구분', 10, true); row.documentNo = text(c[3], '거래번호', 80, true);
        row.priceScaled = decimal(c[12], 4, '단가'); row.exchangeRateScaled = decimal(c[14], 6, '적용환율', 1000000000000);
        row.taxRateScaled = decimal(c[16], 6, '부가세율', 1000000); row.priceBasis = text(c[17], '단가기준', 10, true);
        row.partner = { code: text(c[18], '거래처코드', 60), name: text(c[19], '거래처명', 120), country: text(c[20], '국가코드', 2).toUpperCase(),
          registrationNumber: text(c[21], '등록번호', 80), contactName: text(c[22], '담당자', 100), email: text(c[23], '이메일', 254),
          phone: text(c[24], '연락처', 50), address: text(c[25], '주소', 300) };
        if (!row.quantityScaled || !row.order || !['입고', '출고'].includes(row.direction) || !['KRW','USD','EUR','JPY','CNY'].includes(row.currency) ||
          !row.exchangeRateScaled || row.currency === 'KRW' && row.exchangeRateScaled !== 1000000 || !['세금포함', '세금별도'].includes(row.priceBasis) ||
          row.taxType !== '과세' && row.taxRateScaled !== 0) fail('invalid-argument', '수량·순서·구분·환율·세율·단가기준을 확인해 주세요. 세율 10%는 0.1입니다.');
        if (!row.priceScaled && !row.notes) fail('invalid-argument', '무상 거래의 근거를 비고에 입력해 주세요.');
        if (basisDate && row.date <= basisDate) fail('invalid-argument', '거래일은 기초재고 기준일 다음 날부터 입력합니다.');
      }
      const unique = opening ? String(row.rowNo) : `${row.documentNo.normalize('NFKC').toLowerCase()}:${row.rowNo}`;
      if (rowNumbers.has(unique)) fail('invalid-argument', '파일 안의 행번호 또는 거래번호+행번호가 중복되었습니다.');
      rowNumbers.add(unique); amounts(row); rows.push(row);
    } catch (error) { errors.push({ row: index + 1, sheet: SHEETS[type], message: error.message }); }
  }
  if (!rows.length && !errors.length) errors.push({ row: 10, sheet: SHEETS[type], message: '입력 시트에 회사의 실제 데이터를 입력해 주세요. 참고/예시 시트는 업로드하지 않습니다.' });
  return { type, basisDate, companyLabel, rows, errors };
}
module.exports = { MAX_ROWS, HEADERS, SHEETS, parseMatrix, amounts, safe, round, decimal };
