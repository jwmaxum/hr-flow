const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createErpImportService } = require('../erp-import-service');
const { createErpService } = require('../erp-service');
const { createErpCorrectionService } = require('../erp-correction-service');
const { createErpReportService, buildReport } = require('../erp-report-service');
const { workbook, opening, movement } = require('./erp-import-fixtures.cjs');
const M = require('../erp-ledger-model');
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) throw new Error('Ledger tests require loopback Firestore.');
process.env.METADATA_SERVER_DETECTION = 'none';
const projectId='demo-erp-phase3',app=initializeApp({projectId},'erp-ledger-tests'),db=getFirestore(app);
const now=()=>new Date('2026-11-12T12:00:00Z');let sequence=0;const blobs=new Map();
const bucket={file:path=>({save:async(buffer,opts)=>{if(blobs.has(path))throw Object.assign(new Error('exists'),{code:412});blobs.set(path,{buffer,meta:{...opts.metadata,size:buffer.length,generation:String(++sequence)}});},getMetadata:async()=>[blobs.get(path).meta]})};
const imports=createErpImportService({db,bucket,now}),masters=createErpService({db,now}),corrections=createErpCorrectionService({db,now}),reports=createErpReportService({db,now});
const request=(data,uid='admin',companyId='a')=>({data:{companyId,...data},...(uid?{auth:{uid,token:{auth_time:now().getTime()/1000}}}:{})});
const reject=(promise,code)=>assert.rejects(promise,error=>error.code===code);
const parent=()=>db.doc('companies/a');
const movements=async()=> (await parent().collection('erpMovements').get()).docs.map(doc=>({...doc.data(),id:doc.id})).sort(M.compare);
const stocks=async()=> (await parent().collection('erpInventory').get()).docs.map(doc=>doc.data());
async function reset(){
 const r=await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,{method:'DELETE'});assert.equal(r.status,200);blobs.clear();
 const batch=db.batch();for(const id of ['a','b'])batch.set(db.doc(`companies/${id}`),{status:'ACTIVE',accessUntil:Timestamp.fromDate(new Date('2027-01-01'))});
 for(const [uid,role,companyId] of [['admin','ADMIN','a'],['foreign','ADMIN','b'],['member','MEMBER','a'],['manager','SUB_ADMIN','a'],['root','SUPER_ADMIN','PLATFORM']])batch.set(db.doc(`UserProfile/${uid}`),{uid,role,companyId,status:'ACTIVE'});
 await batch.commit();await masters(request({action:'save',kind:'warehouses',id:'warehouse',expectedRevision:0,values:{code:'WH-01',name:'본사 창고',active:true,notes:'',address:''}}));
}
async function post(type,rows){const source=await workbook(type,rows);const r=await imports(request({action:'preview',id:`upload-${++sequence}`,type,source,options:{allowNewItems:true,allowNewPartners:true}}));assert.equal(r.import.preview.canCommit,true,JSON.stringify(r.import.preview.errors));return imports(request({action:'commit',id:r.import.id,fingerprint:r.import.preview.fingerprint}));}
async function base(){await reset();await post('OPENING',[opening()]);await post('MOVEMENTS',[movement(),movement({1:2,2:'출고',3:'OUT-001',11:5,12:300})]);return movements();}
const preview=async(input,id=`correction-${++sequence}`)=>(await corrections(request({action:'preview',id,input:{date:'2026-11-03',reason:'자동 점검 사유',...input}}))).correction;
const commit=job=>corrections(request({action:'commit',id:job.id,fingerprint:job.fingerprint}));
const filters={from:'2026-11-02',to:'2026-11-30',search:'',itemId:'',warehouseId:''};
const report=(extra={},uid='admin',companyId='a')=>reports(request({action:'report',filters,view:'summary',...extra},uid,companyId));
async function returned(type,source,qty){const job=await preview({type,sourceId:source.id,quantity:String(qty)});await commit(job);return job;}
test('ERP correction and period ledger integration',async t=>{try{
 await t.test('period opening, net receipts/issues, margin and detail/export share one revision',async()=>{
  const rows=await base(),r=await report();assert.equal(r.rows.length,1);assert.deepEqual([r.rows[0].openingQuantity,r.rows[0].inQuantity,r.rows[0].outQuantity,r.rows[0].closingQuantity],[10,10,5,15]);
  assert.deepEqual([r.totals.openingValue,r.totals.inValue,r.totals.outValue,r.totals.closingValue,r.totals.salesKRW,r.totals.marginKRW],[1000,2000,750,2250,1500,750]);
  const detail=await report({view:'detail'});assert.equal(detail.rows.length,2);assert.equal(detail.rows[1].balanceValue,2250);assert.equal(detail.rows[1].price,300);
  const exported=await reports(request({action:'export',filters,view:'summary',revision:r.revision,snapshot:r.snapshot}));assert.deepEqual(exported.rows,r.rows);assert.deepEqual(exported.totals,r.totals);
  const next=await report({filters:{...filters,from:'2026-11-03'}});assert.equal(next.rows[0].openingValue,2250);assert.equal(next.rows[0].inQuantity,0);assert.equal(next.rows[0].closingQuantity,15);
  const scoped=await report({filters:{...filters,itemId:rows[0].itemId,warehouseId:rows[0].warehouseId}});assert.deepEqual(scoped.rows,r.rows);
 });
 await t.test('sales returns restore original cost, enforce cumulative quantity and preserve final rounding',async()=>{
  const rows=await base(),out=rows.find(r=>r.direction==='출고');const before=await parent().collection('erpMovements').doc(out.id).get();
  const first=await returned('SALES_RETURN',out,2);assert.equal(first.rows[0].afterQuantity,17);assert.equal(first.rows[0].afterValue,2550);assert.equal(first.rows[0].refundKRW,600);
  await returned('SALES_RETURN',out,3);assert.equal((await stocks())[0].value,3000);await reject(preview({type:'SALES_RETURN',sourceId:out.id,quantity:'0.0001'}),'failed-precondition');
  const r=await report();assert.equal(r.rows[0].outQuantity,0);assert.equal(r.totals.salesKRW,0);assert.equal(r.totals.cogsKRW,0);assert.deepEqual((await parent().collection('erpMovements').doc(out.id).get()).data(),before.data());
  assert.deepEqual([M.allocation(1,0,1,3),M.allocation(1,1,1,3),M.allocation(1,2,1,3)],[0,1,0]);
 });
 await t.test('purchase returns use current moving average and retain separate original refund',async()=>{
  const rows=await base(),incoming=rows.find(r=>r.type==='MOVEMENTS'&&r.direction==='입고');const job=await returned('PURCHASE_RETURN',incoming,3);
  assert.equal(job.rows[0].afterQuantity,12);assert.equal(job.rows[0].afterValue,1800);assert.equal(job.rows[0].refundKRW,600);
  assert.equal(job.rows[0].effect.inValue,-450);const r=await report();assert.equal(r.totals.closingValue,1800);assert.equal(r.totals.marginKRW,750);
 });
 await t.test('full document cancellation appends exact inverse and duplicate confirmation is idempotent',async()=>{
  const rows=await base(),out=rows.find(r=>r.direction==='출고'),job=await preview({type:'CANCEL',sourceId:out.id});
  const results=await Promise.all([commit(job),commit(job)]);assert.equal(results.filter(r=>r.idempotent).length,1);assert.equal((await stocks())[0].quantity,20);assert.equal((await stocks())[0].value,3000);
  assert.equal((await movements()).length,4);const r=await report();assert.equal(r.totals.salesKRW,0);assert.equal(r.rows[0].outQuantity,0);
  const after=await report({filters:{...filters,from:'2026-11-03'}});assert.equal(after.rows[0].openingQuantity,15);assert.equal(after.rows[0].outQuantity,-5);assert.equal(after.rows[0].closingQuantity,20);
  await reject(preview({type:'CANCEL',sourceId:out.id}),'failed-precondition');await reject(preview({type:'CANCEL',sourceId:(await movements()).at(-1).id}),'failed-precondition');
 });
 await t.test('later affected rows prevent cancellation; multi-line same-item documents reverse in descending order',async()=>{
  const rows=await base();await reject(preview({type:'CANCEL',sourceId:rows.find(r=>r.direction==='입고').id}),'failed-precondition');
  await reset();await post('OPENING',[opening()]);await post('MOVEMENTS',[movement({2:'출고',3:'MULTI',11:2,12:300}),movement({2:'출고',3:'MULTI',4:2,11:3,12:300})]);
  const original=(await movements()).find(r=>r.type==='MOVEMENTS'),job=await preview({type:'CANCEL',sourceId:original.id});assert.equal(job.rows.length,2);await commit(job);assert.equal((await stocks())[0].quantity,10);assert.equal((await stocks())[0].value,1000);
 });
 await t.test('opening cancellation preserves closing baseline and is reported as an adjustment',async()=>{
  await reset();await post('OPENING',[opening()]);const first=(await movements())[0];await commit(await preview({type:'CANCEL',sourceId:first.id}));
  const r=await report();assert.equal(r.rows[0].openingQuantity,10);assert.equal(r.rows[0].adjustQuantity,-10);assert.equal(r.rows[0].closingValue,0);
 });
 await t.test('count and value adjustments, cancellation and final depletion reconcile exactly',async()=>{
  const rows=await base(),pair={itemId:rows[0].itemId,warehouseId:rows[0].warehouseId};
  await commit(await preview({type:'COUNT',...pair,quantity:'18',value:'450'}));assert.equal((await stocks())[0].value,2700);
  await commit(await preview({type:'VALUE',...pair,value:'2600'}));const valueRow=(await movements()).at(-1);await commit(await preview({type:'CANCEL',sourceId:valueRow.id}));assert.equal((await stocks())[0].value,2700);
  await commit(await preview({type:'COUNT',...pair,quantity:'10'}));assert.equal((await stocks())[0].value,1500);
  await commit(await preview({type:'COUNT',...pair,quantity:'0'}));assert.equal((await stocks())[0].value,0);
  await reject(preview({type:'VALUE',...pair,value:'1'}),'failed-precondition');await reject(preview({type:'COUNT',...pair,quantity:'2'}),'invalid-argument');
  const r=await report();assert.equal(r.rows[0].closingQuantity,0);assert.equal(r.rows[0].adjustQuantity,-15);assert.equal(r.rows[0].adjustValue,-2250);
 });
 await t.test('cancelling a latest return restores the source remaining quantity without deleting history',async()=>{
  const out=(await base()).find(r=>r.direction==='출고');await returned('SALES_RETURN',out,2);const ret=(await movements()).at(-1);await commit(await preview({type:'CANCEL',sourceId:ret.id}));
  assert.equal((await stocks())[0].quantity,15);await returned('SALES_RETURN',out,5);assert.equal((await stocks())[0].quantity,20);assert.equal((await report()).totals.salesKRW,0);
 });
 await t.test('stale/concurrent preview revalidation prevents over-return and changed master application',async()=>{
  const out=(await base()).find(r=>r.direction==='출고');const a=await preview({type:'SALES_RETURN',sourceId:out.id,quantity:'4'}),b=await preview({type:'SALES_RETURN',sourceId:out.id,quantity:'4'});
  const results=await Promise.allSettled([commit(a),commit(b)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await stocks())[0].quantity,19);
  const pending=await preview({type:'VALUE',itemId:out.itemId,warehouseId:out.warehouseId,value:'2800'});await db.doc('companies/a/erpWarehouses/warehouse').update({name:'변경 창고'});await reject(commit(pending),'failed-precondition');
  await reject(preview({type:'SALES_RETURN',sourceId:out.id,quantity:'1',date:'2026-11-02'}),'failed-precondition');
 });
 await t.test('readers receive quantity-only projections in screen and Excel; all writes remain administrator-only',async()=>{
  const out=(await base()).find(r=>r.direction==='출고');await returned('SALES_RETURN',out,1);
  for(const uid of ['member','manager'])for(const action of ['report','export'])for(const view of ['summary','detail']){
   const prior=await report({view},uid);const r=await reports(request({action,filters,view,...(action==='export'?{revision:prior.revision,snapshot:prior.snapshot}:{})},uid));const json=JSON.stringify(r);
   for(const key of ['closingValue','openingValue','salesKRW','marginKRW','refundKRW','partnerName','price','effect','reason','supply','cogsKRW'])assert.equal(json.includes(`"${key}"`),false,`${uid} ${action} ${view} ${key}`);
  }
  for(const uid of ['member','manager','root','foreign',null])await reject(corrections(request({action:'preview',id:'unauthorized',input:{type:'CANCEL',sourceId:out.id,date:'2026-11-03',reason:'권한 확인'}},uid)),uid?'permission-denied':'unauthenticated');
  await reject(report({},'foreign','a'),'permission-denied');await reject(report({filters:{...filters,itemId:'foreign-item'}}),'not-found');
  await db.doc('UserProfile/admin').update({status:'SUSPENDED'});await reject(report(),'permission-denied');
 });
 await t.test('paging and export reject changed revisions; historical name search retains all item history',async()=>{
  await reset();await post('OPENING',Array.from({length:105},(_,i)=>opening({0:i+1,1:`I-${String(i).padStart(3,'0')}`,2:`품목 ${i}`})));
  const r=await report();assert.equal(r.rows.length,100);assert.equal(r.totalRows,105);const next=await report({cursor:r.nextCursor});assert.equal(next.rows.length,5);assert.equal(new Set([...r.rows,...next.rows].map(row=>row.itemId)).size,105);assert.deepEqual(next.totals,r.totals);
  await db.doc(`companies/a/erpItems/${r.rows[0].itemId}`).update({name:'변경된 이름',revision:2});
  await reject(report({cursor:r.nextCursor}),'failed-precondition');await reject(reports(request({action:'export',filters,view:'summary',revision:r.revision,snapshot:r.snapshot})),'failed-precondition');
  const row=r.rows[0];await commit(await preview({type:'COUNT',itemId:row.itemId,warehouseId:row.warehouseId,quantity:'9'}));
  await reject(report({cursor:r.nextCursor}),'failed-precondition');await reject(reports(request({action:'export',filters,view:'summary',revision:r.revision})),'failed-precondition');
  await reject(report({cursor:{...r.nextCursor,signature:'bad'}}),'failed-precondition');
  const historical=await report({filters:{...filters,search:row.name}});assert.equal(historical.rows.length,1);assert.equal(historical.rows[0].closingQuantity,9);
 });
 await t.test('malformed requests, revoked sessions, negative adjustments and corrupted ledger fail closed',async()=>{
  const rows=await base(),out=rows.at(-1);const job=await preview({type:'CANCEL',sourceId:out.id});
  await reject(corrections(request({action:'commit',id:job.id,fingerprint:'bad'})),'failed-precondition');
  await reject(preview({type:'VALUE',itemId:out.itemId,warehouseId:out.warehouseId,value:'-1'}),'invalid-argument');
  await reject(preview({type:'CANCEL',sourceId:out.id,reason:'x'}),'invalid-argument');
  await reject(preview({type:'CANCEL',sourceId:'../secret'}),'invalid-argument');
  await reject(report({filters:{...filters,from:'2026-11-01'}}),'invalid-argument');
  await reject(report({filters:{...filters,to:'2026-02-30'}}),'invalid-argument');
  await db.doc('UserProfile/admin').update({sessionValidAfter:now().getTime()/1000+1});await reject(commit(job),'unauthenticated');
  const broken=structuredClone(rows);broken[1].afterValue+=1;assert.throws(()=>buildReport(broken,filters),error=>error.code==='failed-precondition');
 });
 await t.test('200-row opening document cancels atomically and the report reconciles every warehouse balance',async()=>{
  await reset();await post('OPENING',Array.from({length:200},(_,i)=>opening({0:i+1,1:`BULK-${i}`,2:`일괄 품목 ${i}`})));
  const rows=await movements(),job=await preview({type:'CANCEL',sourceId:rows[0].id});assert.equal(job.rows.length,200);await commit(job);
  assert.equal((await stocks()).every(stock=>stock.quantity===0&&stock.value===0),true);const r=await report();assert.equal(r.totalRows,200);assert.equal(r.totals.closingValue,0);assert.equal(r.totals.adjustValue,-200000);
 });
}finally{await deleteApp(app);}});
