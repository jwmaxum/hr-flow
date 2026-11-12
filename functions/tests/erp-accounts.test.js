const {test}=require('node:test');
const assert=require('node:assert/strict');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,Timestamp}=require('firebase-admin/firestore');
const {createErpService}=require('../erp-service');
const {createErpImportService}=require('../erp-import-service');
const {createErpCorrectionService}=require('../erp-correction-service');
const {createErpReportService}=require('../erp-report-service');
const {createErpFinanceService}=require('../erp-finance-service');
const {createErpCustodyService}=require('../erp-custody-service');
if(!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST||''))throw Error('Loopback emulator required');
process.env.METADATA_SERVER_DETECTION='none';
const projectId='demo-erp-accounts',app=initializeApp({projectId},projectId),db=getFirestore(app),now=()=>new Date('2026-11-12T00:00:00Z');
const masters=createErpService({db,now}),imports=createErpImportService({db,now}),corrections=createErpCorrectionService({db,now}),reports=createErpReportService({db,now}),finance=createErpFinanceService({db,now}),custody=createErpCustodyService({db,now});
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
async function movementPreview(direction,lines,extra={}){return (await imports(req({action:'manualPreview',id:`move-${++seq}`,movement:{direction,date:'2026-11-12',warehouseId:'wh',partnerId:'buyer',currency:'KRW',exchangeRate:'1',priceBasis:'세금별도',allowNewItems:false,allowNewPartners:false,lines,...extra}}))).import;}
async function commitMovement(job){return imports(req({action:'commit',id:job.id,fingerprint:job.preview.fingerprint}));}
async function post(direction,lines,extra={}){const job=await movementPreview(direction,lines,extra);assert.equal(job.preview.canCommit,true,JSON.stringify(job.preview.errors));await commitMovement(job);return (await records('erpMovements')).filter(r=>r.importId===job.id);}
async function preview(service,input){return (await service(req({action:'preview',id:`job-${++seq}`,input:{date:'2026-11-12',notes:'합성 검증',...input}}))).job;}
async function commit(service,job){return service(req({action:'commit',id:job.id,fingerprint:job.fingerprint}));}
async function correct(type,sourceId,quantity){const input={type,sourceId,date:'2026-11-12',reason:'합성 검증',...(quantity?{quantity}: {})};const j=(await corrections(req({action:'preview',id:`cor-${++seq}`,input}))).correction;await corrections(req({action:'commit',id:j.id,fingerprint:j.fingerprint}));return j;}
const report=()=>finance(req({action:'report',from:'2026-01-01',to:'2026-12-31'}));
const payment=(extra={})=>({type:'RECEIPT',partnerId:'buyer',currency:'KRW',amount:'100',method:'BANK',reference:'은행검증',...extra});
const stock=async id=>(await records('erpInventory')).find(r=>r.itemId===id);
const ledger=()=>reports(req({action:'report',view:'summary',filters:{from:'2026-11-12',to:'2026-12-31',itemId:'',warehouseId:'',search:''}}));
test('receivables, bundles and customer custody remain atomic and tenant-scoped',async t=>{try{
  await t.test('gross receivables, partial receipts, refunds and reversals reconcile',async()=>{
    await reset();const [sale]=await post('출고',[line()]);let r=await report();assert.deepEqual([r.rows[0].sales,r.rows[0].tax,r.rows[0].balance],[600,60,660]);
    const job=await preview(finance,payment({amount:'400'}));assert.equal(job.after,260);const duplicate=await Promise.all([commit(finance,job),commit(finance,job)]);assert.equal(duplicate.filter(r=>r.idempotent).length,1);
    await reject(preview(finance,payment({amount:'261'})));await correct('SALES_RETURN',sale.id,'1');r=await report();assert.equal(r.rows[0].balance,-70);
    await reject(preview(finance,payment({type:'REFUND',amount:'71'})));const refund=await preview(finance,payment({type:'REFUND',amount:'70'}));await commit(finance,refund);assert.equal((await report()).rows[0].balance,0);
    await commit(finance,await preview(finance,{type:'CANCEL',sourceId:refund.id}));assert.equal((await report()).rows[0].balance,-70);
    await reject(preview(finance,{type:'CANCEL',sourceId:refund.id}));await commit(finance,await preview(finance,{type:'CANCEL',sourceId:job.id}));assert.equal((await report()).rows[0].balance,330);
    const old=await finance(req({action:'report',from:'2026-11-13',to:'2026-11-30'}));assert.equal(old.rows[0].opening,330);assert.equal(old.rows[0].sales,0);
  });
  await t.test('foreign currencies are independent and decimal limits are enforced',async()=>{
    await reset();await post('출고',[line('PART','1','1.23')],{currency:'USD',exchangeRate:'1400'});await post('출고',[line('PART','1','100')]);
    const r=await report();assert.equal(r.rows.length,2);assert.equal(r.rows.find(r=>r.currency==='USD').balance,135);
    await commit(finance,await preview(finance,payment({currency:'USD',amount:'0.35'})));assert.equal((await report()).rows.find(r=>r.currency==='USD').balance,100);
    await reject(preview(finance,payment({currency:'USD',amount:'0.001'})),'invalid-argument');await reject(preview(finance,payment({amount:'1.1'})),'invalid-argument');
  });
  await t.test('concurrent/stale receipts cannot overcollect or silently change reviewed balances',async()=>{
    await reset();await post('출고',[line()]);const a=await preview(finance,payment({amount:'500'})),b=await preview(finance,payment({amount:'500'}));
    const results=await Promise.allSettled([commit(finance,a),commit(finance,b)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await report()).rows[0].balance,160);
    const stale=await preview(finance,payment({amount:'100'}));await post('출고',[line('PART','1','200')]);await reject(commit(finance,stale));
  });
  await t.test('flat bundle sales count once, consume components and preserve historical BOM on partial returns',async()=>{
    await reset();await post('입고',[line('PART2','10','50')]);const values={...itemValues('SET','세트'),itemType:'BUNDLE',components:[{itemId:'part',quantity:'2'},{itemId:'part2',quantity:'1'}]};await save('items','set',values);
    const availability=await masters(req({action:'inventory',itemId:'set'}));assert.equal(availability.virtual,true);assert.equal(availability.quantity,5);assert.equal(availability.value,0);
    const sale=(await post('출고',[line('SET','2','500')])).find(r=>!r.bundleParentId);assert.equal(sale.cost,500);assert.equal((await stock('part')).quantity,6);assert.equal((await stock('part2')).quantity,8);assert.equal(await stock('set'),undefined);
    assert.equal((await report()).rows[0].balance,1100);assert.equal((await ledger()).totals.cogsKRW,500);
    const ret=await correct('SALES_RETURN',sale.id,'1');assert.equal(ret.rows.length,3);assert.equal((await stock('part')).quantity,8);assert.equal((await report()).rows[0].balance,550);
    await save('items','set',{...values,components:[{itemId:'part2',quantity:'3'}]},1);
    await correct('CANCEL',(await records('erpMovements')).find(r=>r.operationId===ret.id&&r.stockMode==='BUNDLE').id);
    assert.equal((await stock('part')).quantity,6);assert.equal((await report()).rows[0].balance,1100);
    await correct('SALES_RETURN',sale.id,'2');assert.equal((await stock('part')).quantity,10);assert.equal((await stock('part2')).quantity,10);assert.equal((await report()).rows[0].balance,0);assert.equal((await ledger()).totals.cogsKRW,0);
  });
  await t.test('bundle restrictions, whole-document cancellation and stale component stock',async()=>{
    await reset();const values={...itemValues('SET','세트'),itemType:'BUNDLE',components:[{itemId:'part',quantity:'2'}]};await save('items','set',values);
    await reject(save('items','bad',{...itemValues('BAD','잘못된 조합'),itemType:'BUNDLE',components:[{itemId:'set',quantity:'1'}]}),'invalid-argument');
    await reject(save('items','dup',{...itemValues('DUP','중복'),itemType:'BUNDLE',components:[{itemId:'part',quantity:'1'},{itemId:'part',quantity:'2'}]}),'invalid-argument');
    const incoming=await movementPreview('입고',[line('SET','1','100')]);assert.equal(incoming.preview.canCommit,false);
    const bad=await movementPreview('출고',[line('SET','6','100')]);assert.equal(bad.preview.canCommit,false);
    const pending=await movementPreview('출고',[line('SET','1','100')]);await post('출고',[line('PART','1','100')]);await reject(commitMovement(pending));
    const rows=await post('출고',[line('SET','2','100')]);await reject(correct('SALES_RETURN',rows.find(r=>r.bundleParentId).id,'1'));
    await correct('CANCEL',rows.find(r=>r.stockMode==='BUNDLE').id);assert.equal((await stock('part')).quantity,9);assert.equal((await ledger()).totals.salesKRW,100);
  });
  await t.test('hold, borrow, partial repayment and returns separate ownership and settle actual cost',async()=>{
    await reset();await post('출고',[line('PART','5','100',{fulfillment:'HOLD'})],{partnerId:'owner'});let lot=(await records('erpCustodyLots'))[0];assert.equal((await stock('part')).quantity,5);
    const [borrow]=await post('출고',[line('PART','3','300',{fulfillment:'BORROW',custodyLotId:lot.id,borrowValue:'360'})]);let loan=(await records('erpBorrowings'))[0];
    assert.equal((await stock('part')).quantity,5);assert.equal((await records('erpCustodyLots'))[0].borrowedQuantityScaled,30000);
    const repay=await preview(custody,{type:'REPAY',borrowingId:loan.id,quantity:'2'});assert.equal(repay.summary.costDifference,-40);await commit(custody,repay);
    assert.equal((await stock('part')).quantity,3);assert.equal((await records('erpBorrowings'))[0].outstandingValue,120);
    const returned=await correct('SALES_RETURN',borrow.id,'1');assert.equal((await records('erpCustodyLots'))[0].borrowedQuantityScaled,0);assert.equal((await stock('part')).quantity,3);assert.equal((await ledger()).totals.cogsKRW,700);
    await correct('CANCEL',(await records('erpMovements')).find(r=>r.operationId===returned.id).id);assert.equal((await records('erpCustodyLots'))[0].borrowedQuantityScaled,10000);
    await reject(preview(custody,{type:'CANCEL',sourceId:repay.id}));await reject(correct('SALES_RETURN',borrow.id,'2'));
    await commit(custody,await preview(custody,{type:'DELIVER',lotId:lot.id,quantity:'4'}));lot=(await records('erpCustodyLots'))[0];assert.equal(lot.availableQuantityScaled,0);assert.equal(lot.deliveredQuantityScaled,40000);
    const last=await preview(custody,{type:'REPAY',borrowingId:loan.id,quantity:'1'});await commit(custody,last);assert.equal((await stock('part')).quantity,2);
    await commit(custody,await preview(custody,{type:'CANCEL',sourceId:last.id}));assert.equal((await stock('part')).quantity,3);assert.equal((await records('erpCustodyLots'))[0].borrowedQuantityScaled,10000);
  });
  await t.test('legacy held registration creates no sales/assets; delivery and cancellation preserve audit',async()=>{
    await reset();const original=await stock('part');const reg=await preview(custody,{type:'REGISTER',itemId:'part',warehouseId:'wh',ownerPartnerId:'owner',quantity:'4',reference:'과거판매-1'});
    await commit(custody,reg);const lot=(await records('erpCustodyLots'))[0];assert.deepEqual(await stock('part'),original);assert.equal((await report()).rows.length,0);
    const deliver=await preview(custody,{type:'DELIVER',lotId:lot.id,quantity:'1'});await commit(custody,deliver);await reject(preview(custody,{type:'CANCEL',sourceId:reg.id}));
    await commit(custody,await preview(custody,{type:'CANCEL',sourceId:deliver.id}));assert.equal((await records('erpCustodyLots'))[0].availableQuantityScaled,40000);
    await commit(custody,await preview(custody,{type:'CANCEL',sourceId:reg.id}));assert.equal((await records('erpCustodyLots'))[0].availableQuantityScaled,0);
    // A separate untouched register can be cancelled without deleting its evidence.
    const second=await preview(custody,{type:'REGISTER',itemId:'part',warehouseId:'wh',ownerPartnerId:'owner',quantity:'1',reference:'과거판매-2'});await commit(custody,second);await commit(custody,await preview(custody,{type:'CANCEL',sourceId:second.id}));
    assert.equal((await records('erpCustodyLots')).find(l=>l.id===`held_${second.id}`).cancelled,true);
  });
  await t.test('borrow availability, owner selection, stale review and idempotency are enforced',async()=>{
    await reset();const reg=await preview(custody,{type:'REGISTER',itemId:'part',warehouseId:'wh',ownerPartnerId:'owner',quantity:'2',reference:'이관'});await commit(custody,reg);const lot=(await records('erpCustodyLots'))[0];
    const l=line('PART','2','200',{fulfillment:'BORROW',custodyLotId:lot.id,borrowValue:'100'});const a=await movementPreview('출고',[l]),b=await movementPreview('출고',[l]);await commitMovement(a);await reject(commitMovement(b));
    assert.equal((await records('erpBorrowings')).length,1);assert.equal((await stock('part')).quantity,10);
    const unavailable=await movementPreview('출고',[l]);assert.equal(unavailable.preview.canCommit,false);
    await correct('CANCEL',(await records('erpMovements')).find(r=>r.stockMode==='BORROW').id);assert.equal((await records('erpCustodyLots'))[0].availableQuantityScaled,20000);
    const sameOwner=await movementPreview('출고',[l],{partnerId:'owner'});assert.equal(sameOwner.preview.canCommit,false);
  });
  await t.test('money and ownership APIs reject anonymous, cross-company, quantity-only and revoked sessions',async()=>{
    await reset();for(const [service,data]of [[finance,{action:'report',from:'2026-01-01',to:'2026-12-31'}],[custody,{action:'list'}]]){
      for(const uid of [null,'member','manager','root','foreign'])await reject(service(req(data,uid)),uid?'permission-denied':'unauthenticated');
      await reject(service(req({...data,unexpected:'field'})),'invalid-argument');
    }
    await post('출고',[line()]);const job=await preview(finance,payment());await db.doc('UserProfile/admin').update({status:'INACTIVE'});await assert.rejects(commit(finance,job));assert.equal((await records('erpReceipts')).length,0);
  });
  await t.test('mixed physical repayments and sales returns exhaust rounded evaluation without residual debt',async()=>{
    await reset();const reg=await preview(custody,{type:'REGISTER',itemId:'part',warehouseId:'wh',ownerPartnerId:'owner',quantity:'4',reference:'원단위 반올림'});await commit(custody,reg);const lot=(await records('erpCustodyLots'))[0];
    const [sale]=await post('출고',[line('PART','4','100',{fulfillment:'BORROW',custodyLotId:lot.id,borrowValue:'1'})]);const loan=(await records('erpBorrowings'))[0];
    await commit(custody,await preview(custody,{type:'REPAY',borrowingId:loan.id,quantity:'2'}));await correct('SALES_RETURN',sale.id,'1');await correct('SALES_RETURN',sale.id,'1');
    const final=(await records('erpBorrowings'))[0];assert.equal(final.outstandingQuantityScaled,0);assert.equal(final.outstandingValue,0);assert.equal((await ledger()).totals.cogsKRW,200);
  });
  await t.test('bundle partial return cost equals restored component costs at one-won rounding boundaries',async()=>{
    await reset(false);await post('입고',[line('PART','3','0.3333'),line('PART2','3','0.3333')]);
    await save('items','set',{...itemValues('SET','세트'),itemType:'BUNDLE',components:[{itemId:'part',quantity:'1'},{itemId:'part2',quantity:'1'}]});
    const sale=(await post('출고',[line('SET','3','10')])).find(r=>r.stockMode==='BUNDLE');
    for(let i=0;i<3;i++) {await correct('SALES_RETURN',sale.id,'1');const asset=(await records('erpInventory')).reduce((s,r)=>s+r.value,0);assert.equal(asset+(await ledger()).totals.cogsKRW,2);}
    assert.equal((await ledger()).totals.cogsKRW,0);
  });
  await t.test('manual multi-item confirmation is independent of concurrent inventory query completion order',async()=>{
    await reset(false);let slowItem='part';
    const wrapped=new Proxy(db,{get(target,key){
      if(key==='runTransaction')return fn=>target.runTransaction(tx=>fn(new Proxy(tx,{get(reader,method){
        if(method==='get')return async ref=>{const result=await reader.get(ref);if(ref.isEqual?.(parent().collection('erpInventory').where('itemId','==',slowItem).limit(501)))await new Promise(resolve=>setTimeout(resolve,80));return result;};
        return typeof reader[method]==='function'?reader[method].bind(reader):reader[method];
      }})));
      return typeof target[key]==='function'?target[key].bind(target):target[key];
    }});
    const service=createErpImportService({db:wrapped,now});const movement={direction:'입고',date:'2026-11-12',warehouseId:'wh',partnerId:'buyer',currency:'KRW',exchangeRate:'1',priceBasis:'세금별도',allowNewItems:false,allowNewPartners:false,lines:[line('PART','3','100'),line('PART2','3','200')]};
    const job=(await service(req({action:'manualPreview',id:`ordered-${++seq}`,movement}))).import;assert.equal(job.preview.canCommit,true);slowItem='part2';
    await service(req({action:'commit',id:job.id,fingerprint:job.preview.fingerprint}));assert.equal((await stock('part')).quantity,3);assert.equal((await stock('part2')).value,600);
  });
}finally{await deleteApp(app);}});
