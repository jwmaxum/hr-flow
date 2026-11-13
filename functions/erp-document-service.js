const { createHash } = require('node:crypto');
const { FieldPath } = require('firebase-admin/firestore');
const { authorizeContext, fail } = require('./security-context');
const { erpMaster: master } = require('./erp-service');
const { exactObject, text, date } = require('./erp-ledger-model');
const { decimal } = require('./erp-import-schema');
const D = require('./erp-document-model');

const MAX_IMAGE = 3 * 1024 * 1024, MAX_PDF = 5 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const emptyUsage = companyId => ({ companyId, quantityScaled: 0, supplyMinor: 0, taxMinor: 0 });
const checkRevision = (doc, expected) => {
  if (!Number.isSafeInteger(expected) || expected < 0 || (doc?.revision || 0) !== expected) fail('aborted', '문서가 변경되었습니다. 다시 열어 주세요.');
};
function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  const { sealPath, logoPath, assets, ...branding } = snapshot.branding;
  return { ...snapshot, branding: { ...branding, sealRegistered: Boolean(sealPath || assets?.seal) } };
}
function view(id, doc, full = true) {
  return { id, companyId: doc.companyId, kind: doc.kind, status: doc.status, revision: doc.revision, edition: doc.edition,
    number: doc.number || '', issueDate: doc.input.issueDate, buyerName: (doc.snapshot || doc.preview)?.buyer.name || '',
    currency: doc.input.currency, totalMinor: (doc.snapshot || doc.preview)?.totals.totalMinor ?? null,
    pdfReady: Boolean(doc.pdf), updatedAt: doc.updatedAt, createdAt: doc.createdAt,
    replacesId: doc.replacesId || '', replacesNumber: doc.replacesNumber || '', replacementId: doc.replacementId || '',
    cancelledAt: doc.cancelledAt || '', cancelReason: doc.cancelReason || '',
    ...(full ? { input: doc.input, preview: publicSnapshot(doc.snapshot || doc.preview), fingerprint: doc.fingerprint || '' } : {}) };
}

