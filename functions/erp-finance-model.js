const { fail } = require('./security-context');
const { erpMaster: master } = require('./erp-service');
const M = require('./erp-ledger-model');
const currencies = ['KRW','USD','EUR','JPY','CNY'];
const digits = currency => ['KRW','JPY'].includes(currency) ? 0 : 2;
const minor = (value, currency) => M.decimal(value, digits(currency), '거래 금액', 9e12);
function salesEvents(rows) {
  const byId = new Map(rows.map(row => [row.id, row])), cache = new Map();
  function amount(row, seen = new Set()) {
    if (cache.has(row.id)) return cache.get(row.id);
    if (seen.has(row.id) || seen.size > 5) fail('failed-precondition', '매출 역거래 연결을 확인해 주세요.');
    seen.add(row.id); let result = null;
    if (row.type === 'MOVEMENTS' && row.direction === '출고' && !row.bundleParentId) result = { partnerId: row.partnerId, partnerName: row.partnerName || '', currency: row.currency,
      supply: minor(row.supply, row.currency), tax: minor(row.tax, row.currency), documentNo: row.documentNo, documentId: M.hash(master.normalize(row.documentNo)), saleDate: row.date, paymentTerms: row.paymentTerms || 'UNCONFIRMED' };
    if (row.type === 'CORRECTION' && row.sourceId && ['CANCEL','SALES_RETURN'].includes(row.operationType)) {
      const source = byId.get(row.sourceId); if (!source) fail('failed-precondition', '매출 원거래를 찾을 수 없습니다.');
      const original = amount(source, seen);
      if (original) result = { ...original, supply: row.operationType === 'CANCEL' ? -original.supply : -minor(row.refundSupply, row.currency), tax: row.operationType === 'CANCEL' ? -original.tax : -minor(row.refundTax, row.currency) };
    }
    cache.set(row.id, result); return result;
  }
  return rows.flatMap(row => { const financial = amount(row); return financial ? [{ ...financial, id: row.id, date: row.date, kind: row.operationType || 'SALE', gross: M.signed(financial.supply + financial.tax), receipt: 0 }] : []; });
}
function paymentEvents(rows) {
  const byId = new Map(rows.map(row => [row.id,row]));
  return rows.map(row => {
    let sign = row.type === 'RECEIPT' ? 1 : -1;
    if (row.type === 'CANCEL') {
      const source = byId.get(row.sourceId);
      if (!source || source.type === 'CANCEL' || source.partnerId !== row.partnerId || source.currency !== row.currency || source.amountMinor !== row.amountMinor) fail('failed-precondition', '수금 취소 연결을 확인해 주세요.');
      sign = source.type === 'RECEIPT' ? -1 : 1;
    }
    return { id: row.id, partnerId: row.partnerId, partnerName: row.partnerName, currency: row.currency, date: row.date, kind: row.type,
      documentNo: row.reference || '', supply: 0, tax: 0, gross: 0, receipt: M.signed(row.amountMinor * sign), method: row.method, notes: row.notes };
  });
}
function summarize(events, from, to, partnerId = '') {
  const groups = new Map();
  for (const event of events.filter(row => row.date <= to && (!partnerId || row.partnerId === partnerId))) {
    const key = `${event.partnerId}:${event.currency}`;
    if (!groups.has(key)) groups.set(key, { partnerId: event.partnerId, partnerName: event.partnerName, currency: event.currency, opening: 0, sales: 0, tax: 0, billed: 0, receipts: 0, balance: 0 });
    const group = groups.get(key);
    if (event.date < from) group.opening = M.signed(group.opening + event.gross - event.receipt);
    else { group.sales = M.signed(group.sales + event.supply); group.tax = M.signed(group.tax + event.tax); group.billed = M.signed(group.billed + event.gross); group.receipts = M.signed(group.receipts + event.receipt); }
    group.balance = M.signed(group.balance + event.gross - event.receipt);
  }
  return [...groups.values()].sort((a,b) => a.partnerName.localeCompare(b.partnerName) || a.currency.localeCompare(b.currency));
}
async function loadFinance(tx, parent) {
    const [sales, payments, state, ledger, settlements, settlementState] = await Promise.all([tx.get(parent.collection('erpMovements').limit(20001)), tx.get(parent.collection('erpReceipts').limit(20001)), tx.get(parent.collection('erpState').doc('receivables')), tx.get(parent.collection('erpState').doc('ledger')),tx.get(parent.collection('erpSettlements').limit(20001)),tx.get(parent.collection('erpState').doc('settlements'))]);
    if (sales.size > 20000 || payments.size > 20000 || settlements.size > 20000) fail('resource-exhausted', '원장 20,000행을 초과했습니다. 자료 분할 집계를 요청해 주세요.');
    for (const snap of [...sales.docs,...payments.docs,...settlements.docs,state,ledger,settlementState]) if (snap.exists) master.verifyTenant(snap.data(), parent.id);
    const movements = sales.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    const paid = payments.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    return { movements, events: [...salesEvents(movements), ...paymentEvents(paid)], paid, settlements:settlements.docs.map(doc=>({...doc.data(),id:doc.id})), settlementState:settlementState.data() || {}, state: state.data() || {}, ledger: ledger.data() || {} };
  }

module.exports={currencies,digits,minor,salesEvents,paymentEvents,summarize,loadFinance};
