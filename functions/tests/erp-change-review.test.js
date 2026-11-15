const {test}=require('node:test');
const assert=require('node:assert/strict');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,Timestamp}=require('firebase-admin/firestore');
const {createErpControlService}=require('../erp-control-service');
const {projectReview}=require('../erp-change-review');
if(!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw Error('Loopback emulator required');
process.env.METADATA_SERVER_DETECTION='none';
const projectId='demo-erp-change-review',app=initializeApp({projectId},projectId),db=getFirestore(app),now=()=>new Date('2026-11-15T00:00:00Z');
const service=createErpControlService({db,now}),parent=db.doc('companies/a');
const call=(extra={},uid='admin',companyId='a')=>service({data:{action:'review',companyId,from:'2026-11-12',to:'2026-11-12',...extra},auth:{uid,token:{auth_time:now().getTime()/1000}}});
const deny=(p,code='permission-denied')=>assert.rejects(p,e=>e.code===code);
const record=(id,changes,extra={})=>({id,companyId:'a',operationId:id,at:'2026-11-12T01:00:00.000Z',actorId:'manager',actorName:'ERP 담당자',actorErpAccess:'MANAGER',authorization:'ERP_MANAGER_DIRECT',domain:'correction',action:'commit',part:1,parts:1,changes,...extra});
const inventory={path:'erpInventory/stock',before:{itemId:'item',warehouseId:'wh',quantity:2,value:200},after:{itemId:'item',warehouseId:'wh',quantity:3,value:300}};
async function reset(){
  assert.equal((await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,{method:'DELETE'})).status,200);
  const b=db.batch();for(const id of ['a','b'])b.set(db.doc('companies/'+id),{status:'ACTIVE',accessUntil:Timestamp.fromDate(new Date('2027-01-01'))});
  for(const [uid,role,companyId,erpAccess] of [['admin','ADMIN','a',''],['manager','SUB_ADMIN','a','MANAGER'],['operator','MEMBER','a','BOTH'],['plain','SUB_ADMIN','a',''],['foreign','ADMIN','b','']])b.set(db.doc('UserProfile/'+uid),{uid,name:uid,role,companyId,erpAccess,status:'ACTIVE'});
  await b.commit();
}
test('change review projection counts split operations once and preserves readable before/after values',()=>{
  const rows=projectReview([record('p1',[inventory],{operationId:'operation',parts:2}),record('p2',[{path:'erpMovements/sale',before:null,after:{itemId:'item',name:'검증 품목',warehouseId:'wh',warehouseName:'본사',quantity:1,documentNo:'OUT-1'}}],{operationId:'operation',part:2,parts:2})]);
  assert.equal(rows.length,1);assert.equal(rows[0].incomplete,false);assert.deepEqual(rows[0].categories,['STOCK','TRADE']);assert.equal(rows[0].changes[0].label,'검증 품목');assert.equal(rows[0].changes[0].warehouseName,'본사');assert.deepEqual(rows[0].changes[0].values[0],{label:'수량',before:'2',after:'3'});
  const cancelled=projectReview([record('cancel',[{path:'erpIssuedDocuments/invoice',before:{status:'ISSUED',input:{currency:'USD'},snapshot:{totals:{totalMinor:1100}}},after:{status:'CANCELLED',input:{currency:'USD'},snapshot:{totals:{totalMinor:0}}}}])])[0];
  assert.deepEqual(cancelled.categories,['DOCUMENT','DELETE']);assert.equal(cancelled.changes[0].values.at(-1).before,'11 USD');
  assert.equal(projectReview([record('p1',[inventory],{parts:2})])[0].incomplete,true);
  const draft={input:{currency:'USD'},preview:{rows:[{code:'P',description:'상품',quantityScaled:20000,priceScaled:15000,supplyMinor:300,taxMinor:30,notes:'private'}],totals:{supplyMinor:300,taxMinor:30,totalMinor:330}}};
  const revised=structuredClone(draft);revised.preview.rows[0].quantityScaled=10000;revised.preview.rows[0].supplyMinor=150;revised.preview.rows[0].taxMinor=15;revised.preview.totals={supplyMinor:150,taxMinor:15,totalMinor:165};
  const detail=projectReview([record('edit',[{path:'erpIssuedDocuments/draft',before:draft,after:revised}])])[0].changes[0].values;
  assert.deepEqual(detail.find(v=>v.label==='1행 수량'),{label:'1행 수량',before:'2',after:'1'});
  assert.deepEqual(detail.find(v=>v.label==='문서 합계'),{label:'문서 합계',before:'3.3 USD',after:'1.65 USD'});
  assert.ok(!JSON.stringify(detail).includes('private'));
});
test('ADMIN and ERP manager review tenant changes with dates, filters and stable pagination',async t=>{try{
  await t.test('period summaries deduplicate operations and use Seoul processing dates without writes',async()=>{
    await reset();const rows=[record('part1',[inventory],{operationId:'one',parts:2,at:'2026-11-11T15:00:00.000Z'}),record('part2',[{path:'erpIssuedDocuments/a',before:{status:'ISSUED'},after:{status:'CANCELLED',number:'ST-1'}}],{operationId:'one',part:2,parts:2,at:'2026-11-11T15:00:00.000Z'}),record('excluded',[inventory],{at:'2026-11-11T14:59:59.000Z'})];
    for(const r of rows)await parent.collection('erpChangeHistory').doc(r.id).set(r);
    const result=await call({},'manager');assert.equal(result.total,1);assert.equal(result.rows[0].historyIds.length,2);assert.equal(result.categories.find(c=>c.key==='STOCK').count,1);assert.equal(result.categories.find(c=>c.key==='DELETE').count,1);assert.equal((await call({category:'MASTER'})).filteredTotal,0);
    assert.equal((await parent.collection('erpChangeHistory').get()).size,3);assert.equal((await parent.collection('erpAudit').get()).size,0);
    for(const uid of ['operator','plain','foreign'])await deny(call({},uid));await deny(call({},'manager','b'));
    await db.doc('UserProfile/manager').update({erpAccess:'BOTH'});await deny(call({},'manager'));
  });
  await t.test('pagination has no missing operations and refuses stale cursors',async()=>{
    await reset();const batch=db.batch();for(let i=0;i<35;i++)batch.set(parent.collection('erpChangeHistory').doc('row-'+i),record('row-'+i,[inventory]));await batch.commit();
    const first=await call();assert.equal(first.total,35);assert.equal(first.rows.length,30);const second=await call({cursor:first.nextCursor});assert.equal(second.rows.length,5);assert.equal(new Set([...first.rows,...second.rows].map(r=>r.id)).size,35);
    await parent.collection('erpChangeHistory').doc('new').set(record('new',[inventory]));await deny(call({cursor:first.nextCursor}),'aborted');
    await deny(call({from:'2026-01-01'}),'invalid-argument');await deny(call({category:'UNKNOWN'}),'invalid-argument');
  });
  await t.test('incomplete or foreign history fails closed instead of displaying partial totals',async()=>{
    await reset();await parent.collection('erpChangeHistory').doc('part').set(record('part',[inventory],{parts:2}));await deny(call(),'failed-precondition');
    await parent.collection('erpChangeHistory').doc('part').update({parts:1,companyId:'b'});await deny(call());
  });
}finally{await deleteApp(app);}});
