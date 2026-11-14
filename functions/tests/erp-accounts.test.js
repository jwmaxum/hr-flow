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
async function movementPreview(direction,lines,extra={}){return (await imports(req({action:'manualPreview',id:`move-${++seq}`,movement:{direction,date:'2026-11-12',warehouseId:'wh',partnerId:'buyer',currency:'KRW',exchangeRate:'1',priceBasis:'세금별도',allowNewItems:false,allowNewPartners:false,lines,...(direction==='출고'?{payment:{status:'CREDIT'}}:{}),...extra}}))).import;}
async function commitMovement(job){return imports(req({action:'commit',id:job.id,fingerprint:job.preview.fingerprint}));}
async function post(direction,lines,extra={}){const job=await movementPreview(direction,lines,extra);assert.equal(job.preview.canCommit,true,JSON.stringify(job.preview.errors));await commitMovement(job);return (await records('erpMovements')).filter(r=>r.importId===job.id);}
async function preview(service,input){return (await service(req({action:'preview',id:`job-${++seq}`,input:{date:'2026-11-12',notes:'합성 검증',...input}}))).job;}
async function commit(service,job){return service(req({action:'commit',id:job.id,fingerprint:job.fingerprint}));}
async function correct(type,sourceId,quantity){const input={type,sourceId,date:'2026-11-12',reason:'합성 검증',...(quantity?{quantity}: {})};const j=(await corrections(req({action:'preview',id:`cor-${++seq}`,input}))).correction;await corrections(req({action:'commit',id:j.id,fingerprint:j.fingerprint}));return j;}
// Restore the old allocation state to exercise pre-deployment returns still awaiting manual release.
async function legacyReturn(sourceId,quantity){const ref=parent().collection('erpState').doc('settlements'),before=await ref.get();const job=await correct('SALES_RETURN',sourceId,quantity);const batch=db.batch();for(const row of await records('erpSettlements'))if(row.sourceKind==='SALES_RETURN'&&row.recoveryId===job.id)batch.delete(parent().collection('erpSettlements').doc(row.id));if(before.exists)batch.set(ref,before.data());else batch.delete(ref);await batch.commit();return job;}
const report=()=>finance(req({action:'report',from:'2026-01-01',to:'2026-12-31'}));
const payment=(extra={})=>({type:'RECEIPT',partnerId:'buyer',currency:'KRW',amount:'100',method:'BANK',reference:'은행검증',...extra});
const stock=async id=>(await records('erpInventory')).find(r=>r.itemId===id);
const ledger=()=>reports(req({action:'report',view:'summary',filters:{from:'2026-11-12',to:'2026-12-31',itemId:'',warehouseId:'',search:''}}));
const settlements=(to='2026-11-12')=>finance(req({action:'settlementReport',to}));
const settlementPreview=async input=>(await finance(req({action:'settlementPreview',id:`settle-${++seq}`,input:{date:'2026-11-12',notes:'배분 검증',...input}}))).job;
const settle=job=>finance(req({action:'settlementCommit',id:job.id,fingerprint:job.fingerprint}));
async function pendingItem(id='part',quantity=209){await parent().collection('erpItems').doc(id).update({pendingOpening:{status:'PENDING_COST',basisDate:'2026-11-11',quantity,unit:'EA',source:'합성 재고.xlsx 원본!C9'}});}
async function openingPreview(lines=[{itemId:'part',quantity:'209',price:'10.1234'}],extra={}){return (await imports(req({action:'openingPreview',id:`opening-${++seq}`,opening:{date:'2026-11-11',warehouseId:'wh',reason:'매입 증빙 확인',zeroCostConfirmed:false,lines,...extra}}))).import;}

const paidOptions={receiptMode:'REUSE_FIRST',confirmNew:false,notes:'자체 입금 확인'};
const paidPreview=async(documentId,extra={})=>(await finance(req({action:'paymentPreview',id:'paid-'+(++seq),input:{documentId,date:'2026-11-12',...paidOptions,...extra}}))).job;
const paidCommit=job=>finance(req({action:'paymentCommit',id:job.id,fingerprint:job.fingerprint}));
const dashboard=month=>finance(req({action:'dashboard',month}));
const recoveryPreview=async(documentId,type,amount,extra={})=>(await finance(req({action:'shipmentRecoveryPreview',id:'recover-'+(++seq),input:{documentId,type,amount,date:'2026-11-12',notes:'반품 후 정산 검증',...(type==='REFUND'?{method:'BANK',reference:'환불확인',confirmPaid:true}:{}),...extra}}))).job;
const recoveryCommit=job=>finance(req({action:'shipmentRecoveryCommit',id:job.id,fingerprint:job.fingerprint}));

