const { fail } = require('./security-context');
const { exactObject, date, hash, decimal } = require('./erp-ledger-model');
const { parseMatrix, HEADERS, SHEETS } = require('./erp-import-schema');
const { erpMaster: master } = require('./erp-service');

// Adapt typed form values to the existing row validator, without creating or storing a workbook.
function manualInput(input) {
  exactObject(input, ['direction','date','warehouseId','partnerId','partner','currency','exchangeRate','priceBasis','lines','allowNewItems','allowNewPartners']);
  if (!['입고','출고'].includes(input.direction) || !Array.isArray(input.lines) || !input.lines.length || input.lines.length > 50) fail('invalid-argument', '입출고 구분과 1~50개 품목을 확인해 주세요.');
  date(input.date); master.identifier(input.warehouseId);
  if (input.partnerId) master.identifier(input.partnerId);
  else exactObject(input.partner, ['code','name','country','registrationNumber']);
  if (input.partnerId && input.partner) fail('invalid-argument', '기존 거래처 또는 신규 거래처 중 하나를 선택해 주세요.');
  for (const key of ['allowNewItems','allowNewPartners']) if (typeof input[key] !== 'boolean') fail('invalid-argument', '신규 등록 확인을 선택해 주세요.');
  for (const line of input.lines) {
    exactObject(line, ['code','name','specification','unit','taxType','quantity','price','notes','fulfillment','custodyLotId','borrowValue']);
    const mode = line.fulfillment || 'DIRECT';
    if (!['DIRECT','HOLD','BORROW'].includes(mode) || input.direction !== '출고' && mode !== 'DIRECT') fail('invalid-argument','보관·차용은 출고에서만 선택합니다.');
    if (mode === 'BORROW') { master.identifier(line.custodyLotId); decimal(line.borrowValue,0,'차용 평가금액',9e12); }
    else if (line.custodyLotId || line.borrowValue != null && line.borrowValue !== '') fail('invalid-argument','차용 출고에만 보관품과 평가금액을 입력합니다.');
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 100000) fail('invalid-argument', '입력 자료가 너무 큽니다.');
  return hash(input);
}
function parseManual(input, { basisDate, order, documentNo, companyLabel }) {
  const guide = []; guide[4] = ['', companyLabel]; guide[5] = ['', basisDate];
  const data = []; data[8] = HEADERS.MOVEMENTS;
  const p = input.partner || {};
  input.lines.forEach((line, i) => data.push([input.date, order, input.direction, documentNo, i + 1,
    line.code, line.name, line.specification || '', line.unit, '', '', line.quantity, line.price,
    input.currency, input.exchangeRate, line.taxType, line.taxType === '과세' ? '0.1' : '0', input.priceBasis,
    p.code || '', p.name || '', p.country || '', p.registrationNumber || '', '', '', '', '', line.notes || '']));
  const parsed = parseMatrix([{ sheet: '작성안내', data: guide }, { sheet: SHEETS.MOVEMENTS, data }], 'MOVEMENTS');
  for (const row of parsed.rows) {
    const line = input.lines[row.rowNo-1];
    row.fulfillment = line.fulfillment || 'DIRECT';
    if (row.fulfillment === 'BORROW') { row.custodyLotId=line.custodyLotId; row.borrowValue=decimal(line.borrowValue,0,'차용 평가금액',9e12); }
  }
  return parsed;
}
module.exports = { manualInput, parseManual };
