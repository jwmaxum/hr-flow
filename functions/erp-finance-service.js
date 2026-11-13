const { authorizeContext, fail } = require('./security-context');
const { erpMaster: master } = require('./erp-service');
const M = require('./erp-ledger-model');
const {createPaymentHandler}=require('./erp-payment-service');
const {createDashboardHandler}=require('./erp-dashboard-service');
const {createFinanceExportHandler}=require('./erp-finance-export');
const { createSettlementHandler } = require('./erp-settlement-service');
const {currencies,minor,salesEvents,paymentEvents,summarize,loadFinance}=require('./erp-finance-model');
function createErpFinanceService({ db, now = () => new Date(), renderFinancePdf = report => require('./erp-finance-pdf').renderFinanceReportPdf(report) }) {
  async function context(request, tx) { const user = await authorizeContext({ db, request, reader: tx || db, now, roles: ['ADMIN'] }); if (user.companyId !== request.data.companyId) fail('permission-denied', '로그인한 회사에서 조회해 주세요.'); return user; }
  const load=loadFinance;
  async function plan(tx, parent, job) {
    const data = await load(tx, parent), input = job.input;
    if (data.state.lastDate && input.date < data.state.lastDate) fail('failed-precondition', `마지막 수금 처리일 ${data.state.lastDate} 이후로 등록해 주세요.`);
    if (data.settlementState.lastDate && input.date < data.settlementState.lastDate) fail('failed-precondition', `마지막 문서 배분·기일 처리일 ${data.settlementState.lastDate} 이후로 등록해 주세요.`);
    let normalized = { ...input };
    if (input.type === 'CANCEL') {
      const source = data.paid.find(row => row.id === input.sourceId);
      if (!source || source.type === 'CANCEL' || data.paid.some(row => row.sourceId === source.id)) fail('failed-precondition', '취소 가능한 수금·환불 원거래를 선택해 주세요.');
      if (input.date < source.date) fail('invalid-argument', '취소일은 원거래일 이후여야 합니다.');
      normalized = { ...input, partnerId: source.partnerId, currency: source.currency, amountMinor: source.amountMinor, method: source.method, reference: source.reference };
    }
    const partner = await tx.get(parent.collection('erpPartners').doc(normalized.partnerId));
    if (!partner.exists) fail('not-found', '거래처를 찾을 수 없습니다.'); master.verifyTenant(partner.data(), parent.id);
    if (!partner.data().active && input.type !== 'CANCEL') fail('failed-precondition', '활성 거래처를 선택해 주세요.');
    const balance = summarize(data.events, '2000-01-01', input.date, normalized.partnerId).find(row => row.currency === normalized.currency)?.balance || 0;
    if (input.type === 'RECEIPT' && normalized.amountMinor > balance) fail('failed-precondition', '수금액이 해당 거래일의 미수잔액을 초과합니다.');
    if (input.type === 'REFUND' && normalized.amountMinor > -balance) fail('failed-precondition', '환불액이 선수금·환불예정 잔액을 초과합니다.');
    const entry = { ...normalized, companyId: parent.id, partnerName: partner.data().name, createdAt: job.createdAt, createdBy: job.createdBy };
    const nextEvents = paymentEvents([...data.paid, { ...entry, id: job.id }]);
    const delta = nextEvents.find(row => row.id === job.id).receipt;
    return { entry, before: balance, after: M.signed(balance - delta), state: data.state, fingerprint: M.hash({ input, state: data.state, ledger: data.ledger, events: data.events, partner: partner.data(), entry }) };
  }
  const paymentHandler=createPaymentHandler({db,now,context,load});
  const dashboard=createDashboardHandler({db,now,context,load});
  const exportReport=createFinanceExportHandler({db,now,context,load,dashboard,renderPdf:renderFinancePdf});
  const settlement = createSettlementHandler({db,now,context,load});
  return async request => {
    const input = M.exactObject(request.data, ['action','companyId','from','to','partnerId','offset','snapshot','id','input','fingerprint','month','format']);
    if (!['dashboardExport','statementExport','dashboard','paymentPreview','paymentCommit','report','preview','commit','settlementReport','settlementPreview','settlementCommit'].includes(input.action)) fail('invalid-argument', '수금 요청을 확인해 주세요.');
    if(input.action.endsWith('Export')){const user=await context(request);return exportReport(request,input,db.collection('companies').doc(user.companyId));}
    if(input.action==='dashboard'){const user=await context(request);return dashboard(request,input,db.collection('companies').doc(user.companyId));}
    if(input.action.startsWith('payment')){const user=await context(request);return paymentHandler(request,input,user,db.collection('companies').doc(user.companyId));}
    if (input.action.startsWith('settlement')) {const user=await context(request);return settlement(request,input,user,db.collection('companies').doc(user.companyId));}
    M.exactObject(input,['action','companyId',...({report:['from','to','partnerId','offset','snapshot'],preview:['id','input'],commit:['id','fingerprint']})[input.action]]);
    const user = await context(request), parent = db.collection('companies').doc(user.companyId);
    if (input.action === 'report') {
      const from = M.date(input.from), to = M.date(input.to), partnerId = input.partnerId ? master.identifier(input.partnerId) : '', offset = input.offset || 0;
      if (from > to || !Number.isSafeInteger(offset) || offset < 0 || offset > 40000) fail('invalid-argument', '조회 기간·위치를 확인해 주세요.');
      return db.runTransaction(async tx => {
        await context(request, tx); const data = await load(tx,parent), rows = summarize(data.events,from,to,partnerId);
        const snapshot=M.hash({from,to,partnerId,state:data.state,ledger:data.ledger,events:data.events});
        if(offset && input.snapshot!==snapshot)fail('failed-precondition','매출·수금 원장이 바뀌었습니다. 미수금을 다시 조회해 주세요.');
        const events = data.events.filter(row => row.date >= from && row.date <= to && (!partnerId || row.partnerId === partnerId)).sort((a,b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
        return { companyId: parent.id, snapshot, rows, events: events.slice(offset,offset+100), nextOffset: events.length > offset+100 ? offset+100 : null, lastDate: data.state.lastDate || null };
      });
    }
    const id = master.identifier(input.id), ref = parent.collection('erpReceiptJobs').doc(id);
    let normalized;
    if (input.action === 'preview') {
      const v = M.exactObject(input.input, ['type','date','partnerId','currency','amount','method','reference','notes','sourceId']);
      if (!['RECEIPT','REFUND','CANCEL'].includes(v.type)) fail('invalid-argument', '수금·환불·취소를 선택해 주세요.');
      normalized = { type: v.type, date: M.date(v.date), notes: M.text(v.notes, '처리 사유', 500, true) };
      if (v.type === 'CANCEL') normalized.sourceId = master.identifier(v.sourceId);
      else {
        if (!currencies.includes(v.currency) || !['BANK','CASH','CARD','OTHER'].includes(v.method)) fail('invalid-argument', '통화·수금 방법을 선택해 주세요.');
        Object.assign(normalized, { partnerId: master.identifier(v.partnerId), currency: v.currency, amountMinor: minor(v.amount,v.currency), method: v.method, reference: M.text(v.reference,'거래 참조번호',100) });
        if (!normalized.amountMinor) fail('invalid-argument', '금액은 0보다 커야 합니다.');
      }
    }
    return db.runTransaction(async tx => {
      await context(request,tx); const snap = await tx.get(ref), old = snap.data(); if (old) master.verifyTenant(old,parent.id);
      if (input.action === 'preview') {
        if (old) { if (M.hash(old.input) !== M.hash(normalized)) fail('already-exists','내용이 변경되었습니다. 새로 검증해 주세요.'); return { job: old }; }
        const job = { id, companyId: parent.id, input: normalized, status:'PENDING', createdAt:now().toISOString(), createdBy:user.uid };
        const result = await plan(tx,parent,job), saved = { ...job, entry:result.entry, before:result.before, after:result.after, fingerprint:result.fingerprint };
        tx.create(ref,saved); return { job:saved };
      }
      if (!old || input.fingerprint !== old.fingerprint) fail('failed-precondition','확인한 미리보기로 다시 시도해 주세요.');
      if (old.status === 'COMMITTED') return { job:old, idempotent:true };
      const fresh = await plan(tx,parent,old);
      if (fresh.fingerprint !== old.fingerprint) fail('failed-precondition','매출·수금 또는 거래처가 변경되었습니다. 새 미리보기를 확인해 주세요.');
      const at = now().toISOString();
      tx.create(parent.collection('erpReceipts').doc(id),{ ...fresh.entry, committedAt:at });
      tx.set(parent.collection('erpState').doc('receivables'),{ companyId:parent.id, revision:(fresh.state.revision || 0)+1,lastDate:old.input.date,updatedAt:at });
      tx.create(parent.collection('erpAudit').doc(),{ companyId:parent.id,actorId:user.uid,action:`RECEIVABLE_${old.input.type}`,receiptId:id,at });
      tx.update(ref,{ status:'COMMITTED',committedAt:at }); return { job:{ ...old,status:'COMMITTED',committedAt:at },idempotent:false };
    });
  };
}
module.exports = { createErpFinanceService: require('./erp-governance').governedService(createErpFinanceService, 'finance'), salesEvents, paymentEvents, summarize };
