const {fail}=require('./security-context');
const {accessOf}=require('./erp-governance');
const M=require('./erp-ledger-model');
const {CHECKS}=require('./erp-close-checklist');
const {erpMaster:master}=require('./erp-service');
const monthOf=value=>{if(typeof value!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value))fail('invalid-argument','마감 월을 선택해 주세요.');return value;};
const reasonOf=value=>{const s=M.text(value,'변경 사유',500,true);if(s.length<3)fail('invalid-argument','사유를 3자 이상 입력해 주세요.');return s;};
function createClosePlans({db,now,context,stateOf,audit,checklist}){
  const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(now());
  async function read(tx,parent,month){const d=(await tx.get(parent.collection('erpClosePlans').doc(month))).data();if(d&&(d.companyId!==parent.id||d.month!==month))fail('failed-precondition','마감 일정의 소속 회사를 확인해 주세요.');return d||null;}
  const allowed=(user,plan)=>user.role==='ADMIN'||plan?.assigneeUids.includes(user.uid);
  function writable(state,month,plan,revision){
    if(state.closedThrough&&month<=state.closedThrough.slice(0,7))fail('failed-precondition','마감된 월의 일정은 재개방 후 변경해 주세요.');
    if(!Number.isSafeInteger(revision)||revision!==(plan?.revision||0))fail('aborted','마감 일정이 변경되었습니다. 다시 조회해 주세요.');
  }
  function view(plan,draft,user){
    const items=plan.items.map(item=>({...item,label:CHECKS.find(([key])=>key===item.key)[1],confirmed:!!draft.items.find(r=>r.key===item.key)?.checked}));
    const incomplete=items.filter(r=>!r.confirmed),mine=items.filter(r=>r.assigneeUid===user.uid&&!r.confirmed&&!r.submission);
    const actionCount=plan.status==='CLOSED'?0:user.role==='ADMIN'?Math.max(1,incomplete.length):mine.length;
    return {...plan,items,pendingCount:incomplete.length,myPendingCount:mine.length,actionCount,
      awaitingAdminCount:incomplete.filter(r=>r.submission).length,overdue:actionCount>0&&plan.dueDate<today(),today:today()};
  }
  function save(tx,parent,state,before,after,user,action,reason){
    tx.set(parent.collection('erpClosePlans').doc(after.month),after);
    tx.set(parent.collection('erpGovernance').doc('control'),{...state,revision:state.revision+1});
    audit(tx,parent,user,action,{month:after.month,reason,before,after});
  }
  async function validateAssignees(tx,parent,uids){
    const unique=[...new Set(uids.map(master.identifier))],docs=await tx.getAll(...unique.map(uid=>db.collection('UserProfile').doc(uid))),users=new Map();
    docs.forEach(d=>{const u=d.data();if(!u||u.companyId!==parent.id||!['ADMIN','SUB_ADMIN','MEMBER'].includes(u.role)||(u.status||'ACTIVE')!=='ACTIVE'||accessOf(u)==='NONE')fail('failed-precondition','담당자는 현재 회사의 활성 ERP 접근자 중에서 선택해 주세요.');users.set(d.id,u);});return users;
  }
  async function list(tx,parent,user){
      let query=parent.collection('erpClosePlans').where('status','==','OPEN').orderBy('month','asc');
      if(user.role!=='ADMIN')query=query.where('assigneeUids','array-contains',user.uid);
      const docs=await tx.get(query.limit(101)),plans=[];
      for(const doc of docs.docs.slice(0,100)){const p=doc.data();if(p.companyId!==parent.id||!allowed(user,p))fail('permission-denied','마감 일정 접근 권한을 확인해 주세요.');plans.push(view(p,await checklist.read(tx,parent,p.month),user));}
    return {plans,hasMore:docs.size>100,today:today()};
  }
  async function handle(request,v,parent){
    if(v.action==='closePlans'||v.action==='closeAlerts')return db.runTransaction(async tx=>{
      const user=await context(request,tx,false);
      const {plans,hasMore}=await list(tx,parent,user);
      const actionable=plans.filter(p=>p.actionCount>0);
      return v.action==='closeAlerts'?{pendingCount:actionable.length,overdueCount:actionable.filter(p=>p.overdue).length,hasMore,checkedAt:now().toISOString()}:{plans,hasMore,today:today()};
    });
    const month=monthOf(v.month);
    return db.runTransaction(async tx=>{
      const user=await context(request,tx,['closePlanSave','closeTaskReset'].includes(v.action)),[plan,state,draft]=await Promise.all([read(tx,parent,month),stateOf(tx,parent),checklist.read(tx,parent,month)]);
      if(v.action==='closePlanGet'){
        if(!allowed(user,plan))fail('permission-denied','배정된 월마감 일정만 조회할 수 있습니다.');
        return {plan:plan?view(plan,draft,user):null,checks:CHECKS.map(([key,label])=>({key,label})),locked:!!state.closedThrough&&month<=state.closedThrough.slice(0,7)};
      }
      writable(state,month,plan,v.revision);
      const at=now().toISOString();let after;
      if(v.action==='closePlanSave'){
        const dueDate=M.date(v.dueDate),reason=reasonOf(v.reason),ownerUid=master.identifier(v.ownerUid);
        if(dueDate.slice(0,7)<=month)fail('invalid-argument','마감 예정일은 대상 월이 지난 날짜로 지정해 주세요.');
        if(!Array.isArray(v.items)||v.items.length!==CHECKS.length||new Set(v.items.map(r=>r?.key)).size!==CHECKS.length)fail('invalid-argument','5개 확인 항목의 담당자를 지정해 주세요.');
        const input=CHECKS.map(([key])=>{const r=v.items.find(x=>x?.key===key);M.exactObject(r,['key','assigneeUid']);return {key,assigneeUid:master.identifier(r.assigneeUid)};});
        const users=await validateAssignees(tx,parent,[ownerUid,...input.map(r=>r.assigneeUid)]);
        after={companyId:parent.id,month,status:'OPEN',revision:(plan?.revision||0)+1,dueDate,ownerUid,ownerName:users.get(ownerUid).name||ownerUid,
          notes:M.text(v.notes,'일정 메모',500),assigneeUids:[...new Set([ownerUid,...input.map(r=>r.assigneeUid)])],
          items:input.map(r=>({...r,assigneeName:users.get(r.assigneeUid).name||r.assigneeUid,submission:plan?.items.find(p=>p.key===r.key&&p.assigneeUid===r.assigneeUid)?.submission||null})),updatedAt:at,updatedBy:user.uid};
        save(tx,parent,state,plan,after,user,'CLOSE_PLAN_SAVED',reason);
      }else{
        if(!plan)fail('not-found','등록된 마감 일정이 없습니다.');
        const item=plan.items.find(r=>r.key===v.key);if(!item)fail('invalid-argument','마감 확인 항목을 선택해 주세요.');
        if(v.action==='closeTaskSubmit'){
          if(user.uid!==item.assigneeUid)fail('permission-denied','본인에게 배정된 항목만 완료 보고할 수 있습니다.');
          const note=reasonOf(v.note);
          if(item.submission){if(item.submission.by===user.uid&&item.submission.note===note)return {plan:view(plan,draft,user),idempotent:true};fail('failed-precondition','완료 보고는 이미 등록되었습니다. 정정은 ADMIN에게 요청해 주세요.');}
          if(draft.items.find(r=>r.key===v.key)?.checked)fail('failed-precondition','ADMIN이 이미 확인한 항목입니다.');
          after={...plan,revision:plan.revision+1,updatedAt:at,updatedBy:user.uid,items:plan.items.map(r=>r.key===v.key?{...r,submission:{by:user.uid,name:user.name||user.uid,at,note}}:r)};
          save(tx,parent,state,plan,after,user,'CLOSE_TASK_SUBMITTED',note);
        }else if(v.action==='closeTaskReset'){
          const reason=reasonOf(v.reason);if(!item.submission)fail('failed-precondition','초기화할 완료 보고가 없습니다.');
          after={...plan,revision:plan.revision+1,updatedAt:at,updatedBy:user.uid,items:plan.items.map(r=>r.key===v.key?{...r,submission:null}:r)};
          save(tx,parent,state,plan,after,user,'CLOSE_TASK_RESET',reason);
        }else fail('invalid-argument','지원하지 않는 마감 일정 요청입니다.');
      }
      return {plan:view(after,draft,user)};
    });
  }
  function finish(tx,parent,plan,status,user){if(plan)tx.set(parent.collection('erpClosePlans').doc(plan.month),{...plan,status,revision:plan.revision+1,updatedAt:now().toISOString(),updatedBy:user.uid,
    ...(status==='OPEN'?{items:plan.items.map(r=>({...r,submission:null}))}:{})});}
  return {handle,read,finish,list};
}
function planSections(plan){return plan?[{name:'마감 일정 담당자',columns:[{label:'확인 항목',width:2},{label:'담당자',width:1},{label:'완료 보고',width:1.5},{label:'보고 메모',width:2}],rows:plan.items.map(r=>[CHECKS.find(([key])=>key===r.key)[1],r.assigneeName,r.submission?.at||'미보고',r.submission?.note||'']),note:`마감 예정일 ${plan.dueDate} · 총괄 ${plan.ownerName} · ${plan.notes}`}]:[];}
module.exports={createClosePlans,planSections};
