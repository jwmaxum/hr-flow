const {fail}=require('./security-context');
const {erpMaster:master}=require('./erp-service');
const M=require('./erp-ledger-model');
const {settlementReport}=require('./erp-settlement-model');
function paymentOptions(value){
  M.exactObject(value,['receiptMode','confirmNew','notes']);
  if(!['REUSE_FIRST','NEW'].includes(value.receiptMode)||typeof value.confirmNew!=='boolean')fail('invalid-argument','기등록 수금 반영 방식을 확인해 주세요.');
  if(value.receiptMode==='NEW'&&!value.confirmNew)fail('invalid-argument','기존 수금과 별개인 새 입금임을 확인해 주세요.');
  return {receiptMode:value.receiptMode,confirmNew:value.confirmNew,notes:M.text(value.notes,'입금 확인 메모',500,true)};
}
// All amounts are minor units. Both shipment-time and later confirmations share this plan.
function planPayment(data,input,identity,{allowZero=false}={}){
  const latest=[data.state.lastDate,data.ledger.lastDate,data.settlementState.lastDate].filter(Boolean).sort().at(-1);
  if(latest&&input.date<latest)fail('failed-precondition',`마지막 재고·수금·배분일 ${latest} 이후로 입금완료를 반영해 주세요.`);
  const report=settlementReport(data,input.date),doc=report.documents.find(d=>d.id===input.documentId);
  if(!doc)fail('failed-precondition','해당 날짜의 확정 출고 문서를 찾을 수 없습니다.');
  if(doc.balance<0||!doc.balance&&!allowZero)fail('failed-precondition','이미 입금완료이거나 환불·초과수금 확인이 필요한 문서입니다.');
  const group=report.summaries.find(r=>r.partnerId===doc.partnerId&&r.currency===doc.currency);
  let remaining=doc.balance,available=Math.max(0,group.unallocated),sequence=data.settlementState.revision||0;const allocations=[],receipts=[];
  const shared={companyId:identity.companyId,partnerId:doc.partnerId,partnerName:doc.partnerName,currency:doc.currency,date:input.date,notes:input.notes,createdAt:identity.createdAt,createdBy:identity.createdBy,sourceKind:'MANUAL_PAYMENT_CONFIRM',confirmationId:identity.id};
  function allocate(receiptId,amountMinor,reference){
    if(allocations.length>=50)fail('resource-exhausted','배분할 기존 수금이 50건을 초과합니다. 기존 수금을 먼저 배분해 주세요.');
    const id=M.hash(['paid-allocation',identity.kind,identity.id,receiptId]);
    allocations.push({...shared,id,type:'ALLOCATE',sequence:++sequence,receiptId,receiptReference:reference,lines:[{documentId:doc.id,documentNo:doc.documentNo,amountMinor}]});remaining=M.signed(remaining-amountMinor);
  }
  if(input.receiptMode==='REUSE_FIRST')for(const r of report.receipts.filter(r=>r.partnerId===doc.partnerId&&r.currency===doc.currency&&!r.cancelled&&r.available>0).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id))){
    const value=Math.min(remaining,available,r.available);if(value){allocate(r.id,value,r.reference||r.id);available-=value;}if(!remaining)break;
  }
  const newAmount=remaining;
  if(newAmount>Math.max(0,group.balance))fail('failed-precondition','다른 문서의 초과수금·미배분 수금이 있습니다. 기등록 수금을 우선 반영하거나 배분을 정리한 뒤 확인해 주세요.');
  if(newAmount){const id=M.hash(['paid-receipt',identity.kind,identity.id]);receipts.push({...shared,id,type:'RECEIPT',amountMinor:newAmount,method:'OTHER',reference:doc.documentNo,sourceDocumentId:doc.id});allocate(id,newAmount,doc.documentNo);}
  const summary={documentId:doc.id,documentNo:doc.documentNo,partnerName:doc.partnerName,currency:doc.currency,date:input.date,billed:doc.billed,before:doc.balance,after:remaining,reused:doc.balance-newAmount,newReceipt:newAmount,receiptMode:input.receiptMode,allocations:allocations.map(a=>({receiptReference:a.receiptReference,amount:a.lines[0].amountMinor}))};
  return {summary,receipts,allocations,state:data.state,settlementState:data.settlementState,sequence,fingerprint:M.hash({data,input,identity,summary})};
}
function flushPayment(tx,parent,plan,at){
  for(const row of plan.receipts){const {id,...record}=row;tx.create(parent.collection('erpReceipts').doc(id),{...record,committedAt:at});}
  for(const row of plan.allocations){const {id,...record}=row;tx.create(parent.collection('erpSettlements').doc(id),{...record,committedAt:at});}
  if(plan.receipts.length)tx.set(parent.collection('erpState').doc('receivables'),{...plan.state,companyId:parent.id,revision:(plan.state.revision||0)+1,lastDate:plan.summary.date,updatedAt:at});
  if(plan.allocations.length)tx.set(parent.collection('erpState').doc('settlements'),{...plan.settlementState,companyId:parent.id,revision:plan.sequence,lastDate:plan.summary.date,updatedAt:at});
}
function createPaymentHandler({db,now,context,load}){
  return async(request,input,user,parent)=>{
    M.exactObject(input,['action','companyId','id',...(input.action==='paymentPreview'?['input']:['fingerprint'])]);
    const id=master.identifier(input.id),ref=parent.collection('erpSettlementJobs').doc(id);let normalized;
    if(input.action==='paymentPreview'){
      const value=M.exactObject(input.input,['documentId','date','receiptMode','confirmNew','notes']);
      const {receiptMode,confirmNew,notes}=value;normalized={documentId:master.identifier(value.documentId),date:M.date(value.date),...paymentOptions({receiptMode,confirmNew,notes})};
    }
    async function plan(tx,job){
      const data=await load(tx,parent),result=planPayment(data,job.input,{id:job.id,companyId:parent.id,kind:'DOCUMENT',createdAt:job.createdAt,createdBy:job.createdBy});
      const doc=settlementReport(data,job.input.date).documents.find(d=>d.id===job.input.documentId),partner=await tx.get(parent.collection('erpPartners').doc(doc.partnerId));
      if(!partner.exists||!partner.data().active)fail('failed-precondition','활성 거래처를 확인해 주세요.');master.verifyTenant(partner.data(),parent.id);
      return {...result,fingerprint:M.hash([result.fingerprint,partner.data()])};
    }
    return db.runTransaction(async tx=>{
      await context(request,tx);const snap=await tx.get(ref),old=snap.data();if(old){master.verifyTenant(old,parent.id);if(old.kind!=='PAYMENT_CONFIRMATION')fail('already-exists','다른 처리에 사용한 요청 번호입니다. 새로 검증해 주세요.');}
      if(input.action==='paymentPreview'){
        if(old){if(M.hash(old.input)!==M.hash(normalized))fail('already-exists','입력 내용이 변경되었습니다. 새로 검증해 주세요.');return {job:old};}
        const job={id,companyId:parent.id,kind:'PAYMENT_CONFIRMATION',input:normalized,status:'PENDING',createdAt:now().toISOString(),createdBy:user.uid},result=await plan(tx,job);
        const saved={...job,summary:result.summary,fingerprint:result.fingerprint};tx.create(ref,saved);return {job:saved};
      }
      if(!old||old.fingerprint!==input.fingerprint)fail('failed-precondition','확인한 미리보기가 필요합니다.');
      if(old.status==='COMMITTED')return {job:old,idempotent:true};
      const fresh=await plan(tx,old);if(fresh.fingerprint!==old.fingerprint)fail('failed-precondition','매출·수금·배분 또는 거래처가 변경되었습니다. 새로 검증해 주세요.');
      const at=now().toISOString();flushPayment(tx,parent,fresh,at);tx.create(parent.collection('erpAudit').doc(),{companyId:parent.id,actorId:user.uid,action:'DOCUMENT_PAID_CONFIRM',documentId:old.input.documentId,confirmationId:id,at});tx.update(ref,{status:'COMMITTED',committedAt:at});return {job:{...old,status:'COMMITTED',committedAt:at},idempotent:false};
    });
  };
}
module.exports={paymentOptions,planPayment,flushPayment,createPaymentHandler};
