const {test}=require('node:test');
const assert=require('node:assert/strict');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,Timestamp}=require('firebase-admin/firestore');
const {createErpControlService}=require('../erp-control-service');
const {CHECKS}=require('../erp-close-checklist');
const M=require('../erp-ledger-model');
const {erpMaster}=require('../erp-service');
if(!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw Error('Loopback emulator required');
process.env.METADATA_SERVER_DETECTION='none';
const projectId='demo-erp-work-queue',app=initializeApp({projectId},projectId),db=getFirestore(app);
let clock='2026-11-13T15:05:00Z';const now=()=>new Date(clock),parent=db.doc('companies/a');
const control=createErpControlService({db,now});
const req=(data={},uid='admin',companyId='a')=>({data:{companyId,action:'workQueue',...data},...(uid?{auth:{uid,token:{auth_time:now().getTime()/1000}}}:{})});
const queue=(uid='admin',companyId='a')=>control(req({},uid,companyId));
const get=(result,key)=>result.sections.find(s=>s.key===key);
const deny=(p,code='permission-denied')=>assert.rejects(p,e=>e.code===code);
const docId=M.hash(erpMaster.normalize('OUT-1'));
async function reset(){
  assert.equal((await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,{method:'DELETE'})).status,200);
  clock='2026-11-13T15:05:00Z';const batch=db.batch();
  for(const id of ['a','b'])batch.set(db.doc('companies/'+id),{nameKo:id,status:'ACTIVE',accessUntil:Timestamp.fromDate(new Date('2027-01-01'))});
  for(const [uid,role,companyId,erpAccess]of [['admin','ADMIN','a',''],['in','MEMBER','a','INBOUND'],['out','MEMBER','a','OUTBOUND'],['both','MEMBER','a','BOTH'],['manager','SUB_ADMIN','a','MANAGER'],['view','MEMBER','a','VIEW'],['none','MEMBER','a',''],['foreign','ADMIN','b',''],['root','SUPER_ADMIN','PLATFORM','']])batch.set(db.doc('UserProfile/'+uid),{uid,name:uid,role,companyId,erpAccess,status:'ACTIVE'});
  const put=(collection,id,value)=>batch.set(parent.collection(collection).doc(id),{companyId:'a',...value});
  for(const uid of ['in','out','both','manager','view'])put('erpApprovals','approval-'+uid,{requestedBy:uid,requesterName:uid,status:'PENDING',createdAt:'2026-11-13T00:00:00Z',date:'2026-11-13',domain:'master',request:{PRIVATE_REQUEST:'never project'},summary:[],reason:'검증 요청'});
  put('erpApprovals','finished',{requestedBy:'in',status:'APPROVED',createdAt:'2026-11-12T00:00:00Z'});
  put('erpItems','pending',{code:'WAIT',name:'원가 대기',unit:'EA',active:true,pendingOpening:{status:'PENDING_COST',basisDate:'2026-11-11',quantity:209,unit:'EA',source:'원본'}});
  put('erpBorrowings','loan',{code:'BORROW',name:'차용상품',unit:'EA',warehouseName:'본사',ownerName:'원소유자',date:'2026-11-12',quantityScaled:30000,outstandingQuantityScaled:30000,outstandingValue:900});
  put('erpMovements','sale',{type:'MOVEMENTS',direction:'출고',date:'2026-11-12',documentNo:'OUT-1',partnerId:'buyer',partnerName:'검증 고객',currency:'KRW',supply:1000,tax:100,paymentTerms:'CREDIT'});
  put('erpSettlements','terms',{type:'TERMS',documentId:docId,partnerId:'buyer',currency:'KRW',date:'2026-11-12',dueDate:'2026-11-13',sequence:1});
  put('erpSettlements','follow',{type:'FOLLOW_UP',documentId:docId,partnerId:'buyer',currency:'KRW',date:'2026-11-12',expectedDate:'2026-11-14',assigneeId:'admin',assigneeName:'관리자',notes:'PRIVATE_NOTE',sequence:2});
  put('erpReceipts','receipt',{type:'RECEIPT',date:'2026-11-13',partnerId:'buyer',partnerName:'검증 고객',currency:'KRW',amountMinor:600,reference:'PRIVATE_BANK'});
  put('erpClosePlans','2026-10',{month:'2026-10',status:'OPEN',dueDate:'2026-11-14',ownerUid:'admin',ownerName:'관리자',revision:1,assigneeUids:['admin','in'],notes:'PRIVATE_PLAN',items:CHECKS.map(([key])=>({key,assigneeUid:'in',assigneeName:'입고 담당',submission:null}))});
  put('erpIssuedDocuments','draft',{kind:'STATEMENT',status:'DRAFT',replacesId:'old',replacesNumber:'ST-01',updatedAt:now().toISOString(),input:{sourceDocumentNo:'OUT-1'}});
  put('erpIssuedDocuments','original',{kind:'STATEMENT',status:'DRAFT',updatedAt:now().toISOString(),input:{sourceDocumentNo:'OUT-2'}});
  await batch.commit();
}
test('role-aware work queue stays read-only and reconciles existing workflows',async t=>{try{
  await t.test('ADMIN sees each category with Seoul dates, correct references and minimal projections',async()=>{
    await reset();await parent.collection('erpApprovals').doc('approval-in').update({createdAt:now().toISOString()});const before=(await parent.collection('erpAudit').get()).size,r=await queue();
    assert.equal(r.today,'2026-11-14');assert.equal(r.access,'ADMIN');assert.equal(r.sections.length,6);assert.ok(r.sections.every(s=>s.status==='READY'));
    assert.equal(get(r,'approvals').count,5);assert.equal(get(r,'approvals').rows.find(row=>row.id==='approval-in').date,'2026-11-14');assert.equal(get(r,'statements').rows[0].date,'2026-11-14');assert.equal(get(r,'closing').rows[0].source,'2026-10');assert.equal(get(r,'closing').rows[0].badge,'오늘 마감');
    const recovery=get(r,'recovery').rows[0];assert.equal(recovery.amountMinor,1100);assert.equal(recovery.unallocatedMinor,600);assert.equal(recovery.badge,'수금 배분 확인');assert.equal(recovery.source,'OUT-1');assert.equal(recovery.date,'2026-11-14');
    assert.equal(get(r,'borrowed').rows[0].quantity,3);assert.equal(get(r,'borrowed').rows[0].dateLabel,'차용일');assert.equal(get(r,'opening').rows[0].quantity,209);assert.equal(get(r,'statements').count,1);assert.equal(get(r,'statements').rows[0].draftId,'draft');
    assert.ok(!JSON.stringify(r).includes('PRIVATE_'));assert.equal((await parent.collection('erpAudit').get()).size,before);
  });
  await t.test('each lower ERP role sees only own pending requests and assigned work, never finance or customer data',async()=>{
    await reset();await parent.collection('erpMovements').doc('sale').update({companyId:'b'});
    for(const uid of ['in','out','both','manager','view']){
      const r=await queue(uid);assert.deepEqual(r.sections.map(s=>s.key),['approvals','closing']);assert.ok(r.sections.every(s=>s.status==='READY'));
      assert.equal(get(r,'approvals').count,1);assert.equal(get(r,'approvals').rows[0].source,'approval-'+uid);
      assert.equal(get(r,'closing').count,uid==='in'?1:0);assert.ok(!JSON.stringify(r).includes('검증 고객'));assert.ok(!JSON.stringify(r).includes('원소유자'));
    }
    for(const uid of ['none','foreign','root'])await deny(queue(uid));await deny(control(req({},null)),'unauthenticated');
    await deny(control(req({access:'ADMIN'},'view')),'invalid-argument');await db.doc('UserProfile/view').update({status:'RESIGNED'});await deny(queue('view'));
  });
  await t.test('row links recheck ownership; approved, repaid and confirmed work disappears',async()=>{
    await reset();const own=await control(req({action:'approvals',id:'approval-in'},'in'));assert.equal(own.requests[0].id,'approval-in');assert.equal(own.requests[0].request,undefined);
    await deny(control(req({action:'approvals',id:'approval-out'},'in')));await deny(control(req({action:'approvals',id:'approval-in',cursor:'x'})),'invalid-argument');
    await parent.collection('erpApprovals').doc('approval-in').update({status:'APPROVED'});await parent.collection('erpBorrowings').doc('loan').update({outstandingQuantityScaled:0});await parent.collection('erpItems').doc('pending').update({'pendingOpening.status':'CONFIRMED'});
    await parent.collection('erpIssuedDocuments').doc('draft').update({status:'ISSUED'});
    let r=await queue();assert.equal(get(r,'statements').count,0);assert.equal(get(r,'approvals').count,4);assert.equal(get(r,'borrowed').count,0);assert.equal(get(r,'opening').count,0);
    await parent.collection('erpClosePlans').doc('2026-10').update({items:CHECKS.map(([key])=>({key,assigneeUid:'in',assigneeName:'입고',submission:{by:'in',at:now().toISOString(),note:'완료'}}))});
    assert.equal(get(await queue('in'),'closing').count,0);assert.equal(get(await queue(),'closing').count,1);
    await parent.collection('erpClosePlans').doc('2026-10').update({status:'CLOSED'});assert.equal(get(await queue(),'closing').count,0);
  });
  await t.test('allocations, returns and future dates use net document balances without inventing collection amounts',async()=>{
    await reset();await parent.collection('erpSettlements').doc('allocation').set({companyId:'a',type:'ALLOCATE',date:'2026-11-13',partnerId:'buyer',currency:'KRW',receiptId:'receipt',sequence:3,lines:[{documentId:docId,amountMinor:600}]});
    let row=get(await queue(),'recovery').rows[0];assert.equal(row.amountMinor,500);assert.equal(row.unallocatedMinor,0);assert.equal(row.badge,'기한 경과');
    await parent.collection('erpMovements').doc('return').set({companyId:'a',type:'CORRECTION',operationType:'SALES_RETURN',sourceId:'sale',date:'2026-11-14',currency:'KRW',refundSupply:500,refundTax:50});assert.equal(get(await queue(),'recovery').count,0);
    await parent.collection('erpMovements').doc('return').update({date:'2026-11-15'});assert.equal(get(await queue(),'recovery').rows[0].amountMinor,500);
    await parent.collection('erpSettlements').doc('terms').update({dueDate:'2026-11-20'});await parent.collection('erpSettlements').doc('follow').update({expectedDate:'2026-11-21'});row=get(await queue(),'recovery').rows[0];assert.equal(row.priority,2);assert.equal(row.badge,'회수 예정');
  });
  await t.test('failed categories are unknown, capped counts are explicit and permissions are rechecked after reads',async()=>{
    await reset();await parent.collection('erpMovements').doc('sale').update({companyId:'b'});let r=await queue();assert.equal(get(r,'recovery').status,'ERROR');assert.equal(get(r,'recovery').count,null);assert.equal(get(r,'opening').status,'READY');
    const batch=db.batch();for(let i=0;i<102;i++)batch.set(parent.collection('erpApprovals').doc('many-'+i),{companyId:'a',status:'PENDING',requestedBy:'in',createdAt:'2026-11-13T01:00:00Z'});await batch.commit();r=await queue('in');assert.equal(get(r,'approvals').count,100);assert.equal(get(r,'approvals').hasMore,true);assert.equal(get(r,'approvals').rows.length,10);
    let changed=false;const proxy=new Proxy(db,{get(target,key){if(key==='runTransaction')return async callback=>{const result=await db.runTransaction(callback);if(!changed){changed=true;await db.doc('UserProfile/in').update({erpAccess:'NONE'});}return result;};const v=target[key];return typeof v==='function'?v.bind(target):v;}});
    await deny(createErpControlService({db:proxy,now})(req({},'in')));
  });
}finally{await deleteApp(app);}});
