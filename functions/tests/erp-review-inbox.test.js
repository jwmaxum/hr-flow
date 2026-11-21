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
    const r=await ready();assert.equal(r.pendingCount,6);assert.equal(r.previousMonthCount,3);assert.equal(r.agedCount,3);assert.equal(r.urgentCount,2);assert.equal(r.rows[0].id,'years');assert.equal(r.rows.find(x=>x.id==='seven').ageDays,7);assert.equal(r.rows.find(x=>x.id==='six').ageDays,6);assert.equal(ageDays('2026-11-14T15:00:00.000Z','2026-11-15'),0);
    assert.equal((await call('reviewInbox',{minDays:7})).filteredTotal,4);assert.equal((await call('reviewInbox',{minDays:30})).filteredTotal,2);
    assert.equal((await call('reviewInbox',{filter:'AGED'})).filteredTotal,3);
    const alert=await call('reviewAlerts',{scope:'ALL',reviewPolicyVersion:1});assert.equal(alert.pendingCount,6);assert.equal(alert.agedCount,3);assert.equal(alert.rows,undefined);
    assert.equal((await call('reviewInbox',{},'manager')).pendingCount,6);for(const uid of ['manager','operator','foreign'])await deny(call('reviewAlerts',{scope:'ALL'},uid));await deny(call('reviewInbox',{},'admin','b'));
    const work=await call('workQueue',{includeReviews:true,reviewScope:'ALL',reviewPolicyVersion:1});assert.equal(work.sections.find(s=>s.key==='reviews').rows[0].badge,'우선 점검 · '+r.oldestAgeDays+'일');
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

  await t.test('default 14/30 and custom thresholds agree across inbox, header and work queue at KST boundaries',async()=>{
    await reset();const policy=await call('reviewPolicyGet');assert.deepEqual([policy.agedDays,policy.urgentDays,policy.revision,policy.configured],[14,30,0,false]);
    for(const [id,at] of [['13','2026-11-01T15:00:00.000Z'],['14','2026-11-01T14:59:59.999Z'],['29','2026-10-17T14:59:59.999Z'],['30','2026-10-16T14:59:59.999Z']])await seed(id,at);
    let r=await ready({filter:'AGED'});assert.equal(r.agedCount,3);assert.equal(r.urgentCount,1);assert.equal(r.rows.length,3);
    const saved=await call('reviewPolicySave',{revision:0,agedDays:13,urgentDays:29,reason:'주기 조정 검증'});assert.equal(saved.revision,1);assert.equal(saved.configured,true);
    r=await ready({filter:'URGENT'});assert.equal(r.agedCount,4);assert.equal(r.urgentCount,2);assert.deepEqual(r.rows.map(r=>r.id),['30','29']);
    const a=await call('reviewAlerts',{scope:'ALL',reviewPolicyVersion:1});assert.equal(a.agedCount,4);assert.equal(a.urgentCount,2);assert.deepEqual(a.policy,saved);
    const q=await call('workQueue',{includeReviews:true,reviewScope:'ALL',reviewPolicyVersion:1}),rows=q.sections.find(s=>s.key==='reviews').rows;
    assert.equal(rows.find(r=>r.id==='29').badge,'우선 점검 · 29일');assert.equal(rows.find(r=>r.id==='13').badge,'장기 미확인 · 13일');
    const other=await call('reviewPolicyGet',{},'foreign','b');assert.equal(other.agedDays,14);assert.equal(other.configured,false);
    const history=await call('review',{from:'2026-11-01',to:'2026-11-15',category:'MASTER'});assert.ok(history.rows.some(r=>r.changes.some(c=>c.values.some(v=>v.label==='장기 미확인 기준(일)'&&v.after==='13'))));
  });
  await t.test('legacy open clients retain literal 7/30 counts and new clients use the company policy',async()=>{
    await reset();for(const days of [7,14,30,40])await seed('age-'+days,new Date(now().getTime()-days*86400000).toISOString());await ready();
    await call('reviewPolicySave',{revision:0,agedDays:20,urgentDays:40,reason:'기준 호환 검증'});
    const legacy=await call('reviewInbox',{minDays:7});assert.equal(legacy.filteredTotal,4);assert.equal(legacy.agedCount,4);assert.equal(legacy.urgentCount,2);
    const current=await call('reviewInbox',{filter:'AGED'});assert.equal(current.filteredTotal,2);assert.equal(current.urgentCount,1);
    assert.equal((await call('reviewAlerts',{scope:'ALL'})).agedCount,4);
    const rows=(await call('workQueue',{includeReviews:true,reviewScope:'ALL'})).sections.find(s=>s.key==='reviews').rows;assert.equal(rows.find(r=>r.id==='age-7').badge,'장기 미확인 · 7일');
    await deny(call('reviewInbox',{filter:'ALL',minDays:0}),'invalid-argument');await deny(call('reviewInbox',{legacyPolicy:true}),'invalid-argument');
  });
  await t.test('only actual company ADMIN can save or reset; malformed values cannot be stored',async()=>{
    await reset();const input={revision:0,agedDays:14,urgentDays:30,reason:'권한 검증'};
    for(const uid of ['manager','operator','foreign']){await deny(call('reviewPolicySave',input,uid));await deny(call('reviewPolicyGet',{},uid));await deny(call('reviewPolicySave',{revision:0,reset:true,reason:'복원 권한'},uid));}
    await deny(call('reviewPolicySave',input,'admin','b'));await deny(service({data:{action:'reviewPolicySave',companyId:'a',...input}}),'unauthenticated');
    for(const pair of [[0,30],[14,14],[15,14],[1.5,30],['14',30],[14,3651],[null,30],[14,true]])await deny(call('reviewPolicySave',{...input,agedDays:pair[0],urgentDays:pair[1]}),'invalid-argument');
    for(const bad of [{revision:-1},{revision:'0'},{reason:'a'},{reset:'yes'},{reset:true},{extra:true}])await deny(call('reviewPolicySave',{...input,...bad}),'invalid-argument');
    for(const action of ['reviewAlerts','workQueue'])await deny(call(action,{reviewPolicyVersion:2}),'invalid-argument');
    assert.equal((await parent.collection('erpReviewState').get()).size,0);assert.equal((await parent.collection('erpAudit').get()).size,0);
  });
  await t.test('concurrent ADMIN updates cannot overwrite and policy revisions invalidate old pages',async()=>{
    await reset();for(let i=0;i<31;i++)await seed('r-'+i);const first=await ready({filter:'ALL'});
    const results=await Promise.allSettled([call('reviewPolicySave',{revision:0,agedDays:10,urgentDays:20,reason:'첫 관리자 변경'}),call('reviewPolicySave',{revision:0,agedDays:15,urgentDays:45,reason:'두 번째 관리자 변경'},'admin2')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'aborted');
    await deny(call('reviewInbox',{filter:'ALL',cursor:first.nextCursor}),'aborted');assert.equal((await parent.collection('erpAudit').get()).size,1);
    const policy=await call('reviewPolicyGet'),again=await call('reviewPolicySave',{revision:1,agedDays:policy.agedDays,urgentDays:policy.urgentDays,reason:'동일 값 재저장'});assert.equal(again.revision,1);assert.equal((await parent.collection('erpAudit').get()).size,1);
  });
  await t.test('reset restores defaults without clearing confirmations, transactions or closed-month controls',async()=>{
    await reset();await seed('old','2025-01-01T00:00:00.000Z');const r=await ready();await call('reviewConfirm',{items:selection(r.rows)});
    const receipt=(await parent.collection('erpReviewConfirmations').get()).docs.map(d=>d.data());
    await parent.collection('erpGovernance').doc('control').set({companyId:'a',revision:10,closedThrough:'2026-10-31',lastClosedMonth:'2026-10'});
    await parent.collection('erpInventory').doc('stock').set({companyId:'a',quantity:2,value:200});
    await call('reviewPolicySave',{revision:0,agedDays:1,urgentDays:3650,reason:'허용 범위 검증'});
    const restored=await call('reviewPolicySave',{revision:1,reset:true,reason:'기본값으로 복원'});assert.deepEqual([restored.agedDays,restored.urgentDays,restored.revision,restored.configured],[14,30,2,false]);
    assert.deepEqual((await parent.collection('erpReviewConfirmations').get()).docs.map(d=>d.data()),receipt);assert.equal((await ready()).pendingCount,0);
    assert.deepEqual((await parent.collection('erpInventory').doc('stock').get()).data(),{companyId:'a',quantity:2,value:200});assert.equal((await parent.collection('erpGovernance').doc('control').get()).data().revision,10);
    assert.equal((await parent.collection('erpAudit').where('action','==','ERP_REVIEW_POLICY_CHANGED').get()).size,2);
    assert.equal((await parent.collection('erpChangeHistory').where('action','==','ERP_REVIEW_POLICY_CHANGED').get()).size,2);
  });
  await t.test('malformed or cross-company policy is rejected rather than silently defaulted',async()=>{
    await reset();const ref=parent.collection('erpReviewState').doc('policy');
    for(const row of [{companyId:'b'},{companyId:'a',agedDays:30,urgentDays:14,revision:1,configured:true},{companyId:'a',agedDays:7,urgentDays:30,revision:1,configured:false}]){await ref.set(row);await deny(call('reviewPolicyGet'),row.companyId==='b'?'permission-denied':'failed-precondition');}
    await ref.delete();await call('reviewPolicySave',{revision:0,agedDays:14,urgentDays:30,reason:'정상 설정 저장'});
    await db.doc('UserProfile/admin').update({role:'SUB_ADMIN',erpAccess:'MANAGER'});await deny(call('reviewPolicySave',{revision:1,reset:true,reason:'권한 회수 검증'}));assert.equal((await ref.get()).data().revision,1);
  });
}finally{await deleteApp(app);}});
