const {fail}=require('./security-context');
const {erpMaster:master}=require('./erp-service');
const M=require('./erp-ledger-model');
const {currencies,minor}=require('./erp-finance-model');
const {settlementReport}=require('./erp-settlement-model');
const {flushPayment}=require('./erp-payment-service');

function normalize(value){
  M.exactObject(value,['mode','partnerId','currency','date','receivedDate','amount','method','reference','notes','receiptId','lines','confirmDistinct']);
  if(!['NEW','EXISTING'].includes(value.mode)||!currencies.includes(value.currency)||typeof value.confirmDistinct!=='boolean')fail('invalid-argument','수금 방식·통화를 확인해 주세요.');
  const input={mode:value.mode,partnerId:master.identifier(value.partnerId),currency:value.currency,date:M.date(value.date),notes:M.text(value.notes,'입금 확인 메모',500,true),confirmDistinct:value.confirmDistinct};
  if(value.mode==='NEW'){
    if(!['BANK','CASH','CARD','OTHER'].includes(value.method))fail('invalid-argument','입금 방법을 확인해 주세요.');
    Object.assign(input,{amountMinor:minor(value.amount,value.currency),method:value.method,reference:M.text(value.reference,'입금 참조번호',100),receivedDate:M.date(value.receivedDate)});
    if(!input.amountMinor||input.receivedDate>input.date)fail('invalid-argument','실제 입금일은 원장 반영일 이하여야 하며 입금액은 0보다 커야 합니다.');
    if(value.receiptId)fail('invalid-argument','새 입금과 기존 수금을 동시에 선택할 수 없습니다.');
  }else{
    input.receiptId=master.identifier(value.receiptId);
    if(value.amount||value.receivedDate||value.method||value.reference||value.confirmDistinct)fail('invalid-argument','기존 수금의 입금일·금액은 변경할 수 없습니다.');
  }
  if(!Array.isArray(value.lines)||value.lines.length>50)fail('invalid-argument','배분 문서는 최대 50건입니다.');
  input.lines=value.lines.map(line=>{M.exactObject(line,['documentId','amount']);const amountMinor=minor(line.amount,value.currency);if(!amountMinor)fail('invalid-argument','배분액은 0보다 커야 합니다.');return {documentId:master.identifier(line.documentId),amountMinor};});
  if(new Set(input.lines.map(l=>l.documentId)).size!==input.lines.length||input.mode==='EXISTING'&&!input.lines.length)fail('invalid-argument','배분 문서를 중복 없이 선택해 주세요.');
  return input;
}

function planCollection(data,input,identity){
  const latest=[data.ledger.lastDate,data.state.lastDate,data.settlementState.lastDate].filter(Boolean).sort().at(-1);
  if(latest&&input.date<latest)fail('failed-precondition',`원장 반영일은 마지막 재고·수금·배분일 ${latest} 이후여야 합니다. 실제 입금일은 별도로 입력해 주세요.`);
  const report=settlementReport(data,input.date,input.partnerId),group=report.summaries.find(g=>g.currency===input.currency);
  if(!group)fail('failed-precondition','해당 거래처·통화의 미수 내역이 없습니다.');
  const receipt=input.mode==='EXISTING'?report.receipts.find(r=>r.id===input.receiptId&&r.currency===input.currency&&!r.cancelled):null;
  if(input.mode==='EXISTING'&&(!receipt||receipt.allocatable<=0))fail('failed-precondition','재사용 가능한 같은 거래처·통화의 수금을 선택해 주세요.');
  const total=input.lines.reduce((n,l)=>M.signed(n+l.amountMinor),0),newAmount=input.mode==='NEW'?input.amountMinor:0;
  if(newAmount>Math.max(0,group.balance))fail('failed-precondition','새 입금액이 거래처 미수잔액을 초과합니다. 기존 수금 재사용과 반환 예정액을 먼저 확인해 주세요.');
  if(total>(receipt?receipt.allocatable:newAmount))fail('failed-precondition','배분 합계가 선택한 수금의 배분 가능액을 초과했습니다. 부족분을 새 입금으로 자동 생성하지 않습니다.');
  const lines=input.lines.map(l=>{const doc=report.documents.find(d=>d.id===l.documentId&&d.currency===input.currency);if(!doc||l.amountMinor>doc.balance)fail('failed-precondition','같은 거래처·통화의 미수 문서와 남은 잔액을 확인해 주세요.');return {...l,documentNo:doc.documentNo,before:doc.balance,after:doc.balance-l.amountMinor};});
  const cancelled=new Set(data.paid.filter(r=>r.type==='CANCEL').map(r=>r.sourceId));
  const duplicates=input.mode==='NEW'?data.paid.filter(r=>r.type==='RECEIPT'&&!cancelled.has(r.id)&&r.partnerId===input.partnerId&&r.currency===input.currency&&(
    input.reference&&r.reference&&master.normalize(r.reference)===master.normalize(input.reference)||
    (r.receivedDate||r.date)===input.receivedDate&&r.amountMinor===newAmount
  )).map(r=>({id:r.id,date:r.receivedDate||r.date,reference:r.reference||'',amount:r.amountMinor})):[];
  if(duplicates.length>50)fail('resource-exhausted','중복 의심 수금이 많습니다. 기존 수금 내역을 먼저 정리해 주세요.');
  const shared={companyId:identity.companyId,partnerId:input.partnerId,partnerName:group.partnerName,currency:input.currency,date:input.date,notes:input.notes,createdAt:identity.at,createdBy:identity.uid,sourceKind:'UNIFIED_COLLECTION',confirmationId:identity.id};
  const receiptId=receipt?.id||M.hash(['collection-receipt',identity.id]);
  const receipts=newAmount?[{...shared,id:receiptId,type:'RECEIPT',amountMinor:newAmount,receivedDate:input.receivedDate,method:input.method,reference:input.reference,duplicateAcknowledgement:duplicates.length?duplicates.map(r=>r.id):[]}]:[];
  const sequence=(data.settlementState.revision||0)+(lines.length?1:0);
  const allocations=lines.length?[{...shared,id:M.hash(['collection-allocation',identity.id]),type:'ALLOCATE',sequence,receiptId,receiptReference:receipt?.reference||input.reference||receiptId,lines:lines.map(({documentId,documentNo,amountMinor})=>({documentId,documentNo,amountMinor}))}]:[];
  const summary={partnerId:input.partnerId,partnerName:group.partnerName,currency:input.currency,date:input.date,receivedDate:receipt?(data.paid.find(r=>r.id===receipt.id).receivedDate||receipt.date):input.receivedDate,
    before:group.balance,after:M.signed(group.balance-newAmount),newReceipt:newAmount,reused:receipt?total:0,allocated:total,unallocatedBefore:group.unallocated,unallocatedAfter:M.signed(group.unallocated+newAmount-total),
    receiptId,receiptRemaining:(receipt?receipt.available:newAmount)-total,lines,duplicates,canCommit:!duplicates.length||input.confirmDistinct};
  return {summary,receipts,allocations,state:data.state,settlementState:data.settlementState,sequence,fingerprint:M.hash({data,input,identity,summary})};
}

