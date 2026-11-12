const {fail}=require('./security-context');
const {erpMaster:master}=require('./erp-service');
const M=require('./erp-ledger-model');
const {minor}=require('./erp-finance-model');
const {settlementReport}=require('./erp-settlement-model');
const {buildReport,projectSummary}=require('./erp-report-service');
function purchaseEvents(rows){
  const byId=new Map(rows.map(r=>[r.id,r])),cache=new Map();
  function value(row,seen=new Set()){
    if(cache.has(row.id))return cache.get(row.id);
    if(seen.has(row.id)||seen.size>5)fail('failed-precondition','매입 역거래 연결을 확인해 주세요.');seen.add(row.id);let result=null;
    if(row.type==='MOVEMENTS'&&row.direction==='입고')result={partnerId:row.partnerId,partnerName:row.partnerName||'',currency:row.currency,supply:minor(row.supply,row.currency),tax:minor(row.tax,row.currency),amountKRW:row.value};
    if(row.type==='CORRECTION'&&row.sourceId&&['CANCEL','PURCHASE_RETURN'].includes(row.operationType)){
      const source=byId.get(row.sourceId);if(!source)fail('failed-precondition','매입 원거래를 찾을 수 없습니다.');const original=value(source,seen);
      if(original)result={...original,supply:row.operationType==='CANCEL'?-original.supply:-minor(row.refundSupply,row.currency),tax:row.operationType==='CANCEL'?-original.tax:-minor(row.refundTax,row.currency),amountKRW:row.operationType==='CANCEL'?-original.amountKRW:-row.refundKRW};
    }
    cache.set(row.id,result);return result;
  }
  return rows.flatMap(row=>{const v=value(row);return v?[{...v,id:row.id,date:row.date,documentNo:row.documentNo,kind:row.operationType||'PURCHASE',gross:M.signed(v.supply+v.tax)}]:[];});
}
function monthEnd(month){return new Date(Date.UTC(+month.slice(0,4),+month.slice(5,7),0)).toISOString().slice(0,10);}
function monthSnapshot(data,purchases,month,today){
  const from=month+'-01',to=[monthEnd(month),today].sort()[0],movements=data.movements.filter(r=>r.date<=to);
  const stock=buildReport(movements,{from,to,itemId:'',warehouseId:'',search:''}),settlement=settlementReport(data,to),currencies=new Map();
  function group(currency){if(!currencies.has(currency))currencies.set(currency,{currency,sales:0,salesGross:0,purchases:0,purchasesGross:0,creditSalesGross:0,unconfirmedSalesGross:0,receipts:0,outstanding:0,refundDue:0,documentOutstanding:0,unallocated:0});return currencies.get(currency);}
  const inMonth=r=>r.date>=from&&r.date<=to,sales=data.events.filter(r=>r.documentId&&inMonth(r)),bought=purchases.filter(inMonth);
  for(const r of data.events.filter(inMonth)){const g=group(r.currency);g.sales=M.signed(g.sales+r.supply);g.salesGross=M.signed(g.salesGross+r.gross);g.receipts=M.signed(g.receipts+r.receipt);if(r.documentId&&r.paymentTerms==='CREDIT')g.creditSalesGross=M.signed(g.creditSalesGross+r.gross);if(r.documentId&&(!r.paymentTerms||r.paymentTerms==='UNCONFIRMED'))g.unconfirmedSalesGross=M.signed(g.unconfirmedSalesGross+r.gross);}
  for(const r of bought){const g=group(r.currency);g.purchases=M.signed(g.purchases+r.supply);g.purchasesGross=M.signed(g.purchasesGross+r.gross);}
  for(const r of settlement.summaries){const g=group(r.currency);g.outstanding=M.signed(g.outstanding+Math.max(0,r.balance));g.refundDue=M.signed(g.refundDue+Math.max(0,-r.balance));g.unallocated=M.signed(g.unallocated+r.unallocated);}
  for(const d of settlement.documents){const g=group(d.currency);g.documentOutstanding=M.signed(g.documentOutstanding+Math.max(0,d.balance));}
  return {month,from,to,stock,settlement,currencies:[...currencies.values()].sort((a,b)=>a.currency.localeCompare(b.currency)),sales,bought,inventoryValue:stock.totals.closingValue,salesKRW:stock.totals.salesKRW,purchasesKRW:bought.reduce((sum,r)=>M.signed(sum+r.amountKRW),0),marginKRW:stock.totals.marginKRW};
}
function createDashboardHandler({db,now,context,load}){
  return async(request,input,parent)=>{
    M.exactObject(input,['action','companyId','month']);
    if(typeof input.month!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(input.month))fail('invalid-argument','조회할 월을 선택해 주세요.');
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(now());if(input.month>today.slice(0,7))fail('invalid-argument','아직 시작하지 않은 월은 조회할 수 없습니다.');
    return db.runTransaction(async tx=>{
      await context(request,tx);const data=await load(tx,parent);
      const waiting=await tx.get(parent.collection('erpItems').where('pendingOpening.status','in',['PENDING_COST','CONFIRMED']).limit(501));if(waiting.size>500)fail('resource-exhausted','이관 관리 품목이 500개를 초과했습니다.');
      const pending=waiting.docs.map(doc=>{master.verifyTenant(doc.data(),parent.id);return doc.data().pendingOpening;});
      const purchases=purchaseEvents(data.movements),selected=monthSnapshot(data,purchases,input.month,today),trend=[];
      for(let i=5;i>=0;i--){const month=new Date(Date.UTC(+input.month.slice(0,4),+input.month.slice(5,7)-1-i,1)).toISOString().slice(0,7);if(month<'2000-01')continue;const row=i===0?selected:monthSnapshot(data,purchases,month,today);trend.push({month,inventoryValue:row.inventoryValue,salesKRW:row.salesKRW,purchasesKRW:row.purchasesKRW,outstandingKRW:row.currencies.find(c=>c.currency==='KRW')?.outstanding||0});}
      const assets=selected.stock.summary.filter(r=>r.closingQuantity||r.closingValue).sort((a,b)=>b.closingValue-a.closingValue||a.code.localeCompare(b.code));
      const byId=new Map(data.movements.map(row=>[row.id,row]));
      const sales=selected.sales.map(r=>({...r,amountKRW:M.effectOf(byId.get(r.id)).salesKRW})).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
      const bought=selected.bought.sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
      const partners=selected.settlement.summaries.filter(r=>r.balance>0||r.documentBalance>0).sort((a,b)=>a.currency.localeCompare(b.currency)||b.balance-a.balance);
      const result={companyId:parent.id,month:input.month,from:selected.from,asOf:selected.to,partialMonth:selected.to<monthEnd(input.month),basisDate:data.ledger.basisDate||null,inventoryValue:selected.inventoryValue,salesKRW:selected.salesKRW,purchasesKRW:selected.purchasesKRW,marginKRW:selected.marginKRW,currencies:selected.currencies,trend,assets:assets.slice(0,100).map(r=>projectSummary(r,true)),assetCount:assets.length,sales:sales.slice(0,100),saleCount:sales.length,purchases:bought.slice(0,100),purchaseCount:bought.length,partners:partners.slice(0,100),partnerCount:partners.length,pendingCount:pending.filter(p=>p.basisDate<=selected.to&&(p.status==='PENDING_COST'||p.postingDate>selected.to)).length};
      if(Buffer.byteLength(JSON.stringify(result))>5e6)fail('resource-exhausted','대시보드 조회 결과가 너무 큽니다.');return result;
    });
  };
}
module.exports={createDashboardHandler,purchaseEvents,monthSnapshot};
