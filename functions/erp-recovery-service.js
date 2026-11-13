const {fail}=require('./security-context');
const {erpMaster:master}=require('./erp-service');
const M=require('./erp-ledger-model');
const {minor}=require('./erp-finance-model');
const {settlementReport}=require('./erp-settlement-model');

// Refunds use a document entitlement and the partner's net available funds.
// RELEASE entries remain append-only; replacement allocations preserve other invoices.
function recoveryBalances(data,report,to){
  const cancelled=new Set(data.paid.filter(r=>r.type==='CANCEL'&&r.date<=to).map(r=>r.sourceId));
  const totals=new Map(),get=id=>{if(!totals.has(id))totals.set(id,{released:0,refunded:0,original:0});return totals.get(id);};
  for(const row of data.settlements)if(row.type==='RELEASE'&&row.recoveryDocumentId&&row.date<=to&&!cancelled.has(row.receiptId)){const v=get(row.recoveryDocumentId);v.released=M.signed(v.released+row.releasedAmountMinor);}
  for(const row of data.paid)if(row.type==='REFUND'&&row.recoveryDocumentId&&row.date<=to&&!cancelled.has(row.id)){const v=get(row.recoveryDocumentId);v.refunded=M.signed(v.refunded+row.amountMinor);}
  for(const row of data.events)if(row.documentId&&row.kind==='SALE'&&row.date<=to){const v=get(row.documentId);v.original=M.signed(v.original+row.gross);}
  const groups=new Map(report.summaries.map(r=>[`${r.partnerId}:${r.currency}`,r])),result=new Map();
  for(const doc of report.documents){
    const {released=0,refunded=0,original=0}=totals.get(doc.id)||{},group=groups.get(`${doc.partnerId}:${doc.currency}`);
    const returnedGross=Math.max(0,original-doc.billed),credit=Math.max(0,Math.min(released,returnedGross)-refunded),unallocated=group?.unallocated||0,partnerBalance=group?.balance||0;
    result.set(doc.id,{excess:Math.max(0,-doc.balance),returnedGross,released,refunded,credit,unallocated,partnerBalance,refundable:Math.max(0,Math.min(credit,unallocated,-partnerBalance))});
  }
  return result;
}
function recoveryState(data,doc,to,report=settlementReport(data,to)) {
  const cancelled=new Set(data.paid.filter(r=>r.type==='CANCEL'&&r.date<=to).map(r=>r.sourceId));
  const releases=data.settlements.filter(r=>r.type==='RELEASE'&&r.recoveryDocumentId===doc.id&&r.date<=to);
  const refunds=data.paid.filter(r=>r.type==='REFUND'&&r.recoveryDocumentId===doc.id&&r.date<=to);
  const history=[...releases.map(r=>({id:r.id,type:'RELEASE',date:r.date,amountMinor:r.releasedAmountMinor,notes:r.notes,reference:'',method:''})),
    ...refunds.map(r=>({id:r.id,type:cancelled.has(r.id)?'REFUND_CANCELLED':'REFUND',date:r.date,amountMinor:r.amountMinor,notes:r.notes,reference:r.reference||'',method:r.method}))]
    .sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
  return {...recoveryBalances(data,report,to).get(doc.id),history:history.slice(0,100),historyCount:history.length};
}

