const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,Timestamp}=require('firebase-admin/firestore');
const {createErpService}=require('../erp-service');
const {createErpImportService}=require('../erp-import-service');
const {createErpCorrectionService}=require('../erp-correction-service');
const {createErpControlService}=require('../erp-control-service');
const {createErpFinanceService}=require('../erp-finance-service');
if(!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw Error('Loopback emulator required');
process.env.METADATA_SERVER_DETECTION='none';
const projectId='demo-erp-governance',app=initializeApp({projectId},projectId),db=getFirestore(app),now=()=>new Date('2026-12-20T00:00:00Z');
const files=new Map();let seq=0,renderHook=null,failRender=false;
const bucket={file:(path,version={})=>({save:async(bytes,options)=>{if(files.has(path)&&options.preconditionOpts.ifGenerationMatch===0)throw Object.assign(Error('exists'),{code:412});files.set(path,{bytes:Buffer.from(bytes),meta:{...options.metadata,size:String(bytes.length),generation:String(++seq)}});},getMetadata:async()=>{if(!files.has(path))throw Object.assign(Error('missing'),{code:404});return [structuredClone(files.get(path).meta)];},download:async()=>{const r=files.get(path);assert.ok(r);if(version.generation)assert.equal(version.generation,r.meta.generation);return [Buffer.from(r.bytes)];}})};
const deps={db,now,bucket},masters=createErpService(deps),imports=createErpImportService(deps),corrections=createErpCorrectionService(deps),finance=createErpFinanceService(deps);
const control=createErpControlService({...deps,renderPdf:async r=>{if(renderHook)await renderHook();if(failRender)throw Error('synthetic render failure');return Buffer.from('%PDF-1.7 '+r.snapshot+' EOF');}});
const req=(data,uid='admin',companyId='a')=>({data:{companyId,...data},...(uid?{auth:{uid,token:{auth_time:now().getTime()/1000}}}:{})});
const call=(action,data={},uid='admin',company='a')=>control(req({action,...data},uid,company));
const parent=()=>db.doc('companies/a');
const docs=async col=>(await parent().collection(col).get()).docs.map(d=>({id:d.id,...d.data()}));
const deny=(p,code='permission-denied')=>assert.rejects(p,e=>e.code===code);
const values={code:'PART',name:'검증 품목',unit:'개',purchasePrice:100,salePrice:200,taxType:'과세',group:'',specification:'',notes:'',active:true};
async function grant(uid,access){const old=(await db.doc('UserProfile/'+uid).get()).data();return call('grant',{uid,access,expectedAccess:old.erpAccess||'NONE',reason:'담당자 지정 검증'});}
const move=(direction,extra={})=>({direction,date:'2026-11-12',warehouseId:'wh',partnerId:'partner',currency:'KRW',exchangeRate:'1',priceBasis:'세금별도',allowNewItems:false,allowNewPartners:false,lines:[{code:'PART',name:'검증 품목',unit:'개',specification:'',taxType:'과세',quantity:'2',price:'100',notes:''}],...(direction==='출고'?{payment:{status:'CREDIT'}}:{}),...extra});
async function previewMove(direction,uid='admin',extra={}){return (await imports(req({action:'manualPreview',id:'move-'+(++seq),movement:move(direction,extra)},uid))).import;}
const commitMove=(job,uid='admin')=>imports(req({action:'commit',id:job.id,fingerprint:job.preview.fingerprint},uid));
async function correction(type='VALUE',uid='member',extra={}){return (await corrections(req({action:'preview',id:'cor-'+(++seq),input:{type,date:'2026-11-12',reason:'장부 원가 정정',itemId:'item',warehouseId:'wh',value:'300',...extra}},uid))).correction;}
const commitCor=(job,uid='member')=>corrections(req({action:'commit',id:job.id,fingerprint:job.fingerprint},uid));
const closePreview=()=>call('closePreview',{month:'2026-11'});
const close=p=>call('close',{month:'2026-11',revision:p.revision,snapshot:p.dashboard.snapshot,checklistRevision:p.checklist.revision,reason:'월말 원장 대사 완료'});
async function completeChecklist(extra={}){const {checklist:d}=await call("checklistGet",{month:"2026-11"});return call("checklistSave",{month:d.month,revision:d.revision,items:d.items.map(({key,note})=>({key,note,checked:true})),noEvidenceReason:"자동 검증용 외부 증빙 없음",...extra});}
async function reset(){
  assert.equal((await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,{method:'DELETE'})).status,200);files.clear();renderHook=null;failRender=false;
  const b=db.batch();for(const id of ['a','b'])b.set(db.doc('companies/'+id),{nameKo:'검증회사 '+id,status:'ACTIVE',accessUntil:Timestamp.fromDate(new Date('2027-12-01'))});
  for(const [uid,role,companyId]of [['admin','ADMIN','a'],['foreign','ADMIN','b'],['member','MEMBER','a'],['manager','SUB_ADMIN','a']])b.set(db.doc('UserProfile/'+uid),{uid,role,companyId,name:uid,status:'ACTIVE'});await b.commit();
  for(const [kind,id,v]of [['warehouses','wh',{code:'WH',name:'본사',address:'',active:true,notes:''}],['partners','partner',{code:'BUYER',name:'검증 거래처',country:'KR',type:'BOTH',registrationNumber:'',contactName:'',email:'',phone:'',address:'',active:true,notes:''}],['items','item',values]])await masters(req({action:'save',kind,id,expectedRevision:0,values:v}));
  await commitMove(await previewMove('입고'));await completeChecklist();
}
test('ERP monthly close, approval and delegation invariants',async t=>{try{
  await t.test('explicit scoped grants, wrong direction, foreign grants and revoked pending writes',async()=>{
    await reset();await deny(masters(req({action:'list',kind:'items'},'member')));await deny(call('directory',{},'member'));await deny(call('grant',{uid:'member',access:'BOTH',expectedAccess:'NONE',reason:'위조 요청'},'manager'));await deny(call('grant',{uid:'foreign',access:'BOTH',expectedAccess:'NONE',reason:'다른 회사'}));
    await grant('member','INBOUND');assert.equal((await masters(req({action:'inventory',itemId:'item'},'member'))).quantity,2);
    await deny(previewMove('출고','member'));const job=await previewMove('입고','member');await grant('member','NONE');await deny(commitMove(job,'member'));await grant('member','INBOUND');await commitMove(job,'member');assert.equal((await docs('erpInventory'))[0].quantity,4);
    await grant('manager','OUTBOUND');await deny(previewMove('입고','manager'));const out=await previewMove('출고','manager');await deny(commitMove(out,'member'));await commitMove(out,'manager');
    await deny(imports(req({action:'list'},'member')));await deny(finance(req({action:'dashboard',month:'2026-11'},'member')));
    await grant('member','BOTH');const stale=await previewMove('입고','member');await grant('member','OUTBOUND');await deny(commitMove(stale,'member'));
  });
  await t.test('corrections queue, canonical replay applies atomically exactly once and records before/after',async()=>{
    await reset();await grant('member','INBOUND');const job=await correction();const queued=await commitCor(job);assert.equal(queued.approvalRequested,true);assert.equal((await docs('erpInventory'))[0].value,200);
    await deny(call('decide',{id:queued.approvalId,decision:'APPROVE',reason:'자기 승인'},'member'));
    await call('decide',{id:queued.approvalId,decision:'APPROVE',reason:'원가 증빙 승인'});assert.equal((await docs('erpInventory'))[0].value,300);
    assert.equal((await call('decide',{id:queued.approvalId,decision:'APPROVE',reason:'중복 승인'})).idempotent,true);
    const history=await docs('erpChangeHistory'),entry=history.find(r=>r.approvalId===queued.approvalId);assert.equal(entry.requestedBy,'member');assert.equal(entry.approvedBy,'admin');assert.ok(entry.changes.some(c=>c.path.startsWith('erpInventory/')&&c.before.value===200&&c.after.value===300));
  });
  await t.test('master price edits need approval; rejected and stale requests cannot mutate',async()=>{
    await reset();await grant('member','BOTH');const r=await masters(req({action:'save',kind:'items',id:'item',expectedRevision:1,values:{...values,purchasePrice:123}},'member'));assert.equal(r.approvalRequested,true);assert.equal((await docs('erpItems'))[0].purchasePrice,100);
    await call('decide',{id:r.approvalId,decision:'REJECT',reason:'원가 자료 미확인'});assert.equal((await docs('erpItems'))[0].purchasePrice,100);
    const job=await correction(),pending=await commitCor(job);await commitMove(await previewMove('입고'));await deny(call('decide',{id:pending.approvalId,decision:'APPROVE',reason:'변경 후 승인'}),'failed-precondition');assert.equal((await parent().collection('erpApprovals').doc(pending.approvalId).get()).data().status,'PENDING');
    await grant('member','NONE');await deny(call('decide',{id:pending.approvalId,decision:'APPROVE',reason:'권한 회수 후 승인'}),'failed-precondition');
  });
  await t.test('closing also blocks pre-reviewed receipts and due-date changes in the closed period',async()=>{
    await reset();await commitMove(await previewMove('출고'));const sales=(await docs('erpDocuments')).find(r=>r.direction==='출고');
    const receipt=(await finance(req({action:'preview',id:'cash-job',input:{type:'RECEIPT',date:'2026-11-12',partnerId:'partner',currency:'KRW',amount:'100',method:'BANK',reference:'자체 확인',notes:'월말 입금 확인'}}))).job;
    const terms=(await finance(req({action:'settlementPreview',id:'terms-job',input:{type:'TERMS',date:'2026-11-12',documentId:sales.id,dueDate:'2026-11-30',notes:'계약 기일'}}))).job;
    await close(await closePreview());await deny(finance(req({action:'commit',id:receipt.id,fingerprint:receipt.fingerprint})),'failed-precondition');await deny(finance(req({action:'settlementCommit',id:terms.id,fingerprint:terms.fingerprint})),'failed-precondition');assert.equal((await docs('erpReceipts')).length,0);assert.equal((await docs('erpSettlements')).length,0);
  });
  await t.test('pending approvals block close; immutable files remain unchanged across reopen and v2',async()=>{
    await reset();await grant('member','BOTH');const q=await commitCor(await correction());await deny(closePreview(),'failed-precondition');await call('decide',{id:q.approvalId,decision:'REJECT',reason:'기간 검토 반려'});
    const p=await closePreview(),r=await close(p);assert.equal(r.archive.version,1);const bytes=await call('download',{id:r.archive.id,fileIndex:0});assert.equal(Buffer.from(bytes.base64,'base64').subarray(0,2).toString(),'PK');
    const old=await previewMove('입고');await deny(commitMove(old),'failed-precondition');await deny(commitCor(await correction('VALUE','admin'),'admin'),'failed-precondition');
    const state=(await call('status')).state;await call('reopen',{month:'2026-11',revision:state.revision,reason:'확정 원가 재검토'});await commitCor(await correction('VALUE','admin'),'admin');await completeChecklist();const second=await close(await closePreview());assert.equal(second.archive.version,2);assert.equal((await call('download',{id:r.archive.id,fileIndex:0})).base64,bytes.base64);assert.equal((await call('archives')).archives.length,2);
    await deny(call('download',{id:r.archive.id,fileIndex:0},'foreign','b'),'not-found');const f=files.get(r.archive.files[0].path);f.bytes[0]^=1;await deny(call('download',{id:r.archive.id,fileIndex:0}),'failed-precondition');
  });
  await t.test('render failures and concurrent ledger changes never publish a partial close',async()=>{
    await reset();failRender=true;await assert.rejects(close(await closePreview()),/synthetic/);assert.equal((await call('status')).state.closedThrough,'');assert.equal((await docs('erpMonthCloses')).length,0);
    failRender=false;const pending=await previewMove('입고');renderHook=async()=>{renderHook=null;await commitMove(pending);};await deny(close(await closePreview()),'aborted');assert.equal((await call('status')).state.closedThrough,'');assert.equal((await docs('erpMonthCloses')).length,0);
    await deny(call('closePreview',{month:'2026-12'}),'failed-precondition');await deny(call('closePreview',{month:'2026-99'}),'invalid-argument');
  });
  await t.test('approval alerts show canonical pending requests and disappear only after a decision',async()=>{
    await reset();await grant('member','BOTH');assert.equal((await call('approvalAlerts')).pendingCount,0);
    const job=await correction(),q=await commitCor(job);await commitCor(job);
    let alerts=await call('approvalAlerts');assert.equal(alerts.pendingCount,1);assert.equal(alerts.items[0].id,q.approvalId);assert.equal(alerts.items[0].request,undefined);assert.equal(alerts.items[0].summary,undefined);
    await deny(call('approvalAlerts',{},'member'));assert.equal((await call('approvalAlerts',{},'foreign','b')).pendingCount,0);
    await call('decide',{id:q.approvalId,decision:'APPROVE',reason:'증빙 확인 승인'});assert.equal((await call('approvalAlerts')).pendingCount,0);
    const next=await commitCor(await correction('VALUE','member',{value:'350'}));await call('decide',{id:next.approvalId,decision:'REJECT',reason:'확인 자료 부족'});await call('decide',{id:next.approvalId,decision:'REJECT',reason:'중복 반려 요청'});assert.equal((await call('approvalAlerts')).pendingCount,0);
    const batch=db.batch();for(let i=0;i<102;i++)batch.set(parent().collection('erpApprovals').doc('alert-'+i),{companyId:'a',status:'PENDING',requesterName:'member',createdAt:'2026-12-01',domain:'master',date:'2026-12-01'});await batch.commit();alerts=await call('approvalAlerts');assert.equal(alerts.pendingCount,100);assert.equal(alerts.hasMore,true);assert.equal(alerts.items.length,5);
  });
  await t.test('checklists require every check and evidence or a reason; stale revisions and scopes cannot close',async()=>{
    await reset();const d=(await call('checklistGet',{month:'2026-11'})).checklist;
    await deny(call('checklistGet',{month:d.month},'foreign','a'));await grant('member','BOTH');await deny(call('checklistSave',{month:d.month,revision:d.revision,items:[]},'member'));
    const partial=d.items.map(({key,note},i)=>({key,note,checked:i!==0}));
    const saved=await call('checklistSave',{month:d.month,revision:d.revision,items:partial,noEvidenceReason:'확인 증빙 없음'});assert.equal(saved.ready,false);await deny(close(await closePreview()),'failed-precondition');
    await deny(call('checklistSave',{month:d.month,revision:d.revision,items:partial,noEvidenceReason:'지난 버전'}),'aborted');
    await deny(call('checklistSave',{month:d.month,revision:saved.checklist.revision,items:[null,...partial.slice(1)],noEvidenceReason:''}),'invalid-argument');
    const checked=await completeChecklist({noEvidenceReason:''});assert.equal(checked.ready,false);await deny(close(await closePreview()),'failed-precondition');
    await completeChecklist();const preview=await closePreview();await completeChecklist({noEvidenceReason:'검토 후 사유 변경'});await deny(close(preview),'failed-precondition');
    const readyPreview=await closePreview();assert.equal(readyPreview.checklistReady,true);const closed=await close(readyPreview);
    assert.ok(closed.archive.checklist.items.every(r=>r.checkedBy==='admin'&&r.checkedAt));
    await deny(completeChecklist(),'failed-precondition');
  });
  await t.test('private evidence validates bytes, retries once, locks and preserves each archived version',async()=>{
    await reset();const month='2026-11',png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    const d=(await call('checklistGet',{month})).checklist,id=randomUUID(),input={month,revision:d.revision,id,name:'대사 증빙.png',mimeType:'image/png',base64:png.toString('base64')};
    await deny(call('evidenceUpload',input,'foreign','a'));await grant('member','BOTH');await deny(call('evidenceUpload',input,'member'));
    for(const extra of [{name:'unsafe.html'},{mimeType:'application/pdf'},{base64:'bad'},{base64:Buffer.alloc(5*1024*1024+1).toString('base64')}])await deny(call('evidenceUpload',{...input,...extra}),'invalid-argument');
    const added=await call('evidenceUpload',input);assert.equal(added.checklist.evidence.length,1);assert.equal((await call('evidenceUpload',input)).idempotent,true);
    await deny(call('evidenceUpload',{...input,name:'바꾼 이름.png'}),'already-exists');
    assert.equal((await call('evidenceDownload',{month,id})).base64,input.base64);await deny(call('evidenceDownload',{month,id},'member'));await deny(call('evidenceDownload',{month,id},'foreign','b'),'not-found');
    const descriptor=added.checklist.evidence[0],stored=files.get(descriptor.path);stored.bytes[0]^=1;await deny(call('evidenceDownload',{month,id}),'failed-precondition');await deny(close(await closePreview()),'failed-precondition');stored.bytes[0]^=1;
    const archived=(await close(await closePreview())).archive;assert.equal(archived.checklist.evidence[0].sha256,descriptor.sha256);
    const book=await require('read-excel-file/node').default(Buffer.from((await call('download',{id:archived.id,fileIndex:0})).base64,'base64'));
    assert.equal(book.find(s=>s.sheet==='마감 증빙').data[1][0],input.name);assert.equal(book.find(s=>s.sheet==='마감 체크리스트').data.length,6);
    await deny(call('evidenceRemove',{month,revision:added.checklist.revision,id,reason:'마감 후 제외'}),'failed-precondition');
    await call('reopen',{month,revision:(await call('status')).state.revision,reason:'추가 대사 결과 반영'});
    const reopened=(await call('checklistGet',{month})).checklist;assert.ok(reopened.items.every(r=>!r.checked));await deny(close(await closePreview()),'failed-precondition');
    await call('evidenceRemove',{month,revision:reopened.revision,id,reason:'차기 보관본에서 제외'});await deny(call('evidenceDownload',{month,id}),'not-found');
    await completeChecklist();const v2=(await close(await closePreview())).archive;assert.equal(v2.version,2);assert.equal(v2.checklist.evidence.length,0);
    assert.equal((await call('evidenceDownload',{month,id,archiveId:archived.id})).base64,input.base64);await deny(call('evidenceDownload',{month:'2026-10',id,archiveId:archived.id}),'not-found');
    assert.ok((await docs('erpChangeHistory')).some(r=>r.action==='CLOSE_EVIDENCE_REMOVED'&&r.changes[0].before.evidence.length===1&&r.changes[0].after.evidence.length===0));
  });
  await t.test('checklist edits during report generation abort close and evidence download rechecks revoked access',async()=>{
    await reset();renderHook=async()=>{renderHook=null;await completeChecklist({noEvidenceReason:'보고서 생성 중 확인 수정'});};await deny(close(await closePreview()),'aborted');assert.equal((await docs('erpMonthCloses')).length,0);
    const month='2026-11',id=randomUUID(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
    await call('evidenceUpload',{month,id,revision:(await call('checklistGet',{month})).checklist.revision,name:'검증.png',mimeType:'image/png',base64:png.toString('base64')});
    const original=bucket.file;bucket.file=(path,version)=>{const file=original(path,version),download=file.download;file.download=async()=>{const result=await download();await db.doc('UserProfile/admin').update({role:'MEMBER'});return result;};return file;};
    try{await deny(call('evidenceDownload',{month,id}));}finally{bucket.file=original;await db.doc('UserProfile/admin').update({role:'ADMIN'});}
  });
}finally{await deleteApp(app);}});
