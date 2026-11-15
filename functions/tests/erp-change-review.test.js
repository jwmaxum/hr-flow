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
  const action=(action,extra={},uid='admin',companyId='a')=>service({data:{action,companyId,...extra},auth:{uid,token:{auth_time:now().getTime()/1000}}});
  const selected=rows=>rows.map(({id,fingerprint})=>({id,fingerprint}));
  await t.test('ADMIN confirmation is immutable, shared, idempotent and does not change accounting or history',async()=>{
    await reset();await parent.collection('erpChangeHistory').doc('stock').set(record('stock',[inventory]));
    await parent.collection('erpGovernance').doc('control').set({companyId:'a',revision:7,closedThrough:'2026-11-30'});
    const source=(await parent.collection('erpChangeHistory').doc('stock').get()).data(),first=await call();
    assert.equal(first.unreviewedCount,1);assert.equal(first.rows[0].reviewStatus,'UNREVIEWED');
    for(const uid of ['manager','operator','plain','foreign'])await deny(action('reviewConfirm',{items:selected(first.rows)},uid));
    await deny(action('reviewConfirm',{items:selected(first.rows)},'admin','b'));
    assert.equal((await action('reviewConfirm',{items:selected(first.rows)})).confirmed,1);
    assert.equal((await action('reviewConfirm',{items:selected(first.rows)})).alreadyConfirmed,1);
    const after=await call();assert.equal(after.unreviewedCount,0);assert.equal(after.reviewedCount,1);assert.equal(after.rows[0].confirmation.by,'admin');
    assert.equal((await call({reviewStatus:'UNREVIEWED'})).filteredTotal,0);assert.equal((await call({reviewStatus:'REVIEWED'})).filteredTotal,1);
    assert.deepEqual((await parent.collection('erpChangeHistory').doc('stock').get()).data(),source);
    assert.equal((await parent.collection('erpAudit').get()).size,1);assert.equal((await parent.collection('erpReviewConfirmations').get()).size,1);
    assert.equal((await parent.collection('erpGovernance').doc('control').get()).data().revision,7);
    assert.equal((await parent.collection('erpInventory').get()).size,0);
    await parent.collection('erpChangeHistory').doc('stock').update({reason:'원본에 추가된 변경'});
    assert.equal((await call()).unreviewedCount,1);await deny(action('reviewConfirm',{items:selected(first.rows)}),'failed-precondition');
  });
  await t.test('concurrent ADMINs preserve the first reviewer and invalidate pagination including filters',async()=>{
    await reset();await db.doc('UserProfile/admin2').set({uid:'admin2',name:'두번째 관리자',role:'ADMIN',companyId:'a',status:'ACTIVE'});
    const b=db.batch();for(let i=0;i<31;i++)b.set(parent.collection('erpChangeHistory').doc('item-'+i),record('item-'+i,[inventory]));await b.commit();
    const first=await call({reviewStatus:'UNREVIEWED'}),items=selected(first.rows.slice(0,1));
    const results=await Promise.all([action('reviewConfirm',{items}),action('reviewConfirm',{items},'admin2')]);assert.equal(results.reduce((n,r)=>n+r.confirmed,0),1);
    const receipt=(await parent.collection('erpReviewConfirmations').get()).docs[0].data();assert.ok(['admin','admin2'].includes(receipt.acknowledgedBy));
    await action('reviewConfirm',{items},'admin2');assert.deepEqual((await parent.collection('erpReviewConfirmations').get()).docs[0].data(),receipt);
    await deny(call({reviewStatus:'UNREVIEWED',cursor:first.nextCursor}),'aborted');
    const full=await call();await deny(call({category:'STOCK',cursor:full.nextCursor}),'aborted');
  });
  await t.test('stale, missing or duplicate parts and mixed batches never create partial confirmations',async()=>{
    await reset();for(const id of ['good','bad'])await parent.collection('erpChangeHistory').doc(id).set(record(id,[inventory]));
    const first=await call();await parent.collection('erpChangeHistory').doc('bad').update({parts:2});
    await deny(action('reviewConfirm',{items:selected(first.rows)}),'failed-precondition');assert.equal((await parent.collection('erpReviewConfirmations').get()).size,0);
    await parent.collection('erpChangeHistory').doc('bad2').set(record('bad2',[inventory],{operationId:'bad',parts:2,part:1}));
    await deny(call(),'failed-precondition');await deny(action('reviewConfirm',{items:selected(first.rows)}),'failed-precondition');
    await deny(action('reviewConfirm',{items:[] }),'invalid-argument');await deny(action('reviewConfirm',{items:[...selected(first.rows),...selected(first.rows)]}),'invalid-argument');
    await parent.collection('erpChangeHistory').doc('bad').update({companyId:'b'});await deny(action('reviewConfirm',{items:selected(first.rows)}));
  });
  await t.test('monthly alerts use Seoul boundaries, include price edits and keep reference records separate',async()=>{
    await reset();const rows=[record('before',[inventory],{at:'2026-10-31T14:59:59.999Z'}),record('start',[inventory],{at:'2026-10-31T15:00:00.000Z'}),record('future',[inventory],{at:'2026-11-15T15:00:00.000Z'}),record('price',[{path:'erpItems/x',before:{purchasePrice:1},after:{purchasePrice:2}}]),record('warehouse',[{path:'erpWarehouses/x',before:null,after:{name:'본사'}}])];
    for(const r of rows)await parent.collection('erpChangeHistory').doc(r.id).set(r);
    const alerts=await action('reviewAlerts');assert.equal(alerts.month,'2026-11');assert.equal(alerts.pendingCount,2);await deny(action('reviewAlerts',{},'manager'));
    const day=await call();assert.equal(day.unreviewedCount,1);assert.equal(day.rows.find(r=>r.id==='warehouse').reviewStatus,'NOT_REQUIRED');
    await action('reviewConfirm',{items:selected(day.rows.filter(r=>r.id==='price'))});assert.equal((await action('reviewAlerts')).pendingCount,1);
    await parent.collection('erpChangeHistory').doc('broken').set(record('broken',[inventory],{parts:2}));await deny(action('reviewAlerts'),'failed-precondition');
  });
  await t.test('ADMIN permission is revalidated inside the transaction',async()=>{
    await reset();await parent.collection('erpChangeHistory').doc('stock').set(record('stock',[inventory]));const first=await call();let revoked=false;
    const proxy=new Proxy(db,{get(target,key){if(key==='runTransaction')return async fn=>{if(!revoked){revoked=true;await db.doc('UserProfile/admin').update({role:'SUB_ADMIN',erpAccess:'MANAGER'});}return db.runTransaction(fn);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
    await deny(createErpControlService({db:proxy,now})({data:{action:'reviewConfirm',companyId:'a',items:selected(first.rows)},auth:{uid:'admin',token:{auth_time:now().getTime()/1000}}}));
    assert.equal((await parent.collection('erpReviewConfirmations').get()).size,0);
  });
}finally{await deleteApp(app);}});
