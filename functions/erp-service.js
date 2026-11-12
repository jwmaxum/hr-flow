const { createHash } = require('node:crypto');
const { FieldPath } = require('firebase-admin/firestore');
const { authorizeContext, fail } = require('./security-context');

const COLLECTIONS = { items: 'erpItems', warehouses: 'erpWarehouses', partners: 'erpPartners' };
const COMMON_FIELDS = ['code', 'name', 'active', 'notes'];
const FIELDS = {
  items: [...COMMON_FIELDS, 'specification', 'unit', 'purchasePrice', 'salePrice', 'taxType', 'group', 'itemType', 'components'],
  warehouses: [...COMMON_FIELDS, 'address'],
  partners: [...COMMON_FIELDS, 'type', 'country', 'registrationNumber', 'contactName', 'email', 'phone', 'address'],
};
const normalize = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ko-KR');
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, label, max, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail('invalid-argument', `${label}을(를) 확인해 주세요.`);
  const result = value.normalize('NFC').trim();
  if (required && !result) fail('invalid-argument', `${label}을(를) 입력해 주세요.`);
  return result;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail('invalid-argument', '자료 식별값을 확인해 주세요.');
  return value;
}
function price(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e9 || Math.abs(value * 10000 - Math.round(value * 10000)) > 0.001) {
    fail('invalid-argument', `${label}는 0 이상, 소수점 4자리 이하로 입력해 주세요.`);
  }
  return value;
}
function validate(kind, input) {
  if (!object(input) || Object.keys(input).some(key => !FIELDS[kind].includes(key))) fail('invalid-argument', '허용된 기준정보만 입력해 주세요.');
  const data = { code: text(input.code, '코드', 60, true), name: text(input.name, '이름', 120, true),
    active: input.active, notes: text(input.notes, '비고', 500) };
  if (typeof data.active !== 'boolean') fail('invalid-argument', '사용 상태를 확인해 주세요.');
  if (kind === 'items') {
    Object.assign(data, { specification: text(input.specification, '규격', 160), unit: text(input.unit, '단위', 20, true),
      purchasePrice: price(input.purchasePrice, '매입단가'), salePrice: price(input.salePrice, '판매단가'),
      taxType: input.taxType, group: text(input.group, '그룹', 80), currency: 'KRW' });
    data.itemType = input.itemType || 'STOCK'; data.components = [];
    if (!['STOCK','BUNDLE'].includes(data.itemType)) fail('invalid-argument','품목 유형을 확인해 주세요.');
    if (data.itemType === 'BUNDLE') {
      if (!Array.isArray(input.components) || !input.components.length || input.components.length > 20) fail('invalid-argument','조합 구성품은 1~20개로 입력해 주세요.');
      const seen = new Set();
      data.components = input.components.map(row => {
        if (!object(row) || Object.keys(row).some(key => !['itemId','quantity'].includes(key))) fail('invalid-argument','구성품 입력을 확인해 주세요.');
        const itemId = identifier(row.itemId), quantityScaled = require('./erp-import-schema').decimal(row.quantity,4,'구성 수량',1e10);
        if (seen.has(itemId) || !quantityScaled) fail('invalid-argument','구성품은 중복 없이 양수 수량으로 입력해 주세요.'); seen.add(itemId);
        return { itemId, quantityScaled };
      });
    } else if (input.components?.length) fail('invalid-argument','일반 품목에는 조합을 지정하지 않습니다.');
    if (!['과세', '영세', '면세'].includes(data.taxType)) fail('invalid-argument', '과세구분을 선택해 주세요.');
  } else if (kind === 'warehouses') data.address = text(input.address, '창고 주소', 300);
  else {
    Object.assign(data, { type: input.type, country: text(input.country, '국가코드', 2, true).toUpperCase(),
      registrationNumber: text(input.registrationNumber, '등록번호', 80), contactName: text(input.contactName, '담당자', 100),
      email: text(input.email, '이메일', 254), phone: text(input.phone, '연락처', 50), address: text(input.address, '주소', 300) });
    if (!['CUSTOMER', 'SUPPLIER', 'BOTH'].includes(data.type) || !/^[A-Z]{2}$/.test(data.country)) fail('invalid-argument', '거래처 유형과 국가코드를 확인해 주세요.');
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) fail('invalid-argument', '이메일 형식을 확인해 주세요.');
    if (data.registrationNumber && !/[\p{L}\p{N}]/u.test(data.registrationNumber)) fail('invalid-argument', '등록번호를 확인해 주세요.');
  }
  return { ...data, codeKey: normalize(data.code), nameKey: normalize(data.name) };
}
function keys(kind, data) {
  const result = [`${kind}:code:${data.codeKey}`];
  if (kind === 'partners' && data.registrationNumber) result.push(`partners:registration:${data.country}:${normalize(data.registrationNumber).replace(/[\s.-]/gu, '')}`);
  return result.map(hash);
}
function view(kind, id, data, canManage) {
  const result = { id, code: data.code, name: data.name, active: data.active, revision: data.revision, updatedAt: data.updatedAt };
  if (canManage) for (const field of FIELDS[kind]) result[field] = data[field];
  else if (kind === 'items') Object.assign(result, { unit: data.unit, specification: data.specification, itemType:data.itemType || 'STOCK' });
  return result;
}
function verifyTenant(data, companyId) {
  if (data?.companyId !== companyId) fail('failed-precondition', '기준정보의 회사 연결을 확인해 주세요.');
}