function createErpDocumentService({ db, bucket, renderPdf, now = () => new Date() }) {
  async function context(request, reader = db) {
    const user = await authorizeContext({ db, request, reader, now, roles: ['ADMIN'] });
    if (request.data.companyId !== user.companyId) fail('permission-denied', '현재 로그인한 회사의 문서만 사용할 수 있습니다.');
    return user;
  }
  const refFor = (companyId, id) => db.doc(`companies/${companyId}/erpIssuedDocuments/${master.identifier(id)}`);
  const read = (reader, ref) => reader === db ? ref.get() : reader.get(ref);
  const usageRef = (parent, kind, sourceId) => parent.collection('erpIssueAllocations').doc(D.hash([kind, sourceId]));
  async function record(reader, ref, companyId) {
    const snap = await read(reader, ref);
    if (!snap.exists) fail('not-found', '문서를 찾을 수 없습니다.');
    master.verifyTenant(snap.data(), companyId); return snap.data();
  }
  async function settings(reader, companyId) {
    const [official, profile] = await Promise.all([read(reader, db.doc(`officialLetterSettings/${companyId}`)), read(reader, db.doc(`companies/${companyId}/erpPrintSettings/profile`))]);
    if (official.exists) master.verifyTenant(official.data(), companyId);
    if (profile.exists) master.verifyTenant(profile.data(), companyId);
    return { official: official.data() || {}, profile: profile.data() || { ...D.profileInput({}), version: 0 } };
  }
  function brandingFor(official, profile, type, requireFields = true) {
    const proforma = type === 'PROFORMA';
    const companyName = proforma ? profile.companyNameEn || official.companyNameEn : official.companyName;
    const address = proforma ? profile.addressEn : official.address;
    const representative = proforma ? profile.representativeEn : official.representative;
    if (requireFields && (!companyName || !address || !representative)) fail('failed-precondition', proforma ? '공급자 출력 설정에 영문 회사명·주소·대표자를 저장해 주세요.' : '회사 서류 템플릿에 회사명·주소·대표자를 저장해 주세요.');
    const width = official.sealWidthMm ?? 23.3, height = official.sealHeightMm ?? 23.3;
    if (![width, height].every(v => Number.isFinite(v) && v >= 5 && v <= 50)) fail('failed-precondition', '등록된 인감 출력 크기를 확인해 주세요.');
    return { companyName: companyName || '', companyNameKo: official.companyName || '', address: address || '', representative: representative || '',
      registrationNumber: profile.registrationNumber || '', businessType: profile.businessType || '', businessItem: profile.businessItem || '',
      phone: official.phone || '', email: official.email || '', bankDetails: profile.bankDetails || '',
      sealPath: official.sealPath || '', logoPath: official.logoPath || '', sealWidthMm: width, sealHeightMm: height,
      settingsVersion: official.version || 0, profileVersion: profile.version || 0 };
  }
  async function sourceRows(reader, parent, documentNo, type) {
    const registry = await record(reader, parent.collection('erpDocuments').doc(D.hash(master.normalize(documentNo))), parent.id);
    if (registry.direction !== '출고') fail('failed-precondition', '확정된 출고 문서만 연결할 수 있습니다.');
    const query = parent.collection('erpMovements').where('documentNo', '==', registry.documentNo).limit(201);
    const result = await read(reader, query);
    if (result.empty || result.size > 200) fail('failed-precondition', '원출고 문서의 행 수를 확인해 주세요.');
    const rows = result.docs.map(row => ({ ...row.data(), id: row.id })).sort((a, b) => a.rowNo - b.rowNo);
    const refs = rows.flatMap(row => [parent.collection('erpMovementLinks').doc(row.id), usageRef(parent, type, row.id)]);
    const states = await reader.getAll(...refs);
    const links = new Map(), usages = new Map();
    rows.forEach((row, i) => {
      master.verifyTenant(row, parent.id);
      if (row.type !== 'MOVEMENTS' || row.direction !== '출고' || row.partnerId !== registry.partnerId || row.currency !== registry.currency) fail('failed-precondition', '원출고 연결을 확인해 주세요.');
      const link = states[i * 2].data() || { companyId: parent.id, returnedQuantityScaled: 0 }, used = states[i * 2 + 1].data() || emptyUsage(parent.id);
      master.verifyTenant(link, parent.id); master.verifyTenant(used, parent.id);
      links.set(row.id, link); usages.set(row.id, used);
    });
    return { registry, rows: rows.filter(row => !row.bundleParentId), links, usages };
  }
  async function plan(reader, parent, value, edition = {}) {
    const content = D.input(value), { official, profile } = await settings(reader, parent.id);
    const branding = brandingFor(official, profile, content.kind);
    const partner = await record(reader, parent.collection('erpPartners').doc(content.partnerId), parent.id);
    if (!partner.active || partner.type === 'SUPPLIER') fail('failed-precondition', '사용 중인 매출 거래처를 선택해 주세요.');
    const buyer = { id: content.partnerId, name: content.kind === 'PROFORMA' ? content.buyerNameEn : partner.name,
      address: content.kind === 'PROFORMA' ? content.buyerAddressEn : partner.address, registrationNumber: partner.registrationNumber,
      country: partner.country, contactName: partner.contactName, email: partner.email, phone: partner.phone };
    let rows, allocations = [], sourceState = [];
    if (content.kind === 'PROFORMA') {
      const itemIds = [...new Set(content.lines.map(line => line.itemId))], snaps = await reader.getAll(...itemIds.map(id => parent.collection('erpItems').doc(id)));
      const items = new Map(snaps.map(snap => [snap.id, snap.data()]));
      rows = content.lines.map((line, index) => {
        const item = items.get(line.itemId); master.verifyTenant(item, parent.id);
        if (!item.active) fail('failed-precondition', '사용 중인 품목만 견적에 추가할 수 있습니다.');
        return D.quoteLine(line, item, content.currency, index + 1);
      });
      sourceState = snaps.map(snap => ({ id: snap.id, revision: snap.data().revision }));
    } else {
      const source = await sourceRows(reader, parent, content.sourceDocumentNo, content.kind);
      if (source.registry.partnerId !== content.partnerId || source.registry.currency !== content.currency || source.registry.date > content.issueDate) fail('invalid-argument', '원출고의 거래처·통화와 발행일을 확인해 주세요.');
      const selected = new Map(source.rows.map(row => [row.id, row]));
      rows = content.lines.map((line, index) => {
        const row = selected.get(line.sourceId);
        if (!row) fail('failed-precondition', '선택한 문서에 속하는 출고 행만 발행할 수 있습니다.');
        const used = source.usages.get(row.id), link = source.links.get(row.id), quantityScaled = decimal(line.quantity, 4, '수량', 1e12);
        const amount = D.sourceAllocation(row, link, used, quantityScaled, content.currency);
        sourceState.push({ id: row.id, used, link });
        allocations.push({ sourceId: row.id, quantityScaled, supplyMinor: amount.supplyMinor, taxMinor: amount.taxMinor, used });
        return { rowNo: index + 1, sourceRowNo: row.rowNo, sourceId: row.id, itemId: row.itemId, code: row.code, description: row.name, specification: row.specification,
          unit: row.unit, quantityScaled, priceScaled: row.priceScaled, ...(row.amountMode === 'TOTAL' ? {amountMode:'TOTAL'} : {}), taxType: row.taxType, taxRateScaled: row.taxRateScaled, priceBasis: row.priceBasis,
          supplyMinor: amount.supplyMinor, taxMinor: amount.taxMinor, notes: line.notes, sourceDate: row.date, warehouseName: row.warehouseName || row.warehouseCode };
      });
    }
    const snapshot = { schema: 1, kind: content.kind, issueDate: content.issueDate, validUntil: content.validUntil, currency: content.currency,
      branding, buyer, rows, totals: D.totals(rows), paymentTerms: content.paymentTerms, deliveryTerms: content.deliveryTerms,
      tradeTerms: content.tradeTerms, notes: content.notes, sourceDocumentNo: content.sourceDocumentNo,
      edition: edition.edition || 1, replacesNumber: edition.replacesNumber || '' };
    return { input: content, snapshot, allocations, fingerprint: D.hash({ snapshot, sourceState, partnerRevision: partner.revision }) };
  }
  function assetPath(value, companyId, frozen = false) {
    const prefix = `companies/${companyId}/${frozen ? 'erp-issue-assets' : 'official-assets'}/`;
    if (typeof value !== 'string' || !value.startsWith(prefix) || !/^[a-f0-9]{64}\.(png|jpg)$/.test(value.slice(prefix.length))) fail('failed-precondition', '현재 회사에 등록된 인감·로고만 사용할 수 있습니다.');
    return value.slice(prefix.length).split('.')[0];
  }
  async function stored(path, limit, expected = null) {
    const file = bucket.file(path), [meta] = await file.getMetadata();
    if (!/^[0-9]+$/.test(String(meta.generation)) || !Number.isSafeInteger(Number(meta.size)) || Number(meta.size) < 1 || Number(meta.size) > limit) fail('failed-precondition', '저장 파일의 크기·버전을 확인해 주세요.');
    if (expected && (String(meta.generation) !== expected.generation || Number(meta.size) !== expected.size)) fail('failed-precondition', '보관 파일이 변경되었습니다. 관리자에게 문의해 주세요.');
    const [bytes] = await bucket.file(path, { generation: String(meta.generation) }).download();
    if (bytes.length !== Number(meta.size) || bytes.length > limit || expected && sha(bytes) !== expected.sha256) fail('failed-precondition', '보관 파일의 무결성을 확인해 주세요.');
    return { bytes, meta, descriptor: { path, generation: String(meta.generation), size: bytes.length, sha256: sha(bytes) } };
  }
  async function freezeAsset(path, companyId) {
    const expectedHash = assetPath(path, companyId), object = await stored(path, MAX_IMAGE);
    if (object.descriptor.sha256 !== expectedHash) fail('failed-precondition', '등록 인감·로고의 원본이 변경되었습니다. 다시 등록해 주세요.');
    const png = path.endsWith('.png'), mime = png ? 'image/png' : 'image/jpeg';
    if (object.meta.contentType !== mime || (png ? object.bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' : object.bytes.subarray(0, 2).toString('hex') !== 'ffd8')) fail('failed-precondition', '등록 이미지의 형식을 확인해 주세요.');
    let image;
    try { image = require('pdfkit').prototype.openImage.call({ _imageRegistry: {}, _imageCount: 0 }, object.bytes); } catch { fail('failed-precondition', '등록 이미지를 읽을 수 없습니다.'); }
    if (![image.width, image.height].every(n => n >= 1 && n <= 4096)) fail('failed-precondition', '등록 이미지의 크기를 확인해 주세요.');
    const target = `companies/${companyId}/erp-issue-assets/${expectedHash}.${png ? 'png' : 'jpg'}`;
    // Reuse a verified content-addressed original, including when logo and seal
    // are identical. The create precondition still protects simultaneous writers.
    let copied;
    try { copied = await stored(target, MAX_IMAGE); }
    catch (error) { if (Number(error.code) !== 404) throw error; }
    if (!copied) {
      try { await bucket.file(target).save(object.bytes, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: mime, cacheControl: 'private, no-store', metadata: { companyId, sha256: expectedHash } } }); }
      catch (error) { if (Number(error.code) !== 412) throw error; }
      copied = await stored(target, MAX_IMAGE);
    }
    if (copied.descriptor.sha256 !== expectedHash || copied.meta.contentType !== mime) fail('failed-precondition', '인감 보관본을 확인해 주세요.');
    return copied.descriptor;
  }
  async function ensurePdf(request, ref) {
    const user = await context(request), current = await record(db, ref, user.companyId);
    if (!['ISSUED', 'CANCELLED'].includes(current.status) || !current.snapshot || D.hash(current.snapshot) !== current.snapshotHash) fail('failed-precondition', '발행된 원본 스냅샷을 확인해 주세요.');
    const path = `companies/${user.companyId}/erp-issued-pdfs/${ref.id}/${current.snapshotHash}.pdf`;
    let object;
    if (current.pdf) {
      if (current.pdf.path !== path) fail('failed-precondition', '발행 PDF 경로를 확인해 주세요.');
      object = await stored(path, MAX_PDF, current.pdf);
    } else {
      // Render only the reserved immutable snapshot. A missing READY file is never
      // silently replaced with a different document or the company's current seal.
      const images = {};
      for (const [key, asset] of Object.entries(current.snapshot.branding.assets)) {
        const expectedHash = assetPath(asset.path, user.companyId, true), saved = await stored(asset.path, MAX_IMAGE, asset);
        if (saved.descriptor.sha256 !== expectedHash) fail('failed-precondition', '보관 인감·로고를 확인해 주세요.');
        images[key] = saved.bytes;
      }
      const bytes = await renderPdf({ ...current.snapshot, number: current.number, issuedAt: current.issuedAt, issuedByName: current.issuedByName }, images);
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PDF || bytes.subarray(0, 5).toString() !== '%PDF-') fail('resource-exhausted', 'PDF 생성 결과 또는 파일 크기를 확인해 주세요.');
      await context(request);
      try { await bucket.file(path).save(bytes, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: 'application/pdf', cacheControl: 'private, no-store', metadata: { companyId: user.companyId, documentId: ref.id, snapshotHash: current.snapshotHash, sha256: sha(bytes) } } }); }
      catch (error) { if (Number(error.code) !== 412) throw error; }
      object = await stored(path, MAX_PDF);
    }
    const metadata = object.meta.metadata || {};
    if (object.meta.contentType !== 'application/pdf' || metadata.companyId !== user.companyId || metadata.documentId !== ref.id || metadata.snapshotHash !== current.snapshotHash || metadata.sha256 !== object.descriptor.sha256) fail('failed-precondition', '발행 PDF의 연결 정보를 확인해 주세요.');
    const latest = await db.runTransaction(async tx => {
      await context(request, tx); const doc = await record(tx, ref, user.companyId);
      if (doc.snapshotHash !== current.snapshotHash || !['ISSUED', 'CANCELLED'].includes(doc.status)) fail('aborted', '발행 상태가 변경되었습니다. 다시 열어 주세요.');
      if (doc.pdf && D.hash(doc.pdf) !== D.hash(object.descriptor)) fail('failed-precondition', '보관 PDF 버전이 변경되었습니다.');
      if (!doc.pdf) tx.update(ref, { pdf: object.descriptor });
      return { ...doc, pdf: object.descriptor };
    });
    return { document: view(ref.id, latest), name: `${latest.status === 'CANCELLED' ? '취소된원본_' : ''}${latest.number}.pdf`, mimeType: 'application/pdf', base64: object.bytes.toString('base64') };
  }
  const audit = (tx, parent, user, id, action, extra = {}) => tx.create(parent.collection('erpAudit').doc(), { companyId: parent.id, actorId: user.uid, recordId: id, kind: 'ISSUED_DOCUMENT', action, at: now().toISOString(), ...extra });
  return async request => {
    const fields = { meta: [], saveProfile: ['profile', 'expectedVersion'], list: ['cursor','sourceDocumentNo'], get: ['id'], sources: ['documentNo', 'kind'],
      save: ['id', 'expectedRevision', 'input'], issue: ['id', 'expectedRevision', 'fingerprint', 'confirm'], pdf: ['id'], previewPdf: ['id', 'expectedRevision'],
      cancel: ['id', 'expectedRevision', 'reason', 'confirm'], revise: ['id', 'sourceId'] };
    const input = request.data;
    if (!input || !Object.hasOwn(fields, input.action)) fail('invalid-argument', '지원하지 않는 거래서류 요청입니다.');
    exactObject(input, ['action', 'companyId', ...fields[input.action]]);
    const user = await context(request), parent = db.doc(`companies/${user.companyId}`), collection = parent.collection('erpIssuedDocuments');
    if (input.action === 'meta') return db.runTransaction(async tx => {
      await context(request, tx); const s = await settings(tx, user.companyId);
      return { profile: { ...D.profileInput(Object.fromEntries(D.PROFILE_FIELDS.map(key => [key, s.profile[key]]))), version: s.profile.version },
        branding: publicSnapshot({ branding: brandingFor(s.official, s.profile, 'INVOICE', false) }).branding,
        companyNameEn: s.official.companyNameEn || '', canIssue: Boolean(s.official.companyName && s.official.address && s.official.representative && s.official.sealPath) };
    });
    if (input.action === 'saveProfile') {
      const values = D.profileInput(input.profile);
      return db.runTransaction(async tx => {
        await context(request, tx); const ref = parent.collection('erpPrintSettings').doc('profile'), old = await tx.get(ref);
        if (old.exists) master.verifyTenant(old.data(), user.companyId);
        checkRevision({ revision: old.data()?.version || 0 }, input.expectedVersion);
        const profile = { ...values, version: input.expectedVersion + 1, companyId: user.companyId, updatedAt: now().toISOString() };
        tx.set(ref, profile); audit(tx, parent, user, 'profile', 'UPDATE_PRINT_PROFILE'); return { profile: { ...values, version: profile.version } };
      });
    }
    if (input.action === 'list') return db.runTransaction(async tx => {
      if(input.sourceDocumentNo!==undefined){
        await context(request,tx);if(input.cursor)fail('invalid-argument','연결 문서 조회는 새로고침해 주세요.');
        const documentNo=text(input.sourceDocumentNo,'출고 문서번호',80,true);
        const found=await tx.get(collection.where('input.sourceDocumentNo','==',documentNo).limit(201));
        if(found.size>200)fail('resource-exhausted','연결 서류가 200건을 초과했습니다. 관리자에게 문의해 주세요.');
        found.docs.forEach(doc=>master.verifyTenant(doc.data(),user.companyId));
        return {documents:found.docs.map(doc=>view(doc.id,doc.data(),false)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||b.id.localeCompare(a.id)),cursor:null};
      }
      await context(request, tx); let query = collection.orderBy('updatedAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
      if (input.cursor) { exactObject(input.cursor, ['updatedAt', 'id']); query = query.startAfter(text(input.cursor.updatedAt, '목록 위치', 30, true), master.identifier(input.cursor.id)); }
      const result = await tx.get(query.limit(21)), selected = result.docs.slice(0, 20), last = selected.at(-1);
      selected.forEach(doc => master.verifyTenant(doc.data(), user.companyId));
      return { documents: selected.map(doc => view(doc.id, doc.data(), false)), cursor: result.size > 20 ? { updatedAt: last.data().updatedAt, id: last.id } : null };
    });
    if (input.action === 'sources') return db.runTransaction(async tx => {
      await context(request, tx); const type = D.kind(input.kind);
      if (type === 'PROFORMA') fail('invalid-argument', '견적은 출고 연결 없이 작성합니다.');
      const source = await sourceRows(tx, parent, text(input.documentNo, '출고 문서번호', 80, true), type);
      const partner = await record(tx, parent.collection('erpPartners').doc(master.identifier(source.registry.partnerId)), user.companyId);
      return { documentNo: source.registry.documentNo, date: source.registry.date, currency: source.registry.currency, partnerId: source.registry.partnerId, partnerName: partner.name,
        rows: source.rows.map(row => ({ id: row.id, code: row.code, name: row.name, specification: row.specification, unit: row.unit, price: row.priceScaled / 10000,
          quantity: row.quantityScaled / 10000, available: source.links.get(row.id).cancelledBy ? 0 : Math.max(0, row.quantityScaled - (source.links.get(row.id).returnedQuantityScaled || 0) - source.usages.get(row.id).quantityScaled) / 10000 })) };
    });
    const ref = refFor(user.companyId, input.id);
    if (input.action === 'get') return db.runTransaction(async tx => { await context(request, tx); return { document: view(ref.id, await record(tx, ref, user.companyId)) }; });
    if (input.action === 'pdf') return ensurePdf(request, ref);
    if (input.action === 'save') return db.runTransaction(async tx => {
      await context(request, tx); const old = (await tx.get(ref)).data();
      if (old) { master.verifyTenant(old, user.companyId); if (old.status !== 'DRAFT') fail('failed-precondition', '발행본은 수정할 수 없습니다. 취소 후 정정 초안을 작성해 주세요.'); }
      checkRevision(old, input.expectedRevision); const prepared = await plan(tx, parent, input.input, old);
      const timestamp = now().toISOString(), doc = { companyId: user.companyId, kind: prepared.input.kind, status: 'DRAFT', input: prepared.input,
        preview: prepared.snapshot, fingerprint: prepared.fingerprint, edition: old?.edition || 1, replacesId: old?.replacesId || '', replacesNumber: old?.replacesNumber || '',
        revision: input.expectedRevision + 1, createdAt: old?.createdAt || timestamp, createdBy: old?.createdBy || user.uid, updatedAt: timestamp, updatedBy: user.uid };
      if (old?.replacesId && old.kind !== prepared.input.kind) fail('invalid-argument', '정정본의 문서 종류는 변경할 수 없습니다.');
      tx.set(ref, doc); audit(tx, parent, user, ref.id, 'SAVE_DRAFT', { revision: doc.revision }); return { document: view(ref.id, doc) };
    });
    if (input.action === 'previewPdf') {
      const draft = await db.runTransaction(async tx => {
        await context(request, tx); const doc = await record(tx, ref, user.companyId); checkRevision(doc, input.expectedRevision);
        if (doc.status !== 'DRAFT') fail('failed-precondition', '초안만 미리볼 수 있습니다.');
        const prepared = await plan(tx, parent, doc.input, doc);
        if (prepared.fingerprint !== doc.fingerprint) fail('failed-precondition', '거래·설정이 변경되었습니다. 초안을 다시 저장해 주세요.');
        return { ...prepared.snapshot, number: 'DRAFT', draft: true, issuedAt: doc.createdAt, issuedByName: user.name || '' };
      });
      const bytes = await renderPdf(draft, {});
      if (bytes.length > MAX_PDF) fail('resource-exhausted', 'PDF 크기가 너무 큽니다. 문서를 나눠 주세요.');
      await db.runTransaction(async tx => { await context(request, tx); const current = await record(tx, ref, user.companyId); checkRevision(current, input.expectedRevision); if (current.status !== 'DRAFT') fail('aborted', '문서 상태가 변경되었습니다.'); });
      return { name: `초안_${draft.kind}.pdf`, mimeType: 'application/pdf', base64: bytes.toString('base64') };
    }
    if (input.action === 'issue') {
      if (input.confirm !== true) fail('invalid-argument', '금액·거래처·인감을 확인한 뒤 발행해 주세요.');
      const original = await record(db, ref, user.companyId);
      if (original.status === 'ISSUED') {
        if (original.issuedRevision !== input.expectedRevision || original.fingerprint !== input.fingerprint) fail('aborted', '다른 발행 요청입니다. 발행본을 다시 열어 주세요.');
        const ready = await ensurePdf(request, ref); return { document: ready.document, idempotent: true };
      }
      checkRevision(original, input.expectedRevision);
      if (original.status !== 'DRAFT' || !original.fingerprint || input.fingerprint !== original.fingerprint) fail('failed-precondition', '최신 초안을 저장·확인한 뒤 발행해 주세요.');
      if (!original.preview.branding.sealPath) fail('failed-precondition', '회사 서류 템플릿에서 법인 인감을 등록하고 초안을 다시 저장해 주세요.');
      const assets = { seal: await freezeAsset(original.preview.branding.sealPath, user.companyId) };
      if (original.preview.branding.logoPath) assets.logo = await freezeAsset(original.preview.branding.logoPath, user.companyId);
      const result = await db.runTransaction(async tx => {
        await context(request, tx); const current = await record(tx, ref, user.companyId);
        if (current.status === 'ISSUED' && current.issuedRevision === input.expectedRevision && current.fingerprint === input.fingerprint) return { document: view(ref.id, current), idempotent: true };
        checkRevision(current, input.expectedRevision);
        if (current.status !== 'DRAFT') fail('failed-precondition', '이미 처리한 문서입니다.');
        const prepared = await plan(tx, parent, current.input, current);
        if (prepared.fingerprint !== input.fingerprint) fail('failed-precondition', '거래·수량·공급자 설정이 변경되었습니다. 초안을 다시 저장해 주세요.');
        const year = prepared.input.issueDate.slice(0, 4), counterRef = parent.collection('erpIssueCounters').doc(`${current.kind}-${year}`), counter = (await tx.get(counterRef)).data();
        if (counter) master.verifyTenant(counter, user.companyId);
        const next = (counter?.last || 0) + 1;
        if (!Number.isSafeInteger(next) || next > 999999) fail('resource-exhausted', '해당 연도의 발행번호 범위를 초과했습니다.');
        const prefix = { PROFORMA: 'PI', INVOICE: 'INV', STATEMENT: 'TS' }[current.kind], number = `${prefix}-${year}-${String(next).padStart(6, '0')}`;
        const { sealPath, logoPath, ...branding } = prepared.snapshot.branding;
        const snapshot = { ...prepared.snapshot, branding: { ...branding, assets } }, timestamp = now().toISOString();
        const doc = { ...current, status: 'ISSUED', number, snapshot, snapshotHash: D.hash(snapshot), issuedRevision: current.revision,
          issuedAt: timestamp, issuedBy: user.uid, issuedByName: user.name || '', revision: current.revision + 1, updatedAt: timestamp, updatedBy: user.uid, pdf: null };
        for (const allocation of prepared.allocations) tx.set(usageRef(parent, current.kind, allocation.sourceId), { companyId: user.companyId,
          quantityScaled: allocation.used.quantityScaled + allocation.quantityScaled, supplyMinor: allocation.used.supplyMinor + allocation.supplyMinor,
          taxMinor: allocation.used.taxMinor + allocation.taxMinor });
        tx.set(counterRef, { companyId: user.companyId, last: next }); tx.set(ref, doc); audit(tx, parent, user, ref.id, 'ISSUE_DOCUMENT', { number });
        return { document: view(ref.id, doc), idempotent: false };
      });
      try { const ready = await ensurePdf(request, ref); return { ...result, document: ready.document }; }
      catch (error) {
        if (['permission-denied', 'unauthenticated'].includes(error.code)) throw error;
        await context(request);
        return { ...result, document: view(ref.id, await record(db, ref, user.companyId)), warning: '번호와 발행 내용은 저장되었습니다. PDF 생성·내려받기로 같은 발행본을 다시 생성해 주세요.' };
      }
    }
    if (input.action === 'cancel') {
      const reason = text(input.reason, '취소 사유', 500, true);
      if (reason.length < 3 || input.confirm !== true) fail('invalid-argument', '취소 사유 3자 이상과 확인이 필요합니다.');
      return db.runTransaction(async tx => {
        await context(request, tx); const doc = await record(tx, ref, user.companyId);
        if (doc.status === 'CANCELLED' && doc.cancelledRevision === input.expectedRevision && doc.cancelReason === reason) return { document: view(ref.id, doc), idempotent: true };
        checkRevision(doc, input.expectedRevision);
        if (doc.status !== 'ISSUED') fail('failed-precondition', '발행한 문서만 취소할 수 있습니다.');
        const rows = doc.kind === 'PROFORMA' ? [] : doc.snapshot.rows, refs = rows.map(row => usageRef(parent, doc.kind, row.sourceId));
        const used = refs.length ? await tx.getAll(...refs) : [];
        used.forEach((snapshot, index) => {
          const value = snapshot.data(), row = rows[index]; master.verifyTenant(value, user.companyId);
          const updated = Object.fromEntries(['quantityScaled', 'supplyMinor', 'taxMinor'].map(field => [field, value[field] - row[field]]));
          if (Object.values(updated).some(n => !Number.isSafeInteger(n) || n < 0)) fail('failed-precondition', '발행 수량·금액 연결을 확인해 주세요.');
          tx.set(snapshot.ref, { companyId: user.companyId, ...updated });
        });
        const docAfter = { ...doc, status: 'CANCELLED', cancelledRevision: doc.revision, revision: doc.revision + 1, cancelReason: reason,
          cancelledAt: now().toISOString(), cancelledBy: user.uid, updatedAt: now().toISOString(), updatedBy: user.uid };
        tx.set(ref, docAfter); audit(tx, parent, user, ref.id, 'CANCEL_DOCUMENT', { number: doc.number, reason }); return { document: view(ref.id, docAfter) };
      });
    }
    // A correction starts a new draft; the cancelled original and its PDF remain.
    const previousRef = refFor(user.companyId, input.sourceId);
    return db.runTransaction(async tx => {
      await context(request, tx); const previous = await record(tx, previousRef, user.companyId), existing = (await tx.get(ref)).data();
      if (existing) { master.verifyTenant(existing, user.companyId); if (existing.replacesId !== previousRef.id) fail('already-exists', '다른 문서 ID입니다.'); return { document: view(ref.id, existing) }; }
      if (previous.status !== 'CANCELLED' || previous.replacementId) fail('failed-precondition', '취소한 원본당 하나의 정정 초안을 만들 수 있습니다.');
      const timestamp = now().toISOString(), doc = { companyId: user.companyId, kind: previous.kind, status: 'DRAFT', edition: previous.edition + 1,
        input: previous.input, preview: null, fingerprint: '', replacesId: previousRef.id, replacesNumber: previous.number, revision: 1,
        createdAt: timestamp, updatedAt: timestamp, createdBy: user.uid, updatedBy: user.uid };
      tx.create(ref, doc); tx.update(previousRef, { replacementId: ref.id }); audit(tx, parent, user, ref.id, 'CREATE_REVISION', { replacesId: previousRef.id });
      return { document: view(ref.id, doc) };
    });
  };
}
module.exports = { createErpDocumentService: require('./erp-governance').governedService(createErpDocumentService,'documents') };
