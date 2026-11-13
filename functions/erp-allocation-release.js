const {fail}=require('./security-context');
const M=require('./erp-ledger-model');

// Preserve every other invoice in the same allocation; all entries are append-only.
function releaseAllocation({report,documentId,amount,shared,sequence,operationId}) {
  const entries=[],preserved=[];let remaining=amount;
  for(const source of report.allocations.filter(a=>a.active&&a.lines.some(l=>l.documentId===documentId)).sort((a,b)=>b.sequence-a.sequence||a.id.localeCompare(b.id))){
    if(!remaining)break;
    if(preserved.length>=40)fail('resource-exhausted','한 번에 40건까지 배분을 정리할 수 있습니다. 반품 수량 또는 해제 금액을 나누어 처리해 주세요.');
    const target=source.lines.find(l=>l.documentId===documentId),releasedAmountMinor=Math.min(remaining,target.amountMinor);
    const lines=source.lines.map(l=>({...l,amountMinor:l.documentId===documentId?l.amountMinor-releasedAmountMinor:l.amountMinor})).filter(l=>l.amountMinor>0);
    const id=M.hash(['return-release',operationId,source.id]),replacementId=lines.length?M.hash(['return-reallocate',operationId,source.id]):'';
    entries.push({...shared,id,type:'RELEASE',sequence:++sequence,sourceId:source.id,receiptId:source.receiptId,releasedAmountMinor,replacementAllocationId:replacementId});
    if(lines.length)entries.push({...shared,id:replacementId,type:'ALLOCATE',sequence:++sequence,receiptId:source.receiptId,lines,replacesAllocationId:source.id});
    preserved.push({sourceId:source.id,releasedAmountMinor,remainingLines:lines});remaining-=releasedAmountMinor;
  }
  if(remaining)fail('failed-precondition','원수금 배분 연결을 다시 확인해 주세요.');
  return {entries,preserved,sequence};
}
module.exports={releaseAllocation};