function createCollectionHandler({db,now,context,load}){
  return async(request,input,user,parent)=>{
    const preview=input.action==='collectionPreview';M.exactObject(input,['action','companyId','id',...(preview?['input']:['fingerprint'])]);
    const id=master.identifier(input.id),ref=parent.collection('erpSettlementJobs').doc(id),normalized=preview?normalize(input.input):null;
    async function plan(tx,job){const data=await load(tx,parent),partner=await tx.get(parent.collection('erpPartners').doc(job.input.partnerId));if(!partner.exists||!partner.data().active)fail('failed-precondition','활성 거래처를 확인해 주세요.');master.verifyTenant(partner.data(),parent.id);
      const result=planCollection(data,job.input,{id:job.id,companyId:parent.id,at:job.createdAt,uid:job.createdBy});return {...result,fingerprint:M.hash([result.fingerprint,partner.data()])};}
    return db.runTransaction(async tx=>{
      await context(request,tx);const old=(await tx.get(ref)).data();if(old){master.verifyTenant(old,parent.id);if(old.kind!=='UNIFIED_COLLECTION')fail('already-exists','다른 처리에 사용한 요청 번호입니다. 새로 검증해 주세요.');}
      if(preview){if(old){if(M.hash(old.input)!==M.hash(normalized))fail('already-exists','요청 번호의 입력 내용이 다릅니다.');return {job:old};}
        const job={id,companyId:parent.id,kind:'UNIFIED_COLLECTION',status:'PENDING',input:normalized,createdAt:now().toISOString(),createdBy:user.uid},result=await plan(tx,job),saved={...job,summary:result.summary,fingerprint:result.fingerprint};tx.create(ref,saved);return {job:saved};}
      if(!old||old.fingerprint!==input.fingerprint)fail('failed-precondition','확인한 미리보기가 필요합니다.');if(old.status==='COMMITTED')return {job:old,idempotent:true};
      const fresh=await plan(tx,old);if(fresh.fingerprint!==old.fingerprint)fail('failed-precondition','매출·수금·배분이 변경되었습니다. 최신 잔액으로 다시 검증해 주세요.');if(!fresh.summary.canCommit)fail('failed-precondition','중복 의심 수금을 재사용하거나 별도 입금임을 확인한 뒤 다시 검증해 주세요.');
      const at=now().toISOString();flushPayment(tx,parent,fresh,at);tx.create(parent.collection('erpAudit').doc(),{companyId:parent.id,actorId:user.uid,action:'UNIFIED_COLLECTION',collectionId:id,receiptId:fresh.summary.receiptId,at});tx.update(ref,{status:'COMMITTED',committedAt:at});return {job:{...old,status:'COMMITTED',committedAt:at},idempotent:false};
    });
  };
}
module.exports={normalize,planCollection,createCollectionHandler};
