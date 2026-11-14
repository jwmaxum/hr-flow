const {test}=require('node:test');
const assert=require('node:assert/strict');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,Timestamp}=require('firebase-admin/firestore');
const {createErpService}=require('../erp-service');
const {createErpImportService}=require('../erp-import-service');
const {createErpCustodyService}=require('../erp-custody-service');
if(!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw Error('Loopback emulator required');
process.env.METADATA_SERVER_DETECTION='none';
const projectId='demo-erp-stock-states',app=initializeApp({projectId},projectId),db=getFirestore(app),now=()=>new Date('2026-11-14T00:00:00Z');
const master=createErpService({db,now}),imports=createErpImportService({db,now}),custody=createErpCustodyService({db,now});let seq=0;
const req=(data,uid='admin',companyId='a')=>({data:{companyId,...data},...(uid?{auth:{uid,token:{auth_time:now().getTime()/1000}}}:{})});
const parent=()=>db.collection('companies').doc('a');
const rows=async c=>(await parent().collection(c).get()).docs.map(d=>({...d.data(),id:d.id}));
const save=async(kind,id,values)=>(await master(req({action:'save',kind,id,expectedRevision:0,values}))).record;
const inventory=(itemId='a',uid='admin',companyId='a')=>master(req({action:'inventory',itemId},uid,companyId));
const components=[{itemId:'a',quantity:'2'},{itemId:'b',quantity:'1'}];
const estimate=(quantity='1',warehouseId='hq',parts=components)=>master(req({action:'bundleEstimate',warehouseId,components:parts,quantity}));
const reject=(p,code='failed-precondition')=>assert.rejects(p,e=>e.code===code);
async function reset(){
  assert.equal((await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`,{method:'DELETE'})).status,200);
  const b=db.batch();for(const id of ['a','b'])b.set(db.doc('companies/'+id),{status:'ACTIVE',accessUntil:Timestamp.fromDate(new Date('2027-01-01'))});
  for(const [uid,role,companyId,erpAccess]of [['admin','ADMIN','a',''],['view','MEMBER','a','VIEW'],['manager','SUB_ADMIN','a','MANAGER'],['member','MEMBER','a',''],['foreign','ADMIN','b',''],['root','SUPER_ADMIN','PLATFORM','']])b.set(db.doc('UserProfile/'+uid),{uid,role,companyId,erpAccess,status:'ACTIVE'});await b.commit();
  for(const [id,name,active]of [['hq','본사',true],['lab','연구소',true],['off','사용 중지 창고',false]])await save('warehouses',id,{code:id.toUpperCase(),name,active,address:'',notes:''});
  for(const [id,name]of [['a','구성품A'],['b','구성품B']])await save('items',id,{code:id.toUpperCase(),name,active:true,specification:'',unit:'EA',purchasePrice:0,salePrice:0,taxType:'과세',group:'',notes:''});
  await save('items','set',{code:'SET',name:'검증세트',active:true,specification:'',unit:'SET',purchasePrice:0,salePrice:0,taxType:'과세',group:'',notes:'',itemType:'BUNDLE',components});
}
const stock=(itemId,warehouseId,quantity,value,patch={})=>parent().collection('erpInventory').doc(`${itemId}-${warehouseId}`).set({companyId:'a',itemId,warehouseId,quantity,value,currency:'KRW',...patch});
const pending=(quantity=209,unit='EA')=>parent().collection('erpItems').doc('a').update({pendingOpening:{status:'PENDING_COST',quantity,basisDate:'2026-11-11',unit,source:'검증.xlsx!C9'}});
async function held(){await parent().collection('erpCustodyLots').doc('lot').set({companyId:'a',itemId:'a',warehouseId:'hq',ownerPartnerId:'owner',ownerName:'PRIVATE_OWNER',notes:'PRIVATE_NOTES',availableQuantityScaled:80000,borrowedQuantityScaled:30000,deliveredQuantityScaled:10000});await parent().collection('erpBorrowings').doc('loan').set({companyId:'a',itemId:'a',warehouseId:'hq',lotId:'lot',ownerPartnerId:'owner',quantityScaled:30000,outstandingQuantityScaled:30000,outstandingValue:123456});}
test('stock ownership states and warehouse kit estimates remain isolated and reconciled',async t=>{try{
  await t.test('owned, physically held, borrowed and pending remain separate without monetary or identity mixing',async()=>{
    await reset();await stock('a','hq',7,700);await stock('a','lab',2,200);await held();await pending();
    const before=await rows('erpInventory'),audit=(await rows('erpChangeHistory')).length,s=await inventory();
    assert.deepEqual([s.quantity,s.value,s.customerHeld,s.borrowedOutstanding,s.pendingOpening.quantity],[9,900,8,3,209]);
    assert.deepEqual(s.warehouses.map(w=>[w.warehouseId,w.quantity,w.customerHeld,w.borrowedOutstanding]),[['hq',7,8,3],['lab',2,0,0]]);
    assert.ok(!JSON.stringify(s).includes('PRIVATE_'));assert.ok(!JSON.stringify(s).includes('123456'));assert.deepEqual(await rows('erpInventory'),before);assert.equal((await rows('erpChangeHistory')).length,audit);
    await parent().collection('erpBorrowings').doc('loan').update({outstandingQuantityScaled:20000});await reject(inventory());
  });
  await t.test('missing stock, posted zero, confirmed zero cost and unknown pending quantities stay distinct',async()=>{
    await reset();await pending(null);let s=await inventory();assert.equal(s.quantity,null);assert.equal(s.value,null);assert.equal(s.pendingOpening.quantity,null);assert.equal((await estimate()).rows[0].recorded,false);
    await stock('a','hq',0,0);s=await inventory();assert.equal(s.status,'RECORDED');assert.equal(s.quantity,0);assert.equal(s.value,0);assert.equal(s.pendingOpening.quantity,null);assert.equal((await estimate()).rows[0].recorded,true);
    await stock('a','hq',4,0);await stock('b','hq',2,0);assert.equal((await inventory('set')).warehouses.find(w=>w.warehouseId==='hq').estimatedCost,0);assert.equal((await estimate()).estimatedCost,0);
    await parent().collection('erpItems').doc('a').update({'pendingOpening.status':'CONFIRMED'});assert.equal((await inventory()).pendingOpening,null);
  });
  await t.test('kits floor each warehouse separately and exclude inactive warehouses, inactive parts and parent kits',async()=>{
    await reset();await stock('a','hq',4,400);await stock('b','hq',1,50);await stock('a','lab',1,100);await stock('b','lab',4,200);await stock('a','off',20,2000);await stock('b','off',20,1000);await held();await pending(209,'BOX');
    let s=await inventory('set');assert.equal(s.quantity,1);const hq=s.warehouses.find(w=>w.warehouseId==='hq');assert.equal(hq.estimatedCost,250);assert.equal(hq.components[0].customerHeld,8);assert.equal(hq.components[0].borrowedOutstanding,3);assert.equal(hq.components[0].pendingQuantity,209);assert.equal(hq.components[0].pendingUnit,'BOX');assert.equal((await estimate()).rows[0].pendingUnit,'BOX');
    assert.equal(s.warehouses.find(w=>w.warehouseId==='lab').estimatedCost,null);assert.equal(s.warehouses.find(w=>w.warehouseId==='off').quantity,0);assert.equal(s.value,0);assert.equal((await estimate()).availableSets,hq.quantity);
    await parent().collection('erpItems').doc('b').update({active:false});assert.equal((await inventory('set')).quantity,0);await reject(estimate());
    await parent().collection('erpItems').doc('b').update({active:true});await parent().collection('erpItems').doc('set').update({active:false});assert.equal((await inventory('set')).quantity,0);assert.equal((await inventory('set')).warehouses[0].estimatedCost,null);
  });
  await t.test('rounding uses requested quantities and preserves fractional orders without inventing missing costs',async()=>{
    await reset();await stock('a','hq',3,100);await stock('b','hq',3,1);const parts=[{itemId:'a',quantity:'1'},{itemId:'b',quantity:'1'}];
    assert.equal((await estimate('1','hq',parts)).estimatedCost,33);assert.equal((await estimate('3','hq',parts)).estimatedCost,101);assert.equal((await estimate('4','hq',parts)).estimatedCost,null);
    const e=await estimate('0.5','hq',[{itemId:'a',quantity:'0.5'},{itemId:'b',quantity:'1'}]);assert.equal(e.canShip,true);assert.equal(e.rows[0].needed,0.25);await reject(estimate('0.0001','hq',[{itemId:'a',quantity:'0.0001'}]),'invalid-argument');
  });
  await t.test('bad balances, missing warehouses, foreign records and broken compositions fail closed',async()=>{
    await reset();await stock('b','hq',3,50);
    for(const patch of [{quantity:-1},{quantity:0.00001},{value:-1},{quantity:0,value:1},{currency:'USD'},{companyId:'b'},{warehouseId:'missing'}]){await stock('a','hq',2,100,patch);await reject(inventory());await reject(inventory('set'));}
    await stock('a','hq',2,100);await parent().collection('erpInventory').doc('duplicate').set((await parent().collection('erpInventory').doc('a-hq').get()).data());await reject(inventory());await parent().collection('erpInventory').doc('duplicate').delete();
    for(const components of [[{itemId:'a',quantityScaled:0}],[{itemId:'a',quantityScaled:10000},{itemId:'a',quantityScaled:10000}],[{itemId:'missing',quantityScaled:10000}],[{itemId:'set',quantityScaled:10000}]]){await parent().collection('erpItems').doc('set').update({components});await reject(inventory('set'));}
  });
  await t.test('same-company ERP readers get aggregates without owner data; denial and session revocation remain enforced',async()=>{
    await reset();await stock('a','hq',7,700);await held();
    for(const uid of ['view','manager']){const s=await inventory('a',uid);assert.equal(s.customerHeld,8);assert.equal(s.borrowedOutstanding,3);assert.ok(!JSON.stringify(s).includes('PRIVATE_'));}
    for(const uid of ['member','foreign','root',null])await reject(inventory('a',uid),uid?'permission-denied':'unauthenticated');await reject(inventory('a','admin','b'),'permission-denied');await reject(inventory('a','foreign','b'),'not-found');
    await db.doc('UserProfile/view').update({erpAccess:'NONE'});await reject(inventory('a','view'),'permission-denied');await db.doc('UserProfile/admin').update({status:'RESIGNED'});await reject(inventory(),'permission-denied');
  });
  await t.test('real hold, borrow, repayment and kit posting agree with both inventory and selected-warehouse estimates',async()=>{
    await reset();for(const id of ['owner','buyer'])await save('partners',id,{code:id,name:id,type:'BOTH',active:true,country:'KR',registrationNumber:'',contactName:'',email:'',phone:'',address:'',notes:''});
    async function post(direction,code,quantity,price,extra={}){const {row,...movementExtra}=extra;const p=(await imports(req({action:'manualPreview',id:'movement-'+(++seq),movement:{direction,date:'2026-11-14',warehouseId:'hq',partnerId:'buyer',currency:'KRW',exchangeRate:'1',priceBasis:'세금별도',allowNewItems:false,allowNewPartners:false,...(direction==='출고'?{payment:{status:'CREDIT'}}:{}),...movementExtra,lines:[{code,name:code==='A'?'구성품A':code==='B'?'구성품B':'검증세트',specification:'',unit:code==='SET'?'SET':'EA',taxType:'과세',quantity,price,notes:'검증',...(row||{})}]}}))).import;assert.equal(p.preview.canCommit,true,JSON.stringify(p.preview.errors));await imports(req({action:'commit',id:p.id,fingerprint:p.preview.fingerprint}));return p;}
    await post('입고','A','10','100');await post('입고','B','10','50');await post('출고','A','2','200',{partnerId:'owner',row:{fulfillment:'HOLD'}});
    const lot=(await rows('erpCustodyLots'))[0];await post('출고','A','1','200',{row:{fulfillment:'BORROW',custodyLotId:lot.id,borrowValue:'100'}});
    let s=await inventory();assert.deepEqual([s.quantity,s.customerHeld,s.borrowedOutstanding],[8,1,1]);const loan=(await rows('erpBorrowings'))[0];
    const p=(await custody(req({action:'preview',id:'repay',input:{type:'REPAY',date:'2026-11-14',notes:'현물 반환',quantity:'1',borrowingId:loan.id}}))).job;await custody(req({action:'commit',id:p.id,fingerprint:p.fingerprint}));await pending();
    s=await inventory();assert.deepEqual([s.quantity,s.customerHeld,s.borrowedOutstanding],[7,2,0]);assert.equal((await inventory('set')).quantity,3);assert.equal((await estimate('3')).estimatedCost,750);
    const sale=await post('출고','SET','3','500');assert.equal(sale.preview.rows[0].cost,750);assert.equal((await inventory('set')).quantity,0);assert.equal((await inventory()).pendingOpening.quantity,209);
  });
}finally{await deleteApp(app);}});
