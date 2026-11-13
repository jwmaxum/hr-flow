const {authorizeContext,fail}=require('./security-context');
const {erpMaster:master}=require('./erp-service');
const M=require('./erp-ledger-model');
const {custodyContext}=require('./erp-custody-model');
function inputOf(v) {
  M.exactObject(v,['type','date','notes','itemId','warehouseId','ownerPartnerId','quantity','lotId','borrowingId','sourceId','reference']);
  if (!['REGISTER','DELIVER','REPAY','CANCEL'].includes(v.type)) fail('invalid-argument','보관 처리 유형을 확인해 주세요.');
  const r={type:v.type,date:M.date(v.date),notes:M.text(v.notes,'처리 사유',500,true)};
  if (v.type==='CANCEL') {r.sourceId=master.identifier(v.sourceId);return r;}
  r.quantityScaled=M.decimal(v.quantity,4,'처리 수량',1e12);
  if (!r.quantityScaled) fail('invalid-argument','양수 수량을 입력해 주세요.');
  if (v.type==='REGISTER') Object.assign(r,{itemId:master.identifier(v.itemId),warehouseId:master.identifier(v.warehouseId),ownerPartnerId:master.identifier(v.ownerPartnerId),reference:M.text(v.reference,'판매 증빙번호',100,true)});
  if (v.type==='DELIVER') r.lotId=master.identifier(v.lotId);
  if (v.type==='REPAY') r.borrowingId=master.identifier(v.borrowingId);
  return r;
}
function createErpCustodyService({db,now=()=>new Date()}) {
  async function context(request,tx) {const user=await authorizeContext({db,request,reader:tx||db,now,roles:['ADMIN']});if(user.companyId!==request.data.companyId)fail('permission-denied','로그인한 회사에서 처리해 주세요.');return user;}
  async function plan(tx,parent,job) {
    const input=job.input,custody=custodyContext(tx,parent,job),readState=[];
    const stateRef=parent.collection('erpState').doc('ledger'),stateSnap=await tx.get(stateRef),state=stateSnap.data();
    if (!state?.basisDate) fail('failed-precondition','기초재고 또는 첫 입고를 먼저 확정해 주세요.');
    master.verifyTenant(state,parent.id);
    if(input.date<state.basisDate || state.lastDate && input.date<state.lastDate)fail('failed-precondition',`마지막 재고 처리일 ${state.lastDate||state.basisDate} 이후로 등록해 주세요.`);
    const custodyStateRef=parent.collection('erpState').doc('custody'),custodyStateSnap=await tx.get(custodyStateRef),custodyState=custodyStateSnap.data()||{};
    if(custodyStateSnap.exists)master.verifyTenant(custodyState,parent.id);
    if(custodyState.lastDate && input.date<custodyState.lastDate)fail('failed-precondition',`마지막 보관 처리일 ${custodyState.lastDate} 이후로 등록해 주세요.`);
    async function record(collection,id) {const snap=await tx.get(parent.collection(collection).doc(id));if(!snap.exists)fail('not-found','회사 기준정보를 찾을 수 없습니다.');master.verifyTenant(snap.data(),parent.id);readState.push([snap.ref.path,snap.data()]);return {...snap.data(),id:snap.id};}
    let row=null,stock=null,source=null;const summary={type:input.type,quantity:input.quantityScaled/10000||0};
    const order=state.lastDate===input.date?state.lastOrder+1:1;
    if(!Number.isSafeInteger(order)||order>999999)fail('failed-precondition','일별 처리순서를 확인해 주세요.');
    async function inventory(itemId,warehouseId) {
      const matches=await tx.get(parent.collection('erpInventory').where('itemId','==',itemId).where('warehouseId','==',warehouseId).limit(2));
      if(matches.size!==1)fail('failed-precondition','반환할 회사 소유 재고를 먼저 입고해 주세요.');
      const doc=matches.docs[0],data=doc.data();master.verifyTenant(data,parent.id);
      const quantityScaled=M.decimal(data.quantity,4,'현재고',9e12);M.signed(data.value);
      if(data.currency!=='KRW'||data.value<0||!quantityScaled&&data.value)fail('failed-precondition','현재고 형식을 확인해 주세요.');
      readState.push([doc.ref.path,data]);return {ref:doc.ref,before:data,quantityScaled,value:data.value};
    }
    function movement(lot,effect,stockValue) {
      const after=M.applyEffect(stockValue,effect);
      return {companyId:parent.id,type:'CORRECTION',operationType:`CUSTODY_${input.type}`,operationId:job.id,sourceId:null,date:input.date,order,rowNo:1,
        documentNo:`CUST-${job.id}`,direction:input.type==='CANCEL'?'차용반환취소':'차용현물반환',itemId:lot.itemId,code:lot.code,name:lot.name,unit:lot.unit || '',warehouseId:lot.warehouseId,warehouseName:lot.warehouseName,
        partnerId:lot.ownerPartnerId,partnerName:lot.ownerName,currency:'KRW',effect,beforeQuantity:stockValue.quantityScaled/10000,beforeValue:stockValue.value,
        afterQuantity:after.quantityScaled/10000,afterValue:after.value,reason:input.notes,createdAt:job.createdAt,createdBy:job.createdBy};
    }
    if(input.type==='REGISTER') {
      const item=await record('erpItems',input.itemId),warehouse=await record('erpWarehouses',input.warehouseId),owner=await record('erpPartners',input.ownerPartnerId);
      if(!item.active||!warehouse.active||!owner.active||item.itemType==='BUNDLE')fail('failed-precondition','활성 일반 품목·창고·거래처를 선택해 주세요.');
      await custody.hold(`held_${job.id}`,{...input,documentNo:input.reference},item,warehouse,owner);
      Object.assign(summary,{name:item.name,ownerName:owner.name,warehouseName:warehouse.name,notice:'이미 판매한 타사 소유 보관품입니다. 매출·회사 재고자산에 중복 반영하지 않습니다.'});
    } else if(input.type==='DELIVER') {
      const lot=await custody.read('erpCustodyLots',input.lotId);custody.validate(lot);
      if(input.date<lot.date||lot.availableQuantityScaled<input.quantityScaled)fail('failed-precondition','보관일 이후, 실제 보관 수량 범위에서 인도해 주세요.');
      lot.availableQuantityScaled-=input.quantityScaled;lot.deliveredQuantityScaled+=input.quantityScaled;custody.put('erpCustodyLots',input.lotId,lot);
      Object.assign(summary,{name:lot.name,ownerName:lot.ownerName,warehouseName:lot.warehouseName,remaining:lot.availableQuantityScaled/10000});
    } else if(input.type==='REPAY') {
      const loan=await custody.read('erpBorrowings',input.borrowingId),lot=await custody.read('erpCustodyLots',loan.lotId);custody.validate(lot);
      if(input.date<loan.date||input.quantityScaled>loan.outstandingQuantityScaled)fail('failed-precondition','차용일 이후, 미반환 수량 범위에서 반환해 주세요.');
      stock=await inventory(loan.itemId,loan.warehouseId);
      const actual=M.averageCost(stock.value,stock.quantityScaled,input.quantityScaled),evaluation=M.allocation(loan.outstandingValue,0,input.quantityScaled,loan.outstandingQuantityScaled);
      loan.outstandingQuantityScaled-=input.quantityScaled;loan.outstandingValue-=evaluation;loan.repaidQuantityScaled+=input.quantityScaled;
      lot.borrowedQuantityScaled-=input.quantityScaled;lot.availableQuantityScaled+=input.quantityScaled;custody.validate(lot);
      custody.put('erpBorrowings',input.borrowingId,loan);custody.put('erpCustodyLots',loan.lotId,lot);
      const effect=M.zeroEffect();effect.outQuantityScaled=input.quantityScaled;effect.outValue=actual;effect.cogsKRW=actual-evaluation;
      row=movement(lot,effect,stock);Object.assign(summary,{name:lot.name,ownerName:lot.ownerName,warehouseName:lot.warehouseName,actualCost:actual,evaluationCost:evaluation,costDifference:actual-evaluation,remaining:loan.outstandingQuantityScaled/10000});
    } else {
      source=await record('erpCustodyJobs',input.sourceId);
      if(source.status!=='COMMITTED'||source.input.type==='CANCEL'||source.cancelledBy)fail('failed-precondition','취소 가능한 보관 처리를 선택해 주세요.');
      for(const change of source.changes) {
        const [,collection,id]=change.path.split('/').slice(-3); // company path ends with companyId/collection/id
        if(!['erpCustodyLots','erpBorrowings'].includes(collection))fail('failed-precondition','보관 취소 연결을 확인해 주세요.');
        const current=await custody.read(collection,id);
        if(input.date<(current.lastDate || current.date))fail('failed-precondition','마지막 보관 처리일 이후로 취소해 주세요.');
        const business=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['revision','updatedAt','lastDate'].includes(key)));
        if(M.hash(business(current))!==M.hash(business(change.after)))fail('failed-precondition','후속 보관·차용 처리가 있어 취소할 수 없습니다. 후속 처리를 먼저 취소해 주세요.');
        custody.put(collection,id,change.before || {...current,availableQuantityScaled:0,borrowedQuantityScaled:0,deliveredQuantityScaled:0,cancelled:true});
      }
      if(source.row) {
        if(state.revision!==source.committedLedgerRevision)fail('failed-precondition','후속 재고 거래가 있어 반환 취소가 불가능합니다.');
        stock=await inventory(source.row.itemId,source.row.warehouseId);
        row=movement({...source.row,ownerPartnerId:source.row.partnerId,ownerName:source.row.partnerName},M.reverse(source.row.effect),stock);
      }
      Object.assign(summary,{...source.summary,type:'CANCEL'});
    }
    const changes=custody.snapshot(),fingerprint=M.hash({input,state,custodyState,readState,changes,row,summary});
    return {custody,changes,fingerprint,summary,row,stock,state,stateRef,custodyState,custodyStateRef,source};
  }
  return async request=>{
    const input=M.exactObject(request.data,['action','companyId','id','input','fingerprint']);
    if(!['list','preview','commit'].includes(input.action))fail('invalid-argument','보관 요청을 확인해 주세요.');
    M.exactObject(input,['action','companyId',...({list:[],preview:['id','input'],commit:['id','fingerprint']})[input.action]]);
    const user=await context(request),parent=db.collection('companies').doc(user.companyId);
    if(input.action==='list') return db.runTransaction(async tx=>{
      await context(request,tx);const result={companyId:parent.id};
      for(const [key,collection] of [['lots','erpCustodyLots'],['borrowings','erpBorrowings'],['operations','erpCustodyJobs']]) {
        const query=key==='operations'?parent.collection(collection).where('status','==','COMMITTED').limit(5001):parent.collection(collection).limit(5001);
        const snaps=await tx.get(query);if(snaps.size>5000)fail('resource-exhausted','보관 자료 5,000건을 초과했습니다. 분할 조회를 요청해 주세요.');
        result[key]=snaps.docs.map(doc=>{master.verifyTenant(doc.data(),parent.id);const data=doc.data();return key==='operations'?{id:doc.id,input:data.input,summary:data.summary,cancelledBy:data.cancelledBy||null}: {...data,id:doc.id};});
      }
      return result;
    });
    const id=master.identifier(input.id),ref=parent.collection('erpCustodyJobs').doc(id),normalized=input.action==='preview'?inputOf(input.input):null;
    return db.runTransaction(async tx=>{
      await context(request,tx);const snap=await tx.get(ref),old=snap.data();if(old)master.verifyTenant(old,parent.id);
      if(input.action==='preview') {
        if(old){if(M.hash(old.input)!==M.hash(normalized))fail('already-exists','새 미리보기로 확인해 주세요.');return {job:old};}
        const job={id,companyId:parent.id,input:normalized,status:'PENDING',createdAt:now().toISOString(),createdBy:user.uid};
        const fresh=await plan(tx,parent,job),saved={...job,fingerprint:fresh.fingerprint,summary:fresh.summary,changes:fresh.changes,row:fresh.row};tx.create(ref,saved);return {job:saved};
      }
      if(!old||input.fingerprint!==old.fingerprint)fail('failed-precondition','확인한 미리보기를 사용해 주세요.');
      if(old.status==='COMMITTED')return {job:old,idempotent:true};
      const fresh=await plan(tx,parent,old);if(fresh.fingerprint!==old.fingerprint)fail('failed-precondition','보관·재고 원장이 변경되었습니다. 다시 미리보기를 확인해 주세요.');
      const at=now().toISOString();fresh.custody.flush(at);
      if(fresh.row) {
        tx.create(parent.collection('erpMovements').doc(M.hash(['custody',id])),{...fresh.row,committedAt:at,committedBy:user.uid});
        tx.set(fresh.stock.ref,{...fresh.stock.before,quantity:fresh.row.afterQuantity,value:fresh.row.afterValue,updatedAt:at,operationId:id});
        tx.set(fresh.stateRef,{...fresh.state,revision:fresh.state.revision+1,lastDate:old.input.date,lastOrder:fresh.row.order,updatedAt:at});
      }
      tx.set(fresh.custodyStateRef,{companyId:parent.id,revision:(fresh.custodyState.revision||0)+1,lastDate:old.input.date,updatedAt:at});
      if(fresh.source)tx.update(parent.collection('erpCustodyJobs').doc(fresh.source.id),{cancelledBy:id});
      const patch={status:'COMMITTED',committedAt:at,committedLedgerRevision:fresh.row?fresh.state.revision+1:fresh.state.revision};tx.update(ref,patch);
      tx.create(parent.collection('erpAudit').doc(),{companyId:parent.id,actorId:user.uid,action:`CUSTODY_${old.input.type}`,operationId:id,at});return {job:{...old,...patch},idempotent:false};
    });
  };
}
module.exports={createErpCustodyService:require('./erp-governance').governedService(createErpCustodyService,'custody'),inputOf};
