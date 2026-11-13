const {fail}=require('./security-context');
const M=require('./erp-ledger-model');
const {loadFinance,salesEvents,paymentEvents}=require('./erp-finance-model');
const {settlementReport}=require('./erp-settlement-model');
const {recoveryState}=require('./erp-recovery-service');
const {releaseAllocation}=require('./erp-allocation-release');

async function planReturnSettlement(tx,parent,job,rows) {
  if(job.input.type!=='SALES_RETURN')return null;
  const data=await loadFinance(tx,parent),date=job.input.date;
  const latest=[data.state.lastDate,data.ledger.lastDate,data.settlementState.lastDate].filter(Boolean).sort().at(-1);
  if(latest&&date<latest)fail('failed-precondition',`마지막 재고·수금·배분일 ${latest} 이후로 반품해 주세요.`);
  const movements=[...data.movements,...rows.map(row=>({...row,id:M.hash(['correction',job.id,row.rowNo])}))];
  const simulated={...data,movements,events:[...salesEvents(movements),...paymentEvents(data.paid)]};
  const events=simulated.events.filter(e=>rows.some(row=>e.id===M.hash(['correction',job.id,row.rowNo])));
  const documentIds=[...new Set(events.map(e=>e.documentId))];
  if(documentIds.length!==1)fail('failed-precondition','반품의 원출고 문서 연결을 확인해 주세요.');
  const documentId=documentIds[0],beforeReport=settlementReport(data,date),afterReport=settlementReport(simulated,date);
  const before=beforeReport.documents.find(d=>d.id===documentId),after=afterReport.documents.find(d=>d.id===documentId);
  if(!before||!after)fail('failed-precondition','반품의 원출고 금액을 확인해 주세요.');
  const released=Math.max(0,-after.balance);
  const shared={companyId:parent.id,partnerId:after.partnerId,partnerName:after.partnerName,currency:after.currency,date,notes:job.input.reason,
    createdAt:job.createdAt,createdBy:job.createdBy,sourceKind:'SALES_RETURN',recoveryId:job.id,recoveryDocumentId:documentId};
  const allocation=releaseAllocation({report:afterReport,documentId,amount:released,shared,sequence:data.settlementState.revision||0,operationId:job.id});
  simulated.settlements=[...data.settlements,...allocation.entries];
  const finalReport=settlementReport(simulated,date),doc=finalReport.documents.find(d=>d.id===documentId),recovery=recoveryState(simulated,doc,date,finalReport);
  const summary={documentId,documentNo:doc.documentNo,partnerName:doc.partnerName,currency:doc.currency,date,
    returnAmount:M.signed(before.billed-doc.billed),receivableBefore:Math.max(0,before.balance),receivableReduction:Math.max(0,before.balance)-Math.max(0,doc.balance),
    receivableAfter:Math.max(0,doc.balance),documentReturnDue:recovery.credit,partnerReceivableAfter:Math.max(0,recovery.partnerBalance),partnerReturnDue:Math.max(0,-recovery.partnerBalance),
    refundable:recovery.refundable,allocationReleased:released,previousExcess:Math.max(0,-before.balance)};
  return {...allocation,summary,state:data.settlementState,fingerprint:M.hash({data,summary,entries:allocation.entries})};
}
function commitReturnSettlement(tx,parent,plan,at){
  if(!plan)return;
  for(const {id,...entry}of plan.entries)tx.create(parent.collection('erpSettlements').doc(id),{...entry,committedAt:at});
  if(plan.entries.length)tx.set(parent.collection('erpState').doc('settlements'),{...plan.state,companyId:parent.id,revision:plan.sequence,lastDate:plan.summary.date,updatedAt:at});
}
module.exports={planReturnSettlement,commitReturnSettlement};
