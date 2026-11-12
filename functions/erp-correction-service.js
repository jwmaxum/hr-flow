const { authorizeContext, fail } = require('./security-context');
const { FieldPath } = require('firebase-admin/firestore');
const { erpMaster: master } = require('./erp-service');
const M = require('./erp-ledger-model');
const { custodyContext } = require('./erp-custody-model');
const TYPES = ['CANCEL','SALES_RETURN','PURCHASE_RETURN','COUNT','VALUE','TRANSFER'];
function inputOf(value) {
  M.exactObject(value, ['type','date','reason','sourceId','itemId','warehouseId','quantity','value','allocations']);
  if (!TYPES.includes(value.type)) fail('invalid-argument', '취소·반품·조정 유형을 선택해 주세요.');
  const result = { type: value.type, date: M.date(value.date), reason: M.text(value.reason, '처리 사유', 500, true) };
  if (result.reason.length < 3) fail('invalid-argument', '처리 사유를 3자 이상 입력해 주세요.');
  if (value.type === 'TRANSFER') {
    if (['sourceId','itemId','quantity','value'].some(key => value[key] !== undefined)) fail('invalid-argument', '창고 이동은 출발 창고와 품목별 도착 창고·수량만 지정합니다.');
    result.warehouseId = master.identifier(value.warehouseId);
    if (!Array.isArray(value.allocations) || !value.allocations.length || value.allocations.length > 75) fail('invalid-argument', '배분 내역은 1~75개로 입력해 주세요.');
    const seen = new Set();
    result.allocations = value.allocations.map(entry => {
      M.exactObject(entry, ['itemId','warehouseId','quantity']);
      const row = { itemId: master.identifier(entry.itemId), warehouseId: master.identifier(entry.warehouseId), quantityScaled: M.decimal(entry.quantity, 4, '이동 수량', 1e12) };
      const key = `${row.itemId}:${row.warehouseId}`;
      if (!row.quantityScaled || row.warehouseId === result.warehouseId || seen.has(key)) fail('invalid-argument', '양수 수량과 서로 다른 출발·도착 창고를 선택하고 같은 품목·도착 창고를 중복 입력하지 마세요.');
      seen.add(key); return row;
    }).sort((a,b) => a.itemId.localeCompare(b.itemId) || a.warehouseId.localeCompare(b.warehouseId));
  } else if (value.allocations !== undefined) fail('invalid-argument', '배분 내역은 창고 이동에만 입력합니다.');
  else if (['COUNT','VALUE'].includes(value.type)) {
    if (value.sourceId) fail('invalid-argument', '재고 조정에는 원거래 ID를 지정하지 않습니다.');
    result.itemId = master.identifier(value.itemId); result.warehouseId = master.identifier(value.warehouseId);
    if (value.type === 'COUNT') result.quantityScaled = M.decimal(value.quantity, 4, '실사 수량', 9e12);
    else if (value.quantity != null && value.quantity !== '') fail('invalid-argument', '금액 조정에는 수량을 입력하지 않습니다.');
    // VALUE specifies the new book value, not an unchecked signed delta.
    result.value = value.value == null || value.value === '' ? null : M.decimal(value.value, 0, '재고 금액', 9e12);
    if (value.type === 'VALUE' && result.value === null) fail('invalid-argument', '조정 후 장부금액을 입력해 주세요.');
  } else {
    result.sourceId = master.identifier(value.sourceId);
    if (value.itemId || value.warehouseId || value.value != null && value.value !== '') fail('invalid-argument', '원거래의 품목·창고·금액은 서버에서 결정합니다.');
    if (value.type !== 'CANCEL') {
      result.quantityScaled = M.decimal(value.quantity, 4, '반품 수량', 1e12);
      if (!result.quantityScaled) fail('invalid-argument', '반품 수량은 0보다 커야 합니다.');
    } else if (value.quantity != null && value.quantity !== '') fail('invalid-argument', '취소는 문서 전체를 반대로 기록합니다.');
  }
  return result;
}
function createErpCorrectionService({ db, now = () => new Date() }) {
  async function context(request, reader = db) {
    const user = await authorizeContext({ db, request, reader, now, roles: ['ADMIN'] });
    if (user.companyId !== request.data.companyId) fail('permission-denied', '로그인한 회사에서 처리해 주세요.');
    return user;
  }
  async function transferStock(request) {
    const warehouseId = master.identifier(request.data.warehouseId);
    const cursor = request.data.cursor == null ? null : master.identifier(request.data.cursor);
    return db.runTransaction(async tx => {
      const user = await context(request, tx), parent = db.collection('companies').doc(user.companyId);
      const warehouse = await tx.get(parent.collection('erpWarehouses').doc(warehouseId));
      if (!warehouse.exists) fail('not-found', '출발 창고를 찾을 수 없습니다.');
      master.verifyTenant(warehouse.data(), user.companyId);
      if (!warehouse.data().active) fail('failed-precondition', '활성 출발 창고를 선택해 주세요.');
      let query = parent.collection('erpInventory').where('warehouseId','==',warehouseId).orderBy(FieldPath.documentId());
      if (cursor) query = query.startAfter(cursor);
      const stock = await tx.get(query.limit(51)), selected = stock.docs.slice(0,50);
      const refs = selected.map(doc => parent.collection('erpItems').doc(master.identifier(doc.data().itemId)));
      const items = refs.length ? await tx.getAll(...refs) : [];
      const records = selected.map((doc,index) => {
        const value = doc.data(), item = items[index]; master.verifyTenant(value, user.companyId);
        if (!item.exists) fail('failed-precondition', '재고의 품목 기준정보를 확인해 주세요.');
        master.verifyTenant(item.data(), user.companyId);
        const quantityScaled = Math.round(value.quantity * 10000);
        if (!Number.isFinite(value.quantity) || Math.abs(value.quantity * 10000 - quantityScaled) > 0.001 || value.currency !== 'KRW') fail('failed-precondition', '현재고 형식을 확인해 주세요.');
        M.signed(quantityScaled); M.signed(value.value);
        if (quantityScaled < 0 || value.value < 0 || !quantityScaled && value.value) fail('failed-precondition', '현재고 수량·금액을 확인해 주세요.');
        return { id: doc.id, itemId: item.id, code: item.data().code, name: item.data().name, unit: item.data().unit,
          active: item.data().active, quantity: value.quantity, value: value.value };
      });
      return { records, nextCursor: stock.size > 50 ? selected.at(-1).id : null };
    });
  }
  async function plan(tx, parent, job) {
    const companyId = parent.id, input = job.input, readState = [], balances = new Map(), links = new Map(), readCache = new Map(), balanceCache = new Map();
    const custody = custodyContext(tx,parent,job);
    const stateRef = parent.collection('erpState').doc('ledger'), stateSnap = await tx.get(stateRef), state = stateSnap.data();
    if (!state?.basisDate) fail('failed-precondition', '먼저 기초재고를 확정해 주세요.');
    master.verifyTenant(state, companyId);
    if (input.date <= state.basisDate || state.lastDate && input.date < state.lastDate) fail('failed-precondition', `기준일 다음 날이면서 마지막 거래일(${state.lastDate || state.basisDate}) 이후의 처리일을 선택해 주세요.`);
    const order = state.lastDate === input.date ? state.lastOrder + 1 : 1;
    if (!Number.isSafeInteger(order) || order > 999999) fail('failed-precondition', '다음 날짜로 처리해 주세요. 해당 날짜의 처리순서 한도입니다.');
    const documentRef = parent.collection('erpDocuments').doc(master.hash(master.normalize(`COR-${job.id}`)));
    if ((await tx.get(documentRef)).exists) fail('already-exists', '처리 문서번호가 이미 사용 중입니다. 새 미리보기를 만들어 주세요.');
    async function read(ref) { if (!readCache.has(ref.path)) readCache.set(ref.path, tx.get(ref)); const snap = await readCache.get(ref.path); if (snap.exists) master.verifyTenant(snap.data(), companyId); readState.push([ref.path, snap.data() || null]); return snap; }
    async function prefetch(refs) {
      const unique = [...new Map(refs.map(ref => [ref.path,ref])).values()].filter(ref => !readCache.has(ref.path));
      for (let i=0;i<unique.length;i+=400) for (const snap of await tx.getAll(...unique.slice(i,i+400))) readCache.set(snap.ref.path,Promise.resolve(snap));
    }
    async function link(id) {
      if (!links.has(id)) { const ref = parent.collection('erpMovementLinks').doc(id), snap = await read(ref); links.set(id, { ref, data: snap.data() || { companyId, returnedQuantityScaled: 0, cancelledBy: null } }); }
      return links.get(id).data;
    }
    async function balance(itemId, warehouseId) {
      const key = `${itemId}:${warehouseId}`; if (balances.has(key)) return balances.get(key);
      const item = await read(parent.collection('erpItems').doc(master.identifier(itemId))), warehouse = await read(parent.collection('erpWarehouses').doc(master.identifier(warehouseId)));
      if (!item.exists || !warehouse.exists) fail('failed-precondition', '품목·창고 기준정보를 확인해 주세요.');
      if (!balanceCache.has(key)) balanceCache.set(key, tx.get(parent.collection('erpInventory').where('itemId','==',itemId).where('warehouseId','==',warehouseId).limit(2)));
      const matches = await balanceCache.get(key);
      if (matches.size > 1) fail('failed-precondition', '중복 현재고를 먼저 정리해 주세요.');
      const snap = matches.docs[0], data = snap?.data(); if (data) master.verifyTenant(data, companyId);
      const quantityScaled = Math.round((data?.quantity || 0) * 10000), value = data?.value || 0;
      if (data && (data.currency !== 'KRW' || !Number.isFinite(data.quantity) || Math.abs(data.quantity * 10000 - quantityScaled) > 0.001)) fail('failed-precondition', '기존 현재고 형식을 확인해 주세요.');
      M.signed(quantityScaled); M.signed(value); if (quantityScaled < 0 || value < 0 || !quantityScaled && value) fail('failed-precondition', '기존 재고수량·금액을 확인해 주세요.');
      readState.push([snap?.ref.path || key, data || null]);
      const result = { ref: snap?.ref || parent.collection('erpInventory').doc(M.hash([itemId,warehouseId])), itemId, warehouseId,
        item: item.data(), virtual: item.data().itemType === 'BUNDLE', warehouse: warehouse.data(), beforeQuantityScaled: quantityScaled, beforeValue: value, quantityScaled, value, openingImportId: data?.openingImportId || null };
      balances.set(key, result); return result;
    }
    let sources = [];
    if (input.sourceId) {
      const source = await read(parent.collection('erpMovements').doc(input.sourceId));
      if (!source.exists) fail('not-found', '원거래를 찾을 수 없습니다.');
      const original = { ...source.data(), id: source.id };
      if (original.operationType?.startsWith('CUSTODY_')) fail('failed-precondition', '보관·차용 탭에서 해당 처리를 취소해 주세요.');
      if (input.type === 'CANCEL') {
        if (original.operationType === 'CANCEL') fail('failed-precondition', '취소 역거래는 다시 취소할 수 없습니다. 재고 조정을 사용해 주세요.');
        const field = original.type === 'OPENING' ? 'importId' : original.type === 'CORRECTION' ? 'operationId' : 'documentNo';
        if (typeof original[field] !== 'string' || !original[field]) fail('failed-precondition', '원거래 문서 연결을 확인해 주세요.');
        const group = await tx.get(parent.collection('erpMovements').where(field, '==', original[field]).limit(201));
        if (group.size > 200) fail('resource-exhausted', '문서의 원장 행이 200개를 초과합니다.');
        sources = group.docs.map(doc => ({ ...doc.data(), id: doc.id })).filter(row => row.type === original.type);
        if (!sources.some(row => row.id === original.id)) fail('failed-precondition', '문서 원장을 확인해 주세요.');
        for (const row of sources) master.verifyTenant(row, companyId);
        sources.sort(M.compare).reverse();
        const ids = new Set(sources.map(row => row.id)), pairs = [...new Map(sources.map(row=>[`${row.itemId}:${row.warehouseId}`,row])).values()];
        for (let i=0;i<pairs.length;i+=20) {
          const results = await Promise.all(pairs.slice(i,i+20).map(source=>tx.get(parent.collection('erpMovements').where('itemId','==',source.itemId).where('warehouseId','==',source.warehouseId)
            .orderBy('date','desc').orderBy('order','desc').orderBy('rowNo','desc').limit(1))));
          if (results.some(latest=>!latest.size||!ids.has(latest.docs[0].id))) fail('failed-precondition', '같은 품목·창고에 후속 거래가 있어 문서 전체 취소가 불가능합니다. 반품 또는 재고 조정을 사용해 주세요.');
        }
      } else {
        if (original.bundleParentId) fail('failed-precondition', '구성품이 아닌 조합상품 원출고 행에서 반품해 주세요.');
        if (original.type !== 'MOVEMENTS' || original.direction !== (input.type === 'SALES_RETURN' ? '출고' : '입고')) fail('failed-precondition', '해당 유형의 원입고·원출고 행을 선택해 주세요.');
        sources = [original];
        if (original.stockMode === 'BUNDLE') {
          if (!Array.isArray(original.bundle) || !original.bundle.length) fail('failed-precondition','판매 당시 조합 구성을 확인해 주세요.');
          for (const part of original.bundle) {
            const component = await read(parent.collection('erpMovements').doc(master.identifier(part.movementId)));
            if (!component.exists || component.data().bundleParentId !== original.id || component.data().quantityScaled !== part.quantityScaled) fail('failed-precondition','구성품 원장 연결을 확인해 주세요.');
            const scaled = BigInt(part.quantityScaled) * BigInt(input.quantityScaled);
            if (scaled % BigInt(original.quantityScaled)) fail('invalid-argument','구성품 반품수량은 소수점 4자리까지 표현할 수 있어야 합니다.');
            sources.push({ ...component.data(), id:component.id, requestedReturnQuantityScaled:Number(scaled / BigInt(original.quantityScaled)) });
          }
        }
      }
    }
    await prefetch(sources.flatMap(source=>[parent.collection('erpItems').doc(master.identifier(source.itemId)),parent.collection('erpWarehouses').doc(master.identifier(source.warehouseId)),
      parent.collection('erpMovementLinks').doc(source.id), ...(source.type==='CORRECTION'&&source.sourceId?[parent.collection('erpMovementLinks').doc(master.identifier(source.sourceId))]:[])]));
    const pairs=[...new Map(sources.map(row=>[`${row.itemId}:${row.warehouseId}`,row])).entries()];
    for(let i=0;i<pairs.length;i+=20) await Promise.all(pairs.slice(i,i+20).map(async([key,source])=>{
      balanceCache.set(key,await tx.get(parent.collection('erpInventory').where('itemId','==',source.itemId).where('warehouseId','==',source.warehouseId).limit(2)));
    }));
    const rows = [];
    async function add(source, stock, effect, extra = {}) {
      const after = M.applyEffect(stock, effect), rowNo = rows.length + 1;
      rows.push({ companyId, type: 'CORRECTION', operationType: input.type, operationId: job.id, sourceId: source?.id || null,
        date: input.date, order, rowNo, documentNo: `COR-${job.id}`, direction: ({ CANCEL:'취소', SALES_RETURN:'판매반품', PURCHASE_RETURN:'매입반품', COUNT:'실사조정', VALUE:'금액조정', TRANSFER:'창고이동' })[input.type],
        itemId: stock.itemId, warehouseId: stock.warehouseId, code: source?.code || stock.item.code, name: source?.name || stock.item.name,
        specification: source?.specification || stock.item.specification || '', unit: source?.unit || stock.item.unit,
        warehouseName: stock.warehouse.name, warehouseCode: stock.warehouse.code, partnerId: source?.partnerId || null,
        partnerName: source?.partnerName || source?.partner?.name || '', sourceDocumentNo: source?.documentNo || '',
        currency: source?.currency || 'KRW', priceScaled: source?.priceScaled ?? null, effect,
        ...(source?.bundleParentId ? { bundleParentId:source.bundleParentId } : {}), ...(source?.stockMode ? { stockMode:source.stockMode } : {}),
        ...(source?.custodyLotId ? {custodyLotId:source.custodyLotId} : {}), ...(source?.borrowingId ? {borrowingId:source.borrowingId} : {}),
        transferWarehouseId: source?.transferWarehouseId || '', transferWarehouseName: source?.transferWarehouseName || '',
        beforeQuantity: stock.quantityScaled / 10000, beforeValue: stock.value, afterQuantity: after.quantityScaled / 10000, afterValue: after.value,
        reason: input.reason, createdAt: job.createdAt, createdBy: job.createdBy, ...extra });
      Object.assign(stock, after);
    }
    for (const source of sources) {
      const usage = await link(source.id), stock = await balance(source.itemId, source.warehouseId);
      if (usage.cancelledBy) fail('failed-precondition', '이미 취소한 원거래입니다.');
      if (input.type === 'CANCEL') {
        if (usage.returnedQuantityScaled) fail('failed-precondition', '이미 반품이 연결된 원거래는 전체 취소할 수 없습니다.');
        if (source.operationType === 'SALES_RETURN' || source.operationType === 'PURCHASE_RETURN') {
          const originalUsage = await link(source.sourceId);
          if (originalUsage.cancelledBy || originalUsage.returnedQuantityScaled < source.returnQuantityScaled) fail('failed-precondition', '원거래의 누적 반품수량을 확인해 주세요.');
          originalUsage.returnedQuantityScaled -= source.returnQuantityScaled;
          await custody.reverseSale(source,source.returnQuantityScaled,-source.effect.cogsKRW,-1);
        } else {
          await custody.reverseSale(source,source.quantityScaled,source.cost);
        }
        await add(source, stock, M.reverse(M.effectOf(source)));
        usage.cancelledBy = job.id;
      } else {
        const previous = usage.returnedQuantityScaled, qty = source.requestedReturnQuantityScaled ?? input.quantityScaled, originalQty = source.quantityScaled;
        if (!Number.isSafeInteger(previous) || previous < 0 || previous + qty > originalQty) fail('failed-precondition', '누적 반품수량이 원거래 수량을 초과합니다.');
        const effect = M.zeroEffect(), refundKRW = M.allocation(source.value, previous, qty, originalQty);
        if (input.type === 'SALES_RETURN') {
          let cost = await custody.returnCost(source,qty,M.allocation(source.cost, previous, qty, originalQty));
          if(source.stockMode==='BUNDLE') {
            cost=0;
            for(const part of sources.filter(row=>row.bundleParentId===source.id)) {
              const partUsage=await link(part.id);
              cost=M.signed(cost+M.allocation(part.cost,partUsage.returnedQuantityScaled,part.requestedReturnQuantityScaled,part.quantityScaled));
            }
          }
          effect.outQuantityScaled = -qty; effect.outValue = -cost; effect.salesKRW = -refundKRW; effect.cogsKRW = -cost;
          if (['BUNDLE','BORROW'].includes(source.stockMode)) { effect.outQuantityScaled = 0; effect.outValue = 0; }
          if (source.bundleParentId) { effect.salesKRW = 0; effect.cogsKRW = 0; }
          await custody.reverseSale(source,qty,cost);
        } else { effect.inQuantityScaled = -qty; effect.inValue = -M.averageCost(stock.value, stock.quantityScaled, qty); }
        const unit = ['KRW','JPY'].includes(source.currency) ? 1 : 100;
        const refundSupply = M.allocation(Math.round(source.supply * unit), previous, qty, originalQty) / unit;
        const refundTax = M.allocation(Math.round(source.tax * unit), previous, qty, originalQty) / unit;
        await add(source, stock, effect, { returnQuantityScaled: qty, refundKRW, refundSupply, refundTax, refundTotal: (Math.round(refundSupply * unit) + Math.round(refundTax * unit)) / unit });
        usage.returnedQuantityScaled += qty;
      }
    }
    if (input.type === 'TRANSFER') {
      const pairs = [...new Map(input.allocations.flatMap(row => [[`${row.itemId}:${input.warehouseId}`, { itemId: row.itemId, warehouseId: input.warehouseId }], [`${row.itemId}:${row.warehouseId}`, row]])).entries()];
      await prefetch(pairs.flatMap(([,row]) => [parent.collection('erpItems').doc(row.itemId), parent.collection('erpWarehouses').doc(row.warehouseId)]));
      for (let i=0;i<pairs.length;i+=20) await Promise.all(pairs.slice(i,i+20).map(async ([key,row]) => {
        balanceCache.set(key, await tx.get(parent.collection('erpInventory').where('itemId','==',row.itemId).where('warehouseId','==',row.warehouseId).limit(2)));
      }));
      const groups = new Map();
      for (const row of input.allocations) { if (!groups.has(row.itemId)) groups.set(row.itemId, []); groups.get(row.itemId).push(row); }
      for (const [itemId, destinations] of groups) {
        const source = await balance(itemId, input.warehouseId);
        if (source.virtual) fail('failed-precondition','조합상품 대신 구성품 재고를 이동해 주세요.');
        if (!source.item.active || !source.warehouse.active) fail('failed-precondition', '활성 품목·창고를 선택해 주세요.');
        const totalQuantity = destinations.reduce((sum,row) => M.signed(sum + row.quantityScaled, '이동 수량'), 0);
        const totalValue = M.averageCost(source.value, source.quantityScaled, totalQuantity);
        let allocated = 0;
        for (const destination of destinations) {
          const target = await balance(itemId, destination.warehouseId);
          if (!target.item.active || !target.warehouse.active) fail('failed-precondition', '활성 도착 창고를 선택해 주세요.');
          const value = M.allocation(totalValue, allocated, destination.quantityScaled, totalQuantity);
          const out = M.zeroEffect(), incoming = M.zeroEffect();
          out.transferOutQuantityScaled = incoming.transferInQuantityScaled = destination.quantityScaled;
          out.transferOutValue = incoming.transferInValue = value;
          await add(null, source, out, { direction: '이동출고', transferWarehouseId: target.warehouseId, transferWarehouseName: target.warehouse.name });
          await add(null, target, incoming, { direction: '이동입고', transferWarehouseId: source.warehouseId, transferWarehouseName: source.warehouse.name });
          allocated += destination.quantityScaled;
        }
      }
      if (rows.reduce((sum,row)=>sum+M.quantityDelta(row.effect),0) !== 0 || rows.reduce((sum,row)=>sum+M.valueDelta(row.effect),0) !== 0) fail('failed-precondition', '이동 전후 수량·금액 합계가 일치하지 않습니다.');
    }
    if (!input.sourceId && input.type !== 'TRANSFER') {
      const stock = await balance(input.itemId, input.warehouseId), effect = M.zeroEffect();
      if (stock.virtual) fail('failed-precondition','조합상품 대신 구성품 재고를 조정해 주세요.');
      if (!stock.item.active || !stock.warehouse.active) fail('failed-precondition', '활성 품목·창고를 선택해 주세요.');
      if (input.type === 'COUNT') {
        const difference = input.quantityScaled - stock.quantityScaled;
        if (!difference) fail('failed-precondition', '실사 수량과 현재고가 같습니다. 금액만 변경하려면 금액 조정을 선택해 주세요.');
        if (difference > 0 && input.value === null) fail('invalid-argument', '수량 증가분의 재고금액을 입력해 주세요.');
        if (difference < 0 && input.value !== null) fail('invalid-argument', '수량 감소분은 서버가 이동평균 원가로 계산합니다. 증가금액을 비워 주세요.');
        effect.adjustQuantityScaled = difference;
        effect.adjustValue = difference > 0 ? input.value : -M.averageCost(stock.value, stock.quantityScaled, -difference);
      } else { effect.adjustValue = input.value - stock.value; if (!effect.adjustValue) fail('failed-precondition', '현재 장부금액과 같습니다.'); }
      await add(null, stock, effect);
    }
    if (!rows.length) fail('failed-precondition', '반영할 원장 행이 없습니다.');
    const fingerprint = M.hash({ input, state, readState, sources, rows, custody:custody.snapshot() });
    return { rows, balances, links, stateRef, state, documentRef, order, fingerprint, custody };
  }
  return async request => {
    const input = M.exactObject(request.data, ['action','companyId','id','input','fingerprint','warehouseId','cursor']);
    if (!['preview','commit','get','transferStock'].includes(input.action)) fail('invalid-argument', '지원하지 않는 처리입니다.');
    if (input.action !== 'preview' && input.input !== undefined || input.action !== 'commit' && input.fingerprint !== undefined) fail('invalid-argument', '처리에 맞는 요청 항목을 사용해 주세요.');
    if (input.action === 'transferStock') {
      if (input.id !== undefined) fail('invalid-argument', '현재고 조회에는 처리 ID를 지정하지 않습니다.');
      await context(request); return transferStock(request);
    }
    if (input.warehouseId !== undefined || input.cursor !== undefined) fail('invalid-argument', '처리에 맞는 요청 항목을 사용해 주세요.');
    const user = await context(request), id = master.identifier(input.id), parent = db.collection('companies').doc(user.companyId), ref = parent.collection('erpCorrections').doc(id);
    const normalized = input.action === 'preview' ? inputOf(input.input) : null;
    return db.runTransaction(async tx => {
      await context(request, tx); const snap = await tx.get(ref), existing = snap.data();
      if (existing) master.verifyTenant(existing, user.companyId);
      if (input.action === 'get') { if (!existing) fail('not-found', '처리 내역을 찾을 수 없습니다.'); return { correction: { id, ...existing } }; }
      if (input.action === 'preview') {
        if (existing) { if (M.hash(existing.input) !== M.hash(normalized)) fail('already-exists', '처리 ID가 이미 사용 중입니다. 새로 검증해 주세요.'); return { correction: { id, ...existing } }; }
        const job = { id, companyId: user.companyId, input: normalized, status: 'PENDING', createdAt: now().toISOString(), createdBy: user.uid };
        const result = await plan(tx, parent, job);
        const saved = { ...job, rows: result.rows, fingerprint: result.fingerprint };
        if (Buffer.byteLength(JSON.stringify(saved)) > 850000) fail('resource-exhausted', '처리 자료 크기 제한을 초과했습니다.');
        tx.create(ref, saved); return { correction: saved };
      }
      if (!existing) fail('not-found', '먼저 검증과 미리보기를 실행해 주세요.');
      if (typeof input.fingerprint !== 'string' || input.fingerprint !== existing.fingerprint) fail('failed-precondition', '확인한 미리보기로 다시 시도해 주세요.');
      if (existing.status === 'COMMITTED') return { correction: { id, ...existing }, idempotent: true };
      const result = await plan(tx, parent, existing);
      if (result.fingerprint !== input.fingerprint) fail('failed-precondition', '재고·원거래·기준정보가 변경되었습니다. 다시 미리보기를 실행해 주세요.');
      const at = now().toISOString();
      result.custody.flush(at);
      for (const row of result.rows) tx.create(parent.collection('erpMovements').doc(M.hash(['correction',id,row.rowNo])), { ...row, committedAt: at, committedBy: user.uid });
      for (const stock of result.balances.values()) if (!stock.virtual) tx.set(stock.ref, { companyId: user.companyId, itemId: stock.itemId, warehouseId: stock.warehouseId,
        quantity: stock.quantityScaled / 10000, value: stock.value, currency: 'KRW', openingImportId: stock.openingImportId, updatedAt: at, operationId: id });
      for (const { ref, data } of result.links.values()) tx.set(ref, { ...data, updatedAt: at });
      tx.create(result.documentRef, { companyId: user.companyId, documentNo: `COR-${id}`, date: existing.input.date, order: result.order, direction: existing.input.type, operationId: id });
      tx.set(result.stateRef, { ...result.state, revision: result.state.revision + 1, lastDate: existing.input.date, lastOrder: result.order, updatedAt: at });
      tx.create(parent.collection('erpAudit').doc(), { companyId: user.companyId, actorId: user.uid, action: existing.input.type, operationId: id, reason: existing.input.reason, rowCount: result.rows.length, at });
      const saved = { ...existing, status: 'COMMITTED', committedAt: at, committedBy: user.uid };
      tx.update(ref, { status: saved.status, committedAt: at, committedBy: user.uid }); return { correction: saved, idempotent: false };
    });
  };
}
module.exports = { createErpCorrectionService, inputOf };