test('aging counts UTC calendar days across leap years and omits future financial events',()=>{
  const {settlementReport}=require('../erp-settlement-model');
  const event={id:'sale',documentId:'doc',documentNo:'OUT',saleDate:'2024-02-28',date:'2024-02-28',partnerId:'buyer',partnerName:'buyer',currency:'USD',gross:135,receipt:0};
  const data={events:[event,{...event,id:'later',date:'2024-03-02',gross:-35}],paid:[],settlements:[{id:'due',type:'TERMS',documentId:'doc',dueDate:'2024-02-28',date:'2024-02-28',partnerId:'buyer',sequence:1}]};
  const r=settlementReport(data,'2024-03-01');assert.deepEqual(r.totals,[{currency:'USD',balance:135,refundDue:0}]);assert.equal(r.documents[0].overdueDays,2);assert.equal(r.documents[0].overdueAmount,135);assert.equal(settlementReport(data,'2024-03-02').documents[0].overdueAmount,100);
});
test('receivables, bundles and customer custody remain atomic and tenant-scoped',async t=>{try{
  await t.test('automatic return settlement reduces credit and shows pending returns without fabricating payouts',async()=>{
    for(const [paid,balance,due,reduced]of [[0,440,0,660],[550,0,110,550],[1100,0,660,0]]){
      await reset();const [sale]=await post('출고',[line('PART','5','200')]),doc=(await settlements()).documents[0];
      if(paid)await paidCommit(await paidPreview(doc.id,{amount:String(paid)}));
      const input={type:'SALES_RETURN',sourceId:sale.id,quantity:'3',date:'2026-11-12',reason:'반품 정산 검증'},id=`auto-${++seq}`;
      const job=(await corrections(req({action:'preview',id,input}))).correction;
      assert.deepEqual([job.settlement.returnAmount,job.settlement.receivableAfter,job.settlement.partnerReturnDue,job.settlement.receivableReduction],[660,balance,due,reduced]);
      assert.equal((await stock('part')).quantity,5);
      const results=await Promise.all([corrections(req({action:'commit',id,fingerprint:job.fingerprint})),corrections(req({action:'commit',id,fingerprint:job.fingerprint}))]);
      assert.equal(results.filter(r=>r.idempotent).length,1);assert.equal((await stock('part')).quantity,8);
      const detail=await finance(req({action:'shipmentDetail',documentId:doc.id}));assert.equal(detail.document.balance,balance);assert.equal(detail.recovery.refundable,due);
      assert.equal((await records('erpReceipts')).filter(r=>r.type==='REFUND').length,0);
      assert.equal((await records('erpMovements')).filter(r=>r.operationId===id).length,1);
      if(due){const returnRow=(await records('erpMovements')).find(r=>r.operationId===id);await correct('CANCEL',returnRow.id);assert.equal((await finance(req({action:'shipmentDetail',documentId:doc.id}))).recovery.credit,0);}
    }
  });
  await t.test('automatic release preserves mixed invoice allocations and rejects a stale finance preview',async()=>{
    await reset();const [sale]=await post('출고',[line()]),first=(await settlements()).documents[0];await post('출고',[line('PART','1','300')]);const second=(await settlements()).documents.find(d=>d.id!==first.id);
    const receipt=await preview(finance,payment({amount:'990'}));await commit(finance,receipt);await settle(await settlementPreview({type:'ALLOCATE',receiptId:receipt.id,lines:[{documentId:first.id,amount:'660'},{documentId:second.id,amount:'330'}]}));
    const input={type:'SALES_RETURN',sourceId:sale.id,quantity:'1',date:'2026-11-12',reason:'혼합 배분 반품'};
    const stale=(await corrections(req({action:'preview',id:`auto-${++seq}`,input}))).correction;
    await settle(await settlementPreview({type:'TERMS',documentId:second.id,dueDate:'2026-11-30'}));await reject(corrections(req({action:'commit',id:stale.id,fingerprint:stale.fingerprint})));
    await correct('SALES_RETURN',sale.id,'1');const r=await settlements();assert.deepEqual(r.documents.map(d=>[d.id,d.allocated]).sort(),[[first.id,330],[second.id,330]].sort());assert.equal(r.receipts[0].amount,990);assert.equal(r.summaries[0].balance,-330);
  });
  await t.test('operator returns keep stock and allocations unchanged until ADMIN approval and respect closed dates',async()=>{
    await reset();const [sale]=await post('출고',[line()]),doc=(await settlements()).documents[0];await paidCommit(await paidPreview(doc.id));await db.doc('UserProfile/member').update({erpAccess:'OUTBOUND'});
    const id=`auto-${++seq}`,input={type:'SALES_RETURN',sourceId:sale.id,quantity:'1',date:'2026-11-12',reason:'승인 후 반품 정산'};
    const job=(await corrections(req({action:'preview',id,input},'member'))).correction;
    assert.equal(job.settlement,undefined);
    const queued=await corrections(req({action:'commit',id,fingerprint:job.fingerprint},'member'));assert.equal(queued.correction.status,'AWAITING_APPROVAL');assert.equal((await stock('part')).quantity,8);assert.equal((await records('erpSettlements')).filter(r=>r.type==='RELEASE').length,0);
    const control=require('../erp-control-service').createErpControlService({db,now});
    await parent().collection('erpGovernance').doc('control').set({companyId:'a',closedThrough:'2026-11-12'},{merge:true});await reject(control(req({action:'decide',id:queued.approvalId,decision:'APPROVE',reason:'마감 반품 승인'})));
    await parent().collection('erpGovernance').doc('control').update({closedThrough:''});await control(req({action:'decide',id:queued.approvalId,decision:'APPROVE',reason:'반품 정산 승인'}));assert.equal((await stock('part')).quantity,9);assert.equal((await records('erpSettlements')).filter(r=>r.type==='RELEASE').length,1);
    const history=(await records('erpChangeHistory')).find(r=>r.approvalId===queued.approvalId);assert.ok(history.changes.some(r=>r.path.startsWith('erpSettlements/')));
  });
  await t.test('return recovery preserves mixed allocations, supports partial releases and refunds exactly once',async()=>{
    await reset();const [sale]=await post('출고',[line()]);const first=(await settlements()).documents[0];await post('출고',[line('PART','1','300')]);const second=(await settlements()).documents.find(d=>d.id!==first.id);
    const receipt=await preview(finance,payment({amount:'990'}));await commit(finance,receipt);
    await settle(await settlementPreview({type:'ALLOCATE',receiptId:receipt.id,lines:[{documentId:first.id,amount:'660'},{documentId:second.id,amount:'330'}]}));
    await legacyReturn(sale.id,'1');await reject(recoveryPreview(first.id,'REFUND','1'));
    const beforeStock=await stock('part'),firstRelease=await recoveryPreview(first.id,'RELEASE','100'),stale=await recoveryPreview(first.id,'RELEASE','100');
    const concurrent=await Promise.all([recoveryCommit(firstRelease),recoveryCommit(firstRelease)]);assert.equal(concurrent.filter(r=>r.idempotent).length,1);await reject(recoveryCommit(stale));
    let r=await settlements();assert.deepEqual(r.documents.map(d=>[d.id,d.allocated]).sort(),[[first.id,560],[second.id,330]].sort());
    await reject(settle(firstRelease));await recoveryCommit(await recoveryPreview(first.id,'RELEASE','230'));await reject(recoveryPreview(first.id,'RELEASE','1'));
    let d=await finance(req({action:'shipmentDetail',documentId:first.id}));assert.deepEqual([d.recovery.released,d.recovery.credit,d.recovery.refundable,d.document.balance],[330,330,330,0]);
    assert.equal((await finance(req({action:'shipmentList',from:'2026-11-01',to:'2026-11-12',status:'REFUND'}))).rows[0].id,first.id);
    const refund=await recoveryPreview(first.id,'REFUND','100');await recoveryCommit(refund);assert.equal((await recoveryCommit(refund)).idempotent,true);
    await recoveryCommit(await recoveryPreview(first.id,'REFUND','230'));await reject(recoveryPreview(first.id,'REFUND','1'));
    d=await finance(req({action:'shipmentDetail',documentId:first.id}));assert.deepEqual([d.recovery.refunded,d.recovery.refundable,d.recovery.partnerBalance],[330,0,0]);assert.deepEqual(await stock('part'),beforeStock);
    r=await settlements();assert.equal(r.documents.find(d=>d.id===second.id).allocated,330);assert.equal(r.receipts.find(r=>r.id===receipt.id).amount,990);
    assert.equal((await records('erpAudit')).filter(r=>r.action==='SHIPMENT_RECOVERY_REFUND').length,2);
  });
  await t.test('document refund cap respects other invoices, refund reversals and cancelled source receipts',async()=>{
    await reset();const [sale]=await post('출고',[line()]),doc=(await settlements()).documents[0];await paidCommit(await paidPreview(doc.id));const receipt=(await records('erpReceipts'))[0];
    await post('출고',[line('PART','1','300')]);await legacyReturn(sale.id,'2');await recoveryCommit(await recoveryPreview(doc.id,'RELEASE','660'));
    let detail=await finance(req({action:'shipmentDetail',documentId:doc.id}));assert.deepEqual([detail.recovery.credit,detail.recovery.refundable],[660,330]);
    await reject(recoveryPreview(doc.id,'REFUND','331'));const refund=await recoveryPreview(doc.id,'REFUND','330');await recoveryCommit(refund);
    await commit(finance,await preview(finance,{type:'CANCEL',sourceId:refund.id}));detail=await finance(req({action:'shipmentDetail',documentId:doc.id}));assert.equal(detail.recovery.refundable,330);assert.ok(detail.recovery.history.some(r=>r.type==='REFUND_CANCELLED'));
    await commit(finance,await preview(finance,{type:'CANCEL',sourceId:receipt.id}));detail=await finance(req({action:'shipmentDetail',documentId:doc.id}));assert.equal(detail.recovery.credit,0);await reject(recoveryPreview(doc.id,'REFUND','1'));
  });
  await t.test('recovery rejects cross-role access, stale previews, bad precision and closed periods',async()=>{
    await reset();const [sale]=await post('출고',[line('PART','2','1')],{currency:'USD',exchangeRate:'1400'}),doc=(await settlements()).documents[0];await paidCommit(await paidPreview(doc.id));await legacyReturn(sale.id,'1');
    for(const amount of ['0','-1','0.001','1e2'])await reject(recoveryPreview(doc.id,'RELEASE',amount),'invalid-argument');
    const job=await recoveryPreview(doc.id,'RELEASE','1.10');
    for(const uid of [null,'member','manager','root','foreign'])await reject(finance(req({action:'shipmentRecoveryCommit',id:job.id,fingerprint:job.fingerprint},uid)),uid?'permission-denied':'unauthenticated');
    await parent().collection('erpGovernance').doc('control').set({companyId:'a',revision:1,closedThrough:'2026-11-12'},{merge:true});await reject(recoveryCommit(job));
    await parent().collection('erpGovernance').doc('control').update({closedThrough:''});await recoveryCommit(job);
    await reject(recoveryPreview(doc.id,'REFUND','1.10',{confirmPaid:false}),'invalid-argument');
    const refund=await recoveryPreview(doc.id,'REFUND','1.10');await commit(finance,await preview(finance,payment({type:'REFUND',currency:'USD',amount:'0.10'})));await reject(recoveryCommit(refund));
    assert.equal((await finance(req({action:'shipmentDetail',documentId:doc.id}))).recovery.refundable,100);
  });
  await t.test('shipment workspace registers partial receipts atomically and reconciles returns at current date',async()=>{
    await reset();const rows=await post('출고',[line()]);const doc=(await settlements()).documents[0];
    const query={action:'shipmentList',from:'2026-11-01',to:'2026-11-12',search:'buyer',status:'OPEN'};
    assert.equal((await finance(req(query))).rows[0].balance,660);
    const loose=await preview(finance,payment({amount:'150'}));await commit(finance,loose);
    const job=await paidPreview(doc.id,{amount:'200',method:'CASH',reference:'partial-1'});
    assert.deepEqual([job.summary.reused,job.summary.newReceipt,job.summary.after],[150,50,460]);
    const competing=await paidPreview(doc.id,{amount:'200'});await paidCommit(job);await reject(paidCommit(competing));assert.equal((await paidCommit(job)).idempotent,true);
    const receipts=await records('erpReceipts');assert.equal(receipts.length,2);assert.equal(receipts.find(r=>r.reference==='partial-1').amountMinor,50);assert.equal(receipts.find(r=>r.reference==='partial-1').method,'CASH');
    const detail=()=>finance(req({action:'shipmentDetail',documentId:doc.id}));
    let d=await detail();assert.deepEqual([d.document.billed,d.document.supplyMinor,d.document.taxMinor,d.document.allocated,d.document.balance],[660,600,60,200,460]);assert.equal(d.rows[0].returnableQuantity,2);assert.equal(d.receipts.length,2);assert.equal(d.receipts.reduce((sum,r)=>sum+r.amount,0),200);assert.deepEqual(d.originalAmounts,{salesKRW:600,costKRW:200});
    const stale=await paidPreview(doc.id,{amount:'100'});await correct('SALES_RETURN',rows[0].id,'1');await reject(paidCommit(stale));
    d=await detail();assert.deepEqual([d.document.billed,d.document.supplyMinor,d.document.taxMinor,d.document.balance,d.rows[0].returnableQuantity],[330,300,30,130,1]);
    await paidCommit(await paidPreview(doc.id,{amount:'130'}));assert.equal((await finance(req({...query,status:'PAID'}))).total,1);
    await correct('SALES_RETURN',rows[0].id,'1');d=await detail();assert.equal(d.document.balance,0);assert.equal(d.recovery.refundable,330);assert.equal(d.rows[0].returnableQuantity,0);assert.equal((await finance(req({...query,status:'REFUND'}))).total,1);assert.equal((await finance(req({...query,status:'OPEN'}))).total,0);
    for(const uid of [null,'member','manager','root','foreign'])for(const input of [query,{action:'shipmentDetail',documentId:doc.id}])await reject(finance(req(input,uid)),uid?'permission-denied':'unauthenticated');
    await reject(finance(req({action:'shipmentDetail',documentId:'foreign-doc'})),'not-found');await reject(finance(req({...query,status:'UNKNOWN'})),'invalid-argument');await reject(finance(req({...query,offset:30,snapshot:'stale'})));
  });
  await t.test('partial receipt amounts enforce currency precision and current document limits',async()=>{
    await reset();await post('출고',[line()]);const doc=(await settlements()).documents[0];
    for(const amount of ['0','-1','660.1','661','NaN','1e3'])await reject(paidPreview(doc.id,{amount}),'invalid-argument');
    await reject(paidPreview(doc.id,{method:'WIRE'}),'invalid-argument');await reject(paidPreview(doc.id,{amount:100}),'invalid-argument');
    await post('출고',[line('PART','1','1')],{currency:'USD',exchangeRate:'1400'});const usd=(await settlements()).documents.find(d=>d.currency==='USD');
    const job=await paidPreview(usd.id,{amount:'0.01'});assert.equal(job.summary.after,109);await paidCommit(job);await reject(paidPreview(usd.id,{amount:'0.001'}),'invalid-argument');
    const d=await finance(req({action:'shipmentDetail',documentId:usd.id}));assert.deepEqual([d.document.billed,d.document.supplyMinor,d.document.taxMinor,d.document.balance],[110,100,10,109]);
  });
  await t.test('shipment details hide component stock rows and preserve their historical return costs',async()=>{
    await reset();await post('입고',[line('PART2','10','50')]);
    await save('items','set',{...itemValues('SET','세트'),itemType:'BUNDLE',components:[{itemId:'part',quantity:'2'},{itemId:'part2',quantity:'1'}]});
    await post('출고',[line('SET','2','300')]);const doc=(await settlements()).documents[0];
    let d=await finance(req({action:'shipmentDetail',documentId:doc.id}));assert.equal(d.rows.length,1);assert.equal(d.rows[0].cost,500);assert.equal(d.rows[0].components.length,2);assert.equal(d.rows[0].components.reduce((sum,r)=>sum+r.cost,0),500);assert.deepEqual(d.originalAmounts,{salesKRW:600,costKRW:500});
    await correct('SALES_RETURN',d.rows[0].id,'1');d=await finance(req({action:'shipmentDetail',documentId:doc.id}));assert.equal(d.rows[0].returnableQuantity,1);assert.equal(d.document.billed,330);
    assert.equal((await stock('part')).quantity,8);assert.equal((await stock('part2')).quantity,9);
  });
  await t.test('mixed VAT modes persist matching gross, net and tax and keep historical shipment searches current',async()=>{
    await reset(false);await post('입고',[line('PART','10','100')],{date:'2026-11-02'});
    const rows=await post('출고',['INCLUDED','EXCLUDED','EXEMPT'].map(vatMode=>line('PART','1','1000',{vatMode})),{date:'2026-11-03',priceBasis:'세금포함'});
    const doc=(await settlements()).documents[0];assert.equal(doc.billed,3100);assert.deepEqual(rows.sort((a,b)=>a.rowNo-b.rowNo).map(r=>[r.supply,r.tax,r.total]),[[909,91,1000],[1000,100,1100],[1000,0,1000]]);
    await paidCommit(await paidPreview(doc.id,{amount:'100'}));
    const result=await finance(req({action:'shipmentList',from:'2026-11-03',to:'2026-11-03'}));assert.equal(result.rows[0].balance,3000);assert.equal(result.asOf,'2026-11-12');
    await correct('CANCEL',rows[0].id);const d=await finance(req({action:'shipmentDetail',documentId:doc.id}));assert.ok(d.rows.every(r=>r.cancelledBy&&r.returnableQuantity===0));assert.equal(d.document.balance,-100);
  });
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
  await t.test('bundle drafts estimate warehouse costs without writes and preserve legacy compositions',async()=>{
    await reset();await post('입고',[line('PART2','10','50')]);
    const components=[{itemId:'part',quantity:'2'},{itemId:'part2',quantity:'1'}];
    const estimate=(extra={},uid='admin')=>masters(req({action:'bundleEstimate',warehouseId:'wh',components,quantity:'3',...extra},uid));
    const before=await records('erpInventory');const e=await estimate();assert.equal(e.estimatedCost,750);assert.equal(e.availableSets,5);assert.deepEqual(e.rows.map(r=>[r.quantity,r.needed,r.shortage]),[[10,6,0],[10,3,0]]);
    const short=await estimate({quantity:'6'});assert.equal(short.canShip,false);assert.equal(short.estimatedCost,null);assert.equal(short.rows[0].shortage,2);assert.deepEqual(await records('erpInventory'),before);
    for(const uid of ['foreign','member',null])await reject(estimate({},uid),uid?'permission-denied':'unauthenticated');
    await db.doc('UserProfile/member').update({erpAccess:'VIEW'});assert.equal((await estimate({},'member')).estimatedCost,750);
    await reject(estimate({components:[components[0],components[0]]}),'invalid-argument');
    await reject(estimate({quantity:'0.0001',components:[{itemId:'part',quantity:'0.0001'}]}),'invalid-argument');
    await reject(estimate({warehouseId:'missing'}),'not-found');
    const one={...itemValues('SET','세트'),itemType:'BUNDLE',components:[{itemId:'part',quantity:'2'}]};
    await reject(save('items','set',one),'invalid-argument');
    // Seed a real pre-migration shape; new registrations must not create it.
    await save('items','set',{...one,components});await parent().collection('erpItems').doc('set').update({components:[{itemId:'part',quantityScaled:20000}]});
    await save('items','set',{...one,name:'기존 세트'},1);assert.equal((await masters(req({action:'inventory',itemId:'set'}))).quantity,5);
    await reject(save('items','set',{...one,components:[{itemId:'part',quantity:'1'}]},2),'invalid-argument');
    const sale=(await post('출고',[line('SET','1','200',{name:'기존 세트'})])).find(r=>!r.bundleParentId);await correct('SALES_RETURN',sale.id,'1');assert.equal((await stock('part')).quantity,10);
  });
  await t.test('exact bundle totals reconcile stock, single sale, COGS, partial returns and paid receipts',async()=>{
    await reset();await post('입고',[line('PART2','10','50')]);await save('items','set',{...itemValues('SET','세트'),itemType:'BUNDLE',components:[{itemId:'part',quantity:'2'},{itemId:'part2',quantity:'1'}]});
    const totalLine=(quantity='3',amount='1000',extra={})=>line('SET',quantity,'',{amountMode:'TOTAL',totalAmount:amount,...extra});
    const j=await movementPreview('출고',[totalLine()],{priceBasis:'세금포함'});assert.equal(j.preview.canCommit,true);assert.deepEqual([j.preview.rows[0].supply,j.preview.rows[0].tax,j.preview.rows[0].total,j.preview.rows[0].cost],[909,91,1000,750]);
    await commitMovement(j);assert.equal((await commitMovement(j)).idempotent,true);const sale=(await records('erpMovements')).find(r=>r.importId===j.id&&!r.bundleParentId);
    assert.equal(sale.amountMode,'TOTAL');assert.equal(sale.inputAmountMinor,1000);assert.equal((await stock('part')).quantity,4);assert.equal((await stock('part2')).quantity,7);assert.equal((await report()).rows[0].balance,1000);assert.equal((await ledger()).totals.cogsKRW,750);
    await correct('SALES_RETURN',sale.id,'1');await correct('SALES_RETURN',sale.id,'2');assert.equal((await report()).rows[0].balance,0);assert.equal((await ledger()).totals.cogsKRW,0);assert.equal((await stock('part')).value,1000);
    await post('출고',[totalLine('3','1000')],{priceBasis:'세금포함',payment:{status:'PAID',...paidOptions}});assert.equal((await records('erpReceipts'))[0].amountMinor,1000);assert.equal((await report()).rows[0].balance,0);
    await reject(movementPreview('출고',[totalLine('1','100',{price:'100'})]),'invalid-argument');await reject(movementPreview('입고',[totalLine()]),'invalid-argument');await reject(movementPreview('출고',[totalLine('1','1.1')]),'invalid-argument');
    const overlap=await movementPreview('출고',[totalLine('2','100'),totalLine('1','100')]);assert.equal(overlap.preview.canCommit,false);
  });
  await t.test('flat bundle sales count once, consume components and preserve historical BOM on partial returns',async()=>{
    await reset();await post('입고',[line('PART2','10','50')]);const values={...itemValues('SET','세트'),itemType:'BUNDLE',components:[{itemId:'part',quantity:'2'},{itemId:'part2',quantity:'1'}]};await save('items','set',values);
    const availability=await masters(req({action:'inventory',itemId:'set'}));assert.equal(availability.virtual,true);assert.equal(availability.quantity,5);assert.equal(availability.value,0);
    const sale=(await post('출고',[line('SET','2','500')])).find(r=>!r.bundleParentId);assert.equal(sale.cost,500);assert.equal((await stock('part')).quantity,6);assert.equal((await stock('part2')).quantity,8);assert.equal(await stock('set'),undefined);
    assert.equal((await report()).rows[0].balance,1100);assert.equal((await ledger()).totals.cogsKRW,500);
    const ret=await correct('SALES_RETURN',sale.id,'1');assert.equal(ret.rows.length,3);assert.equal((await stock('part')).quantity,8);assert.equal((await report()).rows[0].balance,550);
    await save('items','set',{...values,components:[{itemId:'part2',quantity:'3'},{itemId:'part',quantity:'1'}]},1);
    await correct('CANCEL',(await records('erpMovements')).find(r=>r.operationId===ret.id&&r.stockMode==='BUNDLE').id);
    assert.equal((await stock('part')).quantity,6);assert.equal((await report()).rows[0].balance,1100);
    await correct('SALES_RETURN',sale.id,'2');assert.equal((await stock('part')).quantity,10);assert.equal((await stock('part2')).quantity,10);assert.equal((await report()).rows[0].balance,0);assert.equal((await ledger()).totals.cogsKRW,0);
  });
  await t.test('bundle restrictions, whole-document cancellation and stale component stock',async()=>{
    await reset();await post('입고',[line('PART2','10','50')]);const values={...itemValues('SET','세트'),itemType:'BUNDLE',components:[{itemId:'part',quantity:'2'},{itemId:'part2',quantity:'1'}]};await save('items','set',values);
    await reject(save('items','bad',{...itemValues('BAD','잘못된 조합'),itemType:'BUNDLE',components:[{itemId:'set',quantity:'1'},{itemId:'part2',quantity:'1'}]}),'invalid-argument');
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
  await t.test('one receipt allocates across documents without double counting and cancellation restores them',async()=>{
    await reset();await post('출고',[line('PART','1','100'),line('PART','1','200')]);await post('출고',[line('PART','1','100')]);
    const receipt=await preview(finance,payment({amount:'400'}));await commit(finance,receipt);
    let r=await settlements();assert.equal(r.documents.length,2);assert.equal(r.summaries[0].balance,40);assert.equal(r.summaries[0].unallocated,400);
    const big=r.documents.find(d=>d.billed===330),small=r.documents.find(d=>d.billed===110);
    const job=await settlementPreview({type:'ALLOCATE',receiptId:receipt.id,lines:[{documentId:big.id,amount:'300'},{documentId:small.id,amount:'100'}]});
    const result=await Promise.all([settle(job),settle(job)]);assert.equal(result.filter(r=>r.idempotent).length,1);
    r=await settlements();assert.equal(r.summaries[0].balance,40);assert.equal(r.summaries[0].unallocated,0);assert.equal(r.documents.find(d=>d.id===big.id).balance,30);
    await settle(await settlementPreview({type:'RELEASE',sourceId:job.id}));r=await settlements();assert.equal(r.receipts[0].available,400);assert.equal(r.summaries[0].documentBalance,440);
    await reject(settlementPreview({type:'RELEASE',sourceId:job.id}));
    await settle(await settlementPreview({type:'ALLOCATE',receiptId:receipt.id,lines:[{documentId:big.id,amount:'330'}]}));
    await commit(finance,await preview(finance,{type:'CANCEL',sourceId:receipt.id,date:'2026-11-13'}));
    assert.equal((await settlements()).documents.find(d=>d.id===big.id).balance,0);
    r=await settlements('2026-11-13');assert.equal(r.documents.find(d=>d.id===big.id).balance,330);assert.equal(r.receipts[0].cancelled,true);assert.equal(r.summaries[0].balance,440);
    assert.equal((await report()).rows[0].balance,r.summaries[0].balance);
  });
  await t.test('allocation validates identity, currency, precision and concurrent available amounts',async()=>{
    await reset();await post('출고',[line('PART','1','100')]);await post('출고',[line('PART','1','100')],{partnerId:'owner'});await post('출고',[line('PART','1','1.23')],{currency:'USD',exchangeRate:'1400'});
    const receipt=await preview(finance,payment({amount:'100'}));await commit(finance,receipt);
    const r=await settlements(),doc=r.documents.find(d=>d.partnerId==='buyer'&&d.currency==='KRW');
    const input={type:'ALLOCATE',receiptId:receipt.id,lines:[{documentId:doc.id,amount:'100'}]};
    for(const documentId of ['missing',...r.documents.filter(d=>d.id!==doc.id).map(d=>d.id)])await reject(settlementPreview({...input,lines:[{documentId,amount:'1'}]}));
    await reject(settlementPreview({...input,lines:[input.lines[0],input.lines[0]]}),'invalid-argument');
    for(const amount of ['0','111','101'])await reject(settlementPreview({...input,lines:[{documentId:doc.id,amount}]}));
    await reject(settlementPreview({...input,lines:[{documentId:doc.id,amount:'1.01'}]}),'invalid-argument');
    const a=await settlementPreview(input),b=await settlementPreview(input);await settle(a);await reject(settle(b));
    await reject(settlementPreview({...input,date:'2026-11-11'}));
    const foreignReceipt=await preview(finance,payment({currency:'USD',amount:'1.35'}));await commit(finance,foreignReceipt);
    const usd=r.documents.find(d=>d.currency==='USD');await settle(await settlementPreview({type:'ALLOCATE',receiptId:foreignReceipt.id,lines:[{documentId:usd.id,amount:'1.35'}]}));
    assert.equal((await settlements()).documents.find(d=>d.id===usd.id).balance,0);
    for(const uid of [null,'member','manager','root','foreign'])await reject(finance(req({action:'settlementReport',to:'2026-11-12'},uid)),uid?'permission-denied':'unauthenticated');
    await reject(finance(req({action:'settlementPreview',id:'forged',input:{...input,companyId:'b',date:'2026-11-12',notes:'x'}})),'invalid-argument');
  });
  await t.test('due dates age at calendar boundaries and historical terms remain reproducible',async()=>{
    await reset();await post('출고',[line('PART','1','100')]);const receipt=await preview(finance,payment({amount:'40'}));await commit(finance,receipt);
    const doc=(await settlements()).documents[0];await settle(await settlementPreview({type:'ALLOCATE',receiptId:receipt.id,lines:[{documentId:doc.id,amount:'40'}]}));
    await reject(settlementPreview({type:'TERMS',documentId:doc.id,dueDate:'2026-11-11'}),'invalid-argument');
    await reject(settlementPreview({type:'TERMS',documentId:doc.id,dueDate:'2026-02-30'}),'invalid-argument');
    await settle(await settlementPreview({type:'TERMS',documentId:doc.id,dueDate:'2026-11-12'}));
    assert.equal((await settlements()).documents[0].overdueAmount,0);
    let r=await settlements('2026-11-13');assert.equal(r.documents[0].overdueDays,1);assert.equal(r.documents[0].overdueAmount,70);
    const term=await settlementPreview({type:'TERMS',documentId:doc.id,dueDate:'2026-11-30',date:'2026-11-14'});await settle(term);
    assert.equal((await settlements('2026-11-13')).documents[0].dueDate,'2026-11-12');assert.equal((await settlements('2026-11-14')).documents[0].overdueAmount,0);
    await settle(await settlementPreview({type:'TERMS',documentId:doc.id,dueDate:'',date:'2026-11-15'}));r=await settlements('2026-12-01');assert.equal(r.documents[0].dueDate,'');assert.equal(r.summaries[0].undated,70);
    assert.equal((await settlements('2026-11-11')).documents.length,0);
  });
  await t.test('allocated sales returns expose credit and release reconciles refunds without changing sales',async()=>{
    await reset();const [sale]=await post('출고',[line('PART','2','100')]);const receipt=await preview(finance,payment({amount:'200'}));await commit(finance,receipt);
    const doc=(await settlements()).documents[0],allocation=await settlementPreview({type:'ALLOCATE',receiptId:receipt.id,lines:[{documentId:doc.id,amount:'200'}]});await settle(allocation);
    await legacyReturn(sale.id,'1');let r=await settlements();assert.equal(r.documents[0].credit,90);assert.equal(r.documents[0].overdueAmount,0);assert.equal(r.summaries[0].balance,-90);
    await commit(finance,await preview(finance,payment({type:'REFUND',amount:'90'})));r=await settlements();assert.equal(r.summaries[0].balance,0);assert.equal(r.summaries[0].unallocated,-90);
    await settle(await settlementPreview({type:'RELEASE',sourceId:allocation.id}));await settle(await settlementPreview({type:'ALLOCATE',receiptId:receipt.id,lines:[{documentId:doc.id,amount:'110'}]}));r=await settlements();assert.equal(r.summaries[0].balance,0);assert.equal(r.summaries[0].unallocated,0);assert.equal(r.documents[0].credit,0);
    await post('출고',[line('PART','1','100')]);const next=(await settlements()).documents.find(d=>d.id!==doc.id);
    await reject(settlementPreview({type:'ALLOCATE',receiptId:receipt.id,lines:[{documentId:next.id,amount:'90'}]}));
  });
  await t.test('pending opening quantities survive master edits without becoming posted or valued inventory',async()=>{
    await reset(false);const pendingOpening={status:'PENDING_COST',basisDate:'2026-11-11',quantity:209,unit:'EA',source:'재고.xlsx 원본!C9'};
    await parent().collection('erpItems').doc('part').update({pendingOpening});
    let r=await masters(req({action:'inventory',itemId:'part'}));assert.equal(r.status,'PENDING_COST');assert.equal(r.pendingOpening.quantity,209);assert.equal(r.quantity,null);assert.equal(r.value,null);
    await save('items','part',{...itemValues('PART','일반품'),purchasePrice:10},1);r=await masters(req({action:'inventory',itemId:'part'}));assert.deepEqual(r.pendingOpening,{basisDate:'2026-11-11',quantity:209,unit:'EA',source:'재고.xlsx 원본!C9'});assert.equal(r.value,null);assert.equal((await records('erpMovements')).length,0);
    await reject(masters(req({action:'inventory',itemId:'part'},'member')),'permission-denied');
    await reject(save('items','part',{...itemValues('PART','일반품'),pendingOpening},2),'invalid-argument');
    await parent().collection('erpItems').doc('part').update({'pendingOpening.quantity':null});assert.equal((await masters(req({action:'inventory',itemId:'part'}))).pendingOpening.quantity,null);
    await parent().collection('erpItems').doc('part').update({'pendingOpening.quantity':-1});await reject(masters(req({action:'inventory',itemId:'part'})));
  });
  await t.test('pending opening costs post original quantities once and update both valuation and source status atomically',async()=>{
    await reset(false);await pendingItem();const list=await imports(req({action:'openingList'}));assert.equal(list.records.length,1);assert.equal(list.suggestedDate,'2026-11-11');
    const job=await openingPreview();assert.equal(job.preview.canCommit,true,JSON.stringify(job.preview.errors));assert.equal(job.preview.rows[0].value,2116);assert.equal(await stock('part'),undefined);
    const result=await Promise.all([commitMovement(job),commitMovement(job)]);assert.equal(result.filter(r=>r.idempotent).length,1);
    const item=(await parent().collection('erpItems').doc('part').get()).data();assert.equal(item.purchasePrice,10.1234);assert.equal(item.pendingOpening.status,'CONFIRMED');assert.equal(item.pendingOpening.confirmedQuantity,209);assert.equal(item.pendingOpening.value,2116);
    assert.equal((await stock('part')).quantity,209);assert.equal((await stock('part')).value,2116);
    const inventory=await masters(req({action:'inventory',itemId:'part'}));assert.equal(inventory.status,'RECORDED');assert.equal(inventory.pendingOpening,null);assert.equal(inventory.averagePrice,2116/209);
    assert.equal((await report()).rows.length,0);const state=(await parent().collection('erpState').doc('ledger').get()).data();assert.equal(state.basisDate,'2026-11-11');assert.equal(state.lastDate,null);
    await reject(openingPreview());await reject(imports(req({action:'downloadSource',id:job.id})));
    const [movement]=await records('erpMovements');await reject(correct('CANCEL',movement.id));
    await post('출고',[line('PART','9','30')]);assert.equal((await stock('part')).quantity,200);assert.equal((await ledger()).totals.cogsKRW,91);
  });
  await t.test('late opening confirmation appends a dated adjustment and preserves prior reports and ledger sequence',async()=>{
    await reset();await pendingItem('part2',3);const before=(await parent().collection('erpState').doc('ledger').get()).data();
    await reject(openingPreview([{itemId:'part2',quantity:'3',price:'50'}]));
    const job=await openingPreview([{itemId:'part2',quantity:'3',price:'50'}],{date:'2026-11-13'});assert.equal(job.preview.canCommit,true);assert.equal(job.preview.rows[0].postingMode,'ADJUSTMENT');await commitMovement(job);
    const state=(await parent().collection('erpState').doc('ledger').get()).data();assert.equal(state.basisDate,before.basisDate);assert.equal(state.lastDate,'2026-11-13');assert.equal(state.lastOrder,1);assert.equal(state.revision,before.revision+1);
    const old=await reports(req({action:'report',view:'summary',filters:{from:'2026-11-12',to:'2026-11-12',itemId:'part2',warehouseId:'',search:''}}));assert.equal(old.rows.length,0);
    const current=await reports(req({action:'report',view:'summary',filters:{from:'2026-11-13',to:'2026-11-13',itemId:'part2',warehouseId:'',search:''}}));assert.equal(current.rows[0].adjustQuantity,3);assert.equal(current.rows[0].closingValue,150);assert.equal(current.rows[0].salesKRW,0);
    const history=await masters(req({action:'purchaseHistory',itemId:'part2'}));assert.equal(history.rows[0].price,50);assert.equal(history.rows[0].priceBasis,'이관 원가 확정');
    await post('출고',[line('PART2','1','80')],{date:'2026-11-13'});assert.equal((await parent().collection('erpState').doc('ledger').get()).data().lastOrder,2);
  });
  await t.test('opening confirmation protects source quantities, unknown costs, zero confirmations, roles and concurrent previews',async()=>{
    await reset(false);await pendingItem('part',null);await pendingItem('part2',0);
    await reject(openingPreview([{itemId:'part',quantity:'',price:'10'}]),'invalid-argument');await reject(openingPreview([{itemId:'part',quantity:'1',price:''}]),'invalid-argument');
    for(const value of ['-1','1.00001'])await reject(openingPreview([{itemId:'part',quantity:value,price:'10'}]),'invalid-argument');
    await reject(openingPreview([{itemId:'part2',quantity:'1',price:'10'}]));await reject(openingPreview([{itemId:'part2',quantity:'0',price:'0'}]),'invalid-argument');
    const a=await openingPreview([{itemId:'part',quantity:'2',price:'20'},{itemId:'part2',quantity:'0',price:'0'}],{zeroCostConfirmed:true});assert.equal(a.preview.canCommit,true);
    const b=await openingPreview([{itemId:'part',quantity:'2',price:'20'}]);await commitMovement(a);await reject(commitMovement(b));assert.equal((await stock('part2')).quantity,0);assert.equal((await stock('part2')).value,0);
    for(const uid of [null,'member','manager','root','foreign'])await reject(imports(req({action:'openingList'},uid)),uid?'permission-denied':'unauthenticated');
    await reject(imports(req({action:'openingPreview',id:'forged',opening:{companyId:'b'}})),'invalid-argument');
    await reset();await pendingItem('part',209);const conflict=await openingPreview(undefined,{date:'2026-11-12'});assert.equal(conflict.preview.canCommit,false);assert.match(conflict.preview.errors[0].message,/대사/);assert.equal((await stock('part')).quantity,10);
  });
  await t.test('changed source, warehouse, or new stock invalidates the entire pending opening confirmation',async()=>{
    await reset(false);await pendingItem();const job=await openingPreview();
    await parent().collection('erpItems').doc('part').update({'pendingOpening.quantity':210});await reject(commitMovement(job));assert.equal(await stock('part'),undefined);
    await pendingItem();const next=await openingPreview();await save('warehouses','wh',{code:'WH',name:'본사',address:'',notes:'',active:false},1);await reject(commitMovement(next));assert.equal((await records('erpMovements')).length,0);
    await reset(false);await pendingItem();const stale=await openingPreview();await post('입고',[line('PART','1','10')]);await reject(commitMovement(stale));assert.equal((await stock('part')).quantity,1);
  });
  await t.test('collection plans retain due dates and monetary balances while preserving historical owner snapshots',async()=>{
    await reset();await db.doc('UserProfile/member').update({name:'회수 담당'});await post('출고',[line('PART','1','100')]);const doc=(await settlements()).documents[0];
    await settle(await settlementPreview({type:'TERMS',documentId:doc.id,dueDate:'2026-11-12'}));
    const follow=await settlementPreview({type:'FOLLOW_UP',documentId:doc.id,date:'2026-11-13',expectedDate:'2026-11-14',assigneeId:'member',notes:'첫 회수 약속'});const duplicate=await Promise.all([settle(follow),settle(follow)]);assert.equal(duplicate.filter(r=>r.idempotent).length,1);
    assert.equal((await settlements()).documents[0].assigneeId,'');let r=await settlements('2026-11-15');assert.equal(r.documents[0].dueDate,'2026-11-12');assert.equal(r.documents[0].overdueDays,3);assert.equal(r.documents[0].promiseOverdueDays,1);assert.equal(r.documents[0].assigneeName,'회수 담당');assert.equal(r.documents[0].balance,110);
    // Follow-up management must not advance or lock the financial posting date.
    await commit(finance,await preview(finance,payment({amount:'10'})));assert.equal((await settlements('2026-11-15')).documents[0].balance,110);assert.equal((await report()).rows[0].balance,100);
    await settle(await settlementPreview({type:'FOLLOW_UP',documentId:doc.id,date:'2026-11-15',expectedDate:'2026-11-14',assigneeId:'admin',notes:'경과된 약속일 유지·담당 재배정'}));
    await db.doc('UserProfile/admin').update({name:'변경된 이름'});r=await settlements('2026-11-15');assert.equal(r.documents[0].assigneeName,'이름 미등록');assert.equal(r.followUps.length,2);
    await settle(await settlementPreview({type:'FOLLOW_UP',documentId:doc.id,date:'2026-11-16',expectedDate:'',assigneeId:'',notes:'회수 일정 재협의'}));assert.equal((await settlements('2026-11-16')).documents[0].assigneeId,'');assert.equal((await settlements('2026-11-14')).documents[0].assigneeId,'member');
  });
  await t.test('collection assignment rejects foreign or departed staff and rechecks staff status at commit',async()=>{
    await reset();await post('출고',[line('PART','1','100')]);const doc=(await settlements()).documents[0],input={type:'FOLLOW_UP',documentId:doc.id,expectedDate:'2026-11-13',assigneeId:'member'};
    for(const assigneeId of ['foreign','root','missing'])await reject(settlementPreview({...input,assigneeId}));
    await reject(settlementPreview({...input,expectedDate:'2026-11-11'}),'invalid-argument');await reject(settlementPreview({...input,dueDate:'2026-12-01'}),'invalid-argument');
    const pending=await settlementPreview(input);await db.doc('UserProfile/member').update({status:'RESIGNED'});await reject(settle(pending));assert.equal((await records('erpSettlements')).length,0);
    await db.doc('UserProfile/member').update({status:'ACTIVE'});await settle(await settlementPreview(input));await db.doc('UserProfile/member').update({status:'RESIGNED'});
    const report=await settlements();assert.equal(report.documents[0].assigneeId,'member');assert.equal(report.documents[0].assigneeActive,false);assert.equal(report.assignees.some(p=>p.id==='member'),false);
    await reject(settlementPreview(input));await settle(await settlementPreview({...input,assigneeId:'admin'}));assert.equal((await settlements()).documents[0].assigneeActive,true);
  });
  await t.test('paid multi-line shipments atomically record one gross receipt and allocation with stock and sales',async()=>{
    await reset();await post('입고',[line('PART2','4','50')]);
    const job=await movementPreview('출고',[line('PART','2','300'),line('PART2','1','200')],{payment:{status:'PAID',...paidOptions}});
    assert.equal(job.preview.payment.newReceipt,880);assert.equal((await records('erpReceipts')).length,0);assert.equal((await stock('part')).quantity,10);
    const result=await Promise.all([commitMovement(job),commitMovement(job)]);assert.equal(result.filter(r=>r.idempotent).length,1);
    assert.equal((await stock('part')).quantity,8);assert.equal((await stock('part2')).quantity,3);assert.equal((await records('erpReceipts')).length,1);assert.equal((await records('erpSettlements')).length,1);
    const doc=(await settlements()).documents[0];assert.equal(doc.paymentTerms,'PAID');assert.equal(doc.paymentStatus,'PAID');assert.equal(doc.allocated,880);assert.equal(doc.balance,0);assert.equal((await report()).rows[0].balance,0);
    await reject(paidPreview(doc.id));const after=await imports(req({action:'commit',id:job.id,fingerprint:job.preview.fingerprint}));assert.equal(after.idempotent,true);
  });
  await t.test('credit shipments reuse existing partial receipts and only create the unpaid remainder once',async()=>{
    await reset();await post('출고',[line('PART','2','100')],{payment:{status:'CREDIT'}});assert.equal((await records('erpReceipts')).length,0);
    const doc=(await settlements()).documents[0];assert.equal(doc.paymentStatus,'CREDIT');await commit(finance,await preview(finance,payment({amount:'100'})));
    const a=await paidPreview(doc.id),b=await paidPreview(doc.id);assert.equal(a.summary.reused,100);assert.equal(a.summary.newReceipt,120);
    await paidCommit(a);await reject(paidCommit(b));assert.equal((await paidCommit(a)).idempotent,true);assert.equal((await records('erpReceipts')).reduce((sum,r)=>sum+r.amountMinor,0),220);assert.equal((await records('erpSettlements')).length,2);assert.equal((await settlements()).documents[0].paymentStatus,'PAID');
    const auto=(await records('erpReceipts')).find(r=>r.sourceKind==='MANUAL_PAYMENT_CONFIRM');await commit(finance,await preview(finance,{type:'CANCEL',sourceId:auto.id}));assert.equal((await settlements()).documents[0].paymentStatus,'PARTIAL');assert.equal((await settlements()).documents[0].balance,120);
    await paidCommit(await paidPreview(doc.id));assert.equal((await report()).rows[0].balance,0);
  });
  await t.test('paid shipment previews recheck finance revisions and cancellation preserves actual receipts',async()=>{
    await reset();await post('출고',[line('PART','1','100')],{payment:{status:'CREDIT'}});
    const invalid=await movementPreview('출고',[line('PART','100','200')],{payment:{status:'PAID',...paidOptions}});assert.equal(invalid.preview.canCommit,false);assert.equal(invalid.preview.payment,null);assert.match(invalid.preview.errors[0].message,/재고 부족/);await reject(commitMovement(invalid));assert.equal((await records('erpReceipts')).length,0);
    const pending=await movementPreview('출고',[line('PART','1','200')],{payment:{status:'PAID',...paidOptions}});
    await commit(finance,await preview(finance,payment({amount:'50'})));await reject(commitMovement(pending));assert.equal((await stock('part')).quantity,9);
    const [sale]=await post('출고',[line('PART','1','200')],{payment:{status:'PAID',...paidOptions}});await correct('CANCEL',sale.id);
    assert.equal((await records('erpReceipts')).length,2);assert.equal((await stock('part')).quantity,9);assert.equal((await settlements()).documents.find(d=>d.documentNo===sale.documentNo).paymentStatus,'REFUND_DUE');
    await reject(movementPreview('출고',[line()],{payment:undefined}),'invalid-argument');
    await reject(movementPreview('입고',[line()],{payment:{status:'PAID',...paidOptions}}),'invalid-argument');
    await reject(movementPreview('출고',[line()],{payment:{status:'PAID',...paidOptions,receiptMode:'NEW'}}),'invalid-argument');
  });
  await t.test('paid bundles count one sale and free shipments create no zero-value financial rows',async()=>{
    await reset();await post('입고',[line('PART2','10','50')]);await save('items','bundle',{...itemValues('SET','세트'),itemType:'BUNDLE',components:[{itemId:'part',quantity:2},{itemId:'part2',quantity:1}]});
    await post('출고',[line('SET','1','200')],{payment:{status:'PAID',...paidOptions}});assert.equal((await stock('part')).quantity,8);assert.equal((await records('erpReceipts'))[0].amountMinor,220);assert.equal((await settlements()).documents.length,1);
    await post('출고',[line('PART','1','0')],{payment:{status:'PAID',...paidOptions}});assert.equal((await records('erpReceipts')).length,1);assert.equal((await settlements()).documents.some(d=>d.paymentStatus==='NO_BALANCE'),true);
  });
  await t.test('manual paid confirmations enforce exact scope, active partners, cutoff dates and review job kinds',async()=>{
    await reset();await post('출고',[line('PART','1','100')]);const doc=(await settlements()).documents[0];
    for(const uid of [null,'member','manager','root','foreign'])for(const action of ['dashboard','paymentPreview'])await reject(finance(req({action,month:'2026-11',id:'deny',input:{}},uid)),uid?'permission-denied':'unauthenticated');
    await reject(paidPreview(doc.id,{companyId:'b'}),'invalid-argument');await reject(paidPreview(doc.id,{date:'2026-11-11'}));await reject(paidPreview('foreign-doc'));
    const job=await paidPreview(doc.id);await reject(settle(job));const terms=await settlementPreview({type:'TERMS',documentId:doc.id,dueDate:'2026-11-13'});await reject(paidCommit(terms),'already-exists');
    await save('partners','buyer',{code:'buyer',name:'buyer',country:'KR',type:'BOTH',active:false,notes:''},1);await reject(paidCommit(job));assert.equal((await records('erpReceipts')).length,0);
    await reject(dashboard('2026-13'),'invalid-argument');await reject(dashboard('2026-12'),'invalid-argument');
  });
  await t.test('monthly dashboard uses original purchase refund prices instead of moving-average stock removal',async()=>{
    await reset();const original=(await records('erpMovements'))[0];await post('입고',[line('PART','10','300')]);await correct('PURCHASE_RETURN',original.id,'1');
    const d=await dashboard('2026-11');assert.equal(d.inventoryValue,3800);assert.equal(d.purchasesKRW,3900);assert.equal(d.currencies[0].purchases,3900);assert.equal(d.assets[0].closingQuantity,19);assert.equal(d.asOf,'2026-11-12');assert.equal(d.partialMonth,true);
    const returned=(await records('erpMovements')).find(r=>r.operationType==='PURCHASE_RETURN');await correct('CANCEL',returned.id);assert.equal((await dashboard('2026-11')).purchasesKRW,4000);assert.equal((await dashboard('2026-11')).inventoryValue,4000);
  });
  await t.test('monthly snapshots preserve old receivables after later payment and keep foreign currencies separate',async()=>{
    await reset(false);await post('입고',[line('PART','10','100')],{date:'2026-10-31'});await post('출고',[line('PART','2','200')],{payment:{status:'CREDIT'}});
    await post('출고',[line('PART','1','2')],{currency:'USD',exchangeRate:'1300',payment:{status:'CREDIT'}});
    let d=await dashboard('2026-11');assert.equal(d.inventoryValue,700);assert.equal(d.salesKRW,3000);assert.equal(d.currencies.find(r=>r.currency==='KRW').outstanding,440);assert.equal(d.currencies.find(r=>r.currency==='USD').outstanding,220);assert.equal(d.trend.find(r=>r.month==='2026-10').inventoryValue,1000);
    const doc=(await settlements()).documents.find(d=>d.currency==='KRW');await paidCommit(await paidPreview(doc.id,{date:'2026-12-01'}));
    const future=()=>new Date('2026-12-02T00:00:00Z'),api=createErpFinanceService({db,now:future});const q=month=>api({data:{action:'dashboard',companyId:'a',month},auth:{uid:'admin',token:{auth_time:future().getTime()/1000}}});
    d=await q('2026-11');assert.equal(d.partialMonth,false);assert.equal(d.asOf,'2026-11-30');assert.equal(d.currencies.find(r=>r.currency==='KRW').outstanding,440);assert.equal((await q('2026-12')).currencies.find(r=>r.currency==='KRW').outstanding,0);
    assert.equal((await dashboard('2026-10')).inventoryValue,1000);
  });
  await t.test('monthly exports include all 101-plus rows and match a single reviewed snapshot in PDF and Excel data',async()=>{
    await reset();await parent().update({nameKo:'합성 출력회사'});const original=(await records('erpMovements'))[0],batch=db.batch();
    for(let i=0;i<101;i++)batch.set(parent().collection('erpMovements').doc('export-'+i),{...original,id:'export-'+i,itemId:'export-'+i,code:'000'+i,name:'출력 품목 '+i,quantityScaled:10000,value:100,supply:100,tax:10,total:110,afterQuantity:1,afterValue:100});await batch.commit();
    const d=await dashboard('2026-11');assert.equal(d.assets.length,100);assert.equal(d.assetCount,102);assert.equal(d.purchaseCount,102);
    const input={action:'dashboardExport',month:'2026-11',snapshot:d.snapshot,format:'DATA'},data=await finance(req(input));
    assert.equal(data.sections.find(s=>s.name==='재고자산 내역').rows.length,102);assert.equal(data.sections.find(s=>s.name==='매입내역').rows.length,102);
    assert.equal(data.sections[0].rows.find(r=>r[0]==='재고자산')[1],11100);assert.equal(data.companyName,'합성 출력회사');
    const auditBefore=(await records('erpAudit')).length;let captured;
    const api=createErpFinanceService({db,now,renderFinancePdf:async value=>{captured=value;return Buffer.from('%PDF-synthetic');}}),pdf=await api(req({...input,format:'PDF'}));
    assert.equal(captured.snapshot,data.snapshot);assert.equal(pdf.sourceSnapshot,d.snapshot);assert.equal(pdf.snapshot,data.snapshot);assert.equal(pdf.size,14);assert.match(pdf.sha256,/^[a-f0-9]{64}$/);
    assert.equal((await records('erpAudit')).length,auditBefore);assert.equal((await records('erpIssuedDocuments')).length,0);
    await parent().update({nameKo:'변경된 회사'});await reject(finance(req(input)));await reject(finance(req({...input,snapshot:'bad'})),'invalid-argument');
  });
  await t.test('partner statements reconcile currencies, unallocated receipts and credits without exposing internal notes',async()=>{
    await reset();await post('출고',[line('PART','2','100')]);const sale=(await settlements()).documents[0];
    await post('출고',[line('PART','1','2')],{currency:'USD',exchangeRate:'1300'});await commit(finance,await preview(finance,payment({amount:'100',reference:'PRIVATE-BANK-REF',notes:'PRIVATE-RECEIPT-NOTE'})));
    await settle(await settlementPreview({type:'TERMS',documentId:sale.id,dueDate:'2026-11-12'}));await settle(await settlementPreview({type:'FOLLOW_UP',documentId:sale.id,expectedDate:'2026-11-20',assigneeId:'admin',notes:'PRIVATE-FOLLOW-UP'}));
    const to='2026-11-13',source=await settlements(to),input={action:'statementExport',to,partnerId:'buyer',snapshot:source.snapshot,format:'DATA'},out=await finance(req(input));
    const totals=out.sections[0].rows;assert.deepEqual(totals.find(r=>r[0]==='KRW'),['KRW',220,100,220,100,120,220]);assert.deepEqual(totals.find(r=>r[0]==='USD'),['USD',2.2,0,2.2,0,2.2,0]);
    assert.equal(out.sections[1].rows.find(r=>r[1]===sale.documentNo)[7],1);assert.equal(out.sections[2].rows[0][3],100);
    for(const secret of ['PRIVATE-BANK-REF','PRIVATE-RECEIPT-NOTE','PRIVATE-FOLLOW-UP','assigneeId','followUpNotes'])assert.equal(JSON.stringify(out).includes(secret),false);
    await save('partners','buyer',{code:'buyer',name:'buyer',country:'KR',type:'BOTH',active:false,notes:''},1);assert.equal((await finance(req(input))).partnerName,'buyer');
    await save('partners','buyer',{code:'buyer',name:'buyer',country:'KR',type:'BOTH',active:true,notes:''},2);await commit(finance,await preview(finance,payment({amount:'20'})));await reject(finance(req(input)));
    const original=(await records('erpMovements')).find(r=>r.documentNo===sale.documentNo);await correct('SALES_RETURN',original.id,'2');
    const credit=await finance(req({...input,snapshot:(await settlements(to)).snapshot}));assert.equal(credit.sections[0].rows.find(r=>r[0]==='KRW')[5],-120);
    const monthlyCredit=await dashboard('2026-11');assert.equal(monthlyCredit.partners.find(r=>r.currency==='KRW').balance,-120);assert.equal(monthlyCredit.currencies.find(r=>r.currency==='KRW').refundDue,120);
    const empty=await finance(req({...input,to:'2026-11-11',snapshot:(await settlements('2026-11-11')).snapshot}));assert.equal(empty.sections[1].rows.length,0);
  });
  await t.test('report export endpoints enforce company identity, role, exact fields and post-render revocation',async()=>{
    await reset();const d=await dashboard('2026-11'),input={action:'dashboardExport',month:'2026-11',snapshot:d.snapshot,format:'DATA'};
    for(const uid of [null,'member','manager','root','foreign'])await reject(finance(req(input,uid)),uid?'permission-denied':'unauthenticated');
    await reject(finance(req({...input,rows:[]})),'invalid-argument');await reject(finance(req({...input,format:'HTML'})),'invalid-argument');
    const snapshot=(await settlements()).snapshot;await db.doc('companies/b/erpPartners/foreign-only').set({companyId:'b',name:'비공개 거래처'});
    await reject(finance(req({action:'statementExport',to:'2026-11-12',partnerId:'foreign-only',snapshot,format:'DATA'})),'not-found');
    const api=createErpFinanceService({db,now,renderFinancePdf:async()=>{await db.doc('UserProfile/admin').update({status:'DISABLED'});return Buffer.from('%PDF-synthetic');}});
    await reject(api(req({...input,format:'PDF'})),'permission-denied');
  });
}finally{await deleteApp(app);}});