function createErpService({ db, now = () => new Date() }) {
  async function context(request, reader = db, write = false) {
    const user = await authorizeContext({ db, request, reader, now, roles: write ? ['ADMIN'] : ['ADMIN', 'SUB_ADMIN', 'MEMBER'] });
    if (request.data.companyId !== user.companyId) fail('permission-denied', '현재 로그인한 회사에서 다시 시도해 주세요.');
    return user;
  }
  return async request => {
    const data = request.data;
    if (!object(data)) fail('invalid-argument', '요청 형식을 확인해 주세요.');
    const action = data.action;
    if (!['list', 'save', 'inventory', 'purchaseHistory'].includes(action)) fail('invalid-argument', '지원하지 않는 ERP 요청입니다.');
    const user = await context(request, db, action === 'save' || action === 'purchaseHistory');
    const companyId = user.companyId, canManage = user.role === 'ADMIN';
    const companyRef = db.collection('companies').doc(companyId);
    if (action === 'purchaseHistory') {
      if (Object.keys(data).some(key => !['action','companyId','itemId','cursor'].includes(key))) fail('invalid-argument', '입고 이력 요청을 확인해 주세요.');
      const itemId = identifier(data.itemId);
      return db.runTransaction(async tx => {
        await context(request, tx, true);
        const item = await tx.get(companyRef.collection('erpItems').doc(itemId));
        if (!item.exists) fail('not-found', '품목을 찾을 수 없습니다.'); verifyTenant(item.data(), companyId);
        let query = companyRef.collection('erpMovements').where('itemId', '==', itemId).orderBy('date','desc').orderBy('order','desc').orderBy('rowNo','desc').orderBy(FieldPath.documentId(),'desc');
        if (data.cursor) {
          const cursor = await tx.get(companyRef.collection('erpMovements').doc(identifier(data.cursor)));
          if (!cursor.exists || cursor.data().itemId !== itemId) fail('invalid-argument', '이력 조회 위치를 확인해 주세요.');
          verifyTenant(cursor.data(), companyId); query = query.startAfter(cursor);
        }
        const snapshots = await tx.get(query.limit(51)), scanned = snapshots.docs.slice(0,50);
        scanned.forEach(doc => verifyTenant(doc.data(), companyId));
        const receipts = scanned.filter(doc => doc.data().type === 'OPENING' || doc.data().type === 'MOVEMENTS' && doc.data().direction === '입고');
        const links = receipts.length ? await tx.getAll(...receipts.map(doc => companyRef.collection('erpMovementLinks').doc(doc.id))) : [];
        const rows = receipts.map((doc, i) => {
          const row = doc.data(), link = links[i].data(); if (link) verifyTenant(link, companyId);
          return { id: doc.id, date: row.date, documentNo: row.documentNo || '기초재고', warehouseName: row.warehouseName,
            quantity: row.quantityScaled / 10000, price: row.priceScaled == null ? null : row.priceScaled / 10000, currency: row.currency,
            priceBasis: row.priceBasis || '기초재고', value: row.value, costPerUnit: row.quantityScaled ? row.value * 10000 / row.quantityScaled : null,
            cancelled: !!link?.cancelledBy, returnedQuantity: (link?.returnedQuantityScaled || 0) / 10000 };
        });
        return { rows, nextCursor: snapshots.size > 50 ? scanned.at(-1).id : null };
      });
    }
    if (action === 'inventory') {
      const itemId = identifier(data.itemId);
      return db.runTransaction(async tx => {
        const current = await context(request, tx);
        const item = await tx.get(companyRef.collection('erpItems').doc(itemId));
        if (!item.exists) fail('not-found', '품목을 찾을 수 없습니다.');
        verifyTenant(item.data(), companyId);
        if (item.data().itemType === 'BUNDLE') {
          const components = item.data().components, stockByPart = [], allWarehouses = new Set();
          if (!components?.length || components.length > 20) fail('failed-precondition','조합 구성을 확인해 주세요.');
          for (const component of components) {
            const part = await tx.get(companyRef.collection('erpItems').doc(identifier(component.itemId)));
            if (!part.exists) fail('failed-precondition','구성품을 찾을 수 없습니다.'); verifyTenant(part.data(),companyId);
            const stocks = await tx.get(companyRef.collection('erpInventory').where('itemId','==',component.itemId).limit(501));
            if (stocks.size > 500) fail('resource-exhausted','구성품 창고 수를 확인해 주세요.');
            const byWarehouse = new Map();
            for (const snap of stocks.docs) {
              const row=snap.data();verifyTenant(row,companyId);
              if (byWarehouse.has(row.warehouseId) || !Number.isFinite(row.quantity) || row.quantity < 0) fail('failed-precondition','구성품 재고를 확인해 주세요.');
              byWarehouse.set(row.warehouseId,part.data().active ? Math.round(row.quantity*10000) : 0); allWarehouses.add(row.warehouseId);
            }
            stockByPart.push({quantityScaled:component.quantityScaled,byWarehouse});
          }
          const rows=[];
          for (const warehouseId of allWarehouses) {
            const warehouse=await tx.get(companyRef.collection('erpWarehouses').doc(identifier(warehouseId)));
            if(!warehouse.exists)fail('failed-precondition','구성품 창고를 확인해 주세요.');verifyTenant(warehouse.data(),companyId);
            const quantity=Math.min(...stockByPart.map(part=>Math.floor((part.byWarehouse.get(warehouseId)||0)/part.quantityScaled)));
            rows.push({warehouseId,warehouseCode:warehouse.data().code,warehouseName:warehouse.data().name,warehouseActive:warehouse.data().active,quantity,updatedAt:null,...(current.role==='ADMIN'?{value:0}:{})});
          }
          return {item:view('items',item.id,item.data(),current.role==='ADMIN'),virtual:true,status:'RECORDED',quantity:rows.reduce((sum,row)=>sum+row.quantity,0),
            ...(current.role==='ADMIN'?{value:0,averagePrice:null,currency:'KRW'}:{}),warehouses:rows,checkedAt:now().toISOString()};
        }
        const balances = await tx.get(companyRef.collection('erpInventory').where('itemId', '==', itemId).limit(501));
        if (balances.size > 500) fail('resource-exhausted', '창고별 재고가 너무 많습니다. 관리자에게 문의해 주세요.');
        const warehouseIds = [...new Set(balances.docs.map(row => identifier(row.data().warehouseId)))];
        const warehouseDocs = await Promise.all(warehouseIds.map(id => tx.get(companyRef.collection('erpWarehouses').doc(id))));
        const warehouses = new Map(warehouseDocs.map(row => [row.id, row.data()]));
        const seen = new Set();
        const rows = balances.docs.map(row => {
          const balance = row.data(), warehouse = warehouses.get(balance.warehouseId);
          verifyTenant(balance, companyId);
          verifyTenant(warehouse, companyId);
          if (seen.has(balance.warehouseId)) fail('failed-precondition', '창고별 재고 중복을 확인해 주세요.');
          seen.add(balance.warehouseId);
          if (!Number.isFinite(balance.quantity) || !Number.isSafeInteger(Math.round(balance.quantity * 10000)) ||
            !Number.isSafeInteger(balance.value) || balance.currency !== 'KRW') fail('failed-precondition', '재고 집계 자료를 확인해 주세요.');
          return { warehouseId: balance.warehouseId, warehouseCode: warehouse.code, warehouseName: warehouse.name,
            warehouseActive: warehouse.active, quantity: balance.quantity,
            ...(current.role === 'ADMIN' ? { value: balance.value } : {}), updatedAt: balance.updatedAt || null };
        });
        const quantity = rows.length ? rows.reduce((sum, row) => sum + Math.round(row.quantity * 10000), 0) / 10000 : null;
        const value = current.role === 'ADMIN' && rows.length ? rows.reduce((sum, row) => sum + row.value, 0) : null;
        if (quantity !== null && !Number.isSafeInteger(Math.round(quantity * 10000)) || value !== null && !Number.isSafeInteger(value)) fail('failed-precondition', '재고 합계 범위를 확인해 주세요.');
        return { item: view('items', item.id, item.data(), current.role === 'ADMIN'), status: rows.length ? 'RECORDED' : 'UNINITIALIZED',
          quantity, ...(current.role === 'ADMIN' ? { value, averagePrice: quantity > 0 ? value / quantity : null, currency: 'KRW' } : {}), warehouses: rows, checkedAt: now().toISOString() };
      });
    }
    const kind = data.kind;
    if (!Object.hasOwn(COLLECTIONS, kind)) fail('invalid-argument', '기준정보 종류를 확인해 주세요.');
    if (kind === 'partners' && !canManage) fail('permission-denied', '거래처 관리는 회사 관리자 권한이 필요합니다.');
    const collection = companyRef.collection(COLLECTIONS[kind]);
    if (action === 'list') {
      const search = normalize(text(data.search, '검색어', 120));
      const searchBy = data.searchBy === undefined ? 'name' : data.searchBy;
      if (!['name', 'code'].includes(searchBy)) fail('invalid-argument', '검색 기준을 확인해 주세요.');
      const field = searchBy === 'code' ? 'codeKey' : 'nameKey';
      let query = collection.orderBy(field).orderBy(FieldPath.documentId());
      if (search) query = query.where(field, '>=', search).where(field, '<=', `${search}\uf8ff`);
      if (data.cursor) {
        if (!object(data.cursor)) fail('invalid-argument', '목록 위치를 확인해 주세요.');
        query = query.startAfter(text(data.cursor.key, '목록 위치', 240, true), identifier(data.cursor.id));
      }
      const snapshots = await query.limit(51).get(), docs = snapshots.docs.slice(0, 50);
      docs.forEach(doc => verifyTenant(doc.data(), companyId));
      // Do not return data fetched just before a company/role/session was revoked.
      const current = await context(request);
      if (current.role !== user.role) fail('permission-denied', '권한이 변경되었습니다. 다시 확인해 주세요.');
      const last = docs.at(-1);
      return { records: docs.map(doc => view(kind, doc.id, doc.data(), canManage)), canManage,
        nextCursor: snapshots.size > 50 ? { key: last.data()[field], id: last.id } : null };
    }
    const id = identifier(data.id);
    if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0) fail('invalid-argument', '자료 버전을 확인해 주세요.');
    const values = validate(kind, data.values), ref = collection.doc(id);
    return db.runTransaction(async tx => {
      await context(request, tx, true);
      const snapshot = await tx.get(ref), previous = snapshot.data();
      if (snapshot.exists) verifyTenant(previous, companyId);
      if ((previous?.revision || 0) !== data.expectedRevision) fail('aborted', '다른 사용자가 수정했습니다. 목록을 새로고침한 후 다시 편집해 주세요.');
      if (kind === 'items') {
        if (previous && (previous.itemType || 'STOCK') !== values.itemType) fail('failed-precondition','등록 후 일반·조합 유형은 변경할 수 없습니다. 새 품목코드로 등록해 주세요.');
        const components = values.components.length ? await tx.getAll(...values.components.map(row => companyRef.collection('erpItems').doc(row.itemId))) : [];
        for (const component of components) {
          if (component.id === id || !component.exists) fail('invalid-argument','자기 자신을 제외한 등록 구성품을 선택해 주세요.');
          verifyTenant(component.data(),companyId);
          if (!component.data().active || component.data().itemType === 'BUNDLE') fail('invalid-argument','조합에는 활성 일반 품목만 포함할 수 있습니다.');
        }
      }
      if (kind === 'items' && previous && previous.unit !== values.unit) {
        const stock = await tx.get(companyRef.collection('erpInventory').where('itemId', '==', id).limit(1));
        if (!stock.empty) fail('failed-precondition', '재고가 등록된 품목의 단위는 변경할 수 없습니다.');
      }
      const nextKeys = keys(kind, values), oldKeys = previous ? keys(kind, previous) : [];
      const reservations = companyRef.collection('erpKeys');
      const allKeys = [...new Set([...oldKeys, ...nextKeys])];
      const keyDocs = await Promise.all(allKeys.map(key => tx.get(reservations.doc(key))));
      for (const key of keyDocs) if (nextKeys.includes(key.id) && key.exists && key.data().recordId !== id) {
        fail('already-exists', kind === 'partners' ? '같은 코드 또는 국가·등록번호의 거래처가 있습니다.' : '이미 등록된 코드입니다. 기존 자료를 확인해 주세요.');
      }
      const timestamp = now().toISOString();
      const record = { ...values, companyId, revision: data.expectedRevision + 1,
        createdAt: previous?.createdAt || timestamp, createdBy: previous?.createdBy || user.uid, updatedAt: timestamp, updatedBy: user.uid };
      for (const key of keyDocs) if (!nextKeys.includes(key.id) && key.data()?.recordId === id) tx.delete(key.ref);
      for (const key of nextKeys) tx.set(reservations.doc(key), { recordId: id, kind, companyId });
      tx.set(ref, record);
      tx.create(companyRef.collection('erpAudit').doc(), { companyId, actorId: user.uid, kind, recordId: id,
        action: snapshot.exists ? 'UPDATE' : 'CREATE', revision: record.revision, active: record.active, at: timestamp });
      return { record: view(kind, id, record, true) };
    });
  };
}

module.exports = { createErpService, erpMaster: { validate, normalize, keys, hash, identifier, verifyTenant } };
