const { fail } = require('./security-context');
const { erpMaster: master } = require('./erp-service');
const M = require('./erp-ledger-model');

// Customer-owned goods never enter erpInventory. All changes share the sale's transaction.
function custodyContext(tx, parent, job) {
  const staged = new Map(), before = new Map();
  async function read(collection, id, optional = false) {
    const ref = parent.collection(collection).doc(master.identifier(id));
    if (staged.has(ref.path)) return staged.get(ref.path).data;
    const snap = await tx.get(ref), data = snap.data();
    if (!data && !optional) fail('not-found','보관·차용 원장을 찾을 수 없습니다.');
    if (data) master.verifyTenant(data,parent.id);
    before.set(ref.path,data || null); staged.set(ref.path,{ref,data:data ? {...data}:null}); return staged.get(ref.path).data;
  }
  function put(collection,id,data) {
    const ref = parent.collection(collection).doc(id);
    if (!before.has(ref.path)) fail('internal','보관 원장을 먼저 조회해야 합니다.');
    staged.set(ref.path,{ref,data:{...data,companyId:parent.id,lastDate:job.input?.date || job.rows?.at(-1)?.date || data.date,revision:(before.get(ref.path)?.revision || 0)+1,updatedAt:job.createdAt}});
  }
  function validate(lot) {
    for (const key of ['availableQuantityScaled','borrowedQuantityScaled','deliveredQuantityScaled']) if (!Number.isSafeInteger(lot[key]) || lot[key]<0) fail('failed-precondition','보관 수량을 확인해 주세요.');
    M.signed(lot.availableQuantityScaled+lot.borrowedQuantityScaled+lot.deliveredQuantityScaled);
  }
  async function hold(id,row,item,warehouse,partner) {
    if (await read('erpCustodyLots',id,true)) fail('already-exists','보관 원장이 이미 있습니다.');
    put('erpCustodyLots',id,{itemId:item.id,code:item.code,name:item.name,unit:item.unit,warehouseId:warehouse.id,warehouseName:warehouse.name,
      ownerPartnerId:partner.id,ownerName:partner.name,availableQuantityScaled:row.quantityScaled,borrowedQuantityScaled:0,deliveredQuantityScaled:0,
      sourceMovementId:row.id || '',date:row.date,reference:row.documentNo || '',notes:row.notes || '',createdBy:job.createdBy,createdAt:job.createdAt});
  }
  async function borrow(id,lotId,row,item,warehouse,partner,cost) {
    const lot = await read('erpCustodyLots',lotId); validate(lot);
    if(row.date<(lot.lastDate || lot.date))fail('failed-precondition','마지막 보관 처리일 이후로 차용 판매해 주세요.');
    if (lot.itemId!==item.id || lot.warehouseId!==warehouse.id || lot.ownerPartnerId===partner.id) fail('invalid-argument','같은 품목·창고의 다른 거래처 소유 보관품을 선택해 주세요.');
    if (lot.availableQuantityScaled<row.quantityScaled) fail('failed-precondition','빌릴 수 있는 보관 수량이 부족합니다.');
    if (await read('erpBorrowings',id,true)) fail('already-exists','차용 원장이 이미 있습니다.');
    lot.availableQuantityScaled-=row.quantityScaled; lot.borrowedQuantityScaled+=row.quantityScaled; put('erpCustodyLots',lotId,lot);
    put('erpBorrowings',id,{lotId,itemId:item.id,code:item.code,name:item.name,warehouseId:warehouse.id,warehouseName:warehouse.name,
      ownerPartnerId:lot.ownerPartnerId,ownerName:lot.ownerName,buyerPartnerId:partner.id,buyerName:partner.name,
      quantityScaled:row.quantityScaled,outstandingQuantityScaled:row.quantityScaled,evaluationValue:cost,outstandingValue:cost,
      returnedQuantityScaled:0,repaidQuantityScaled:0,sourceMovementId:row.id,date:row.date,reference:row.documentNo,createdBy:job.createdBy,createdAt:job.createdAt});
  }
  // A sale return removes the owner's holding or restores a borrowed holding.
  // sign=-1 re-applies it when a return is cancelled.
  async function reverseSale(source,qty,cost,sign=1) {
    if (!source.custodyLotId) return;
    const lot=await read('erpCustodyLots',source.custodyLotId); validate(lot);
    if(job.input.date<(lot.lastDate || lot.date))fail('failed-precondition','마지막 보관 처리일 이후로 반품·취소해 주세요.');
    if (lot.itemId!==source.itemId || lot.warehouseId!==source.warehouseId) fail('failed-precondition','보관품 원거래 연결을 확인해 주세요.');
    if (source.stockMode==='HOLD') {
      lot.availableQuantityScaled-=qty*sign;
    } else if (source.stockMode==='BORROW') {
      const loan=await read('erpBorrowings',source.borrowingId);
      if (loan.lotId!==source.custodyLotId) fail('failed-precondition','차용 원거래 연결을 확인해 주세요.');
      loan.outstandingQuantityScaled-=qty*sign; loan.outstandingValue-=cost*sign; loan.returnedQuantityScaled+=qty*sign;
      if (loan.outstandingQuantityScaled<0 || loan.outstandingValue<0 || !loan.outstandingQuantityScaled && loan.outstandingValue || loan.returnedQuantityScaled<0 || loan.outstandingQuantityScaled>loan.quantityScaled) fail('failed-precondition','이미 반환된 차용 거래입니다. 미반환 수량 범위에서 반품해 주세요.');
      lot.availableQuantityScaled+=qty*sign; lot.borrowedQuantityScaled-=qty*sign; put('erpBorrowings',source.borrowingId,loan);
    }
    validate(lot); put('erpCustodyLots',source.custodyLotId,lot);
  }
  const snapshot = () => [...staged].map(([path,{data}])=>({path,before:before.get(path),after:data}));
  async function returnCost(source,qty,fallback) {
    if(source.stockMode!=='BORROW')return fallback;
    const loan=await read('erpBorrowings',source.borrowingId);
    return M.allocation(loan.outstandingValue,0,qty,loan.outstandingQuantityScaled);
  }
  function flush(at) { for (const {ref,data} of staged.values()) if (data) tx.set(ref,{...data,updatedAt:at}); }
  return {read,put,validate,hold,borrow,reverseSale,returnCost,snapshot,flush};
}
module.exports={custodyContext};
