const { fail } = require('./security-context');
const M = require('./erp-ledger-model');
const { safe } = require('./erp-import-schema');
const S = require('./erp-stock-state');

// Read-only estimate for a draft composition or selected set. Posting still
// re-evaluates all order lines together in the existing atomic import planner.
async function estimateBundle({ db, request, companyRef, context, now, master }) {
  const input = request.data;
  M.exactObject(input, ['action','companyId','warehouseId','components','quantity']);
  const warehouseId = master.identifier(input.warehouseId);
  const sets = M.decimal(input.quantity, 4, '세트 수량', 1e12);
  if (!sets || !Array.isArray(input.components) || !input.components.length || input.components.length > 20) fail('invalid-argument','구성품과 양수 세트 수량을 입력해 주세요.');
  const seen = new Set(), components = input.components.map(row => {
    M.exactObject(row, ['itemId','quantity']);
    const itemId = master.identifier(row.itemId), perSet = M.decimal(row.quantity, 4, '구성 수량', 1e10);
    if (!perSet || seen.has(itemId)) fail('invalid-argument','구성품은 중복 없이 양수 수량으로 입력해 주세요.');
    seen.add(itemId);
    const product = BigInt(sets) * BigInt(perSet);
    if (product % 10000n) fail('invalid-argument','세트와 구성 수량의 곱은 소수점 4자리 이하여야 합니다.');
    return {itemId, perSet, needed: safe(product / 10000n, '구성 수량')};
  });
  return db.runTransaction(async tx => {
    await context(request, tx);
    const wh=await S.warehouses(tx,companyRef,master),warehouse=wh.get(warehouseId);
    if (!warehouse) fail('not-found','창고를 찾을 수 없습니다.');
    if (!warehouse.active) fail('failed-precondition','사용 중인 창고를 선택해 주세요.');
    const states=new Map(),budget={rows:0};
    for (const component of components) {
      const part = await tx.get(companyRef.collection('erpItems').doc(component.itemId));
      if (!part.exists) fail('not-found','구성품을 찾을 수 없습니다.');
      master.verifyTenant(part.data(), companyRef.id);
      if (!part.data().active || part.data().itemType === 'BUNDLE') fail('failed-precondition','활성 일반 품목만 구성품으로 선택해 주세요.');
      states.set(part.id,await S.itemState(tx,companyRef,{...part.data(),id:part.id},wh,master,budget));
    }
    return {...S.estimate(states,components.map(c=>({itemId:c.itemId,quantityScaled:c.perSet})),warehouse,sets),checkedAt:now().toISOString()};
  });
}
module.exports = { estimateBundle };
