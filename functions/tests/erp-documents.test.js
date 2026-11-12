const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createErpService } = require('../erp-service');
const { createErpImportService } = require('../erp-import-service');
const { createErpDocumentService } = require('../erp-document-service');
const { createErpCorrectionService } = require('../erp-correction-service');
const { createOfficialLetterService } = require('../official-letter-service');
const { renderErpDocumentPdf } = require('../erp-document-pdf');
const D = require('../erp-document-model');
const { workbook, opening, movement } = require('./erp-import-fixtures.cjs');
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) throw new Error('ERP document tests require loopback Firestore.');
process.env.METADATA_SERVER_DETECTION = 'none';
const projectId = 'demo-erp-phase4', app = initializeApp({ projectId }, 'erp-document-tests'), db = getFirestore(app);
const now = () => new Date('2026-11-12T03:00:00Z'), files = new Map(); let sequence = 0, renderCount = 0, failRendering = false, renderHook = null, ignorePreconditions = false;
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const bucket = { file: (path, version = {}) => ({
  save: async (bytes, options = {}) => {
    if (!ignorePreconditions && files.has(path) && options.preconditionOpts?.ifGenerationMatch === 0) throw Object.assign(new Error('exists'), { code: 412 });
    files.set(path, { bytes: Buffer.from(bytes), meta: { ...structuredClone(options.metadata || {}), size: String(bytes.length), generation: String(++sequence) }, options });
  },
  getMetadata: async () => { if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 404 }); return [structuredClone(files.get(path).meta)]; },
  download: async () => { const value = files.get(path); if (!value || version.generation && version.generation !== value.meta.generation) throw new Error('missing generation'); return [Buffer.from(value.bytes)]; },
}) };
const render = async (snapshot, images) => {
  renderCount++;
  if (renderHook) await renderHook();
  if (failRendering) throw new Error('synthetic render failure');
  assert.ok(snapshot.draft || images.seal); return Buffer.from(`%PDF-1.7 ${snapshot.number} ${D.hash(snapshot)} ${renderCount}`);
};
const deps = { db, bucket, now }, documents = createErpDocumentService({ ...deps, renderPdf: render });
const masters = createErpService(deps), imports = createErpImportService(deps), official = createOfficialLetterService({ ...deps, renderPdf: render }), corrections = createErpCorrectionService(deps);
const request = (data, uid = 'admin', companyId = 'a') => ({ data: { companyId, ...data }, ...(uid ? { auth: { uid, token: { auth_time: now().getTime() / 1000 } } } : {}) });
const call = (action, data = {}, uid = 'admin', companyId = 'a', service = documents) => service(request({ action, ...data }, uid, companyId));
const denied = (value, code) => assert.rejects(value, error => error.code === code);
const parent = () => db.doc('companies/a');
const load = async id => (await call('get', { id })).document;
const save = async (input, id = `draft-${++sequence}`, revision = 0) => (await call('save', { id, expectedRevision: revision, input })).document;
const issue = doc => call('issue', { id: doc.id, expectedRevision: doc.revision, fingerprint: doc.fingerprint, confirm: true });
const cancel = doc => call('cancel', { id: doc.id, expectedRevision: doc.revision, reason: '거래 정보 정정', confirm: true });
const profile = { companyNameEn: 'Sample Supplier Ltd.', addressEn: '10 Sample Road, Seoul, Korea', representativeEn: 'Sample Kim', registrationNumber: '123-45-67890', businessType: '도소매', businessItem: '전자제품', bankDetails: 'Sample Bank / SAMPLE-0001' };
async function reset() {
  const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' }); assert.equal(response.status, 200);
  files.clear(); failRendering = false; renderHook = null; ignorePreconditions = false;
  const batch = db.batch(); for (const company of ['a', 'b']) batch.set(db.doc(`companies/${company}`), { status: 'ACTIVE', nameKo: `검증회사 ${company}`, accessUntil: Timestamp.fromDate(new Date('2027-01-01')) });
  for (const [uid, role, companyId] of [['admin', 'ADMIN', 'a'], ['admin2', 'ADMIN', 'a'], ['foreign', 'ADMIN', 'b'], ['member', 'MEMBER', 'a'], ['manager', 'SUB_ADMIN', 'a'], ['root', 'SUPER_ADMIN', 'PLATFORM']]) batch.set(db.doc(`UserProfile/${uid}`), { uid, name: '검증 담당자', role, companyId, status: 'ACTIVE' });
  await batch.commit();
  await masters(request({ action: 'save', kind: 'warehouses', id: 'warehouse', expectedRevision: 0, values: { code: 'WH-01', name: '본사 창고', active: true, notes: '', address: '' } }));
  for (const [type, rows] of [['OPENING', [opening()]], ['MOVEMENTS', [movement({ 2: '출고', 3: 'OUT-001', 11: 5, 12: 300 })]]]) {
    const source = await workbook(type, rows), preview = await imports(request({ action: 'preview', id: `upload-${++sequence}`, type, source, options: { allowNewItems: true, allowNewPartners: true } }));
    assert.equal(preview.import.preview.canCommit, true, JSON.stringify(preview.import.preview.errors));
    await imports(request({ action: 'commit', id: preview.import.id, fingerprint: preview.import.preview.fingerprint }));
  }
  await official(request({ action: 'saveSettings', expectedVersion: 0, settings: { companyName: '검증 공급자', companyNameEn: profile.companyNameEn, address: '서울 검증로 10', representative: '검증 대표', logoData: png, sealData: png, sealWidthMm: 28, sealHeightMm: 18 } }));
  await call('saveProfile', { profile, expectedVersion: 0 });
  const source = await call('sources', { documentNo: 'OUT-001', kind: 'INVOICE' });
  return { ...source, sourceId: source.rows[0].id, itemId: (await parent().collection('erpItems').get()).docs[0].id };
}
function input(source, kind = 'INVOICE', quantity = '5') {
  return { kind, issueDate: '2026-11-12', validUntil: kind === 'PROFORMA' ? '2026-12-12' : '', partnerId: source.partnerId,
    buyerNameEn: kind === 'PROFORMA' ? 'Buyer Corporation' : '', buyerAddressEn: kind === 'PROFORMA' ? '20 Buyer Street, New York, USA' : '',
    currency: source.currency, sourceDocumentNo: kind === 'PROFORMA' ? '' : source.documentNo,
    lines: kind === 'PROFORMA' ? [{ itemId: source.itemId, description: 'Sample monitor', quantity, price: '132500', taxType: '과세', taxRate: '0.1', priceBasis: '세금포함', notes: '' }] : [{ sourceId: source.sourceId, quantity, notes: '' }],
    paymentTerms: '발행 후 30일', deliveryTerms: '합의 장소 납품', tradeTerms: '', notes: '합성 테스트 문서' };
}
async function inventory() {
  const result = {};
  for (const name of ['erpInventory', 'erpMovements', 'erpImports', 'erpState']) result[name] = (await parent().collection(name).get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
  return result;
}

test('ERP PDF issuance, source allocation and private archive', async t => { try {
  await t.test('bundle statements show the sale once and preserve the company seal without printing component stock rows', async () => {
    const existing = await reset();
    await masters(request({action:'save',kind:'items',id:'bundle',expectedRevision:0,values:{code:'SET',name:'조합상품',unit:'SET',specification:'',purchasePrice:0,salePrice:500,taxType:'과세',group:'',notes:'',active:true,itemType:'BUNDLE',components:[{itemId:existing.itemId,quantity:'2'}]}}));
    const movement={direction:'출고',payment:{status:'CREDIT'},date:'2026-11-12',warehouseId:'warehouse',partnerId:existing.partnerId,currency:'KRW',exchangeRate:'1',priceBasis:'세금별도',allowNewItems:false,allowNewPartners:false,
      lines:[{code:'SET',name:'조합상품',specification:'',unit:'SET',taxType:'과세',quantity:'2',price:'500',notes:''}]};
    const job=(await imports(request({action:'manualPreview',id:'bundle-statement',movement}))).import;assert.equal(job.preview.canCommit,true);
    await imports(request({action:'commit',id:job.id,fingerprint:job.preview.fingerprint}));
    const source=await call('sources',{documentNo:job.preview.rows[0].documentNo,kind:'STATEMENT'});assert.equal(source.rows.length,1);assert.equal(source.rows[0].name,'조합상품');
    const before=await inventory(),draft=await save(input({...source,sourceId:source.rows[0].id},'STATEMENT','2')),issued=(await issue(draft)).document;
    assert.equal(issued.totalMinor,1100);const stored=(await parent().collection('erpIssuedDocuments').doc(issued.id).get()).data();assert.equal(stored.snapshot.rows.length,1);assert.ok(stored.snapshot.branding.assets.seal);assert.deepEqual(await inventory(),before);
  });
  await t.test('a manual outgoing transaction issues a statement with its sales price and the registered seal', async () => {
    const existing = await reset();
    const movement = { direction: '출고', payment:{status:'CREDIT'}, date: '2026-11-12', warehouseId: 'warehouse', partnerId: existing.partnerId,
      currency: 'KRW', exchangeRate: '1', priceBasis: '세금포함', allowNewItems: false, allowNewPartners: false,
      lines: [{ code: '0001', name: '합성 품목', specification: '규격', unit: 'EA', taxType: '과세', quantity: '2', price: '440', notes: '' }] };
    const job = (await imports(request({ action: 'manualPreview', id: 'manual-statement', movement }))).import;
    assert.equal(job.preview.canCommit, true, JSON.stringify(job.preview.errors));
    await imports(request({ action: 'commit', id: job.id, fingerprint: job.preview.fingerprint }));
    const source = await call('sources', { documentNo: job.preview.rows[0].documentNo, kind: 'STATEMENT' });
    const before = await inventory();
    const draft = await save(input({ ...source, sourceId: source.rows[0].id }, 'STATEMENT', '2'));
    const issued = (await issue(draft)).document;
    assert.equal(issued.status, 'ISSUED'); assert.equal(issued.totalMinor, 880); assert.equal(issued.pdfReady, true);
    const stored = (await parent().collection('erpIssuedDocuments').doc(issued.id).get()).data();
    assert.ok(stored.snapshot.branding.assets.seal); assert.deepEqual(await inventory(), before);
  });
  await t.test('three document types reserve independent numbers, freeze the registered seal and never mutate inventory', async () => {
    const source = await reset(), before = await inventory();
    for (const [kind, prefix] of [['PROFORMA', 'PI'], ['INVOICE', 'INV'], ['STATEMENT', 'TS']]) {
      const draft = await save(input(source, kind)), result = await issue(draft), doc = result.document;
      assert.equal(doc.number, `${prefix}-2026-000001`); assert.equal(doc.pdfReady, true); assert.equal(doc.status, 'ISSUED');
      const original = await call('pdf', { id: doc.id }), again = await call('pdf', { id: doc.id }); assert.equal(original.base64, again.base64);
      const stored = (await parent().collection('erpIssuedDocuments').doc(doc.id).get()).data();
      assert.equal(stored.snapshot.branding.sealWidthMm, 28); assert.equal(stored.snapshot.branding.sealHeightMm, 18);
      const frozen = files.get(stored.snapshot.branding.assets.seal.path); assert.ok(frozen.bytes.equals(Buffer.from(png.split(',')[1], 'base64')));
      assert.equal(frozen.options.preconditionOpts.ifGenerationMatch, 0);
      assert.equal(files.get(stored.pdf.path).meta.cacheControl, 'private, no-store');
      assert.equal(JSON.stringify(doc).includes('erp-issue-assets'), false);
    }
    assert.deepEqual(await inventory(), before);
    const meta = await call('meta'); assert.equal(meta.profile.companyNameEn, profile.companyNameEn); assert.equal(meta.canIssue, true);
  });
  await t.test('identical logo and seal reuse one archived generation even in an emulator without create preconditions', async () => {
    const source = await reset(); ignorePreconditions = true;
    let generation;
    for (const kind of ['PROFORMA', 'INVOICE', 'STATEMENT']) {
      const result = await issue(await save(input(source, kind))); assert.equal(result.document.pdfReady, true);
      const stored = (await parent().collection('erpIssuedDocuments').doc(result.document.id).get()).data();
      const { seal, logo } = stored.snapshot.branding.assets;
      assert.deepEqual(seal, logo);
      if (generation) assert.equal(seal.generation, generation);
      generation = seal.generation;
    }
  });
  await t.test('duplicate and concurrent issue requests reuse one number and one allocation', async () => {
    const source = await reset(), draft = await save(input(source));
    const results = await Promise.all([issue(draft), issue(draft)]); assert.equal(results.filter(r => r.idempotent).length, 1); assert.equal(results[0].document.number, results[1].document.number);
    assert.equal((await parent().collection('erpIssueCounters').doc('INVOICE-2026').get()).data().last, 1);
    assert.equal((await call('sources', { documentNo: 'OUT-001', kind: 'INVOICE' })).rows[0].available, 0);
    const second = await save(input(source, 'PROFORMA')); const another = await save(input(source, 'PROFORMA')); const issued = await Promise.all([issue(second), issue(another)]);
    assert.equal(new Set(issued.map(r => r.document.number)).size, 2);
    await denied(save(input(source)), 'failed-precondition');
  });
  await t.test('partial source quantities, independent statement allocation and cancellation reconcile exactly', async () => {
    const source = await reset(), before = await inventory();
    const first = (await issue(await save(input(source, 'INVOICE', '2')))).document;
    const second = (await issue(await save(input(source, 'INVOICE', '3')))).document;
    assert.equal(first.totalMinor + second.totalMinor, 1650);
    await issue(await save(input(source, 'STATEMENT')));
    const cancelled = await cancel(first); assert.equal(cancelled.document.status, 'CANCELLED');
    await cancel(first); // Retry cannot release the allocation twice.
    const replacement = (await issue(await save(input(source, 'INVOICE', '2')))).document;
    assert.equal(second.totalMinor + replacement.totalMinor, 1650); assert.deepEqual(await inventory(), before);
    assert.equal((await call('pdf', { id: first.id })).document.status, 'CANCELLED');
  });
  await t.test('rounding gaps from cancelling one partial invoice remain bounded and fully allocate the original', async () => {
    const row = { quantityScaled: 30000, supply: 1, tax: 1 }, link = { returnedQuantityScaled: 0 }, used = { quantityScaled: 10000, supplyMinor: 1, taxMinor: 1 };
    const partial = D.sourceAllocation(row, link, used, 1, 'KRW'); assert.equal(partial.supplyMinor, 0);
    const final = D.sourceAllocation(row, link, { ...used, quantityScaled: 10001 }, 19999, 'KRW'); assert.equal(final.supplyMinor, 0); assert.equal(final.taxMinor, 0);
    assert.deepEqual(D.totals([{ supplyMinor: 1, taxMinor: 0 }, { supplyMinor: 0, taxMinor: 1 }]), { supplyMinor: 1, taxMinor: 1, totalMinor: 2 });
  });
  await t.test('returns, cancelled sources and competing drafts are revalidated at issue time', async () => {
    const source = await reset(), first = await save(input(source, 'INVOICE', '4')), second = await save(input(source, 'INVOICE', '4'));
    await issue(first); await denied(issue(second), 'failed-precondition');
    await reset(); const src = await call('sources', { documentNo: 'OUT-001', kind: 'INVOICE' }), pending = await save(input({ ...src, sourceId: src.rows[0].id }));
    const preview = await corrections(request({ action: 'preview', id: 'return-one', input: { type: 'SALES_RETURN', sourceId: src.rows[0].id, quantity: '1', date: '2026-11-03', reason: '구매자 반품 요청' } }));
    await corrections(request({ action: 'commit', id: 'return-one', fingerprint: preview.correction.fingerprint }));
    await denied(issue(pending), 'failed-precondition');
    assert.equal((await call('sources', { documentNo: 'OUT-001', kind: 'INVOICE' })).rows[0].available, 4);
    const fresh = await reset(), p = await save(input(fresh));
    const c = await corrections(request({ action: 'preview', id: 'cancel-out', input: { type: 'CANCEL', sourceId: fresh.sourceId, date: '2026-11-03', reason: '출고 자체 취소' } }));
    await corrections(request({ action: 'commit', id: 'cancel-out', fingerprint: c.correction.fingerprint })); await denied(issue(p), 'failed-precondition');
  });
  await t.test('company settings and master changes invalidate drafts but never change issued PDF bytes', async () => {
    const source = await reset(), draft = await save(input(source, 'PROFORMA'));
    await call('saveProfile', { profile: { ...profile, addressEn: 'Changed address' }, expectedVersion: 1 }); await denied(issue(draft), 'failed-precondition');
    const current = await save(draft.input, draft.id, draft.revision), issued = (await issue(current)).document;
    const original = await call('pdf', { id: issued.id }), count = renderCount;
    await db.doc('officialLetterSettings/a').update({ companyName: '변경 공급자', sealPath: 'companies/a/official-assets/unavailable.png', version: 9 });
    await parent().collection('erpPartners').doc(source.partnerId).update({ name: '변경 거래처', revision: 20 });
    assert.equal((await call('pdf', { id: issued.id })).base64, original.base64); assert.equal(renderCount, count);
  });
  await t.test('render failure keeps the number and frozen assets for retry after the original seal is removed', async () => {
    const source = await reset(), draft = await save(input(source)); failRendering = true;
    const result = await issue(draft); assert.equal(result.document.status, 'ISSUED'); assert.equal(result.document.pdfReady, false); assert.ok(result.warning);
    const settings = (await db.doc('officialLetterSettings/a').get()).data(); files.delete(settings.sealPath);
    failRendering = false; const ready = await call('pdf', { id: draft.id }); assert.equal(ready.document.pdfReady, true); assert.equal(ready.document.number, result.document.number);
    assert.equal((await parent().collection('erpIssueCounters').doc('INVOICE-2026').get()).data().last, 1);
  });
  await t.test('missing or modified ready PDFs and corrupt frozen images fail closed', async () => {
    const source = await reset(), issued = (await issue(await save(input(source)))).document;
    const ref = parent().collection('erpIssuedDocuments').doc(issued.id), stored = (await ref.get()).data(), file = files.get(stored.pdf.path), count = renderCount;
    files.delete(stored.pdf.path); await assert.rejects(call('pdf', { id: issued.id })); assert.equal(renderCount, count);
    files.set(stored.pdf.path, { ...file, bytes: Buffer.from('x'.repeat(file.bytes.length)) }); await denied(call('pdf', { id: issued.id }), 'failed-precondition');
    const s = await reset(); failRendering = true; const pending = (await issue(await save(input(s)))).document, saved = (await parent().collection('erpIssuedDocuments').doc(pending.id).get()).data();
    failRendering = false; files.get(saved.snapshot.branding.assets.seal.path).meta.generation = '99999'; await denied(call('pdf', { id: pending.id }), 'failed-precondition');
  });
  await t.test('missing seals, foreign paths, corrupt bytes and changed template ownership block issue', async () => {
    const source = await reset(); await db.doc('officialLetterSettings/a').update({ sealPath: '', version: 2 });
    const draft = await save(input(source)); assert.equal(draft.preview.branding.sealRegistered, false); await denied(issue(draft), 'failed-precondition');
    await db.doc('officialLetterSettings/a').update({ sealPath: `companies/b/official-assets/${'a'.repeat(64)}.png`, version: 3 });
    await denied(issue(await save(input(source))), 'failed-precondition');
    const current = await reset(), settings = (await db.doc('officialLetterSettings/a').get()).data(); files.get(settings.sealPath).bytes[0] = 0;
    await denied(issue(await save(input(current))), 'failed-precondition');
    await db.doc('officialLetterSettings/a').update({ companyId: 'b' }); await denied(call('meta'), 'failed-precondition');
  });
  await t.test('cancellation and one linked revision preserve the old PDF and reserve a fresh number', async () => {
    const source = await reset(), before = await inventory(), issued = (await issue(await save(input(source)))).document, original = await call('pdf', { id: issued.id });
    await denied(call('save', { id: issued.id, expectedRevision: issued.revision, input: issued.input }), 'failed-precondition');
    await cancel(issued); const revised = (await call('revise', { id: 'revision-new', sourceId: issued.id })).document;
    assert.equal(revised.replacesId, issued.id); assert.equal(revised.edition, 2); assert.equal(revised.preview, null);
    await call('revise', { id: 'revision-new', sourceId: issued.id }); await denied(call('revise', { id: 'revision-other', sourceId: issued.id }), 'failed-precondition');
    const updated = await save({ ...revised.input, notes: '정정 발행' }, revised.id, revised.revision), next = (await issue(updated)).document;
    assert.notEqual(next.number, issued.number); assert.equal(next.replacesNumber, issued.number); assert.equal((await call('pdf', { id: issued.id })).base64, original.base64); assert.deepEqual(await inventory(), before);
  });
  await t.test('all endpoints deny other companies, quantity-only roles and revoked sessions including post-render revocation', async () => {
    const source = await reset(), draft = await save(input(source));
    for (const uid of [null, 'member', 'manager', 'root']) for (const action of ['meta', 'list', 'get', 'pdf', 'sources']) {
      const data = action === 'get' || action === 'pdf' ? { id: draft.id } : action === 'sources' ? { documentNo: 'OUT-001', kind: 'INVOICE' } : {};
      await denied(call(action, data, uid), uid ? 'permission-denied' : 'unauthenticated');
    }
    await denied(call('get', { id: draft.id }, 'foreign', 'a'), 'permission-denied'); await denied(call('get', { id: draft.id }, 'foreign', 'b'), 'not-found');
    await denied(call('get', { id: '../a' }), 'invalid-argument');
    await db.doc('UserProfile/admin').update({ sessionValidAfter: now().getTime() / 1000 + 1 }); await denied(call('meta'), 'unauthenticated');
    await db.doc('UserProfile/admin').update({ sessionValidAfter: null });
    renderHook = () => db.doc('UserProfile/admin').update({ role: 'MEMBER' }); await denied(call('previewPdf', { id: draft.id, expectedRevision: draft.revision }), 'permission-denied'); renderHook = null;
  });
  await t.test('strict input validation, dates, price precision and preview revisions protect the issue boundary', async () => {
    const source = await reset(), value = input(source, 'PROFORMA');
    for (const patch of [{ currency: 'BTC' }, { issueDate: '2026-02-30' }, { validUntil: '2025-01-01' }, { buyerNameEn: '' }, { sealPath: 'foreign' }, { lines: [] }, { lines: Array(101).fill(value.lines[0]) }]) await denied(save({ ...value, ...patch }), 'invalid-argument');
    for (const patch of [{ quantity: '-1' }, { price: '1.00001' }, { taxType: '면세', taxRate: '0.1' }, { description: 'bad\u0000text' }]) await denied(save({ ...value, lines: [{ ...value.lines[0], ...patch }] }), 'invalid-argument');
    const draft = await save(value); await denied(call('previewPdf', { id: draft.id, expectedRevision: 0 }), 'aborted'); await denied(call('issue', { id: draft.id, expectedRevision: draft.revision, fingerprint: draft.fingerprint, confirm: false }), 'invalid-argument');
    const preview = await call('previewPdf', { id: draft.id, expectedRevision: draft.revision }); assert.ok(Buffer.from(preview.base64, 'base64').toString().includes('DRAFT'));
    assert.equal((await parent().collection('erpIssueCounters').get()).size, 0);
    await denied(call('saveProfile', { profile, expectedVersion: 0 }), 'aborted'); await denied(call('meta', { extra: true }), 'invalid-argument');
    assert.equal(D.koreanAmount(6167700), '육백십육만칠천칠백'); assert.equal(D.koreanAmount(0), '영');
  });
  await t.test('archive integrity survives Firestore map field reordering but rejects changed values or line order', async () => {
    const source = await reset(), issued = (await issue(await save(input(source)))).document;
    const ref = parent().collection('erpIssuedDocuments').doc(issued.id), stored = (await ref.get()).data();
    const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value;
    const original = await call('pdf', { id: issued.id });
    await ref.update({ snapshot: reorder(stored.snapshot), pdf: reorder(stored.pdf) });
    assert.equal((await call('pdf', { id: issued.id })).base64, original.base64);
    assert.notEqual(D.hash([{ a: 1 }, { b: 2 }]), D.hash([{ b: 2 }, { a: 1 }]));
    await ref.update({ snapshot: { ...stored.snapshot, notes: 'altered archive' } });
    await denied(call('pdf', { id: issued.id }), 'failed-precondition');
  });
  await t.test('list pagination and PDFKit generation use the same validated financial snapshot', async () => {
    const source = await reset(); for (let i = 0; i < 22; i++) await save(input(source, 'PROFORMA'));
    const first = await call('list'), second = await call('list', { cursor: first.cursor }); assert.equal(first.documents.length, 20); assert.equal(second.documents.length, 2);
    const draft = await load(first.documents[0].id), snapshot = { ...draft.preview, number: 'PI-2026-000001', issuedAt: now().toISOString(), issuedByName: '검증 담당자' };
    const pdf = await renderErpDocumentPdf(snapshot, { seal: Buffer.from(png.split(',')[1], 'base64') }); assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))); assert.ok(pdf.length > 10000);
    assert.equal(snapshot.totals.totalMinor, 662500); assert.equal(snapshot.totals.supplyMinor + snapshot.totals.taxMinor, 662500);
  });
} finally { await db.terminate(); await deleteApp(app); } });
