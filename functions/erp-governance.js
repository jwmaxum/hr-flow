const { authorizeContext, fail } = require('./security-context');
const { createHash } = require('node:crypto');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const accessOf = user => (user.status||'ACTIVE')!=='ACTIVE'?'NONE':user.role === 'ADMIN' ? 'ADMIN' : user.role==='SUB_ADMIN'&&user.erpAccess==='MANAGER'?'MANAGER':['SUB_ADMIN','MEMBER'].includes(user.role)&&['VIEW','INBOUND','OUTBOUND','BOTH'].includes(user.erpAccess) ? user.erpAccess : 'NONE';
function requireAction(user,domain,action){
  const reads={master:['itemSearch','list','inventory','purchaseHistory','bundleEstimate'],report:['meta','report','export']};
  if(accessOf(user)==='VIEW'&&!reads[domain]?.includes(action))fail('permission-denied','ERP 조회 전용 권한입니다. 등록·수정·취소는 담당 권한과 ADMIN 승인이 필요합니다.');
}
function requireDirection(user, direction) {
  const access = accessOf(user);
  if (!['ADMIN','MANAGER','BOTH'].includes(access) && access !== (direction === '입고' ? 'INBOUND' : direction === '출고' ? 'OUTBOUND' : 'INVALID')) fail('permission-denied','지정된 입고·출고 담당 업무만 처리할 수 있습니다.');
}
async function authorizeErp(args) {
  const user = await authorizeContext({...args, roles:['ADMIN','SUB_ADMIN','MEMBER']});
  if (user.companyId !== args.request.data?.companyId || accessOf(user) === 'NONE') fail('permission-denied','ERP 접근 권한이 없습니다. 회사 ADMIN에게 담당자 지정을 요청해 주세요.');
  return user;
}
async function checkImport(user, input, job) {
  if (user.role === 'ADMIN') return;
  if(accessOf(user)==='VIEW')fail('permission-denied','조회 전용 사용자는 입출고를 등록할 수 없습니다.');
  if (!['manualPreview','commit','get','cancel'].includes(input.action)) fail('permission-denied','담당자는 입고·출고 직접 등록을 이용해 주세요. Excel·기초재고 관리는 ADMIN 업무입니다.');
  if (input.action === 'manualPreview') {
    requireDirection(user,input.movement?.direction);
    if (input.movement?.lines?.some(row=>row.fulfillment && row.fulfillment !== 'DIRECT')) fail('permission-denied','보관·차용 출고는 ADMIN이 처리해야 합니다.');
  }
  if (job) {
    if (job.createdBy !== user.uid || job.source.kind !== 'MANUAL') fail('permission-denied','본인이 직접 등록한 입출고만 처리할 수 있습니다.');
    for (const row of job.rows) {requireDirection(user,row.direction);if(row.fulfillment && row.fulfillment !== 'DIRECT') fail('permission-denied','보관·차용은 ADMIN 업무입니다.');}
  }
}
async function checkCorrection(user, input, tx, parent) {
  if (user.role === 'ADMIN') return;
  if(accessOf(user)==='VIEW')fail('permission-denied','조회 전용 사용자는 변경을 요청할 수 없습니다.');
  if (input.type === 'TRANSFER') {if(!['BOTH','MANAGER'].includes(accessOf(user)))fail('permission-denied','창고 이동은 입출고 전체 담당 권한이 필요합니다.');return;}
  if (['COUNT','VALUE'].includes(input.type)) return;
  const source = await tx.get(parent.collection('erpMovements').doc(input.sourceId));
  if (!source.exists || source.data().companyId !== parent.id) fail('not-found','원거래를 찾을 수 없습니다.');
  requireDirection(user,source.data().direction);
}
const tracked = new Set(['erpItems','erpWarehouses','erpPartners','erpMovements','erpInventory','erpMovementLinks','erpDocuments','erpReceipts','erpSettlements','erpCustodyJobs','erpCustodyLots','erpIssuedDocuments','erpPrintSettings']);
const timed = new Set(['erpMovements','erpReceipts','erpSettlements','erpDocuments','erpCustodyJobs','erpIssuedDocuments']);

