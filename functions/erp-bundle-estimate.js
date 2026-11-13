const { fail } = require('./security-context');
const M = require('./erp-ledger-model');
const { safe } = require('./erp-import-schema');

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
    const warehouse = await tx.get(companyRef.collection('erpWarehouses').doc(warehouseId));
    if (!warehouse.exists) fail('not-found','창고를 찾을 수 없습니다.');
    master.verifyTenant(warehouse.data(), companyRef.id);
    if (!warehouse.data().active) fail('failed-precondition','사용 중인 창고를 선택해 주세요.');
    const rows = [];
    for (const component of components) {
      const part = await tx.get(companyRef.collection('erpItems').doc(component.itemId));
      if (!part.exists) fail('not-found','구성품을 찾을 수 없습니다.');
      master.verifyTenant(part.data(), companyRef.id);
      if (!part.data().active || part.data().itemType === 'BUNDLE') fail('failed-precondition','활성 일반 품목만 구성품으로 선택해 주세요.');
      const stocks = await tx.get(companyRef.collection('erpInventory').where('itemId','==',component.itemId).limit(501));
      if (stocks.size > 500) fail('resource-exhausted','품목별 창고 수 제한을 초과했습니다.');
      stocks.docs.forEach(doc => master.verifyTenant(doc.data(), companyRef.id));
      const matches = stocks.docs.filter(doc => doc.data().warehouseId === warehouseId);
      if (matches.length > 1) fail('failed-precondition','창고별 재고 중복을 확인해 주세요.');
      const stock = matches[0]?.data(), quantity = Math.round((stock?.quantity || 0) * 10000), value = stock?.value || 0;
      if (stock && (!Number.isFinite(stock.quantity) || stock.quantity < 0 || Math.abs(stock.quantity * 10000 - quantity) > 0.001 || !Number.isSafeInteger(quantity) ||
        !Number.isSafeInteger(stock.value) || stock.value < 0 || stock.currency !== 'KRW' || !quantity && value)) fail('failed-precondition','구성품 재고 수량·금액을 확인해 주세요.');
      const enough = quantity >= component.needed;
      rows.push({itemId:part.id, code:part.data().code, name:part.data().name, unit:part.data().unit, perSet:component.perSet / 10000,
        quantity:quantity / 10000, needed:component.needed / 10000, shortage:Math.max(0,component.needed - quantity) / 10000,
        availableSets:Math.floor(quantity / component.perSet), averagePrice:quantity ? value * 10000 / quantity : null,
        estimatedCost:enough ? M.averageCost(value,quantity,component.needed) : null, pendingCost:part.data().pendingOpening?.status === 'PENDING_COST'});
    }
    const canShip = rows.every(row => !row.shortage);
    return {rows, canShip, availableSets:Math.min(...rows.map(row => row.availableSets)),
      estimatedCost:canShip ? M.signed(rows.reduce((sum,row) => sum + row.estimatedCost,0)) : null, checkedAt:now().toISOString()};
  });
}
module.exports = { estimateBundle };