function createRecoveryHandler({db,now,context,load}) {
  async function plan(tx,parent,job) {
    const data=await load(tx,parent),input=job.input;
    const latest=[data.state.lastDate,data.ledger.lastDate,data.settlementState.lastDate].filter(Boolean).sort().at(-1);
    if(latest&&input.date<latest)fail('failed-precondition',`마지막 재고·수금·배분일 ${latest} 이후로 처리해 주세요.`);
    const report=settlementReport(data,input.date),doc=report.documents.find(d=>d.id===input.documentId);
    if(!doc)fail('not-found','현재 회사의 확정 출고 문서를 찾을 수 없습니다.');
    const partner=await tx.get(parent.collection('erpPartners').doc(doc.partnerId));
    if(!partner.exists)fail('not-found','출고 거래처를 찾을 수 없습니다.');master.verifyTenant(partner.data(),parent.id);
    const state=recoveryState(data,doc,input.date,report),amountMinor=minor(input.amount,doc.currency);
    if(!amountMinor)fail('invalid-argument','처리 금액은 0보다 커야 합니다.');
    const limit=input.type==='RELEASE'?state.excess:state.refundable;
    if(amountMinor>limit)fail('failed-precondition',input.type==='RELEASE'?'선택 문서의 초과 배분액을 초과했습니다.':'환불액이 이 문서의 해제 잔액 또는 거래처의 환불 가능 순수금을 초과합니다. 배분을 먼저 정리해 주세요.');
    const shared={companyId:parent.id,partnerId:doc.partnerId,partnerName:doc.partnerName,currency:doc.currency,date:input.date,notes:input.notes,
      createdAt:job.createdAt,createdBy:job.createdBy,sourceKind:'RETURN_RECOVERY',recoveryId:job.id,recoveryDocumentId:doc.id};
    const entries=[],preserved=[];let sequence=data.settlementState.revision||0;
    if(input.type==='RELEASE'){
      let remaining=amountMinor;
      for(const source of report.allocations.filter(a=>a.active&&a.lines.some(l=>l.documentId===doc.id)).sort((a,b)=>b.sequence-a.sequence||a.id.localeCompare(b.id))){
        if(!remaining)break;
        if(preserved.length>=40)fail('resource-exhausted','한 번에 40건까지 배분을 정리할 수 있습니다. 금액을 나누어 처리해 주세요.');
        const target=source.lines.find(l=>l.documentId===doc.id),releasedAmountMinor=Math.min(remaining,target.amountMinor);
        const lines=source.lines.map(l=>({...l,amountMinor:l.documentId===doc.id?l.amountMinor-releasedAmountMinor:l.amountMinor})).filter(l=>l.amountMinor>0);
        const id=M.hash(['return-release',job.id,source.id]),replacementId=lines.length?M.hash(['return-reallocate',job.id,source.id]):'';
        entries.push({...shared,id,type:'RELEASE',sequence:++sequence,sourceId:source.id,receiptId:source.receiptId,releasedAmountMinor,replacementAllocationId:replacementId});
        if(lines.length)entries.push({...shared,id:replacementId,type:'ALLOCATE',sequence:++sequence,receiptId:source.receiptId,lines,replacesAllocationId:source.id});
        preserved.push({sourceId:source.id,releasedAmountMinor,remainingLines:lines});remaining-=releasedAmountMinor;
      }
      if(remaining)fail('failed-precondition','원수금 배분 연결을 다시 확인해 주세요.');
    }
    const refund=input.type==='REFUND'?{...shared,type:'REFUND',amountMinor,method:input.method,reference:input.reference}:null;
    const summary={type:input.type,documentId:doc.id,documentNo:doc.documentNo,partnerName:doc.partnerName,currency:doc.currency,date:input.date,amountMinor,
      documentBefore:doc.balance,documentAfter:doc.balance+(refund?0:amountMinor),partnerBefore:state.partnerBalance,partnerAfter:state.partnerBalance+(refund?amountMinor:0),
      unallocatedBefore:state.unallocated,unallocatedAfter:state.unallocated+(refund?-amountMinor:amountMinor),preserved};
    return {entries,refund,summary,sequence,state:data.state,settlementState:data.settlementState,fingerprint:M.hash({data,input,summary,partner:partner.data()})};
  }
  return async(request,input,user,parent)=>{
    const preview=input.action==='shipmentRecoveryPreview';
    M.exactObject(input,['action','companyId','id',...(preview?['input']:['fingerprint'])]);
    const id=master.identifier(input.id),ref=parent.collection('erpSettlementJobs').doc(id);let normalized;
    if(preview){
      const v=input.input;
      if(!v||!['RELEASE','REFUND'].includes(v.type))fail('invalid-argument','배분 해제 또는 실제 환불을 선택해 주세요.');
      M.exactObject(v,['type','documentId','date','amount','notes',...(v.type==='REFUND'?['method','reference','confirmPaid']:[])]);
      normalized={type:v.type,documentId:master.identifier(v.documentId),date:M.date(v.date),amount:M.text(v.amount,'처리 금액',40,true),notes:M.text(v.notes,'처리 사유',500,true)};
      if(v.type==='REFUND'){
        if(v.confirmPaid!==true||!['BANK','CASH','CARD','OTHER'].includes(v.method))fail('invalid-argument','실제 환불 지급 여부와 방법을 확인해 주세요.');
        Object.assign(normalized,{method:v.method,reference:M.text(v.reference,'환불 참조번호',100),confirmPaid:true});
      }
    }
    return db.runTransaction(async tx=>{
      await context(request,tx);const snap=await tx.get(ref),old=snap.data();
      if(old){master.verifyTenant(old,parent.id);if(old.kind!=='SHIPMENT_RECOVERY')fail('already-exists','다른 업무에 사용한 요청 번호입니다.');}
      if(preview){
        if(old){if(M.hash(old.input)!==M.hash(normalized))fail('already-exists','내용이 변경되었습니다. 새로 확인해 주세요.');return {job:old};}
        const job={id,kind:'SHIPMENT_RECOVERY',companyId:parent.id,input:normalized,status:'PENDING',createdAt:now().toISOString(),createdBy:user.uid};
        const planned=await plan(tx,parent,job),saved={...job,summary:planned.summary,fingerprint:planned.fingerprint};tx.create(ref,saved);return {job:saved};
      }
      if(!old||input.fingerprint!==old.fingerprint)fail('failed-precondition','확인한 미리보기로 다시 시도해 주세요.');
      if(old.status==='COMMITTED')return {job:old,idempotent:true};
      const fresh=await plan(tx,parent,old);
      if(fresh.fingerprint!==old.fingerprint)fail('failed-precondition','반품·수금·배분 내역이 변경되었습니다. 새 미리보기를 확인해 주세요.');
      const at=now().toISOString();
      for(const {id:entryId,...record}of fresh.entries)tx.create(parent.collection('erpSettlements').doc(entryId),{...record,committedAt:at});
      if(fresh.entries.length)tx.set(parent.collection('erpState').doc('settlements'),{...fresh.settlementState,companyId:parent.id,revision:fresh.sequence,lastDate:old.input.date,updatedAt:at});
      if(fresh.refund){tx.create(parent.collection('erpReceipts').doc(id),{...fresh.refund,committedAt:at});tx.set(parent.collection('erpState').doc('receivables'),{...fresh.state,companyId:parent.id,revision:(fresh.state.revision||0)+1,lastDate:old.input.date,updatedAt:at});}
      tx.create(parent.collection('erpAudit').doc(),{companyId:parent.id,actorId:user.uid,action:`SHIPMENT_RECOVERY_${old.input.type}`,documentId:old.input.documentId,jobId:id,amountMinor:fresh.summary.amountMinor,at});
      tx.update(ref,{status:'COMMITTED',committedAt:at});return {job:{...old,status:'COMMITTED',committedAt:at},idempotent:false};
    });
  };
}
module.exports={createRecoveryHandler,recoveryState,recoveryBalances};
