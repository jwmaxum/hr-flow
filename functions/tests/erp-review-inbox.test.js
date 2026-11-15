const {test}=require('node:test');
const assert=require('node:assert/strict');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,Timestamp}=require('firebase-admin/firestore');
const {createErpControlService}=require('../erp-control-service');
const {createErpService}=require('../erp-service');
const {projectReview}=require('../erp-change-review');
const {ageDays,recordInbox}=require('../erp-review-inbox');
if(!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw Error('Loopback emulator required');
process.env.METADATA_SERVER_DETECTION='none';
const projectId='demo-erp-review-inbox',app=initializeApp({projectId},projectId),db=getFirestore(app),now=()=>new Date('2026-11-15T00:00:00Z'),parent=db.doc('companies/a');
const service=createErpControlService({db,now});
const request=(action,extra={},uid='admin',companyId='a')=>({data:{action,companyId,...extra},auth:{uid,token:{auth_time:now().getTime()/1000}}});
const call=(action,extra={},uid='admin',companyId='a')=>service(request(action,extra,uid,companyId));
const deny=(p,code='permission-denied')=>assert.rejects(p,e=>e.code===code);
const inventory={path:'erpInventory/stock',before:{quantity:2,value:200},after:{quantity:3,value:300}};
const record=(id,at='2026-11-12T01:00:00.000Z',extra={})=>({companyId:'a',operationId:id,at,actorId:'manager',actorName:'ERP 담당자',domain:'correction',action:'commit',part:1,parts:1,changes:[inventory],...extra});
async function reset(){
  assert.equal((await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,{method:'DELETE'})).status,200);
  const b=db.batch();for(const id of ['a','b'])b.set(db.doc('companies/'+id),{status:'ACTIVE',accessUntil:Timestamp.fromDate(new Date('2027-01-01'))});
  for(const [uid,role,companyId,erpAccess] of [['admin','ADMIN','a',''],['admin2','ADMIN','a',''],['manager','SUB_ADMIN','a','MANAGER'],['operator','MEMBER','a','BOTH'],['foreign','ADMIN','b','']])b.set(db.doc('UserProfile/'+uid),{uid,name:uid,role,companyId,erpAccess,status:'ACTIVE'});await b.commit();
}
async function seed(id,at,extra){await parent.collection('erpChangeHistory').doc(id).set(record(id,at,extra));}
async function ready(extra={}){for(let i=0;i<100;i++){const r=await call('reviewInbox',extra);if(r.ready)return r;assert.equal(r.pendingCount,null);assert.deepEqual(r.rows,[]);}throw Error('Bootstrap did not finish');}
const selection=rows=>rows.map(({id,fingerprint})=>({id,fingerprint}));
test('cumulative review inbox preserves source history, shared confirmations and complete coverage',async t=>{try{
  await t.test('past years, KST calendar boundaries, exclusions and counts are exact after preparation',async()=>{
    await reset();for(const [id,at] of [['years','2024-01-01T00:00:00.000Z'],['prior','2026-10-31T14:59:59.999Z'],['thirty','2026-10-16T14:59:59.999Z'],['seven','2026-11-08T14:59:59.999Z'],['six','2026-11-08T15:00:00.000Z'],['today','2026-11-14T15:00:00.000Z'],['future','2026-11-15T15:00:00.000Z']])await seed(id,at);
    await seed('reference',undefined,{changes:[{path:'erpWarehouses/x',before:null,after:{name:'본사'}}]});
    const first=await call('reviewInbox');assert.equal(first.ready,false);assert.equal(first.pendingCount,null);
    const r=await ready();assert.equal(r.pendingCount,6);assert.equal(r.previousMonthCount,3);assert.equal(r.agedCount,4);assert.equal(r.urgentCount,2);assert.equal(r.rows[0].id,'years');assert.equal(r.rows.find(x=>x.id==='seven').ageDays,7);assert.equal(r.rows.find(x=>x.id==='six').ageDays,6);assert.equal(ageDays('2026-11-14T15:00:00.000Z','2026-11-15'),0);
    assert.equal((await call('reviewInbox',{minDays:7})).filteredTotal,4);assert.equal((await call('reviewInbox',{minDays:30})).filteredTotal,2);
    const alert=await call('reviewAlerts',{scope:'ALL'});assert.equal(alert.pendingCount,6);assert.equal(alert.agedCount,4);assert.equal(alert.rows,undefined);
    assert.equal((await call('reviewInbox',{},'manager')).pendingCount,6);for(const uid of ['manager','operator','foreign'])await deny(call('reviewAlerts',{scope:'ALL'},uid));await deny(call('reviewInbox',{},'admin','b'));
    const work=await call('workQueue',{includeReviews:true,reviewScope:'ALL'});assert.equal(work.sections.find(s=>s.key==='reviews').rows[0].badge,'우선 점검 · '+r.oldestAgeDays+'일');
  });
  await t.test('resumable bootstrap exceeds the old 1000-record limit without partial counts or omissions',async()=>{
    await reset();for(let start=0;start<1001;start+=400){const batch=db.batch();for(let i=start;i<Math.min(1001,start+400);i++)batch.set(parent.collection('erpChangeHistory').doc(String(i).padStart(4,'0')),record('event-'+i,'2025-01-01T00:00:00.000Z'));await batch.commit();}
    const r=await ready();assert.equal(r.pendingCount,1001);assert.equal(r.agedCount,1001);assert.equal((await parent.collection('erpReviewState').doc('inbox').get()).data().processed,1001);
    const second=await call('reviewInbox',{cursor:r.nextCursor});assert.equal(second.rows.length,30);assert.equal(new Set([...r.rows,...second.rows].map(x=>x.id)).size,60);
    await deny(call('reviewInbox',{minDays:7,cursor:r.nextCursor}),'aborted');await deny(call('reviewInbox',{minDays:6}),'invalid-argument');
  });
  await t.test('split operations across bootstrap pages and concurrent prior confirmations are preserved',async()=>{
    await reset();await seed('000',undefined,{operationId:'split',parts:2});await seed('zzz',undefined,{operationId:'split',parts:2,part:2});
    for(let i=0;i<26;i++)await seed('mid-'+i);
    const old=await call('review',{from:'2026-11-01',to:'2026-11-15'}),split=old.rows.find(r=>r.id==='split');
    await call('reviewConfirm',{items:selection([split])});const receipt=(await parent.collection('erpReviewConfirmations').get()).docs[0].data();
    const step=await call('reviewInbox');assert.equal(step.ready,false);assert.equal(step.processed,25);
    const another=old.rows.find(r=>r.id!=='split');await call('reviewConfirm',{items:selection([another])});
    const r=await ready();assert.equal(r.pendingCount,25);assert.ok(!r.rows.some(x=>x.id==='split'||x.id===another.id));assert.deepEqual((await parent.collection('erpReviewConfirmations').get()).docs.find(d=>d.data().eventId==='split').data(),receipt);
    assert.equal((await parent.collection('erpChangeHistory').get()).size,28);assert.equal((await parent.collection('erpReviewInbox').get()).size,27);
  });
  await t.test('live governed writes are indexed atomically and details validate the complete original fingerprint',async()=>{
    await reset();await ready();const master=createErpService({db,now});
    const values={code:'ITEM',name:'품목',unit:'개',purchasePrice:10,salePrice:20,taxType:'과세',active:true,specification:'',group:'',notes:''};
    await master(request('save',{kind:'items',id:'item',expectedRevision:0,values},'manager'));
    await master(request('save',{kind:'items',id:'item',expectedRevision:1,values:{...values,purchasePrice:12}},'manager'));
    const r=await ready();assert.equal(r.pendingCount,1);const event=r.rows[0];assert.equal(event.authorization,'ERP_MANAGER_DIRECT');
    const detail=await call('reviewInboxDetail',{id:event.id,fingerprint:event.fingerprint});assert.ok(detail.changes[0].values.some(v=>v.label==='매입단가(원)'&&v.after==='12'));
    const raw=(await parent.collection('erpChangeHistory').where('operationId','==',event.id).get()).docs;assert.equal(projectReview(raw.map(d=>({...d.data(),id:d.id})))[0].fingerprint,event.fingerprint);
    await raw[0].ref.update({hidden:'changed source'});await deny(call('reviewInboxDetail',{id:event.id,fingerprint:event.fingerprint}),'failed-precondition');await deny(call('reviewConfirm',{items:selection([event])}),'failed-precondition');
  });
  await t.test('concurrent ADMIN confirmations invalidate cursors and preserve the first reviewer without accounting writes',async()=>{
    await reset();for(let i=0;i<31;i++)await seed('r-'+i);const first=await ready(),items=selection(first.rows.slice(0,1));
    await deny(call('reviewConfirm',{items},'manager'));
    const results=await Promise.all([call('reviewConfirm',{items}),call('reviewConfirm',{items},'admin2')]);assert.equal(results.reduce((n,r)=>n+r.confirmed,0),1);
    await deny(call('reviewInbox',{cursor:first.nextCursor}),'aborted');const next=await ready();assert.equal(next.pendingCount,30);
    const confirmation=(await parent.collection('erpReviewConfirmations').get()).docs[0].data();await call('reviewConfirm',{items},'admin2');assert.deepEqual((await parent.collection('erpReviewConfirmations').get()).docs[0].data(),confirmation);
    assert.equal((await parent.collection('erpInventory').get()).size,0);assert.equal((await parent.collection('erpChangeHistory').get()).size,31);
    // A new ID before the bootstrap frontier is present because the live writer
    // indexes history and the inbox atomically, not by advancing that frontier.
    await db.runTransaction(async tx=>{const r=record('new-op');tx.create(parent.collection('erpChangeHistory').doc('000-new'),r);recordInbox(tx,parent,[{...r,id:'000-new'}]);tx.set(parent.collection('erpGovernance').doc('control'),{companyId:'a',revision:1});});assert.equal((await ready()).pendingCount,31);
  });
  await t.test('incomplete/foreign source fails closed and preparation never fabricates zero',async()=>{
    await reset();await seed('broken',undefined,{parts:2});await deny(call('reviewInbox'),'failed-precondition');assert.equal((await parent.collection('erpReviewState').doc('inbox').get()).exists,false);
    await parent.collection('erpChangeHistory').doc('broken').update({parts:1,companyId:'b'});await deny(call('reviewInbox'));
    await reset();await deny(call('reviewInbox',{},'operator'));assert.equal((await parent.collection('erpReviewState').get()).size,0);
  });
}finally{await deleteApp(app);}});
