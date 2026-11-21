const {fail}=require('./security-context');
const {digest}=require('./erp-governance');
const M=require('./erp-ledger-model');
const DEFAULTS=Object.freeze({agedDays:14,urgentDays:30});
const policyRef=parent=>parent.collection('erpReviewState').doc('policy');
function validDays(aged,urgent){return Number.isSafeInteger(aged)&&Number.isSafeInteger(urgent)&&aged>=1&&urgent<=3650&&urgent>aged;}
async function readPolicy(tx,parent){
  const row=(await tx.get(policyRef(parent))).data();
  if(!row)return {companyId:parent.id,...DEFAULTS,revision:0,configured:false,updatedAt:null,updatedByName:null};
  if(row.companyId!==parent.id)fail('permission-denied','알림 기준의 회사를 확인해 주세요.');
  if(!validDays(row.agedDays,row.urgentDays)||!Number.isSafeInteger(row.revision)||row.revision<1||typeof row.configured!=='boolean'||!row.configured&&(row.agedDays!==DEFAULTS.agedDays||row.urgentDays!==DEFAULTS.urgentDays))fail('failed-precondition','저장된 알림 기준을 확인해 주세요.');
  return {companyId:parent.id,agedDays:row.agedDays,urgentDays:row.urgentDays,revision:row.revision,configured:row.configured,updatedAt:row.updatedAt,updatedByName:row.updatedByName};
}
function createReviewPolicy({db,context,now}){
  async function admin(request,tx){const user=await context(request,tx);if(user.role!=='ADMIN')fail('permission-denied','알림 기준 설정은 회사 ADMIN만 처리할 수 있습니다.');return user;}
  async function get(request,parent){return db.runTransaction(async tx=>{await admin(request,tx);return readPolicy(tx,parent);},{readOnly:true});}
  async function save(request,parent,v){
    if(!Number.isSafeInteger(v.revision)||v.revision<0)fail('invalid-argument','알림 기준 버전을 확인해 주세요.');
    if(v.reset!==undefined&&typeof v.reset!=='boolean')fail('invalid-argument','기본값 복원 옵션을 확인해 주세요.');
    if(v.reset===true&&(v.agedDays!==undefined||v.urgentDays!==undefined))fail('invalid-argument','기본값 복원과 개별 기준을 함께 지정할 수 없습니다.');
    const {agedDays,urgentDays}=v.reset===true?DEFAULTS:v;
    if(!validDays(agedDays,urgentDays))fail('invalid-argument','기준은 1~3650일의 정수이며 우선 확인은 장기 미확인보다 커야 합니다.');
    const reason=M.text(v.reason,'변경 사유',500,true);if(reason.length<3)fail('invalid-argument','변경 사유를 3자 이상 입력해 주세요.');
    return db.runTransaction(async tx=>{
      const user=await admin(request,tx),before=await readPolicy(tx,parent);
      if(before.revision!==v.revision)fail('aborted','다른 ADMIN이 알림 기준을 변경했거나 이미 저장되었습니다. 현재 기준을 다시 조회해 주세요.');
      const configured=v.reset!==true;
      if(before.agedDays===agedDays&&before.urgentDays===urgentDays&&before.configured===configured)return before;
      const at=now().toISOString(),after={companyId:parent.id,agedDays,urgentDays,configured,revision:before.revision+1,updatedAt:at,updatedBy:user.uid,updatedByName:user.name||user.uid};
      const action='ERP_REVIEW_POLICY_CHANGED',id=digest([parent.id,action,after.revision]);
      tx.set(policyRef(parent),after);
      tx.create(parent.collection('erpAudit').doc(id),{companyId:parent.id,actorId:user.uid,actorName:after.updatedByName,action,at,before,after,reason});
      tx.create(parent.collection('erpChangeHistory').doc(id),{companyId:parent.id,operationId:id,domain:'control',action,actorId:user.uid,actorName:after.updatedByName,requestedBy:user.uid,approvedBy:user.uid,reason,at,part:1,parts:1,changes:[{path:'erpReviewState/policy',before,after}]});
      // Alert policy does not alter inventory, confirmations or month-close locks.
      const {updatedBy,...result}=after;return result;
    });
  }
  return {get,save};
}
module.exports={DEFAULTS,readPolicy,createReviewPolicy};
