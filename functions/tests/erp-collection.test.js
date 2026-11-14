const {test}=require('node:test');
const assert=require('node:assert/strict');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,Timestamp}=require('firebase-admin/firestore');
const {createErpService}=require('../erp-service');
const {createErpImportService}=require('../erp-import-service');
const {createErpCorrectionService}=require('../erp-correction-service');
const {createErpFinanceService}=require('../erp-finance-service');
if(!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw Error('Loopback emulator required');
process.env.METADATA_SERVER_DETECTION='none';
const projectId='demo-erp-collections',app=initializeApp({projectId},projectId),db=getFirestore(app),now=()=>new Date('2026-11-12T00:00:00Z');
const masters=createErpService({db,now}),imports=createErpImportService({db,now}),corrections=createErpCorrectionService({db,now}),finance=createErpFinanceService({db,now});
let seq=0;
const req=(data,uid='admin',companyId='a')=>({data:{companyId,...data},...(uid?{auth:{uid,token:{auth_time:now().getTime()/1000}}}:{})});
const parent=()=>db.collection('companies').doc('a');
const records=async name=>(await parent().collection(name).get()).docs.map(d=>({...d.data(),id:d.id}));
const reject=(p,code='failed-precondition')=>assert.rejects(p,e=>e.code===code);
async function save(kind,id,values,revision=0){return (await masters(req({action:'save',kind,id,expectedRevision:revision,values}))).record;}
const itemValues=(code,name)=>({code,name,specification:'',unit:'EA',purchasePrice:0,salePrice:0,taxType:'과세',group:'',notes:'',active:true});
async function reset(initial=true){
  assert.equal((await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,{method:'DELETE'})).status,200);
  const b=db.batch();for(const id of ['a','b'])b.set(db.doc(`companies/${id}`),{status:'ACTIVE',accessUntil:Timestamp.fromDate(new Date('2027-01-01'))});
  for(const [uid,role,companyId]of [['admin','ADMIN','a'],['foreign','ADMIN','b'],['member','MEMBER','a'],['manager','SUB_ADMIN','a'],['root','SUPER_ADMIN','PLATFORM']])b.set(db.doc(`UserProfile/${uid}`),{uid,role,companyId,status:'ACTIVE'});await b.commit();
  await save('warehouses','wh',{code:'WH',name:'본사',address:'',notes:'',active:true});
  for(const id of ['owner','buyer'])await save('partners',id,{code:id,name:id,country:'KR',registrationNumber:'',contactName:'',email:'',phone:'',address:'',type:'BOTH',notes:'',active:true});
  await save('items','part',itemValues('PART','일반품'));await save('items','part2',itemValues('PART2','구성품2'));
  if(initial)await post('입고',[line('PART','10','100')]);
}
function line(code='PART',quantity='2',price='300',extra={}){return {code,name:code==='PART'?'일반품':code==='PART2'?'구성품2':'세트',specification:'',unit:'EA',taxType:'과세',quantity,price,notes:'검증용',...extra};}
async function movementPreview(direction,lines,extra={}){return (await imports(req({action:'manualPreview',id:`move-${++seq}`,movement:{direction,date:'2026-11-12',warehouseId:'wh',partnerId:'buyer',currency:'KRW',exchangeRate:'1',priceBasis:'세금별도',allowNewItems:false,allowNewPartners:false,lines,...(direction==='출고'?{payment:{status:'CREDIT'}}:{}),...extra}}))).import;}
async function commitMovement(job){return imports(req({action:'commit',id:job.id,fingerprint:job.preview.fingerprint}));}
async function post(direction,lines,extra={}){const job=await movementPreview(direction,lines,extra);assert.equal(job.preview.canCommit,true,JSON.stringify(job.preview.errors));await commitMovement(job);return (await records('erpMovements')).filter(r=>r.importId===job.id);}
async function preview(service,input){return (await service(req({action:'preview',id:`job-${++seq}`,input:{date:'2026-11-12',notes:'합성 검증',...input}}))).job;}
async function commit(service,job){return service(req({action:'commit',id:job.id,fingerprint:job.fingerprint}));}
async function correct(type,sourceId,quantity){const input={type,sourceId,date:'2026-11-12',reason:'합성 검증',...(quantity?{quantity}: {})};const j=(await corrections(req({action:'preview',id:`cor-${++seq}`,input}))).correction;await corrections(req({action:'commit',id:j.id,fingerprint:j.fingerprint}));return j;}
const stock=async id=>(await records('erpInventory')).find(r=>r.itemId===id);
const settlements=(to='2026-11-12')=>finance(req({action:'settlementReport',to}));
const settlementPreview=async input=>(await finance(req({action:'settlementPreview',id:`settle-${++seq}`,input:{date:'2026-11-12',notes:'배분 검증',...input}}))).job;
const settle=job=>finance(req({action:'settlementCommit',id:job.id,fingerprint:job.fingerprint}));
async function pendingItem(id='part',quantity=209){await parent().collection('erpItems').doc(id).update({pendingOpening:{status:'PENDING_COST',basisDate:'2026-11-11',quantity,unit:'EA',source:'합성 재고.xlsx 원본!C9'}});}
const collectionInput=(patch={})=>({mode:'NEW',partnerId:'buyer',currency:'KRW',date:'2026-11-12',receivedDate:'2026-11-11',amount:'300',method:'BANK',reference:'COL-001',notes:'실제 입금 확인',confirmDistinct:false,lines:[],...patch});
const collectionPreview=async input=>(await finance(req({action:'collectionPreview',id:`collection-${++seq}`,input}))).job;
const collect=job=>finance(req({action:'collectionCommit',id:job.id,fingerprint:job.fingerprint}));
const reuse=(receiptId,lines,patch={})=>collectionInput({mode:'EXISTING',receiptId,lines,amount:undefined,receivedDate:undefined,method:undefined,reference:undefined,...patch});
test('unified collections preserve receipts, allocations, tenant scope and close locks',async t=>{try{
  await t.test('one new receipt allocates multiple documents atomically; existing funds never create another receipt',async()=>{
    await reset();await post('출고',[line('PART','2','300')]);await post('출고',[line('PART','1','200')]);const docs=(await settlements()).documents,inventory=await records('erpInventory');
    const j=await collectionPreview(collectionInput({amount:'500',lines:docs.map(d=>({documentId:d.id,amount:d.billed===660?'200':'100'}))}));
    assert.deepEqual([j.summary.before,j.summary.after,j.summary.newReceipt,j.summary.allocated,j.summary.unallocatedAfter],[880,380,500,300,200]);
    const results=await Promise.all([collect(j),collect(j)]);assert.equal(results.filter(r=>r.idempotent).length,1);assert.equal((await records('erpReceipts')).length,1);
    const r=(await settlements()).receipts[0],u=await collectionPreview(reuse(r.id,[{documentId:docs.find(d=>d.billed===660).id,amount:'200'}]));
    assert.deepEqual([u.summary.before,u.summary.after,u.summary.reused,u.summary.newReceipt,u.summary.unallocatedAfter],[380,380,200,0,0]);await collect(u);
    assert.equal((await records('erpReceipts')).length,1);assert.equal((await settlements()).summaries[0].balance,380);assert.deepEqual(await records('erpInventory'),inventory);
    assert.equal((await records('erpReceipts'))[0].receivedDate,'2026-11-11');assert.equal((await records('erpChangeHistory')).filter(r=>r.action==='collectionCommit').length,2);
  });
  await t.test('duplicate date/amount or reference requires reviewed distinct-deposit confirmation',async()=>{
    await reset();await post('출고',[line('PART','5','300')]);const first=await collectionPreview(collectionInput());await collect(first);
    const suspect=await collectionPreview(collectionInput({reference:'different'}));assert.equal(suspect.summary.canCommit,false);assert.equal(suspect.summary.duplicates[0].id,first.summary.receiptId);await reject(collect(suspect));
    const sameReference=await collectionPreview(collectionInput({amount:'100',receivedDate:'2026-11-12'}));assert.equal(sameReference.summary.canCommit,false);
    const distinct=await collectionPreview(collectionInput({confirmDistinct:true}));await collect(distinct);assert.equal((await records('erpReceipts')).length,2);assert.deepEqual((await records('erpReceipts')).find(r=>r.id===distinct.summary.receiptId).duplicateAcknowledgement,[first.summary.receiptId]);
    const third=await collectionPreview(collectionInput({amount:'50',reference:'different-new'})),other=await collectionPreview(collectionInput({amount:'50',reference:'different-new'}));await collect(third);await reject(collect(other));assert.equal((await records('erpReceipts')).length,3);
  });
  await t.test('selected receipts enforce gross/net availability, currency, cancellation and changed previews',async()=>{
    await reset();const rows=await post('출고',[line('PART','3','300')]);const doc=(await settlements()).documents[0];const r=await collectionPreview(collectionInput({amount:'700'}));await collect(r);
    await reject(collectionPreview(reuse(r.summary.receiptId,[{documentId:doc.id,amount:'701'}])));
    await reject(collectionPreview(reuse(r.summary.receiptId,[{documentId:doc.id,amount:'100'},{documentId:doc.id,amount:'100'}])),'invalid-argument');
    await reject(collectionPreview(reuse(r.summary.receiptId,[{documentId:doc.id,amount:'100'}],{partnerId:'owner'})));
    await reject(collectionPreview(reuse(r.summary.receiptId,[{documentId:doc.id,amount:'100'}],{currency:'USD'})));
    const stale=await collectionPreview(reuse(r.summary.receiptId,[{documentId:doc.id,amount:'100'}]));await correct('SALES_RETURN',rows[0].id,'2');await reject(collect(stale));
    const refund=await preview(finance,{type:'REFUND',partnerId:'buyer',currency:'KRW',amount:'370',method:'BANK',reference:'refund'});await commit(finance,refund);
    await reject(collectionPreview(reuse(r.summary.receiptId,[{documentId:doc.id,amount:'331'}])));const valid=await collectionPreview(reuse(r.summary.receiptId,[{documentId:doc.id,amount:'330'}]));
    const cancel=await preview(finance,{type:'CANCEL',sourceId:r.summary.receiptId});await commit(finance,cancel);await reject(collect(valid));assert.equal((await records('erpSettlements')).filter(r=>r.sourceKind==='UNIFIED_COLLECTION').length,0);
  });
  await t.test('new endpoints preserve ADMIN-only scope, job identity and monthly closing',async()=>{
    await reset();await post('출고',[line()]);const input=collectionInput(),id=`guard-${++seq}`;
    for(const uid of ['member','manager','foreign','root',''])await reject(finance(req({action:'collectionPreview',id,input},uid)),uid?'permission-denied':'unauthenticated');
    await db.doc('UserProfile/manager').update({erpAccess:'MANAGER'});await reject(finance(req({action:'collectionPreview',id,input},'manager')),'permission-denied');
    const j=(await finance(req({action:'collectionPreview',id,input}))).job;
    await reject(finance(req({action:'collectionPreview',id,input:{...input,amount:'200'}})),'already-exists');
    await reject(finance(req({action:'collectionCommit',id,fingerprint:'wrong'})));
    await parent().collection('erpGovernance').doc('control').set({companyId:'a',revision:1,closedThrough:'2026-11-30',lastClosedMonth:'2026-11'});await reject(collect(j));assert.equal((await records('erpReceipts')).length,0);
    await parent().collection('erpGovernance').doc('control').update({closedThrough:''});await db.doc('UserProfile/admin').update({status:'RESIGNED'});await reject(collect(j),'permission-denied');
  });
  await t.test('fractional currency, malformed input and historical application dates fail safely',async()=>{
    await reset();await post('출고',[line('PART','2','1.25')],{currency:'USD',exchangeRate:'1300',priceBasis:'세금포함'});const d=(await settlements()).documents[0];
    const j=await collectionPreview(collectionInput({currency:'USD',amount:'1.23',lines:[{documentId:d.id,amount:'1.20'}]}));assert.deepEqual([j.summary.newReceipt,j.summary.allocated,j.summary.unallocatedAfter],[123,120,3]);await collect(j);
    for(const patch of [{amount:'0'},{amount:'1.001'},{amount:'-1'},{date:'2026-11-11'},{receivedDate:'2026-11-13'},{lines:[{documentId:d.id,amount:'1',extra:true}]},{lines:Array.from({length:51},()=>({documentId:d.id,amount:'1'}))}])await assert.rejects(collectionPreview(collectionInput({currency:'USD',...patch})));
    assert.equal((await records('erpReceipts')).length,1);
  });
}finally{await deleteApp(app);}});
