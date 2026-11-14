const {fail}=require('./security-context');
const M=require('./erp-ledger-model');

function scaled(value,label='재고 수량'){
  const result=Math.round(value*10000);
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||Math.abs(value*10000-result)>0.001)fail('failed-precondition',`${label}을 확인해 주세요. 음수 재고는 보관·차용 원장과 대사해야 합니다.`);
  return M.signed(result,label);
}
function nonnegative(value,label){if(!Number.isSafeInteger(value)||value<0)fail('failed-precondition',`${label}을 확인해 주세요.`);return M.signed(value,label);}
function pendingOf(item){
  const p=item.pendingOpening;if(p?.status!=='PENDING_COST')return null;
  M.date(p.basisDate);if(p.quantity!==null)scaled(p.quantity,'이관 대기 수량');
  return {basisDate:p.basisDate,quantity:p.quantity,source:M.text(p.source,'원본 위치',200,true),unit:M.text(p.unit,'원본 단위',20,true)};
}
async function warehouses(tx,parent,master){
  const docs=await tx.get(parent.collection('erpWarehouses').limit(501));
  if(docs.size>500)fail('resource-exhausted','창고별 재고 조회는 최대 500개 창고입니다.');
  const result=new Map();for(const doc of docs.docs){const row=doc.data();master.verifyTenant(row,parent.id);master.identifier(doc.id);result.set(doc.id,{id:doc.id,code:row.code,name:row.name,active:row.active===true});}return result;
}
// This projection deliberately omits customer identities, references and loan valuations.
async function itemState(tx,parent,item,wh,master,budget={rows:0}){
  const results=await Promise.all(['erpInventory','erpCustodyLots','erpBorrowings'].map(name=>tx.get(parent.collection(name).where('itemId','==',item.id).limit(501))));
  budget.rows+=results.reduce((n,r)=>n+r.size,0);
  if(results.some(r=>r.size>500)||budget.rows>10000)fail('resource-exhausted','품목별 재고·보관·차용 조회 범위를 초과했습니다. 전체 자료를 대사한 후 조회해 주세요.');
  const stocks=new Map(),holdings=new Map(),lots=new Map(),loanTotals=new Map();
  function check(row){master.verifyTenant(row,parent.id);if(row.itemId!==item.id||!wh.has(master.identifier(row.warehouseId)))fail('failed-precondition','품목·창고 연결을 확인해 주세요.');}
  function held(id){if(!holdings.has(id))holdings.set(id,{customerHeldScaled:0,borrowedScaled:0});return holdings.get(id);}
  for(const doc of results[0].docs){const row=doc.data();check(row);const quantityScaled=scaled(row.quantity),value=nonnegative(row.value,'재고 금액');
    if(stocks.has(row.warehouseId)||row.currency!=='KRW'||!quantityScaled&&value)fail('failed-precondition','창고별 재고 중복·통화·수량과 금액을 확인해 주세요.');
    stocks.set(row.warehouseId,{quantityScaled,value,updatedAt:row.updatedAt||null});}
  for(const doc of results[1].docs){const row=doc.data();check(row);
    for(const k of ['availableQuantityScaled','borrowedQuantityScaled','deliveredQuantityScaled'])nonnegative(row[k],'고객 소유 보관 수량');
    if(row.cancelled){if(row.availableQuantityScaled||row.borrowedQuantityScaled)fail('failed-precondition','취소한 보관품의 잔량을 확인해 주세요.');continue;}
    lots.set(doc.id,row);const h=held(row.warehouseId);h.customerHeldScaled=M.signed(h.customerHeldScaled+row.availableQuantityScaled);}
  for(const doc of results[2].docs){const row=doc.data();check(row);const outstanding=nonnegative(row.outstandingQuantityScaled,'차용 미반환 수량');nonnegative(row.quantityScaled,'차용 수량');
    if(outstanding>row.quantityScaled||row.cancelled&&outstanding)fail('failed-precondition','차용 미반환 수량을 확인해 주세요.');
    if(!outstanding)continue;const lot=lots.get(row.lotId);
    if(!lot||lot.warehouseId!==row.warehouseId||lot.ownerPartnerId!==row.ownerPartnerId)fail('failed-precondition','차용과 고객 보관품의 연결을 대사해 주세요.');
    loanTotals.set(row.lotId,M.signed((loanTotals.get(row.lotId)||0)+outstanding));const h=held(row.warehouseId);h.borrowedScaled=M.signed(h.borrowedScaled+outstanding);}
  for(const [id,lot]of lots)if(lot.borrowedQuantityScaled!==(loanTotals.get(id)||0))fail('failed-precondition','보관품 차용 수량과 차용 미반환 원장을 대사해 주세요.');
  return {item,stocks,holdings,pending:pendingOf(item)};
}
function composition(components,master){
  if(!Array.isArray(components)||!components.length||components.length>20)fail('failed-precondition','세트 구성을 확인해 주세요.');
  const seen=new Set();return components.map(c=>{const itemId=master.identifier(c.itemId);if(seen.has(itemId)||!nonnegative(c.quantityScaled,'세트 구성 수량'))fail('failed-precondition','세트 구성품과 수량을 확인해 주세요.');seen.add(itemId);return {itemId,quantityScaled:c.quantityScaled};});
}
function estimate(states,components,warehouse,sets=10000,parentActive=true){
  const rows=components.map(c=>{
    const state=states.get(c.itemId),item=state.item,stock=state.stocks.get(warehouse.id),holding=state.holdings.get(warehouse.id);
    const product=BigInt(sets)*BigInt(c.quantityScaled);if(product%10000n)fail('invalid-argument','세트와 구성 수량의 곱은 소수점 4자리 이하여야 합니다.');
    const needed=M.signed(Number(product/10000n)),quantity=stock?.quantityScaled||0,value=stock?.value||0,active=warehouse.active&&item.active===true&&item.itemType!=='BUNDLE'&&parentActive;
    const enough=active&&quantity>=needed;
    return {itemId:item.id,code:item.code,name:item.name,unit:item.unit,recorded:!!stock,active:item.active===true,perSet:c.quantityScaled/10000,quantity:quantity/10000,needed:needed/10000,
      shortage:Math.max(0,needed-quantity)/10000,availableSets:active?Math.floor(quantity/c.quantityScaled):0,averagePrice:quantity?value*10000/quantity:null,
      estimatedCost:enough?M.averageCost(value,quantity,needed):null,pendingCost:!!state.pending,pendingQuantity:state.pending?.quantity??null,pendingUnit:state.pending?.unit||item.unit,
      customerHeld:(holding?.customerHeldScaled||0)/10000,borrowedOutstanding:(holding?.borrowedScaled||0)/10000};
  });
  const canShip=parentActive&&warehouse.active&&rows.every(r=>r.active&&!r.shortage);
  return {rows,canShip,availableSets:Math.min(...rows.map(r=>r.availableSets)),estimatedCost:canShip?M.signed(rows.reduce((n,r)=>n+r.estimatedCost,0)):null};
}
async function inventory({db,request,companyRef,context,now,master,view}){
  M.exactObject(request.data,['action','companyId','itemId']);const id=master.identifier(request.data.itemId);
  return db.runTransaction(async tx=>{
    await context(request,tx);const doc=await tx.get(companyRef.collection('erpItems').doc(id));if(!doc.exists)fail('not-found','품목을 찾을 수 없습니다.');master.verifyTenant(doc.data(),companyRef.id);
    const item={...doc.data(),id:doc.id},wh=await warehouses(tx,companyRef,master),base={item:view('items',id,doc.data(),true),currency:'KRW',checkedAt:now().toISOString()};
    if(item.itemType==='BUNDLE'){
      const components=composition(item.components,master),parts=await tx.getAll(...components.map(c=>companyRef.collection('erpItems').doc(c.itemId))),states=new Map(),budget={rows:0};
      for(const part of parts){if(!part.exists)fail('failed-precondition','세트 구성품을 찾을 수 없습니다.');master.verifyTenant(part.data(),companyRef.id);if(part.data().itemType==='BUNDLE')fail('failed-precondition','세트 안에 세트를 포함할 수 없습니다.');states.set(part.id,await itemState(tx,companyRef,{...part.data(),id:part.id},wh,master,budget));}
      const rows=[...wh.values()].map(w=>{const e=estimate(states,components,w,10000,item.active===true);return {warehouseId:w.id,warehouseCode:w.code,warehouseName:w.name,warehouseActive:w.active,quantity:e.availableSets,value:0,updatedAt:null,estimatedCost:e.estimatedCost,canShip:e.canShip,components:e.rows};});
      return {...base,virtual:true,status:'RECORDED',quantity:M.signed(rows.reduce((n,r)=>n+r.quantity,0)),value:0,averagePrice:null,warehouses:rows};
    }
    const state=await itemState(tx,companyRef,item,wh,master),ids=new Set([...state.stocks.keys(),...state.holdings.keys()]);
    const rows=[...ids].map(id=>{const w=wh.get(id),s=state.stocks.get(id),h=state.holdings.get(id);return {warehouseId:id,warehouseCode:w.code,warehouseName:w.name,warehouseActive:w.active,
      quantity:(s?.quantityScaled||0)/10000,value:s?.value??null,recorded:!!s,updatedAt:s?.updatedAt||null,customerHeld:(h?.customerHeldScaled||0)/10000,borrowedOutstanding:(h?.borrowedScaled||0)/10000};});
    const sum=key=>M.signed(rows.reduce((n,r)=>n+Math.round(r[key]*10000),0))/10000;
    const quantity=state.stocks.size?sum('quantity'):null,value=state.stocks.size?M.signed(rows.reduce((n,r)=>n+(r.value||0),0)):null;
    return {...base,pendingOpening:state.pending,status:state.stocks.size?'RECORDED':state.pending?'PENDING_COST':'UNINITIALIZED',quantity,value,averagePrice:quantity>0?value/quantity:null,
      customerHeld:sum('customerHeld'),borrowedOutstanding:sum('borrowedOutstanding'),warehouses:rows};
  });
}
module.exports={scaled,pendingOf,warehouses,itemState,composition,estimate,inventory};
