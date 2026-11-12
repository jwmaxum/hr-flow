const { authorizeContext, fail } = require('./security-context');
const { erpMaster: master } = require('./erp-service');
const M = require('./erp-ledger-model');
const MONEY = ['openingValue','inValue','outValue','transferInValue','transferOutValue','adjustValue','closingValue','salesKRW','cogsKRW','marginKRW','averageInPrice'];
const QUANTITY = ['openingQuantity','inQuantity','outQuantity','transferInQuantity','transferOutQuantity','adjustQuantity','closingQuantity'];
const LIMIT = 20000, PAGE = 100;
function filtersOf(value) {
  M.exactObject(value, ['from','to','itemId','warehouseId','search']);
  const result = { from: M.date(value.from), to: M.date(value.to), itemId: value.itemId ? master.identifier(value.itemId) : '',
    warehouseId: value.warehouseId ? master.identifier(value.warehouseId) : '', search: M.text(value.search, '품목 검색', 120) };
  if (result.from > result.to) fail('invalid-argument', '시작일은 종료일 이전이어야 합니다.');
  return result;
}
function projectSummary(row, canManage) {
  const output = { itemId: row.itemId, code: row.code, name: row.name, specification: row.specification, unit: row.unit,
    warehouseId: row.warehouseId, warehouseCode: row.warehouseCode, warehouseName: row.warehouseName };
  for (const key of QUANTITY) output[key] = row[key] / 10000;
  if (canManage) for (const key of MONEY) output[key] = row[key];
  return output;
}
function projectDetail(row, canManage) {
  const effect = M.effectOf(row), output = { id: row.id, date: row.date, order: row.order, rowNo: row.rowNo, type: row.type,
    bundleParentId: row.bundleParentId || '', stockMode: row.stockMode || '', operationType: row.operationType || '', direction: row.direction, documentNo: row.documentNo || '기초재고', sourceId: row.sourceId || null,
    sourceDocumentNo: row.sourceDocumentNo || '', importId: row.importId || null, operationId: row.operationId || null,
    transferWarehouseName: row.transferWarehouseName || '',
    itemId: row.itemId, code: row.code, name: row.name, specification: row.specification || '', unit: row.unit,
    warehouseId: row.warehouseId, warehouseName: row.warehouseName || '', warehouseCode: row.warehouseCode || '',
    quantityDelta: M.quantityDelta(effect) / 10000, balanceQuantity: row.reportQuantityScaled / 10000,
    inQuantity: effect.inQuantityScaled / 10000, outQuantity: effect.outQuantityScaled / 10000,
    transferInQuantity: effect.transferInQuantityScaled / 10000, transferOutQuantity: effect.transferOutQuantityScaled / 10000,
    adjustQuantity: (effect.adjustQuantityScaled + effect.openingQuantityScaled) / 10000 };
  // Notes, supplier identity, raw effect and any monetary amount are not sent to quantity-only users.
  if (canManage) Object.assign(output, { partnerName: row.partnerName || row.partner?.name || '', reason: row.reason || row.notes || '',
    currency: row.currency || 'KRW', price: row.priceScaled == null ? null : row.priceScaled / 10000,
    supply: row.supply ?? null, tax: row.tax ?? null, total: row.total ?? null, valueDelta: M.valueDelta(effect), balanceValue: row.reportValue,
    inValue: effect.inValue, outValue: effect.outValue, adjustValue: effect.adjustValue + effect.openingValue,
    transferInValue: effect.transferInValue, transferOutValue: effect.transferOutValue,
    salesKRW: effect.salesKRW, cogsKRW: effect.cogsKRW, marginKRW: M.signed(effect.salesKRW - effect.cogsKRW),
    refundKRW: row.refundKRW ?? null, refundSupply: row.refundSupply ?? null, refundTax: row.refundTax ?? null,
    returnQuantity: row.returnQuantityScaled == null ? null : row.returnQuantityScaled / 10000,
    createdAt: row.createdAt, committedAt: row.committedAt || null });
  return output;
}
function buildReport(movements, filters, masters = new Map()) {
  const groups = new Map(), details = [];
  const search = master.normalize(filters.search || '');
  const matchedItems = new Set(movements.filter(row => !search || [masters.get(`erpItems/${row.itemId}`)?.name,
    masters.get(`erpItems/${row.itemId}`)?.code, row.name, row.code].filter(Boolean).some(value => master.normalize(value).includes(search))).map(row => row.itemId));
  for (const row of [...movements].sort(M.compare)) {
    const currentItem = masters.get(`erpItems/${row.itemId}`), warehouse = masters.get(`erpWarehouses/${row.warehouseId}`);
    if (!matchedItems.has(row.itemId)) continue;
    const key = `${row.itemId}:${row.warehouseId}`, effect = M.effectOf(row);
    if (!groups.has(key)) groups.set(key, { itemId: row.itemId, warehouseId: row.warehouseId, code: currentItem?.code || row.code, name: currentItem?.name || row.name,
      specification: currentItem?.specification || row.specification || '', unit: currentItem?.unit || row.unit,
      warehouseCode: warehouse?.code || row.warehouseCode || '', warehouseName: warehouse?.name || row.warehouseName || row.warehouseId,
      ...Object.fromEntries([...QUANTITY,...MONEY].map(field => [field,0])), runningQuantity: 0, runningValue: 0 });
    const group = groups.get(key);
    group.runningQuantity = M.signed(group.runningQuantity + M.quantityDelta(effect), '재고수량');
    group.runningValue = M.signed(group.runningValue + M.valueDelta(effect));
    if (group.runningQuantity < 0 || group.runningValue < 0 || !Number.isFinite(row.afterQuantity) || Math.abs(group.runningQuantity / 10000 - row.afterQuantity) > 0.0000001 || group.runningValue !== row.afterValue) fail('failed-precondition', '확정 원장과 저장된 잔액이 일치하지 않습니다. 관리자에게 원장 대사를 요청해 주세요.');
    if (row.date < filters.from) { group.openingQuantity = group.runningQuantity; group.openingValue = group.runningValue; }
    else {
      group.inQuantity = M.signed(group.inQuantity + effect.inQuantityScaled); group.inValue = M.signed(group.inValue + effect.inValue);
      group.outQuantity = M.signed(group.outQuantity + effect.outQuantityScaled); group.outValue = M.signed(group.outValue + effect.outValue);
      group.transferInQuantity = M.signed(group.transferInQuantity + effect.transferInQuantityScaled); group.transferInValue = M.signed(group.transferInValue + effect.transferInValue);
      group.transferOutQuantity = M.signed(group.transferOutQuantity + effect.transferOutQuantityScaled); group.transferOutValue = M.signed(group.transferOutValue + effect.transferOutValue);
      group.adjustQuantity = M.signed(group.adjustQuantity + effect.adjustQuantityScaled + effect.openingQuantityScaled);
      group.adjustValue = M.signed(group.adjustValue + effect.adjustValue + effect.openingValue);
      group.salesKRW = M.signed(group.salesKRW + effect.salesKRW); group.cogsKRW = M.signed(group.cogsKRW + effect.cogsKRW);
      details.push({ ...row, warehouseName: row.warehouseName || group.warehouseName, warehouseCode: row.warehouseCode || group.warehouseCode,
        reportQuantityScaled: group.runningQuantity, reportValue: group.runningValue });
    }
    group.closingQuantity = group.runningQuantity; group.closingValue = group.runningValue;
  }
  const summary = [...groups.values()].sort((a,b) => a.code.localeCompare(b.code) || a.itemId.localeCompare(b.itemId) || a.warehouseId.localeCompare(b.warehouseId));
  const totals = Object.fromEntries([...QUANTITY,...MONEY].map(key => [key,0]));
  for (const group of summary) {
    group.marginKRW = M.signed(group.salesKRW - group.cogsKRW);
    // Net receipts can be zero/negative after returns. A positive denominator alone permits an average.
    group.averageInPrice = group.inQuantity > 0 && group.inValue >= 0 ? Number((BigInt(group.inValue) * 100000000n) / BigInt(group.inQuantity)) / 10000 : null;
    for (const key of [...QUANTITY,...MONEY.filter(key => key !== 'averageInPrice')]) totals[key] = M.signed(totals[key] + group[key]);
  }
  totals.averageInPrice = null;
  return { summary, details, totals };
}
function createErpReportService({ db, now = () => new Date() }) {
  async function context(request, reader = db) {
    const user = await authorizeContext({ db, request, reader, now, roles: ['ADMIN','SUB_ADMIN','MEMBER'] });
    if (user.companyId !== request.data.companyId) fail('permission-denied', '현재 로그인한 회사에서 조회해 주세요.');
    return user;
  }
  return async request => {
    const input = M.exactObject(request.data, ['action','companyId','filters','view','cursor','revision','snapshot']);
    if (!['meta','report','export'].includes(input.action)) fail('invalid-argument', '조회 방식을 확인해 주세요.');
    const initial = await context(request), parent = db.collection('companies').doc(initial.companyId);
    if (input.action === 'meta' && ['filters','view','cursor','revision','snapshot'].some(key => input[key] !== undefined)) fail('invalid-argument', '기준일 조회 항목을 확인해 주세요.');
    const filters = input.action === 'meta' ? null : filtersOf(input.filters);
    if (filters && !['summary','detail'].includes(input.view)) fail('invalid-argument', '총괄 또는 상세 원장을 선택해 주세요.');
    if (input.action === 'export' && input.cursor != null) fail('invalid-argument', '내려받기는 전체 조회 범위를 사용합니다.');
    return db.runTransaction(async tx => {
      const user = await context(request, tx), canManage = user.role === 'ADMIN';
      const stateDoc = await tx.get(parent.collection('erpState').doc('ledger')), state = stateDoc.data();
      if (state) master.verifyTenant(state, user.companyId);
      const meta = { companyId: user.companyId, canManage, basisDate: state?.basisDate || null, lastDate: state?.lastDate || null, revision: state?.revision || 0 };
      if (input.action === 'meta') return meta;
      if (!state?.basisDate) return { ...meta, filters, view: input.view, rows: [], totalRows: 0, totals: null, nextCursor: null };
      if (filters.from <= state.basisDate) fail('invalid-argument', `기초재고는 ${state.basisDate} 마감 기준입니다. 조회 시작일은 다음 날부터 선택해 주세요.`);
      if (input.revision !== undefined && input.revision !== state.revision) fail('failed-precondition', '원장이 변경되었습니다. 다시 조회한 뒤 내려받아 주세요.');
      let offset = 0;
      if (input.cursor != null) {
        M.exactObject(input.cursor, ['offset','revision','signature']);
        if (!Number.isSafeInteger(input.cursor.offset) || input.cursor.offset < 0 || input.cursor.offset > LIMIT || input.cursor.revision !== state.revision) fail('failed-precondition', '조회 조건이나 원장이 변경되었습니다. 첫 페이지부터 다시 조회해 주세요.');
        offset = input.cursor.offset;
      }
      let query = parent.collection('erpMovements').where('date','<=',filters.to);
      for (const field of ['itemId','warehouseId']) if (filters[field]) {
        const snap = await tx.get(parent.collection(field === 'itemId' ? 'erpItems' : 'erpWarehouses').doc(filters[field]));
        if (!snap.exists) fail('not-found', '이 회사의 품목·창고를 선택해 주세요.'); master.verifyTenant(snap.data(), user.companyId);
        query = query.where(field,'==',filters[field]);
      }
      const documents = await tx.get(query.orderBy('date','asc').limit(LIMIT + 1));
      if (documents.size > LIMIT) fail('resource-exhausted', '조회 대상 원장이 20,000행을 초과했습니다. 품목·창고를 지정해 주세요. 일부 합계는 표시하지 않습니다.');
      const movements = documents.docs.map(doc => { master.verifyTenant(doc.data(), user.companyId); return { ...doc.data(), id: doc.id }; });
      const paths = [...new Set(movements.flatMap(row => [`erpItems/${master.identifier(row.itemId)}`, `erpWarehouses/${master.identifier(row.warehouseId)}`]))], masters = new Map();
      for (let i = 0; i < paths.length; i += 400) {
        const docs = await tx.getAll(...paths.slice(i, i + 400).map(path => db.doc(`${parent.path}/${path}`)));
        for (const doc of docs) if (doc.exists) { master.verifyTenant(doc.data(), user.companyId); masters.set(`${doc.ref.parent.id}/${doc.id}`, doc.data()); }
      }
      // Hash only report labels/revisions, never private master prices or contact fields.
      const signature = M.hash({ companyId: user.companyId, revision: state.revision, filters, view: input.view, canManage,
        masters: [...masters].sort(([a],[b])=>a.localeCompare(b)).map(([path,row])=>[path,row.revision,row.code,row.name,row.unit||'',row.specification||'',row.active]) });
      if (input.cursor && input.cursor.signature !== signature || input.action === 'export' && input.snapshot !== signature) fail('failed-precondition', '조회 조건·품목·창고 정보가 변경되었습니다. 다시 조회한 결과로 진행해 주세요.');
      const model = buildReport(movements, filters, masters), all = input.view === 'summary' ? model.summary : model.details;
      const selected = input.action === 'export' ? all : all.slice(offset, offset + PAGE);
      if (input.action === 'export' && selected.length > 5000) fail('resource-exhausted', 'Excel 내려받기는 최대 5,000행입니다. 기간·품목·창고를 좁혀 주세요.');
      const rows = selected.map(row => input.view === 'summary' ? projectSummary(row, canManage) : projectDetail(row, canManage));
      if (canManage && input.view === 'detail' && rows.length) {
        for (let i = 0; i < rows.length; i += 400) {
          const docs = await tx.getAll(...rows.slice(i, i + 400).map(row => parent.collection('erpMovementLinks').doc(row.id)));
          docs.forEach((doc, j) => {
            if (doc.exists) master.verifyTenant(doc.data(), user.companyId);
            Object.assign(rows[i + j], { cancelledBy: doc.data()?.cancelledBy || null, returnedQuantity: (doc.data()?.returnedQuantityScaled || 0) / 10000 });
          });
        }
      }
      const totals = Object.fromEntries([...QUANTITY, ...(canManage ? MONEY : [])].map(key => [key, QUANTITY.includes(key) ? model.totals[key] / 10000 : model.totals[key]]));
      const unitTotals = new Map();
      for (const row of model.summary) {
        if (!unitTotals.has(row.unit)) unitTotals.set(row.unit, Object.fromEntries(QUANTITY.map(key => [key,0])));
        for (const key of QUANTITY) unitTotals.get(row.unit)[key] = M.signed(unitTotals.get(row.unit)[key] + row[key]);
      }
      const result = { ...meta, snapshot: signature, filters, view: input.view, rows, totalRows: all.length, totals,
        unitTotals: [...unitTotals].map(([unit, values]) => ({ unit, ...Object.fromEntries(QUANTITY.map(key => [key,values[key] / 10000])) })),
        nextCursor: input.action !== 'export' && offset + PAGE < all.length ? { offset: offset + PAGE, revision: state.revision, signature } : null };
      if (Buffer.byteLength(JSON.stringify(result)) > 5 * 1024 * 1024) fail('resource-exhausted', '조회 결과가 큽니다. 기간·품목·창고를 좁혀 주세요.');
      return result;
    });
  };
}
module.exports = { createErpReportService, buildReport, projectSummary, projectDetail, filtersOf };
