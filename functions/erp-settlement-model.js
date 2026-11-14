const M = require('./erp-ledger-model');
const { fail } = require('./security-context');

// Amounts remain integer minor units. PDF copies and bank references are never document identities.
function settlementReport(data, to, partnerId = '') {
  const documents = new Map(), receipts = new Map();
  const included = row => row.date <= to && (!partnerId || row.partnerId === partnerId);
  for (const event of data.events.filter(row => row.documentId && included(row))) {
    if (!documents.has(event.documentId)) documents.set(event.documentId, {
      id: event.documentId, documentNo: event.documentNo, date: event.saleDate,
      partnerId: event.partnerId, partnerName: event.partnerName, currency: event.currency,
      paymentTerms:event.paymentTerms||'UNCONFIRMED', billed: 0, allocated: 0, dueDate: '', termsDate: '', expectedDate:'', assigneeId:'', assigneeName:'', followUpDate:'', followUpNotes:'',
    });
    const doc = documents.get(event.documentId);
    if (doc.partnerId !== event.partnerId || doc.currency !== event.currency || doc.date !== event.saleDate) fail('failed-precondition', '출고 문서 연결을 확인해 주세요.');
    doc.billed = M.signed(doc.billed + event.gross);
  }
  const cancelled = new Set(data.paid.filter(row => row.type === 'CANCEL' && row.date <= to).map(row => row.sourceId));
  for (const row of data.paid.filter(row => row.type === 'RECEIPT' && included(row))) receipts.set(row.id, {
    id: row.id, date: row.date, receivedDate: row.receivedDate || row.date, reference: row.reference || '', partnerId: row.partnerId,
    partnerName: row.partnerName, currency: row.currency, amount: row.amountMinor,
    allocated: 0, available: 0, cancelled: cancelled.has(row.id),
  });
  const entries = data.settlements.filter(included).sort((a,b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  const releases = new Map(entries.filter(row => row.type === 'RELEASE').map(row => [row.sourceId,row]));
  const allocations = [];
  for (const row of entries) {
    if (row.type === 'TERMS') {
      const doc = documents.get(row.documentId);
      if (!doc) fail('failed-precondition', '지급기일의 출고 문서를 확인해 주세요.');
      doc.dueDate = row.dueDate; doc.termsDate = row.date;
    }
    if (row.type === 'FOLLOW_UP') {
      const doc=documents.get(row.documentId);
      if(!doc)fail('failed-precondition','회수 관리의 출고 문서를 확인해 주세요.');
      Object.assign(doc,{expectedDate:row.expectedDate,assigneeId:row.assigneeId,assigneeName:row.assigneeName,followUpDate:row.date,followUpNotes:row.notes});
    }
    if (row.type !== 'ALLOCATE') continue;
    const receipt = receipts.get(row.receiptId);
    if (!receipt) fail('failed-precondition', '배분한 원수금을 확인해 주세요.');
    const active = !releases.has(row.id) && !receipt.cancelled;
    for (const line of row.lines) {
      const doc = documents.get(line.documentId);
      if (!doc || doc.partnerId !== receipt.partnerId || doc.currency !== receipt.currency) fail('failed-precondition', '수금 배분의 문서 연결을 확인해 주세요.');
      if (active) { doc.allocated = M.signed(doc.allocated + line.amountMinor); receipt.allocated = M.signed(receipt.allocated + line.amountMinor); }
    }
    const release = releases.get(row.id);
    allocations.push({ ...row, active, released: releases.has(row.id), releaseDate:release?.date || '', releaseNotes:release?.notes || '', receiptCancelled: receipt.cancelled });
  }
  for (const receipt of receipts.values()) receipt.available = receipt.cancelled ? 0 : M.signed(receipt.amount - receipt.allocated);
  for (const doc of documents.values()) {
    doc.balance = M.signed(doc.billed - doc.allocated);
    doc.overdueDays = doc.balance > 0 && doc.dueDate ? Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${doc.dueDate}T00:00:00Z`)) / 86400000)) : 0;
    doc.overdueAmount = doc.overdueDays ? doc.balance : 0;
    doc.credit = Math.max(0, -doc.balance);
    doc.paymentStatus=doc.balance<0?'REFUND_DUE':doc.balance===0?(doc.billed===0?'NO_BALANCE':'PAID'):doc.allocated>0?'PARTIAL':doc.paymentTerms==='CREDIT'?'CREDIT':'UNCONFIRMED';
    doc.promiseOverdueDays=doc.balance>0&&doc.expectedDate?Math.max(0,Math.round((Date.parse(`${to}T00:00:00Z`)-Date.parse(`${doc.expectedDate}T00:00:00Z`))/86400000)):0;
  }
  const groups = new Map();
  for (const event of data.events.filter(included)) {
    const key = `${event.partnerId}:${event.currency}`;
    if (!groups.has(key)) groups.set(key, {partnerId:event.partnerId,partnerName:event.partnerName,currency:event.currency,netReceipts:0,allocated:0,documentBalance:0,overdueAmount:0,credit:0,undated:0});
    const group = groups.get(key); group.netReceipts = M.signed(group.netReceipts + event.receipt);
  }
  for (const doc of documents.values()) {
    const group = groups.get(`${doc.partnerId}:${doc.currency}`);
    for (const key of ['allocated','overdueAmount','credit']) group[key] = M.signed(group[key] + doc[key]);
    group.documentBalance = M.signed(group.documentBalance + doc.balance);
    if (!doc.dueDate && doc.balance > 0) group.undated = M.signed(group.undated + doc.balance);
  }
  for (const receipt of receipts.values()) {
    const group = groups.get(`${receipt.partnerId}:${receipt.currency}`);
    receipt.allocatable = Math.min(receipt.available,Math.max(0,group.netReceipts-group.allocated));
  }
  const summaries=[...groups.values()].map(row=>({...row,unallocated:M.signed(row.netReceipts-row.allocated),balance:M.signed(row.documentBalance-row.netReceipts+row.allocated)}));
  const totals=new Map();for(const row of summaries){if(!totals.has(row.currency))totals.set(row.currency,{currency:row.currency,balance:0,refundDue:0});const total=totals.get(row.currency);total.balance=M.signed(total.balance+Math.max(0,row.balance));total.refundDue=M.signed(total.refundDue+Math.max(0,-row.balance));}
  return {
    totals:[...totals.values()],asOf: to, documents:[...documents.values()].sort((a,b) => b.date.localeCompare(a.date) || a.documentNo.localeCompare(b.documentNo)),
    receipts:[...receipts.values()].sort((a,b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)),
    allocations:allocations.reverse(), terms:entries.filter(row => row.type === 'TERMS').reverse(), followUps:entries.filter(row=>row.type==='FOLLOW_UP').reverse(),
    summaries,
  };
}
const financeSnapshot=(data,companyId,to)=>M.hash({companyId,to,data});
module.exports = { settlementReport, financeSnapshot };
