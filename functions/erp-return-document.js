const {fail}=require('./security-context');
const {text,date}=require('./erp-ledger-model');
const D=require('./erp-document-model');

// Cancel the old statement and prepare only its still-delivered lines in one transaction.
function createReturnDocument({db,now,context,record,refFor,sourceRows,usageRef,view,audit,checkRevision}){
  return async(request,input,user,parent,ref)=>{
    const reason=text(input.reason,'정정 사유',500,true),issueDate=date(input.issueDate);
    if(reason.length<3||input.confirm!==true)fail('invalid-argument','반품 정정 사유 3자 이상과 확인이 필요합니다.');
    const sourceRef=refFor(user.companyId,input.sourceId),requestHash=D.hash(input);
    if(sourceRef.id===ref.id)fail('invalid-argument','새 정정 문서 번호를 사용해 주세요.');
    return db.runTransaction(async tx=>{
      await context(request,tx);
      const previous=await record(tx,sourceRef,parent.id),existing=await tx.get(ref);
      if(previous.returnRecovery?.id===ref.id){
        if(previous.returnRecovery.requestHash!==requestHash)fail('already-exists','정정 요청 내용이 변경되었습니다. 새로 확인해 주세요.');
        return {document:existing.exists?view(ref.id,await record(tx,ref,parent.id)):view(sourceRef.id,previous),cancelledOnly:!existing.exists,idempotent:true};
      }
      if(existing.exists)fail('already-exists','이미 사용된 문서 번호입니다.');
      checkRevision(previous,input.expectedRevision);
      if(previous.kind!=='STATEMENT'||previous.status!=='ISSUED'||previous.replacementId)fail('failed-precondition','발행 중인 거래명세표를 선택해 주세요.');
      const source=await sourceRows(tx,parent,previous.input.sourceDocumentNo,'STATEMENT');
      if(issueDate<source.registry.date)fail('invalid-argument','정정 발행일은 원출고일 이후여야 합니다.');
      const beforeRows=new Map(previous.snapshot.rows.map(row=>[row.sourceId,row]));
      const available=new Map();let affected=false;
      for(const row of source.rows){
        const old=beforeRows.get(row.id);if(!old)continue;
        const link=source.links.get(row.id),used=source.usages.get(row.id);
        const remaining=Object.fromEntries(['quantityScaled','supplyMinor','taxMinor'].map(key=>[key,used[key]-old[key]]));
        if(Object.values(remaining).some(n=>!Number.isSafeInteger(n)||n<0))fail('failed-precondition','기발행 수량·금액 연결을 확인해 주세요.');
        if(link.cancelledBy||link.returnedQuantityScaled>0)affected=true;
        const capacity=link.cancelledBy?0:Math.max(0,row.quantityScaled-(link.returnedQuantityScaled||0)-remaining.quantityScaled);
        available.set(row.id,{quantityScaled:Math.min(old.quantityScaled,capacity),remaining});
      }
      if(!affected||available.size!==beforeRows.size)fail('failed-precondition','이 거래명세표에 연결된 반품·취소 내역을 확인해 주세요.');
      const lines=previous.input.lines.flatMap(line=>{const quantity=available.get(line.sourceId)?.quantityScaled||0;return quantity?[{...line,quantity:String(quantity/10000)}]:[];});
      const at=now().toISOString(),cancelled={...previous,status:'CANCELLED',cancelledRevision:previous.revision,revision:previous.revision+1,cancelReason:reason,
        cancelledAt:at,cancelledBy:user.uid,updatedAt:at,updatedBy:user.uid,returnRecovery:{id:ref.id,requestHash,cancelledOnly:!lines.length},...(lines.length?{replacementId:ref.id}:{})};
      const draft=lines.length?{companyId:parent.id,kind:'STATEMENT',status:'DRAFT',edition:previous.edition+1,
        input:D.input({...previous.input,issueDate,lines}),preview:null,fingerprint:'',replacesId:sourceRef.id,replacesNumber:previous.number,revision:1,
        createdAt:at,updatedAt:at,createdBy:user.uid,updatedBy:user.uid}:null;
      for(const [sourceId,value]of available)tx.set(usageRef(parent,'STATEMENT',sourceId),{companyId:parent.id,...value.remaining});
      tx.set(sourceRef,cancelled);if(draft)tx.create(ref,draft);
      audit(tx,parent,user,sourceRef.id,'RETURN_STATEMENT_CORRECTION',{reason,replacementId:draft?ref.id:'',sourceDocumentNo:previous.input.sourceDocumentNo,cancelledOnly:!draft});
      return {document:draft?view(ref.id,draft):view(sourceRef.id,cancelled),cancelledOnly:!draft};
    });
  };
}
module.exports={createReturnDocument};
