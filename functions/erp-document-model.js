const { fail } = require('./security-context');
const { erpMaster: master } = require('./erp-service');
const { exactObject, text, date } = require('./erp-ledger-model');
const { decimal, amounts, safe, round } = require('./erp-import-schema');

const KINDS = ['PROFORMA', 'INVOICE', 'STATEMENT'];
const CURRENCIES = ['KRW', 'USD', 'EUR', 'JPY', 'CNY'];
const PROFILE_FIELDS = ['companyNameEn', 'addressEn', 'representativeEn', 'registrationNumber', 'businessType', 'businessItem', 'bankDetails'];
// Firestore can reorder map fields. Match the existing payroll snapshot hashing
// pattern while preserving array order (document line order is significant).
const hash = value => master.hash(JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry));
const digits = currency => ['KRW', 'JPY'].includes(currency) ? 0 : 2;
const money = (value, currency) => decimal(value, digits(currency), '금액', 9e12);
function multiline(value, label, max = 1000) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > max || [...value].some(char => /\p{Cc}/u.test(char) && !['\n', '\r', '\t'].includes(char))) fail('invalid-argument', `${label}의 길이와 문자를 확인해 주세요.`);
  return value.replace(/\r\n?/g, '\n').replaceAll('\t', ' ').trim().normalize('NFC');
}
function profileInput(value) {
  exactObject(value, PROFILE_FIELDS);
  return Object.fromEntries(PROFILE_FIELDS.map(key => [key, key === 'bankDetails' ? multiline(value[key], '은행 정보', 500) : text(value[key], '공급자 정보', key === 'addressEn' ? 300 : 120)]));
}
function kind(value) {
  if (!KINDS.includes(value)) fail('invalid-argument', '발행할 문서 종류를 선택해 주세요.');
  return value;
}
function input(value) {
  exactObject(value, ['kind', 'issueDate', 'validUntil', 'partnerId', 'buyerNameEn', 'buyerAddressEn', 'currency', 'sourceDocumentNo', 'lines', 'paymentTerms', 'deliveryTerms', 'tradeTerms', 'notes']);
  const type = kind(value.kind), proforma = type === 'PROFORMA';
  const result = { kind: type, issueDate: date(value.issueDate), validUntil: value.validUntil ? date(value.validUntil) : '',
    partnerId: master.identifier(value.partnerId), buyerNameEn: text(value.buyerNameEn, 'Buyer name', 200), buyerAddressEn: text(value.buyerAddressEn, 'Buyer address', 300),
    currency: text(value.currency, '통화', 3, true), sourceDocumentNo: text(value.sourceDocumentNo, '원출고 문서번호', 80, !proforma),
    paymentTerms: multiline(value.paymentTerms, '결제 조건', 500), deliveryTerms: multiline(value.deliveryTerms, '납기·배송 조건', 500),
    tradeTerms: multiline(value.tradeTerms, '무역 조건', 500), notes: multiline(value.notes, '비고', 1000) };
  if (!CURRENCIES.includes(result.currency) || result.validUntil && result.validUntil < result.issueDate) fail('invalid-argument', '통화와 유효기간을 확인해 주세요.');
  if (proforma && (!result.buyerNameEn || !result.buyerAddressEn || !result.validUntil || result.sourceDocumentNo)) fail('invalid-argument', 'Proforma에는 영문 거래처명·주소·유효기간을 입력하고 원출고 번호는 비워 주세요.');
  if (!Array.isArray(value.lines) || !value.lines.length || value.lines.length > 100) fail('invalid-argument', '품목은 1~100행으로 입력해 주세요.');
  const seen = new Set();
  result.lines = value.lines.map(line => {
    exactObject(line, proforma ? ['itemId', 'description', 'quantity', 'price', 'taxType', 'taxRate', 'priceBasis', 'notes'] : ['sourceId', 'quantity', 'notes']);
    const quantityScaled = decimal(line.quantity, 4, '수량', 1e12);
    if (!quantityScaled) fail('invalid-argument', '발행 수량은 0보다 커야 합니다.');
    const common = { quantity: String(quantityScaled / 10000), notes: text(line.notes, '행 비고', 200) };
    if (!proforma) {
      const sourceId = master.identifier(line.sourceId);
      if (seen.has(sourceId)) fail('invalid-argument', '같은 출고 행을 중복 선택할 수 없습니다.');
      seen.add(sourceId); return { sourceId, ...common };
    }
    const priceScaled = decimal(line.price, 4, '단가', 1e13), taxRateScaled = decimal(line.taxRate, 6, '세율', 1e6);
    if (!['과세', '영세', '면세'].includes(line.taxType) || !['세금포함', '세금별도'].includes(line.priceBasis) || line.taxType !== '과세' && taxRateScaled !== 0) fail('invalid-argument', '과세구분·세율·단가기준을 확인해 주세요.');
    if (!priceScaled && !common.notes) fail('invalid-argument', '무상 품목은 행 비고에 근거를 입력해 주세요.');
    return { itemId: master.identifier(line.itemId), description: text(line.description, '영문 품목명', 200, true), ...common,
      price: String(priceScaled / 10000), taxRate: String(taxRateScaled / 1e6), taxType: line.taxType, priceBasis: line.priceBasis };
  });
  return result;
}
function quoteLine(line, item, currency, rowNo) {
  const quantityScaled = decimal(line.quantity, 4, '수량'), priceScaled = decimal(line.price, 4, '단가');
  const calculated = amounts({ type: 'MOVEMENTS', quantityScaled, priceScaled, taxRateScaled: decimal(line.taxRate, 6, '세율'), priceBasis: line.priceBasis, currency, exchangeRateScaled: 1e6 });
  return { rowNo, itemId: line.itemId, sourceId: '', code: item.code, description: line.description, specification: item.specification,
    unit: item.unit, quantityScaled, priceScaled, taxType: line.taxType, taxRateScaled: decimal(line.taxRate, 6, '세율'), priceBasis: line.priceBasis,
    supplyMinor: money(calculated.supply, currency), taxMinor: money(calculated.tax, currency), notes: line.notes, sourceDate: '', warehouseName: '' };
}
function sourceAllocation(row, link, used, quantityScaled, currency) {
  const original = row.quantityScaled, returned = link.returnedQuantityScaled || 0;
  for (const value of [original, returned, used.quantityScaled, used.supplyMinor, used.taxMinor]) if (!Number.isSafeInteger(value) || value < 0 || value > 9e12) fail('failed-precondition', '원거래 발행 이력을 확인해 주세요.');
  const available = original - returned - used.quantityScaled;
  if (link.cancelledBy || !original || available < quantityScaled) fail('failed-precondition', '취소·반품·기발행 수량을 제외한 발행 가능 수량을 초과했습니다.');
  const allocate = field => {
    const total = money(row[field === 'supplyMinor' ? 'supply' : 'tax'], currency);
    const net = total - safe(round(BigInt(total) * BigInt(returned), BigInt(original))), remaining = net - used[field];
    if (remaining < 0) fail('failed-precondition', '반품 후 기발행 금액을 정정해야 합니다. 기존 발행 문서를 취소·정정해 주세요.');
    // Cancellation can leave rounding gaps. Final remaining quantity consumes the
    // exact unallocated amount; earlier portions cannot exceed that remainder.
    return quantityScaled === available ? remaining : Math.min(remaining, safe(round(BigInt(total) * BigInt(quantityScaled), BigInt(original))));
  };
  return { supplyMinor: allocate('supplyMinor'), taxMinor: allocate('taxMinor'), availableQuantityScaled: available };
}
function totals(rows) {
  const supplyMinor = safe(rows.reduce((sum, row) => sum + BigInt(row.supplyMinor), 0n));
  const taxMinor = safe(rows.reduce((sum, row) => sum + BigInt(row.taxMinor), 0n));
  return { supplyMinor, taxMinor, totalMinor: safe(BigInt(supplyMinor) + BigInt(taxMinor)) };
}
function koreanAmount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9e12) throw new Error('Invalid Korean amount');
  if (!value) return '영';
  const digit = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'], small = ['', '십', '백', '천'], large = ['', '만', '억', '조'];
  let result = '', group = 0;
  while (value) {
    let part = value % 10000, text = '', place = 0;
    while (part) { const n = part % 10; if (n) text = (n === 1 && place ? '' : digit[n]) + small[place] + text; part = Math.floor(part / 10); place++; }
    if (text) result = text + large[group] + result;
    value = Math.floor(value / 10000); group++;
  }
  return result;
}
module.exports = { KINDS, PROFILE_FIELDS, CURRENCIES, digits, money, multiline, profileInput, kind, input, quoteLine, sourceAllocation, totals, koreanAmount, hash };