// The ERP option never promotes an HR role or grants finance/governance rights.
async function managerDirectChange(user,domain,request,result,changed,tx,parent){
  if(accessOf(user)!=='MANAGER')return false;
  if(domain==='correction'){
    const input=result.correction?.input;
    if(['COUNT','VALUE','SALES_RETURN','PURCHASE_RETURN'].includes(input?.type))return true;
    if(input?.type!=='CANCEL')return false;
    const source=(await tx.get(parent.collection('erpMovements').doc(input.sourceId))).data();
    return source?.companyId===parent.id && source.type==='MOVEMENTS';
  }
  if(domain!=='master'||request.data.kind!=='items')return false;
  const rows=changed.filter(r=>r.path.startsWith('erpItems/'));
  const allowed=new Set(['purchasePrice','salePrice','revision','updatedAt','updatedBy']);
  return rows.length===1&&rows.every(r=>r.before&&r.after&&Object.keys({...r.before,...r.after}).every(k=>allowed.has(k)||digest(r.before[k]??null)===digest(r.after[k]??null)));
}

// Buffer writes so closing, permissions, approval and append-only history are
// checked in the SAME transaction as every existing ERP writer. Never wrap a
// transaction callback with a second committing transaction.
function governedService(factory, domain) {
  return dependencies => async request => {
    const {db, now=()=>new Date()}=dependencies;
    requireAction(await authorizeErp({db,request,now}),domain,request.data?.action);
    const proxy = new Proxy(db, {get(target,key) {
      if(key !== 'runTransaction') {const value=target[key];return typeof value==='function'?value.bind(target):value;}
      return callback => db.runTransaction(async tx=>{
        const user=await authorizeErp({db,request,reader:tx,now});
        requireAction(user,domain,request.data?.action);
        const parent=db.collection('companies').doc(user.companyId), stateRef=parent.collection('erpGovernance').doc('control');
        const stateDoc=await tx.get(stateRef),state=stateDoc.data()||{companyId:parent.id,revision:0,closedThrough:'',lastClosedMonth:''};
        if(state.companyId!==parent.id)fail('failed-precondition','회사 마감 상태를 확인해 주세요.');
        const pending=[];
        const buffered=new Proxy(tx,{get(target,key){if(['create','set','update','delete'].includes(key))return(...args)=>{pending.push({method:key,args});return buffered;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
        const result=await callback(buffered);
        const meaningful=pending.filter(w=>tracked.has(w.args[0].parent.id)&&!(w.args[0].parent.id==='erpIssuedDocuments'&&w.method==='update'&&Object.keys(w.args[1]).every(k=>k==='pdf')));
        const audits=pending.filter(w=>w.args[0].parent.id==='erpAudit');
        if(!meaningful.length&&!audits.length){for(const w of pending)tx[w.method](...w.args);return result;}
        const changed=[];
        for(let i=0;i<meaningful.length;i+=200){const rows=meaningful.slice(i,i+200),docs=await tx.getAll(...rows.map(w=>w.args[0]));docs.forEach((doc,j)=>{const w=rows[j],before=doc.data()||null;changed.push({path:w.args[0].path.slice(parent.path.length+1),before,after:w.method==='delete'?null:w.method==='update'||w.args[2]?.merge?{...before,...w.args[1]}:w.args[1]});});}
        const dates=changed.filter(w=>timed.has(w.path.split('/')[0])).flatMap(w=>[w.before,w.after].map(row=>row?.date||row?.input?.date||row?.input?.issueDate)).filter(Boolean);
        if(state.closedThrough && dates.some(date=>date<=state.closedThrough))fail('failed-precondition',`${state.closedThrough}까지 월마감되었습니다. ADMIN이 마감을 재개방한 후 처리해 주세요.`);
        const correction=domain==='correction'&&request.data.action==='commit'&&result.correction?.input.type!=='TRANSFER';
        const masterEdit=domain==='master'&&request.data.action==='save'&&changed.some(r=>r.before&&['erpItems','erpWarehouses','erpPartners'].some(c=>r.path.startsWith(c+'/')));
        const needsApproval=correction||masterEdit;
        const managerDirect=needsApproval&&await managerDirectChange(user,domain,request,result,changed,tx,parent);
        const at=now().toISOString(),operationId=digest([domain,request.data]);
        const approvalRef=parent.collection('erpApprovals').doc(operationId);
        if(needsApproval&&user.role!=='ADMIN'&&!managerDirect){
          const old=await tx.get(approvalRef);
          if(old.exists&&old.data().status!=='PENDING')fail('failed-precondition','이미 처리된 승인 요청입니다. 변경 내용을 다시 입력하고 새로 검증해 주세요.');
          if(!old.exists){
            const draft={companyId:parent.id,id:operationId,domain,request:request.data,requestedBy:user.uid,requesterName:user.name||user.email||user.uid,status:'PENDING',createdAt:at,date:dates.sort()[0]||at.slice(0,10),reason:result.correction?.input.reason||'기준정보 수정·사용중지 요청',summary:result.correction?.rows||changed.filter(r=>r.path.startsWith('erpItems/')||r.path.startsWith('erpWarehouses/')||r.path.startsWith('erpPartners/'))};
            if(Buffer.byteLength(JSON.stringify(draft))>800000)fail('resource-exhausted','변경 요청을 나누어 등록해 주세요.');
            tx.create(approvalRef,draft);tx.create(parent.collection('erpAudit').doc(),{companyId:parent.id,actorId:user.uid,action:'APPROVAL_REQUEST',approvalId:operationId,at});
            tx.set(stateRef,{...state,revision:state.revision+1});
          }
          return {...result,approvalRequested:true,approvalId:operationId,...(result.correction?{correction:{...result.correction,status:'AWAITING_APPROVAL'}}:{}),...(result.record?{record:null}:{})};
        }
        const approval=request.erpApproval;
        if(needsApproval&&(user.role==='ADMIN'||managerDirect)&&!approval){
          const pendingApproval=await tx.get(approvalRef);
          if(pendingApproval.data()?.status==='PENDING')fail('failed-precondition','승인 대기 중인 변경입니다. 승인 요청 화면에서 승인·반려해 주세요.');
        }
        if(approval){
          if(user.role!=='ADMIN'||approval.id!==operationId)fail('permission-denied','승인 요청 연결이 올바르지 않습니다.');
          const doc=await tx.get(approvalRef),a=doc.data();
          if(!a||a.companyId!==parent.id||a.status!=='PENDING'||digest(a.request)!==digest(request.data))fail('failed-precondition','승인 대기 요청을 다시 조회해 주세요.');
          const requester=await tx.get(db.collection('UserProfile').doc(a.requestedBy));
          if(!requester.exists||requester.data().companyId!==parent.id||(requester.data().status||'ACTIVE')!=='ACTIVE'||['NONE','VIEW'].includes(accessOf(requester.data())))fail('permission-denied','요청자의 ERP 업무 권한이 해제되었습니다. 요청을 반려해 주세요.');
          if(domain==='correction')await checkCorrection({...requester.data(),uid:a.requestedBy},result.correction.input,tx,parent);
          tx.update(approvalRef,{status:'APPROVED',decidedAt:at,decidedBy:user.uid,decisionReason:approval.reason});
        }
        // Every changed record has before/after values. Split at a safe document
        // size rather than truncate a large imported transaction's audit trail.
        const chunks=[];let chunk=[],size=0;
        for(const row of changed){const n=Buffer.byteLength(JSON.stringify(row));if(n>800000)fail('resource-exhausted','변경 이력 크기를 초과했습니다. 입력을 나누어 주세요.');if(size+n>800000){chunks.push(chunk);chunk=[];size=0;}chunk.push(row);size+=n;}if(chunk.length)chunks.push(chunk);
        for(const w of pending)tx[w.method](...w.args);
        chunks.forEach((changes,i)=>tx.create(parent.collection('erpChangeHistory').doc(),{companyId:parent.id,operationId,domain,action:request.data.action,actorId:user.uid,actorName:user.name||user.email||user.uid,requestedBy:approval?.requestedBy||user.uid,approvedBy:needsApproval&&!managerDirect?user.uid:null,approvalId:approval?.id||null,...(managerDirect?{authorization:'ERP_MANAGER_DIRECT',actorErpAccess:'MANAGER'}:{}),reason:approval?.reason||result.correction?.input.reason||'',at,part:i+1,parts:chunks.length,changes}));
        tx.set(stateRef,{...state,revision:state.revision+1});
        return result;
      });
    }});
    return factory({...dependencies,db:proxy})(request);
  };
}
module.exports={governedService,authorizeErp,accessOf,requireDirection,checkImport,checkCorrection,digest};
