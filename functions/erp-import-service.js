const { authorizeContext, fail } = require('./security-context');
const { erpMaster: master } = require('./erp-service');
const { parseErpFile } = require('./erp-import-files');
const { amounts, safe, round, SHEETS } = require('./erp-import-schema');
const { hash } = require('./erp-ledger-model');
const M = require('./erp-ledger-model');
const { custodyContext } = require('./erp-custody-model');
const { manualInput, parseManual } = require('./erp-manual-schema');
const issue = (row, message, type) => ({ sheet: SHEETS[type], row, message });
const publicSource = source => ({ kind: source.kind || 'XLSX', name: source.name, size: source.size, sha256: source.sha256 });
function optionsOf(value = {}) {
  const names = ['defaultWarehouseId','warehouseByRow','partnerByRow','allowNewItems','allowNewPartners','acceptExistingItems'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !names.includes(key))) fail('invalid-argument', '매핑 설정을 확인해 주세요.');
  const result = { defaultWarehouseId: value.defaultWarehouseId ? master.identifier(value.defaultWarehouseId) : '', warehouseByRow: {}, partnerByRow: {} };
  for (const field of ['allowNewItems','allowNewPartners','acceptExistingItems']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') fail('invalid-argument', '확인 항목을 다시 선택해 주세요.');
    result[field] = value[field] === true;
  }
  for (const field of ['warehouseByRow','partnerByRow']) {
    if (value[field] !== undefined && (!value[field] || typeof value[field] !== 'object' || Array.isArray(value[field]) || Object.keys(value[field]).length > 200)) fail('invalid-argument', '행별 매핑을 확인해 주세요.');
    for (const [row, id] of Object.entries(value[field] || {})) {
      if (!/^(?:[1-9]\d?|1\d\d|20\d)$/.test(row) || +row < 10) fail('invalid-argument', '매핑 행은 10~209행입니다.');
      result[field][row] = master.identifier(id);
    }
  }
  return result;
}
function expose(id, job) {
  return { id, companyId: job.companyId, type: job.type, status: job.status, basisDate: job.basisDate, companyLabel: job.companyLabel,
    source: publicSource(job.source), preview: job.preview, createdAt: job.createdAt, committedAt: job.committedAt || null };
}
function createErpImportService({ db, bucket, now = () => new Date(), parseFile = parseErpFile }) {
  async function context(request, tx) {
    const user = await authorizeContext({ db, request, reader: tx || db, now, roles: ['ADMIN'] });
    if (request.data.companyId !== user.companyId) fail('permission-denied', '현재 로그인한 회사에서 다시 시도해 주세요.');
    return user;
  }
  async function plan(tx, parent, job) {
    const companyId = parent.id, options = job.options, errors = [...job.errors], warnings = [], previews = [], writes = new Map(), reads = new Map();
    const custody = custodyContext(tx,parent,job);
    const get = ref => {
      if (!reads.has(ref.path)) reads.set(ref.path, tx.get(ref));
      return reads.get(ref.path);
    };
    async function prefetch(refs) {
      const unique = [...new Map(refs.filter(ref => !reads.has(ref.path)).map(ref => [ref.path, ref])).values()];
      for (let i = 0; i < unique.length; i += 400) for (const snap of await tx.getAll(...unique.slice(i, i + 400))) reads.set(snap.ref.path, Promise.resolve(snap));
    }
    const scope = data => master.verifyTenant(data, companyId);
    const stateRef = parent.collection('erpState').doc('ledger'), stateDoc = await get(stateRef), state = stateDoc.data() || {};
    if (stateDoc.exists) scope(state);
    if (state.basisDate && state.basisDate !== job.basisDate) errors.push(issue(6, `회사에 확정된 기준일은 ${state.basisDate}입니다.`, job.type));
    if (job.type === 'MOVEMENTS' && !state.basisDate) {
      if (job.initializeEmptyLedger && job.source.kind === 'MANUAL' && job.rows.every(row => row.direction === '입고')) {
        const [inventory, movements] = await Promise.all([tx.get(parent.collection('erpInventory').limit(1)), tx.get(parent.collection('erpMovements').limit(1))]);
        if (!inventory.empty || !movements.empty) errors.push(issue(0, '기존 재고의 기준일을 먼저 확인해 주세요.', job.type));
        else warnings.push(issue(0, `기존 재고가 없는 회사입니다. ${job.basisDate} 기준 재고 0에서 시작합니다. 이후 기초재고 추가는 제한됩니다.`, job.type));
      } else errors.push(issue(6, '먼저 기초재고를 확정해 회사의 기준일을 설정해 주세요.', job.type));
    }
    if (job.type === 'OPENING' && state.lastDate) errors.push(issue(6, '입출고가 시작된 회사는 기초재고를 추가할 수 없습니다.', job.type));
    if (job.source.kind !== 'MANUAL') {
      const receipt = await get(parent.collection('erpImportReceipts').doc(job.source.sha256));
      if (receipt.exists) errors.push(issue(0, '이미 확정한 파일입니다. 업로드 이력에서 확인해 주세요.', job.type));
    }
    const masters = new Map(), masterState = new Map(), stocks = new Map(), itemBalances = new Map(), candidatesByName = new Map(), documents = new Map(), seenOpening = new Set();
    const reserve = async (kind, id, values) => {
      for (const key of master.keys(kind, values)) {
        const ref = parent.collection('erpKeys').doc(key), snap = await get(ref);
        const staged = writes.get(ref.path)?.data;
        if (snap.exists && snap.data().recordId !== id || staged && staged.recordId !== id) fail('invalid-argument', '같은 코드 또는 등록번호의 기준정보가 중복됩니다.');
        writes.set(ref.path, { ref, data: { companyId, kind, recordId: id } });
      }
    };
    const byCode = async (kind, code) => {
      if (!code) return '';
      const ref = parent.collection('erpKeys').doc(master.hash(`${kind}:code:${master.normalize(code)}`));
      const snap = await get(ref); if (snap.exists) scope(snap.data());
      return writes.get(ref.path)?.data.recordId || snap.data()?.recordId || '';
    };
    const existing = async (kind, id) => {
      const key = `${kind}:${id}`; if (masters.has(key)) return masters.get(key);
      const names = { items: 'erpItems', warehouses: 'erpWarehouses', partners: 'erpPartners' };
      const snap = await get(parent.collection(names[kind]).doc(master.identifier(id)));
      if (!snap.exists) fail('invalid-argument', '기준정보를 찾을 수 없습니다. 회사 내 코드를 확인해 주세요.');
      const data = snap.data(); scope(data);
      if (!data.active) fail('invalid-argument', `${data.name}: 사용 중지된 기준정보입니다.`);
      const record = { ...data, id }; masters.set(key, record); masterState.set(key, record); return record;
    };
    const create = async (kind, id, values) => {
      const name = kind === 'items' ? 'erpItems' : 'erpPartners', ref = parent.collection(name).doc(id);
      const snap = await get(ref); if (snap.exists) fail('invalid-argument', '신규 기준정보 식별값이 중복됩니다.');
      const record = { ...master.validate(kind, values), companyId, revision: 1, createdAt: job.createdAt, updatedAt: job.createdAt,
        createdBy: job.createdBy, updatedBy: job.createdBy };
      await reserve(kind, id, record); writes.set(ref.path, { ref, data: record });
      const result = { ...record, id, isNew: true }; masters.set(`${kind}:${id}`, result); return result;
    };
    async function itemFor(row) {
      const codeId = await byCode('items', row.code), id = codeId || `i_${hash(master.normalize(row.code))}`;
      let item = masters.get(`items:${id}`);
      if (!item && codeId) item = await existing('items', codeId);
      if (!item) {
        if (!options.allowNewItems) fail('invalid-argument', '신규 품목입니다. 신규 품목 등록 확인을 선택한 후 재검증해 주세요.');
        item = await create('items', id, { code: row.code, name: row.name, unit: row.unit, specification: row.specification,
          taxType: row.taxType, group: row.group || '', active: true, notes: '', purchasePrice: 0, salePrice: 0 });
      }
      if (item.unit !== row.unit) fail('invalid-argument', `품목 단위가 다릅니다. 등록 단위: ${item.unit}`);
      if (item.name !== row.name || item.specification !== row.specification) {
        if (!options.acceptExistingItems) fail('invalid-argument', `기존 품목명/규격과 다릅니다. 등록 품목: ${item.name}. 확인 후 기존 품목 사용을 선택해 주세요.`);
        warnings.push(issue(row.sourceRow, `기존 품목 ${item.name} 사용. 파일 설명과 거래단가는 원장에 보존합니다.`, job.type));
      }
      return item;
    }
    async function warehouseFor(row) {
      const mapped = options.warehouseByRow[row.sourceRow] || (!row.warehouseCode ? options.defaultWarehouseId : '');
      const id = mapped || await byCode('warehouses', row.warehouseCode);
      if (!id) fail('invalid-argument', '회사 창고를 먼저 등록하고 창고코드를 입력하거나 공란 창고를 매핑해 주세요.');
      const record = await existing('warehouses', id);
      if (!mapped && row.warehouseName && row.warehouseName !== record.name) fail('invalid-argument', `창고명 불일치: ${record.name}`);
      return record;
    }
    async function partnerFor(row, preview) {
      const p = row.partner, mapped = options.partnerByRow[row.sourceRow];
      if (mapped) return existing('partners', mapped);
      const codeId = await byCode('partners', p.code);
      let registrationId = '';
      if (p.country && p.registrationNumber) {
        const key = master.hash(`partners:registration:${p.country}:${master.normalize(p.registrationNumber).replace(/[\s.-]/gu, '')}`);
        const snap = await get(parent.collection('erpKeys').doc(key)); if (snap.exists) scope(snap.data());
        registrationId = writes.get(parent.collection('erpKeys').doc(key).path)?.data.recordId || snap.data()?.recordId || '';
      }
      if (codeId && registrationId && codeId !== registrationId) fail('invalid-argument', '거래처 코드와 등록번호가 서로 다른 거래처를 가리킵니다.');
      if (codeId || registrationId) {
        const record = await existing('partners', codeId || registrationId);
        preview.partnerCandidates = [{ id: record.id, code: record.code, name: record.name }];
        if (p.name && p.name !== record.name || p.country && p.country !== record.country || p.registrationNumber && master.normalize(p.registrationNumber).replace(/[\s.-]/gu, '') !== master.normalize(record.registrationNumber).replace(/[\s.-]/gu, '')) fail('invalid-argument', '거래처 정보가 다릅니다. 기존 거래처를 명시적으로 선택하거나 파일을 수정해 주세요.');
        return record;
      }
      if (!p.name || !p.country) fail('invalid-argument', '신규 거래처는 이름과 국가코드가 필요합니다.');
      const candidateKey = master.normalize(p.name);
      if (!candidatesByName.has(candidateKey)) candidatesByName.set(candidateKey, tx.get(parent.collection('erpPartners').where('nameKey', '==', candidateKey).limit(10)));
      const candidates = await candidatesByName.get(candidateKey);
      preview.partnerCandidates = candidates.docs.filter(doc => doc.data().active).map(doc => { scope(doc.data()); return { id: doc.id, code: doc.data().code, name: doc.data().name }; });
      if (!options.allowNewPartners) fail('invalid-argument', '신규 거래처 후보입니다. 기존 거래처를 선택하거나 신규 등록 확인 후 재검증해 주세요.');
      const identity = p.code ? ['code', master.normalize(p.code)] : p.registrationNumber ? ['reg', p.country, master.normalize(p.registrationNumber).replace(/[\s.-]/gu, '')] : ['manual', job.id, p.country, master.normalize(p.name)];
      const id = `p_${hash(identity)}`;
      if (masters.has(`partners:${id}`)) return masters.get(`partners:${id}`);
      warnings.push(issue(row.sourceRow, `신규 거래처 ${p.name} 등록${!p.registrationNumber ? ' (등록번호 없음, 동명 거래처 자동 병합 안 함)' : ''}`, job.type));
      return create('partners', id, { ...p, code: p.code || `AUTO-${hash(identity).slice(0, 16)}`, active: true, notes: '', type: 'BOTH' });
    }
    async function stockFor(itemId, warehouseId) {
      const key = `${itemId}:${warehouseId}`; if (stocks.has(key)) return stocks.get(key);
      if (!itemBalances.has(itemId)) itemBalances.set(itemId, await tx.get(parent.collection('erpInventory').where('itemId', '==', itemId).limit(501)));
      const result = itemBalances.get(itemId);
      if (result.size > 500) fail('invalid-argument', '품목별 창고 수 제한을 초과했습니다.');
      const matches = result.docs.filter(doc => doc.data().warehouseId === warehouseId);
      if (matches.length > 1) fail('invalid-argument', '창고별 현재고 중복을 먼저 확인해 주세요.');
      const snapshot = matches[0], previous = snapshot?.data();
      if (previous) {
        scope(previous);
        if (!Number.isFinite(previous.quantity) || previous.quantity < 0 || !Number.isSafeInteger(previous.value) || previous.value < 0 || previous.currency !== 'KRW' ||
          !Number.isSafeInteger(Math.round(previous.quantity * 10000)) || Math.abs(previous.quantity * 10000 - Math.round(previous.quantity * 10000)) > 0.001) fail('invalid-argument', '기존 현재고의 수량·금액 형식을 확인해 주세요.');
      }
      const balance = { ref: snapshot?.ref || parent.collection('erpInventory').doc(hash([itemId, warehouseId])), itemId, warehouseId,
        exists: !!snapshot, beforeQuantity: previous?.quantity || 0, beforeValue: previous?.value || 0,
        quantityScaled: Math.round((previous?.quantity || 0) * 10000), value: previous?.value || 0, openingImportId: previous?.openingImportId || null };
      stocks.set(key, balance); return balance;
    }
    const sorted = [...job.rows].sort((a,b) => a.date.localeCompare(b.date) || a.order - b.order || a.rowNo - b.rowNo);
    // Batch predictable references before the row loop; 200-row imports should not
    // incur a network round trip for each key, master and ledger row.
    await prefetch(sorted.flatMap(row => [['items',row.code], ['warehouses',row.warehouseCode], ['partners',row.partner?.code]].filter(([,code]) => code)
      .map(([kind,code]) => parent.collection('erpKeys').doc(master.hash(`${kind}:code:${master.normalize(code)}`)))));
    const itemIds = new Map(), predictable = [];
    for (const row of sorted) {
      const itemId = await byCode('items', row.code) || `i_${hash(master.normalize(row.code))}`;
      itemIds.set(master.normalize(row.code), itemId); predictable.push(parent.collection('erpItems').doc(itemId));
      const warehouseId = options.warehouseByRow[row.sourceRow] || (!row.warehouseCode ? options.defaultWarehouseId : '') || await byCode('warehouses', row.warehouseCode);
      if (warehouseId) predictable.push(parent.collection('erpWarehouses').doc(warehouseId));
      if (job.type === 'MOVEMENTS' || warehouseId) predictable.push(parent.collection('erpMovements').doc(job.type === 'MOVEMENTS' ? hash(['trade',master.normalize(row.documentNo),row.rowNo]) : hash(['opening',itemId,warehouseId])));
    }
    await prefetch(predictable);
    const uniqueItems = [...new Set(itemIds.values())]; let balanceCount = 0;
    for (let i = 0; i < uniqueItems.length; i += 20) {
      await Promise.all(uniqueItems.slice(i, i + 20).map(async itemId => {
        const result = await tx.get(parent.collection('erpInventory').where('itemId', '==', itemId).limit(501));
        balanceCount += result.size; itemBalances.set(itemId, result);
      }));
      if (balanceCount > 2000) fail('resource-exhausted', '창고별 재고 자료가 많습니다. 품목을 나눠 업로드해 주세요.');
    }
    const orderKeys = new Map();
    for (const row of sorted) {
      const preview = { sourceRow: row.sourceRow, code: row.code, name: row.name, direction: row.direction, date: row.date, documentNo: row.documentNo,
        quantity: row.quantityScaled / 10000, unit: row.unit, currency: row.currency, price: row.priceScaled == null ? null : row.priceScaled / 10000,
        warehouseName: row.warehouseName, partnerName: row.partner?.name || '', partnerCandidates: [] };
      previews.push(preview);
      try {
        const item = await itemFor(row), warehouse = await warehouseFor(row), partner = row.partner ? await partnerFor(row, preview) : null;
        if (job.source.kind === 'MANUAL' && row.direction === '출고' && partner?.type === 'SUPPLIER') fail('invalid-argument', '출고 거래처는 매출처 또는 매입·매출처를 선택해 주세요.');
        if (item.itemType === 'BUNDLE' && (job.type !== 'MOVEMENTS' || row.direction !== '출고')) fail('invalid-argument','조합상품은 직접 입고하지 않습니다. 구성품을 입고해 주세요.');
        const balance = await stockFor(item.id, warehouse.id), amount = amounts(row), key = `${item.id}:${warehouse.id}`;
        if (item.itemType === 'BUNDLE') balance.virtual = true;
        Object.assign(preview, { itemId: item.id, warehouseId: warehouse.id, warehouseName: warehouse.name, partnerName: partner?.name || '',
          partnerId: partner?.id || null, newItem: !!item.isNew, newPartner: !!partner?.isNew, beforeQuantity: balance.quantityScaled / 10000, beforeValue: balance.value, ...amount });
        let movementId, cost = 0, bundle = null, effect, ownership = {};
        if (job.type === 'OPENING') {
          if (balance.exists || seenOpening.has(key)) fail('invalid-argument', '품목·창고 기초재고가 이미 있거나 파일 안에서 중복됩니다.');
          seenOpening.add(key); movementId = hash(['opening', item.id, warehouse.id]);
          balance.quantityScaled = row.quantityScaled; balance.value = amount.value; balance.openingImportId = job.id;
        } else {
          const docKey = master.normalize(row.documentNo), orderKey = `${row.date}:${row.order}`;
          const docData = { companyId, documentNo: row.documentNo, date: row.date, order: row.order, direction: row.direction,
            partnerId: partner.id, currency: row.currency, exchangeRateScaled: row.exchangeRateScaled, importId: job.id };
          if (orderKeys.has(orderKey) && orderKeys.get(orderKey) !== docKey) fail('invalid-argument', '같은 날짜의 서로 다른 문서는 처리순서를 다르게 입력해 주세요.');
          orderKeys.set(orderKey, docKey);
          if (documents.has(docKey) && JSON.stringify(documents.get(docKey).data) !== JSON.stringify(docData)) fail('invalid-argument', '같은 거래번호의 거래일·순서·구분·거래처·통화·환율을 일치시켜 주세요.');
          if (!documents.has(docKey)) {
            const ref = parent.collection('erpDocuments').doc(hash(docKey)), snap = await get(ref);
            if (snap.exists) fail('invalid-argument', '이미 확정한 거래번호입니다. 한 거래 문서의 모든 행을 한 파일로 업로드해 주세요.');
            documents.set(docKey, { ref, data: docData });
          }
          if (state.lastDate && (row.date < state.lastDate || row.date === state.lastDate && row.order <= state.lastOrder)) fail('invalid-argument', `마지막 확정 순서(${state.lastDate}, ${state.lastOrder}) 이후 거래만 반영할 수 있습니다.`);
          if (row.direction === '출고') {
            if (item.itemType === 'BUNDLE' && row.fulfillment && row.fulfillment !== 'DIRECT') fail('invalid-argument','조합상품은 구성품 직접 출고만 지원합니다. 보관·차용은 개별 품목으로 출고해 주세요.');
            if (item.itemType === 'BUNDLE') {
              bundle = [];
              if (!item.components?.length || item.components.length > 20) fail('invalid-argument','조합 구성을 확인해 주세요.');
              const parentId = hash(['trade',docKey,row.rowNo]);
              for (const component of item.components) {
                const part = await existing('items',component.itemId);
                if (part.itemType === 'BUNDLE' || part.id === item.id) fail('invalid-argument','중첩·순환 조합은 사용할 수 없습니다.');
                const product = BigInt(row.quantityScaled) * BigInt(component.quantityScaled);
                if (product % 10000n) fail('invalid-argument','구성품 출고 수량은 소수점 4자리 이내여야 합니다.');
                const quantityScaled = safe(product / 10000n,'구성 수량'), stock = await stockFor(part.id,warehouse.id);
                if (stock.quantityScaled < quantityScaled) fail('invalid-argument',`${part.name} 구성품 재고 부족: ${stock.quantityScaled/10000}`);
                const value = M.averageCost(stock.value,stock.quantityScaled,quantityScaled), partEffect = M.zeroEffect();
                partEffect.outQuantityScaled = quantityScaled; partEffect.outValue = value;
                stock.quantityScaled -= quantityScaled; stock.value -= value; cost = safe(BigInt(cost)+BigInt(value));
                const id = hash(['bundle',parentId,part.id]), ref = parent.collection('erpMovements').doc(id);
                if ((await get(ref)).exists) fail('invalid-argument','이미 확정된 구성품 출고입니다.');
                bundle.push({ movementId:id,itemId:part.id,code:part.code,name:part.name,quantityScaled,cost:value,quantityPerSetScaled:component.quantityScaled });
                writes.set(ref.path,{ ref,data:{ companyId,importId:job.id,...row,itemId:part.id,code:part.code,name:part.name,unit:part.unit,specification:part.specification || '',
                  warehouseId:warehouse.id,warehouseName:warehouse.name,warehouseCode:warehouse.code,partnerId:partner.id,partnerName:partner.name,
                  quantityScaled,priceScaled:0,supply:0,tax:0,total:0,value:0,cost:value,effect:partEffect,bundleParentId:parentId,
                  afterQuantity:stock.quantityScaled/10000,afterValue:stock.value,createdAt:job.createdAt,createdBy:job.createdBy } });
              }
              effect = M.zeroEffect(); effect.salesKRW = amount.value; effect.cogsKRW = cost;
            } else if (row.fulfillment === 'BORROW') {
              const id = hash(['trade',docKey,row.rowNo]); cost = row.borrowValue;
              effect = M.zeroEffect(); effect.salesKRW=amount.value; effect.cogsKRW=cost;
              ownership={stockMode:'BORROW',custodyLotId:row.custodyLotId,borrowingId:`loan_${id}`,effect};
              await custody.borrow(ownership.borrowingId,row.custodyLotId,{...row,id},item,warehouse,partner,cost);
            } else {
            if (balance.quantityScaled < row.quantityScaled) fail('invalid-argument', `재고 부족: 현재 ${balance.quantityScaled / 10000}, 출고 ${row.quantityScaled / 10000}`);
            cost = row.quantityScaled === balance.quantityScaled ? balance.value : safe(round(BigInt(balance.value) * BigInt(row.quantityScaled), BigInt(balance.quantityScaled)));
            balance.quantityScaled -= row.quantityScaled; balance.value -= cost;
            if (row.fulfillment === 'HOLD') {
              const id=hash(['trade',docKey,row.rowNo]); ownership={stockMode:'HOLD',custodyLotId:`hold_${id}`};
              await custody.hold(ownership.custodyLotId,{...row,id},item,warehouse,partner);
            }
            }
          } else { balance.quantityScaled = safe(BigInt(balance.quantityScaled) + BigInt(row.quantityScaled), '수량'); balance.value = safe(BigInt(balance.value) + BigInt(amount.value)); }
          movementId = hash(['trade', docKey, row.rowNo]);
        }
        const movementRef = parent.collection('erpMovements').doc(movementId), oldMovement = await get(movementRef);
        if (oldMovement.exists) fail('invalid-argument', '이미 반영된 원장 행입니다.');
        Object.assign(preview, { cost, ...ownership, ...(bundle ? { bundle } : {}), afterQuantity: balance.quantityScaled / 10000, afterValue: balance.value });
        writes.set(movementRef.path, { ref: movementRef, data: { companyId, importId: job.id, ...row, itemId: item.id, warehouseId: warehouse.id,
          sourceKind: job.source.kind || 'XLSX', partnerId: partner?.id || null, partnerName: partner?.name || '', warehouseName: warehouse.name, warehouseCode: warehouse.code,
          ...amount, cost, ...ownership, ...(bundle ? { bundle,stockMode:'BUNDLE',effect } : {}), afterQuantity: preview.afterQuantity, afterValue: preview.afterValue, createdAt: job.createdAt, createdBy: job.createdBy } });
      } catch (error) { if (!['invalid-argument', 'failed-precondition'].includes(error.code)) throw error; errors.push(issue(row.sourceRow, error.message, job.type)); }
    }
    const balances = [...stocks.values()].map(b => ({ itemId: b.itemId, warehouseId: b.warehouseId, beforeQuantity: b.beforeQuantity, beforeValue: b.beforeValue, quantity: b.quantityScaled / 10000, value: b.value }));
    if ([...writes.values()].filter(entry => entry.ref.parent.id === 'erpMovements').length > 200) errors.push(issue(0,'구성품을 포함한 원장 행은 문서당 200개까지 가능합니다.',job.type));
    const itemTotals = job.source.kind === 'MANUAL' ? [...itemBalances].map(([itemId, snapshots]) => {
      let quantity = 0n, value = 0n; const seen = new Set();
      for (const snapshot of snapshots.docs) {
        const b = snapshot.data(); scope(b);
        if (seen.has(b.warehouseId) || !Number.isFinite(b.quantity) || b.quantity < 0 || !Number.isSafeInteger(Math.round(b.quantity * 10000)) || Math.abs(b.quantity * 10000 - Math.round(b.quantity * 10000)) > 0.001 || !Number.isSafeInteger(b.value) || b.value < 0 || b.currency !== 'KRW') fail('failed-precondition', '품목 전체 재고 집계를 확인해 주세요.');
        seen.add(b.warehouseId); quantity += BigInt(Math.round(b.quantity * 10000)); value += BigInt(b.value);
      }
      const beforeQuantity = safe(quantity, '수량') / 10000, beforeValue = safe(value);
      for (const b of balances.filter(row => row.itemId === itemId)) { quantity += BigInt(Math.round(b.quantity * 10000)) - BigInt(Math.round(b.beforeQuantity * 10000)); value += BigInt(b.value - b.beforeValue); }
      return { itemId, name:masters.get(`items:${itemId}`)?.name || '', beforeQuantity, beforeValue, quantity: safe(quantity, '수량') / 10000, value: safe(value) };
    }) : [];
    const fingerprint = hash({ schema: 3, state, rows: previews, masters: [...masterState], source: job.source.sha256, options, errors, itemTotals, balances, custody:custody.snapshot() });
    return { preview: { fingerprint, rows: previews, errors, warnings, balances, itemTotals, canCommit: !errors.length && !!previews.length,
      newItems: [...masters.values()].filter(r => r.isNew && r.unit).length, newPartners: [...masters.values()].filter(r => r.isNew && r.country).length },
      writes, stocks, documents, state, stateRef, custody, last: sorted.at(-1) };
  }
  return async request => {
    const input = request.data;
    if (!input || typeof input !== 'object' || !['manualPreview','preview','get','list','commit','cancel','downloadSource','template'].includes(input.action)) fail('invalid-argument', '업로드 요청을 확인해 주세요.');
    const fields = { manualPreview: ['id','movement'], preview: ['id','type','source','options'], get: ['id'], list: [], commit: ['id','fingerprint'], cancel: ['id'], downloadSource: ['id'], template: ['type'] };
    if (Object.keys(input).some(key => !['action','companyId',...fields[input.action]].includes(key))) fail('invalid-argument', '허용된 업로드 요청 필드만 사용해 주세요.');
    const user = await context(request), parent = db.collection('companies').doc(user.companyId), collection = parent.collection('erpImports');
    if (input.action === 'template') {
      const files = { OPENING: '기초재고_이관_입력양식.xlsx', MOVEMENTS: '거래별_입출고_입력양식.xlsx' };
      if (!Object.hasOwn(files, input.type)) fail('invalid-argument', '양식 종류를 선택해 주세요.');
      const bytes = await require('node:fs/promises').readFile(require('node:path').join(__dirname, 'assets', 'erp', files[input.type]));
      await context(request); return { name: files[input.type], mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: bytes.toString('base64') };
    }
    if (input.action === 'list') return db.runTransaction(async tx => {
      await context(request, tx); const snapshots = await tx.get(collection.orderBy('createdAt', 'desc').limit(50));
      return { imports: snapshots.docs.map(doc => { const job = doc.data(); master.verifyTenant(job, user.companyId); return { id: doc.id, type: job.type, sourceKind: job.source.kind || 'XLSX', status: job.status, name: job.source.name, createdAt: job.createdAt, rowCount: job.rows.length, errorCount: job.preview.errors.length }; }) };
    });
    const id = master.identifier(input.id), ref = collection.doc(id);
    if (input.action === 'manualPreview') {
      const requestHash = manualInput(input.movement), movement = input.movement;
      return db.runTransaction(async tx => {
        await context(request, tx); const existing = await tx.get(ref);
        if (existing.exists) {
          const old = existing.data(); master.verifyTenant(old, user.companyId);
          if (old.source.kind !== 'MANUAL' || old.requestHash !== requestHash) fail('already-exists', '입력 내용이 변경되었습니다. 새로 검증해 주세요.');
          return { import: expose(id, old) };
        }
        const stateDoc = await tx.get(parent.collection('erpState').doc('ledger')), state = stateDoc.data() || {};
        if (stateDoc.exists) master.verifyTenant(state, user.companyId);
        const basisDate = state.basisDate || new Date(new Date(`${movement.date}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0,10);
        const order = state.lastDate === movement.date ? state.lastOrder + 1 : 1;
        const parsed = parseManual(movement, { basisDate, order, documentNo: `MAN-${id.length <= 76 ? id : master.hash(id)}`, companyLabel: '직접 입력' });
        const options = optionsOf({ defaultWarehouseId: movement.warehouseId, partnerByRow: Object.fromEntries(parsed.rows.filter(() => movement.partnerId).map(row => [row.sourceRow, movement.partnerId])), allowNewItems: movement.allowNewItems, allowNewPartners: movement.allowNewPartners });
        const job = { ...parsed, id, companyId: user.companyId, requestHash, initializeEmptyLedger: !state.basisDate && movement.direction === '입고',
          status: 'PENDING', options, createdBy: user.uid, createdAt: now().toISOString(), source: { kind: 'MANUAL', name: `${movement.direction} 직접 등록`, size: 0, sha256: requestHash } };
        job.preview = (await plan(tx, parent, job)).preview;
        if (Buffer.byteLength(JSON.stringify(job)) > 850000) fail('resource-exhausted', '입력 행을 나눠 주세요.');
        tx.create(ref, job); return { import: expose(id, job) };
      });
    }
    if (input.action === 'preview') {
      const options = optionsOf(input.options), parsed = await parseFile(input.source, input.type);
      const { buffer, ...data } = parsed;
      const sourcePath = `companies/${user.companyId}/erp-sources/${id}/${parsed.source.sha256}.xlsx`, file = bucket.file(sourcePath);
      // Unique source hashes never overwrite another pending/committed source.
      try { await file.save(buffer, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: parsed.source.mimeType,
        metadata: { companyId: user.companyId, importId: id, sha256: parsed.source.sha256 } } }); }
      catch (error) { if (![409,412].includes(Number(error.code))) throw error; }
      const [metadata] = await file.getMetadata();
      if (metadata.metadata?.companyId !== user.companyId || metadata.metadata?.sha256 !== parsed.source.sha256 || Number(metadata.size) !== buffer.length || !/^\d+$/.test(String(metadata.generation))) fail('internal', '원본 파일 저장을 확인하지 못했습니다.');
      const job = { ...data, id, companyId: user.companyId, status: 'PENDING', options, createdBy: user.uid, createdAt: now().toISOString(),
        source: { ...parsed.source, storagePath: sourcePath, generation: String(metadata.generation) } };
      return db.runTransaction(async tx => {
        await context(request, tx); const existing = await tx.get(ref);
        if (existing.exists) {
          const old = existing.data(); master.verifyTenant(old, user.companyId);
          if (old.source.kind === 'MANUAL' || old.source.sha256 !== job.source.sha256 || hash(old.options) !== hash(options) || old.type !== job.type) fail('already-exists', '업로드 식별값이 이미 사용 중입니다. 새로 검증해 주세요.');
          return { import: expose(id, old) };
        }
        job.preview = (await plan(tx, parent, job)).preview;
        if (Buffer.byteLength(JSON.stringify(job)) > 850000) fail('resource-exhausted', '검증 자료가 너무 큽니다. 입력 행을 나눠 주세요.');
        tx.create(ref, job); return { import: expose(id, job) };
      });
    }
    if (input.action === 'downloadSource') {
      const snap = await ref.get(), job = snap.data(); if (!snap.exists) fail('not-found', '업로드 자료를 찾을 수 없습니다.');
      master.verifyTenant(job, user.companyId);
      if (job.source.kind === 'MANUAL') fail('failed-precondition', '직접 등록한 거래는 원본 Excel 파일이 없습니다. 등록 이력과 원장에서 확인해 주세요.');
      if (job.source.storagePath !== `companies/${user.companyId}/erp-sources/${id}/${job.source.sha256}.xlsx` || !/^[a-f0-9]{64}$/.test(job.source.sha256) || !/^\d+$/.test(job.source.generation)) fail('failed-precondition', '원본 파일의 회사 경로를 확인해 주세요.');
      const [bytes] = await bucket.file(job.source.storagePath, { generation: job.source.generation }).download();
      if (bytes.length !== job.source.size || master.hash(bytes) !== job.source.sha256) fail('failed-precondition', '원본 파일의 무결성을 확인하지 못했습니다.');
      await context(request); return { name: job.source.name, mimeType: job.source.mimeType, base64: bytes.toString('base64') };
    }
    return db.runTransaction(async tx => {
      await context(request, tx); const snap = await tx.get(ref), job = snap.data();
      if (!snap.exists) fail('not-found', '업로드 자료를 찾을 수 없습니다.'); master.verifyTenant(job, user.companyId);
      if (input.action === 'get') return { import: expose(id, job) };
      if (input.action === 'cancel') {
        if (job.status === 'COMMITTED') fail('failed-precondition', '확정된 원장은 검토 취소로 삭제할 수 없습니다.');
        tx.update(ref, { status: 'CANCELLED', cancelledAt: now().toISOString(), cancelledBy: user.uid });
        return { import: expose(id, { ...job, status: 'CANCELLED' }) };
      }
      if (typeof input.fingerprint !== 'string' || input.fingerprint !== job.preview.fingerprint) fail('failed-precondition', '확인한 미리보기 정보로 다시 시도해 주세요.');
      if (job.status === 'COMMITTED') return { import: expose(id, job), idempotent: true };
      if (job.status !== 'PENDING' || !job.preview.canCommit) fail('failed-precondition', '오류를 수정하고 다시 검증한 파일만 확정할 수 있습니다.');
      const fresh = await plan(tx, parent, job);
      if (!fresh.preview.canCommit || fresh.preview.fingerprint !== input.fingerprint) fail('failed-precondition', '재고·기준정보 또는 다른 거래가 변경되었습니다. 파일을 다시 검증하고 새 미리보기를 확인해 주세요.');
      const timestamp = now().toISOString();
      // All authorization, duplicate, master and balance reads are complete before any writes.
      fresh.custody.flush(timestamp);
      for (const entry of fresh.writes.values()) tx.set(entry.ref, entry.data);
      for (const entry of fresh.documents.values()) tx.create(entry.ref, entry.data);
      for (const balance of fresh.stocks.values()) if (!balance.virtual) tx.set(balance.ref, { companyId: user.companyId, itemId: balance.itemId, warehouseId: balance.warehouseId,
        quantity: balance.quantityScaled / 10000, value: balance.value, currency: 'KRW', openingImportId: balance.openingImportId, updatedAt: timestamp, importId: id });
      tx.set(fresh.stateRef, { companyId: user.companyId, basisDate: job.basisDate, revision: (fresh.state.revision || 0) + 1,
        lastDate: job.type === 'MOVEMENTS' ? fresh.last.date : null, lastOrder: job.type === 'MOVEMENTS' ? fresh.last.order : null, updatedAt: timestamp });
      if (job.source.kind !== 'MANUAL') tx.create(parent.collection('erpImportReceipts').doc(job.source.sha256), { companyId: user.companyId, importId: id, at: timestamp });
      tx.create(parent.collection('erpAudit').doc(), { companyId: user.companyId, actorId: user.uid, action: job.source.kind === 'MANUAL' ? 'MANUAL_MOVEMENT_COMMIT' : 'IMPORT_COMMIT', importId: id, type: job.type, rowCount: job.rows.length, at: timestamp });
      const patch = { status: 'COMMITTED', committedAt: timestamp, committedBy: user.uid };
      tx.update(ref, patch); return { import: expose(id, { ...job, ...patch }), idempotent: false };
    });
  };
}
module.exports = { createErpImportService, optionsOf };
