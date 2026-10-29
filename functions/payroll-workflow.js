const { createHash, randomUUID } = require('node:crypto');
const { Timestamp } = require('firebase-admin/firestore');
const { authorizeContext, fail } = require('./security-context');
const { PAYROLL_MONEY_FIELDS, normalizePayrollRow, sumPayrollRows, validatePayrollRecord } = require('./payroll-report-model');
const { completePayrollAmounts } = require('./payroll-import-schema.mjs');

const ACTIONS = new Set(['importSource', 'startCorrection', 'listDrafts', 'getDraft', 'updateDraft', 'approveDraft', 'cancelDraft',
  'listDraftVersions', 'getDraftVersion', 'listRevisions', 'getRevision', 'sourceDownload']);
const COMPONENTS = ['monthlyGross', 'nonTaxable', 'pension', 'health', 'longTerm', 'employment', 'incomeTax', 'localTax', 'otherDeductions'];
const MAX_BYTES = 900 * 1024, MAX_SOURCE = 3 * 1024 * 1024;
const revisionId = number => 'r' + String(number).padStart(6, '0');
const versionId = number => 'v' + String(number).padStart(6, '0');
const text = (value, max = 1000, required = false) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || required && !value.trim()) fail('invalid-argument', '입력한 문구와 길이를 확인해 주세요.');
  return value.trim();
};
const nullableText = (value, max) => value == null ? '' : text(value, max);
function reasonText(value) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('invalid-argument', '사유는 3~1,000자로 입력해 주세요.');
  return value.trim();
}
function integer(value, label = '버전') { if (!Number.isSafeInteger(value) || value < 1) fail('invalid-argument', `${label} 값을 확인해 주세요.`); return value; }
function json(value) { return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry); }
const hash = value => createHash('sha256').update(json(value)).digest('hex');
const snapshotOnly = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'id'));
function bound(value) { if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) fail('resource-exhausted', '급여 자료가 한 문서의 저장 한도를 초과했습니다.'); }
function editableAmounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !PAYROLL_MONEY_FIELDS.includes(key))) fail('invalid-argument', '급여 금액 항목을 확인해 주세요.');
  if (COMPONENTS.some(field => field === 'otherDeductions' && value[field] === undefined ? false : !Number.isSafeInteger(value[field]))) fail('invalid-argument', '급여 금액은 정확한 원 단위 정수로 입력해 주세요.');
  try {
    const amounts = completePayrollAmounts(value, { validateTotals: true });
    if (PAYROLL_MONEY_FIELDS.some(field => value[field] !== undefined && value[field] !== amounts[field])) fail('invalid-argument', '급여 합계와 공제 금액이 일치하지 않습니다.');
    return amounts;
  } catch (error) { if (error.code === 'invalid-argument') fail('invalid-argument', error.message); throw error; }
}
function publicSource(source) {
  return source ? { name: source.name, mimeType: source.mimeType, size: source.size, sha256: source.sha256 } : undefined;
}
function partialLegacyTotals(record) {
  const values = {};
  for (const [key, field] of [['totalGross', 'monthlyGross'], ['totalNet', 'netPay'], ['totalDeductions', 'totalDeductions'], ['totalInsurance', 'totalInsurance']]) {
    if (Number.isSafeInteger(record?.[key])) values[field] = record[key];
  }
  return Object.keys(values).length ? values : null;
}
function diffRows(before, rows, legacyTotals = null) {
  const previous = new Map((before?.rows || []).map(row => [row.userId, row]));
  const next = new Map(rows.map(row => [row.userId, row]));
  const added = rows.filter(row => !previous.has(row.userId)).map(({ userId, name }) => ({ userId, name }));
  const removed = [...previous.values()].filter(row => !next.has(row.userId)).map(({ userId, name }) => ({ userId, name }));
  const changed = [];
  for (const row of rows) {
    const old = previous.get(row.userId); if (!old) continue;
    const fields = [];
    for (const field of ['name', 'employeeNumber', 'joinDate', 'resignDate', 'position', 'divisionName', 'teamName']) if ((old[field] || '') !== (row[field] || '')) fields.push({ field, before: old[field] || '', after: row[field] || '' });
    for (const field of PAYROLL_MONEY_FIELDS) if ((old.amounts[field] ?? 0) !== (row.amounts[field] ?? 0)) fields.push({ field, before: old.amounts[field] ?? 0, after: row.amounts[field] ?? 0 });
    if (fields.length) changed.push({ userId: row.userId, name: row.name, fields });
  }
  return { added, removed, changed, totals: { before: before?.sums || legacyTotals, after: sumPayrollRows(rows) } };
}

function createPayrollWorkflow({ db, bucket, now = () => new Date(), parseSourceFile }, hooks) {
  const { current, verifySession, recordSummary, payrollRecordId, identifier, inputShape, yearInput, monthInput,
    renderMonthlyPdf, branding, pdfFile } = hooks;
  const get = (reader, reference) => reader === db ? reference.get() : reader.get(reference);
  const draftRef = id => db.collection('payroll_drafts').doc(identifier(id));
  const recordRef = id => db.collection('payroll_records').doc(identifier(id));
  async function guard(request, user, reader = db) {
    const caller = await authorizeContext({ db, request, reader, now, roles: ['ADMIN'] });
    if (caller.uid !== user.uid || caller.companyId !== user.companyId || caller.role !== user.role) fail('permission-denied', '계정 또는 소속 회사가 변경되었습니다.');
    return caller;
  }
  async function period(reader, user, year, month) {
    const canonicalId = payrollRecordId(user.companyId, year, month);
    const query = db.collection('payroll_records').where('companyId', '==', user.companyId).where('year', '==', year).where('month', '==', month).limit(1001);
    const [docs, canonical] = await Promise.all([get(reader, query), get(reader, recordRef(canonicalId))]);
    if (docs.size > 1000) fail('resource-exhausted', '해당 월의 기존 급여 이력이 너무 많습니다.');
    const records = docs.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    if (canonical.exists) {
      const value = canonical.data();
      if (value.companyId !== user.companyId || value.year !== year || value.month !== month) fail('failed-precondition', '급여 문서 식별자의 충돌을 확인해 주세요.');
      if (!records.some(row => row.id === canonicalId)) records.push({ ...value, id: canonicalId });
    }
    const modern = records.filter(row => row.schemaVersion === 2).sort((a, b) => String(a.approvedAtIso || '').localeCompare(String(b.approvedAtIso || '')) || (a.revision || 1) - (b.revision || 1));
    const active = modern.find(row => row.id === canonicalId) || modern.at(-1) || null;
    if (active) { try { validatePayrollRecord(active, user.companyId); } catch { fail('failed-precondition', '기존 승인 급여 상세자료를 확인해 주세요.'); } }
    const legacy = records.filter(row => row.schemaVersion !== 2);
    const latestLegacy = [...legacy].sort((a, b) => String(a.approvedAtIso || a.approvedAt?.toDate?.().toISOString() || '').localeCompare(String(b.approvedAtIso || b.approvedAt?.toDate?.().toISOString() || ''))).at(-1);
    return { canonicalId, active, legacy, latestLegacy,
      fingerprint: hash(records.sort((a, b) => a.id.localeCompare(b.id))), revision: active?.revision || 0 };
  }
  function owned(data, user) { if (!data || data.companyId !== user.companyId) fail('not-found', '소속 회사의 급여 자료를 찾을 수 없습니다.'); return data; }
  async function loadDraft(reader, user, id) {
    const reference = draftRef(id), snapshot = await get(reader, reference);
    if (!snapshot.exists) fail('not-found', '급여 초안을 찾을 수 없습니다.');
    const draft = owned({ ...snapshot.data(), id: snapshot.id }, user);
    if (!['PENDING', 'APPROVED', 'CANCELLED'].includes(draft.status) || !Array.isArray(draft.rows)) fail('failed-precondition', '저장된 급여 초안 형식을 확인해 주세요.');
    return { reference, snapshot, draft };
  }
  function rowsChecked(rows, companyId) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 2000) fail('invalid-argument', '급여 대상은 1~2,000명으로 등록해 주세요.');
    try {
      const checked = rows.map(row => normalizePayrollRow(row, companyId));
      if (new Set(checked.map(row => row.userId)).size !== checked.length) throw new Error('duplicate');
      sumPayrollRows(checked); return checked;
    } catch { fail('invalid-argument', '직원별 급여 금액과 합계 또는 대상자 중복을 확인해 주세요.'); }
  }
  function dataHash(draft) { return hash({ companyId: draft.companyId, year: draft.year, month: draft.month, rows: draft.rows,
    kind: draft.kind, reason: draft.reason, source: publicSource(draft.source) || null }); }
  async function dto(user, draft, full = true, readonly = false) {
    const state = await period(db, user, draft.year, draft.month);
    const result = { id: draft.id, companyId: draft.companyId, year: draft.year, month: draft.month, status: draft.status,
      draftVersion: draft.draftVersion, kind: draft.kind, reason: draft.reason, sums: sumPayrollRows(draft.rows),
      employeeCount: draft.rows.length, baseRevision: draft.baseRevision, baseRecordId: draft.baseRecordId,
      baseFingerprint: draft.baseFingerprint, dataHash: dataHash(draft),
      createdAtIso: draft.createdAtIso, createdByName: draft.createdByName, updatedAtIso: draft.updatedAtIso,
      updatedByName: draft.updatedByName, stale: draft.status === 'PENDING' && state.fingerprint !== draft.baseFingerprint,
      ...(draft.source ? { source: publicSource(draft.source) } : {}), ...(readonly ? { readonly: true } : {}),
      ...(draft.promotedRevision ? { promotedRevision: draft.promotedRevision } : {}) };
    if (full) {
      const baseline = await draftRef(draft.id).collection('baseline').doc('original').get();
      if (!baseline.exists || baseline.data().companyId !== user.companyId) fail('failed-precondition', '초안의 기준 자료가 없습니다.');
      const before = baseline.data().record ? validatePayrollRecord(baseline.data().record, user.companyId) : null;
      result.rows = rowsChecked(draft.rows, user.companyId);
      result.diff = diffRows(before, result.rows, baseline.data().legacyTotals || null);
      if (Buffer.byteLength(JSON.stringify(result)) > 5 * 1024 * 1024) fail('resource-exhausted', '급여 검토 자료가 너무 큽니다.');
    }
    return result;
  }
  function versionSnapshot(draft) { const { id, ...data } = draft; return { ...data, companyId: draft.companyId, draftId: id }; }
  async function saveSource(user, id, parsed) {
    if (!bucket || !Buffer.isBuffer(parsed.buffer) || parsed.buffer.length < 1 || parsed.buffer.length > MAX_SOURCE || parsed.source.size !== parsed.buffer.length || createHash('sha256').update(parsed.buffer).digest('hex') !== parsed.source.sha256) fail('invalid-argument', '원본 파일 정보와 크기를 확인해 주세요.');
    const extension = /\.(xlsx|csv)$/i.exec(parsed.source.name)?.[1].toLowerCase();
    if (!extension) fail('invalid-argument', '지원하는 원본 파일 형식이 아닙니다.');
    const path = `companies/${user.companyId}/payroll-sources/${id}/${parsed.source.sha256}.${extension}`;
    const file = bucket.file(path);
    try {
      await file.save(parsed.buffer, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: parsed.source.mimeType,
        metadata: { companyId: user.companyId, draftId: id, sha256: parsed.source.sha256 } } });
      const [metadata] = await file.getMetadata();
      if (!/^[0-9]+$/.test(String(metadata.generation)) || Number(metadata.size) !== parsed.source.size) fail('internal', '원본 파일 저장을 확인하지 못했습니다.');
      return { ...parsed.source, storagePath: path, generation: String(metadata.generation), draftId: id };
    } catch (error) {
      try {
        const [metadata] = await file.getMetadata();
        if (metadata.metadata?.companyId === user.companyId && metadata.metadata?.draftId === id && metadata.metadata?.sha256 === parsed.source.sha256 && /^[0-9]+$/.test(String(metadata.generation))) {
          await bucket.file(path, { generation: String(metadata.generation) }).delete({ ifGenerationMatch: String(metadata.generation), ignoreNotFound: true });
        }
      } catch { console.error('[PayrollSourceCleanup] deferred'); }
      throw error;
    }
  }
  async function cleanupSource(source) {
    if (!source) return;
    try { await bucket.file(source.storagePath, { generation: source.generation }).delete({ ifGenerationMatch: source.generation, ignoreNotFound: true }); }
    catch { console.error('[PayrollSourceCleanup] deferred'); }
  }
  function mapImported(parsedRows, profiles, user, year, month) {
    const emails = new Map();
    for (const doc of profiles.docs) {
      const profile = doc.data();
      if (profile.companyId !== user.companyId || !['ADMIN', 'SUB_ADMIN', 'MEMBER'].includes(profile.role) || typeof profile.email !== 'string') continue;
      const key = profile.email.trim().toLowerCase();
      if (emails.has(key)) emails.set(key, null); else emails.set(key, doc.id);
    }
    return rowsChecked(parsedRows.map(row => {
      const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
      if (row.joinDate && row.joinDate > monthEnd || row.joinDate && row.resignDate && row.resignDate < row.joinDate) fail('invalid-argument', '원본의 입·퇴사일과 급여 귀속 월을 확인해 주세요.');
      const hasLogin = typeof row.employeeLoginId === 'string' && row.employeeLoginId.trim();
      const hasArchive = typeof row.archiveCode === 'string' && row.archiveCode.trim();
      if (Boolean(hasLogin) === Boolean(hasArchive)) fail('invalid-argument', '직원 로그인 ID 또는 과거 직원 관리코드 중 하나만 지정해 주세요.');
      let userId;
      if (hasLogin) {
        userId = emails.get(row.employeeLoginId.trim().toLowerCase());
        if (!userId) fail('invalid-argument', '파일의 직원 로그인 ID와 소속 회사 등록 정보를 확인해 주세요.');
      } else {
        const code = row.archiveCode.trim().normalize('NFC').toLowerCase();
        if (!/^[\p{L}\p{N}_.:-]{1,80}$/u.test(code)) fail('invalid-argument', '과거 직원 관리코드의 형식을 확인해 주세요.');
        userId = 'archive_' + hash([user.companyId, code]);
      }
      return { userId, companyId: user.companyId, name: row.name, employeeNumber: row.employeeNumber || '',
        joinDate: row.joinDate || '', resignDate: row.resignDate || '', position: row.position || '', divisionName: row.divisionName || '', teamName: row.teamName || '',
        amounts: editableAmounts(row.amounts), calculation: { mode: 'IMPORTED', tableSource: 'imported-source' } };
    }), user.companyId);
  }
  async function createDraft(request, user, kind) {
    const input = request.data;
    inputShape(input, kind === 'IMPORT' ? ['action', 'year', 'month', 'reason', 'source'] : ['action', 'recordId', 'reason']);
    const reason = reasonText(input.reason), id = randomUUID();
    let year, month, parsed, source;
    if (kind === 'IMPORT') {
      year = yearInput(input.year); month = monthInput(input.month);
      const kst = new Date(now().getTime() + 9 * 3600000);
      if (year * 12 + month > kst.getUTCFullYear() * 12 + kst.getUTCMonth() + 1) fail('invalid-argument', '과거 자료는 현재 귀속 월까지 등록할 수 있습니다.');
      try { parsed = await (parseSourceFile || require('./payroll-import-files').parsePayrollSourceFile)(input.source); }
      catch (error) { if (error.code === 'invalid-argument') fail('invalid-argument', error.message); throw error; }
      await current(request, user);
      source = await saveSource(user, id, parsed);
    } else {
      const original = await recordRef(input.recordId).get();
      if (!original.exists) fail('not-found', '급여 문서를 찾을 수 없습니다.');
      const record = owned(original.data(), user); year = yearInput(record.year); month = monthInput(record.month);
    }
    let committed = false;
    try {
      const draft = await db.runTransaction(async tx => {
        const caller = await guard(request, user, tx);
        const state = await period(tx, caller, year, month);
        let rows;
        if (kind === 'IMPORT') {
          const profiles = await tx.get(db.collection('UserProfile').where('companyId', '==', caller.companyId).limit(2001));
          if (profiles.size > 2000) fail('resource-exhausted', '직원 조회 한도를 초과했습니다.');
          rows = mapImported(parsed.rows, profiles, caller, year, month);
        } else {
          if (!state.active) fail('failed-precondition', '상세자료가 없는 집계 기록은 원본 파일을 가져와 보완해 주세요.');
          rows = rowsChecked(state.active.rows, caller.companyId);
          source = state.active.source || undefined;
        }
        const time = now().toISOString();
        const data = { companyId: caller.companyId, year, month, status: 'PENDING', draftVersion: 1, kind, reason, rows,
          sums: sumPayrollRows(rows), baseRevision: state.revision, baseRecordId: state.active?.id || state.latestLegacy?.id || '',
          canonicalRecordId: state.canonicalId, baseFingerprint: state.fingerprint,
          createdAtIso: time, createdBy: caller.uid, createdByName: nullableText(caller.name, 100), updatedAtIso: time,
          updatedBy: caller.uid, updatedByName: nullableText(caller.name, 100), ...(source ? { source } : {}) };
        data.dataHash = dataHash(data); bound(data);
        const baseline = { companyId: caller.companyId, draftId: id, record: state.active || null, legacyTotals: partialLegacyTotals(state.latestLegacy), baseFingerprint: state.fingerprint };
        bound(baseline); await verifySession(request);
        const reference = draftRef(id);
        tx.create(reference, data); tx.create(reference.collection('baseline').doc('original'), baseline);
        tx.create(reference.collection('versions').doc(versionId(1)), versionSnapshot({ ...data, id }));
        return { ...data, id };
      });
      committed = true;
      const result = await dto(user, draft); await current(request, user); return { draft: result };
    } catch (error) { if (kind === 'IMPORT' && !committed) await cleanupSource(source); throw error; }
  }
  async function resolveRevision(user, id, requested) {
    const root = await recordRef(id).get();
    if (!root.exists) fail('not-found', '급여 문서를 찾을 수 없습니다.');
    const data = owned(root.data(), user), revision = requested === undefined ? data.revision || 1 : integer(requested);
    const canonicalId = payrollRecordId(user.companyId, data.year, data.month);
    const head = canonicalId === id ? root : await recordRef(canonicalId).get();
    if (head.exists && (head.data().companyId !== user.companyId || head.data().year !== data.year || head.data().month !== data.month)) fail('failed-precondition', '급여 문서 식별자의 충돌을 확인해 주세요.');
    const reference = head.exists && head.data().schemaVersion === 2 ? head.ref : root.ref;
    const active = reference.path === root.ref.path ? data : owned(head.data(), user);
    const selected = requested === undefined ? active.revision || 1 : revision;
    const archived = await reference.collection('revisions').doc(revisionId(selected)).get();
    let snapshot;
    if (archived.exists) {
      const wrapper = owned(archived.data(), user);
      if (wrapper.recordId !== reference.id || wrapper.revision !== selected || !wrapper.snapshot || wrapper.dataHash !== hash(wrapper.snapshot)) fail('failed-precondition', '급여 개정 이력의 무결성을 확인해 주세요.');
      snapshot = wrapper.snapshot;
    } else if ((active.revision || 1) === selected) snapshot = active;
    else fail('not-found', '해당 개정의 승인 자료를 찾을 수 없습니다.');
    if (snapshot.schemaVersion !== 2) fail('failed-precondition', '기존 집계 자료에는 직원별 상세 PDF가 없습니다.');
    let checked;
    try { checked = validatePayrollRecord({ ...snapshot, id: reference.id }, user.companyId); }
    catch { fail('failed-precondition', '급여 개정 이력의 상세자료를 확인해 주세요.'); }
    return { raw: snapshot, checked, revision: selected, rootId: reference.id, fingerprint: hash(snapshot), activeRevision: active.revision || 1 };
  }
  function approvedWrapper(raw, user, id) {
    const snapshot = snapshotOnly(raw);
    return { companyId: user.companyId, recordId: id, revision: raw.revision || 1, snapshot,
      dataHash: hash(snapshot), summary: { ...recordSummary({ ...snapshot, id }, user.companyId), companyId: user.companyId,
        ...(raw.reason ? { reason: raw.reason } : {}), ...(raw.origin ? { origin: raw.origin } : {}),
        ...(raw.source ? { source: publicSource(raw.source) } : {}) } };
  }
  async function approve(request, user) {
    const input = request.data; inputShape(input, ['action', 'id', 'expectedDraftVersion']); const expected = integer(input.expectedDraftVersion);
    const result = await db.runTransaction(async tx => {
      const caller = await guard(request, user, tx), loaded = await loadDraft(tx, caller, input.id), draft = loaded.draft;
      if (draft.status === 'APPROVED' && draft.approvedFromDraftVersion === expected) {
        const archived = await tx.get(recordRef(draft.canonicalRecordId).collection('revisions').doc(revisionId(draft.promotedRevision)));
        const wrapper = owned(archived.data(), caller);
        if (!archived.exists || wrapper.recordId !== draft.canonicalRecordId || wrapper.revision !== draft.promotedRevision || wrapper.summary?.companyId !== caller.companyId || wrapper.dataHash !== hash(wrapper.snapshot)) fail('failed-precondition', '승인 결과를 확인하지 못했습니다.');
        await verifySession(request);
        return { record: wrapper.summary, draftId: draft.id, revision: draft.promotedRevision, idempotent: true };
      }
      if (draft.status !== 'PENDING' || draft.draftVersion !== expected) fail('aborted', '초안이 변경되었습니다. 저장된 최신 내용을 다시 확인해 주세요.');
      const state = await period(tx, caller, draft.year, draft.month);
      if (state.fingerprint !== draft.baseFingerprint || state.revision !== draft.baseRevision || dataHash(draft) !== draft.dataHash) fail('aborted', '기준 승인본 또는 초안이 변경되었습니다. 최신 승인본으로 새 초안을 작성해 주세요.');
      const rows = rowsChecked(draft.rows, caller.companyId), revision = state.revision + 1, reference = recordRef(state.canonicalId);
      const oldArchive = state.active ? await tx.get(reference.collection('revisions').doc(revisionId(state.revision))) : null;
      const newArchive = await tx.get(reference.collection('revisions').doc(revisionId(revision)));
      if (newArchive.exists) fail('aborted', '이미 사용된 개정 번호입니다. 다시 조회해 주세요.');
      const legacyRefs = state.legacy.map(record => ({ record, ref: reference.collection('legacySources').doc(hash([caller.companyId, record.id, hash(record)])) }));
      if (legacyRefs.length > 100) fail('resource-exhausted', '보관할 기존 집계 이력이 너무 많습니다.');
      const legacyDocs = await Promise.all(legacyRefs.map(({ ref }) => tx.get(ref)));
      for (const [index, snapshot] of legacyDocs.entries()) if (snapshot.exists) {
        const value = snapshot.data(), original = legacyRefs[index].record;
        if (value.companyId !== caller.companyId || value.recordId !== reference.id || value.legacyId !== original.id || value.dataHash !== hash(value.snapshot) || value.dataHash !== hash(original)) fail('failed-precondition', '기존 집계 이력의 무결성을 확인해 주세요.');
      }
      const approvedDate = now(), approvedAtIso = approvedDate.toISOString(), sums = sumPayrollRows(rows);
      const data = { schemaVersion: 2, scope: 'COMPANY', companyId: caller.companyId, year: draft.year, month: draft.month,
        rows, sums, revision, approvedAtIso, approvedAt: Timestamp.fromDate(approvedDate), approvedBy: caller.uid,
        approvedByName: nullableText(caller.name, 100), origin: draft.kind, reason: draft.reason, sourceDraftId: draft.id,
        taxTable: { source: draft.kind === 'IMPORT' ? 'imported-source' : 'manual-correction', version: '', fileName: draft.source?.name || '' },
        ...(draft.source ? { source: draft.source } : {}), previousHash: state.active ? hash(snapshotOnly(state.active)) : state.fingerprint,
        divisionId: 'ALL', divisionName: '전체 본부', employeeCount: rows.length, totalGross: sums.monthlyGross,
        totalNet: sums.netPay, totalDeductions: sums.totalDeductions, totalTax: sums.incomeTax + sums.localTax,
        totalInsurance: sums.totalInsurance, calculationBasis: 'APPROVED_SAVED_AMOUNTS', employmentProration: 'NOT_RECALCULATED' };
      if (!Number.isSafeInteger(data.totalTax)) fail('invalid-argument', '소득세·지방소득세 합계가 저장 범위를 초과했습니다.');
      data.dataHash = hash({ ...data, approvedAt: approvedAtIso }); bound(data);
      validatePayrollRecord({ ...data, id: reference.id }, caller.companyId);
      const finished = { ...draft, status: 'APPROVED', draftVersion: expected + 1, approvedFromDraftVersion: expected,
        promotedRevision: revision, updatedAtIso: approvedAtIso, updatedBy: caller.uid, updatedByName: data.approvedByName };
      const nextVersion = loaded.reference.collection('versions').doc(versionId(finished.draftVersion));
      const priorBytes = state.active ? Buffer.byteLength(JSON.stringify(state.active)) : 0;
      if (priorBytes + Buffer.byteLength(JSON.stringify(data)) * 3 + legacyRefs.reduce((size, { record }) => size + Buffer.byteLength(JSON.stringify(record)), 0) > 8 * 1024 * 1024) fail('resource-exhausted', '한 번에 승인·보관할 자료가 너무 큽니다.');
      if (oldArchive?.exists && (oldArchive.data().companyId !== caller.companyId || oldArchive.data().recordId !== reference.id ||
        oldArchive.data().dataHash !== hash(oldArchive.data().snapshot) || oldArchive.data().dataHash !== hash(snapshotOnly(state.active)))) fail('failed-precondition', '기존 개정 이력을 확인해 주세요.');
      await verifySession(request);
      if (state.active && !oldArchive.exists) tx.create(reference.collection('revisions').doc(revisionId(state.revision)), approvedWrapper(state.active, caller, reference.id));
      for (const [index, { ref, record }] of legacyRefs.entries()) if (!legacyDocs[index].exists) {
        const backup = { companyId: caller.companyId, recordId: reference.id, legacyId: record.id, snapshot: record, dataHash: hash(record) };
        bound(backup); tx.create(ref, backup);
      }
      const wrapper = approvedWrapper(data, caller, reference.id);
      tx.create(reference.collection('revisions').doc(revisionId(revision)), wrapper); tx.set(reference, data);
      const { id, ...finishedData } = finished;
      tx.set(loaded.reference, finishedData); tx.create(nextVersion, versionSnapshot(finished));
      return { record: wrapper.summary, draftId: id, revision, idempotent: false };
    });
    await current(request, user); return result;
  }
  async function edit(request, user, cancel = false) {
    const input = request.data; inputShape(input, cancel ? ['action', 'id', 'expectedDraftVersion', 'reason'] : ['action', 'id', 'expectedDraftVersion', 'reason', 'rows']);
    const expected = integer(input.expectedDraftVersion), reason = reasonText(input.reason);
    const draft = await db.runTransaction(async tx => {
      const caller = await guard(request, user, tx), { reference, draft: existing } = await loadDraft(tx, caller, input.id);
      if (existing.status !== 'PENDING' || existing.draftVersion !== expected) fail('aborted', '초안이 변경되었거나 검토가 종료되었습니다.');
      let rows = existing.rows;
      if (!cancel) {
        if (!Array.isArray(input.rows) || input.rows.length !== rows.length || new Set(input.rows.map(row => row?.userId)).size !== rows.length) fail('invalid-argument', '기존 대상자 전원의 금액을 지정해 주세요. 대상 추가·삭제는 원본을 새로 가져와 처리합니다.');
        const updates = new Map(input.rows.map(row => {
          if (!row || Object.keys(row).some(key => !['userId', 'amounts'].includes(key))) fail('invalid-argument', '급여 수정 항목을 확인해 주세요.');
          return [identifier(row.userId), editableAmounts(row.amounts)];
        }));
        if (rows.some(row => !updates.has(row.userId))) fail('invalid-argument', '다른 대상자의 급여를 주입할 수 없습니다.');
        rows = rows.map(row => {
          const amounts = updates.get(row.userId);
          if (PAYROLL_MONEY_FIELDS.every(field => (row.amounts[field] ?? 0) === amounts[field])) return row;
          return { ...row, amounts, calculation: { mode: 'ADJUSTED', tableSource: 'manual-correction' } };
        });
        rows = rowsChecked(rows, caller.companyId);
      }
      const data = { ...existing, rows, sums: sumPayrollRows(rows), reason, status: cancel ? 'CANCELLED' : 'PENDING',
        draftVersion: expected + 1, updatedAtIso: now().toISOString(), updatedBy: caller.uid, updatedByName: nullableText(caller.name, 100) };
      data.dataHash = dataHash(data); const { id, ...stored } = data; bound(stored); await verifySession(request);
      tx.set(reference, stored); tx.create(reference.collection('versions').doc(versionId(data.draftVersion)), versionSnapshot(data));
      return { ...stored, id };
    });
    const result = await dto(user, draft); await current(request, user); return { draft: result };
  }
  async function sourceDownload(request, user) {
    const input = request.data;
    inputShape(input, input.draftId !== undefined ? ['action', 'draftId'] : ['action', 'recordId', 'revision']);
    let source, initial, readAgain;
    if (input.draftId !== undefined) {
      const loaded = await loadDraft(db, user, input.draftId); source = loaded.draft.source; initial = hash(loaded.snapshot.data());
      readAgain = async () => { const latest = await loadDraft(db, user, input.draftId); return hash(latest.snapshot.data()); };
    } else {
      const selected = await resolveRevision(user, identifier(input.recordId), input.revision); source = selected.raw.source; initial = selected.fingerprint;
      readAgain = async () => (await resolveRevision(user, input.recordId, input.revision)).fingerprint;
    }
    if (!source) fail('not-found', '보관된 원본 파일이 없습니다.');
    if (!bucket) fail('failed-precondition', '원본 파일 저장소를 사용할 수 없습니다.');
    const extension = /\.(xlsx|csv)$/i.exec(source.name || '')?.[1].toLowerCase();
    const path = `companies/${user.companyId}/payroll-sources/${identifier(source.draftId)}/${source.sha256}.${extension}`;
    if (!extension || !/^[a-f0-9]{64}$/.test(source.sha256) || source.storagePath !== path || !/^[0-9]+$/.test(source.generation) || !Number.isSafeInteger(source.size) || source.size < 1 || source.size > MAX_SOURCE) fail('failed-precondition', '원본 파일 경로와 저장 정보를 확인해 주세요.');
    const file = bucket.file(path, { generation: source.generation });
    const storageRead = async operation => {
      try { return await operation(); }
      catch (error) { if ([404, 409, 412].includes(Number(error.code))) fail('failed-precondition', '보관된 원본 파일의 저장 세대를 확인해 주세요.'); throw error; }
    };
    const [metadata] = await storageRead(() => file.getMetadata());
    if (String(metadata.generation) !== source.generation || Number(metadata.size) !== source.size || metadata.contentType !== source.mimeType || metadata.metadata?.companyId !== user.companyId || metadata.metadata?.draftId !== source.draftId || metadata.metadata?.sha256 !== source.sha256) fail('failed-precondition', '원본 파일의 저장 세대와 소속 정보를 확인해 주세요.');
    const [bytes] = await storageRead(() => file.download({ validation: 'crc32c' }));
    if (!Buffer.isBuffer(bytes) || bytes.length !== source.size || createHash('sha256').update(bytes).digest('hex') !== source.sha256) fail('failed-precondition', '원본 파일의 내용이 변경되었습니다.');
    await current(request, user); if (await readAgain() !== initial) fail('aborted', '원본 파일의 급여 자료가 변경되었습니다. 다시 조회해 주세요.');
    const [latestMetadata] = await storageRead(() => file.getMetadata());
    if (String(latestMetadata.generation) !== source.generation || latestMetadata.metadata?.sha256 !== source.sha256) fail('aborted', '원본 파일이 변경되었습니다.');
    await current(request, user);
    return { filename: source.name, mimeType: source.mimeType, base64: bytes.toString('base64'), sha256: source.sha256, size: source.size };
  }

  return async (request, user) => {
    const input = request.data;
    if (!ACTIONS.has(input?.action) && !(input?.action === 'monthlyPdf' && input.revision !== undefined)) return null;
    if (input.action === 'importSource') return createDraft(request, user, 'IMPORT');
    if (input.action === 'startCorrection') return createDraft(request, user, 'CORRECTION');
    if (input.action === 'approveDraft') return approve(request, user);
    if (input.action === 'updateDraft' || input.action === 'cancelDraft') return edit(request, user, input.action === 'cancelDraft');
    if (input.action === 'sourceDownload') return sourceDownload(request, user);
    if (input.action === 'listDrafts') {
      inputShape(input, ['action', 'year']); const year = yearInput(input.year);
      const docs = await db.collection('payroll_drafts').where('companyId', '==', user.companyId).where('year', '==', year).limit(101).get();
      if (docs.size > 100) fail('resource-exhausted', '해당 연도의 초안이 너무 많습니다.');
      const drafts = [];
      for (const doc of docs.docs) drafts.push(await dto(user, owned({ ...doc.data(), id: doc.id }, user), false));
      await current(request, user); return { drafts: drafts.sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso)) };
    }
    if (['getDraft', 'getDraftVersion', 'listDraftVersions'].includes(input.action)) {
      inputShape(input, input.action === 'getDraftVersion' ? ['action', 'id', 'draftVersion'] : ['action', 'id']);
      const loaded = await loadDraft(db, user, input.id);
      if (input.action === 'listDraftVersions') {
        const docs = await loaded.reference.collection('versions').select('companyId', 'draftId', 'draftVersion', 'status', 'reason', 'updatedAtIso', 'updatedByName', 'sums').limit(1001).get();
        if (docs.size > 1000) fail('resource-exhausted', '초안 변경 이력이 너무 많습니다.');
        const versions = docs.docs.map(doc => {
          const value = owned(doc.data(), user);
          if (value.draftId !== loaded.draft.id || !Number.isSafeInteger(value.draftVersion) || value.draftVersion < 1) fail('failed-precondition', '초안 변경 이력의 소속을 확인해 주세요.');
          return value;
        }).sort((a, b) => b.draftVersion - a.draftVersion);
        await current(request, user); return { versions };
      }
      let draft = loaded.draft;
      if (input.action === 'getDraftVersion') {
        const doc = await loaded.reference.collection('versions').doc(versionId(integer(input.draftVersion))).get();
        if (!doc.exists) fail('not-found', '저장된 초안 버전을 찾을 수 없습니다.');
        draft = owned({ ...doc.data(), id: loaded.draft.id }, user);
        if (draft.draftId !== loaded.draft.id || draft.draftVersion !== input.draftVersion) fail('failed-precondition', '초안 변경 이력을 확인해 주세요.');
      }
      const result = await dto(user, draft, true, input.action === 'getDraftVersion');
      await current(request, user); return { draft: result };
    }
    if (input.action === 'listRevisions') {
      inputShape(input, ['action', 'id']);
      const original = await recordRef(input.id).get();
      if (!original.exists) fail('not-found', '급여 문서를 찾을 수 없습니다.');
      const originalData = owned(original.data(), user);
      const state = await period(db, user, originalData.year, originalData.month);
      if (!state.active) {
        const revisions = state.legacy.map(snapshot => ({ id: snapshot.id, companyId: user.companyId, year: snapshot.year, month: snapshot.month,
          kind: 'LEGACY', revision: 0, legacy: true, pdfAvailable: false, active: false, totals: partialLegacyTotals(snapshot),
          approvedByName: nullableText(snapshot.approvedByName, 100) }));
        await current(request, user); return { revisions };
      }
      const selected = await resolveRevision(user, identifier(input.id)); const reference = recordRef(selected.rootId);
      const [docs, old] = await Promise.all([reference.collection('revisions').select('companyId', 'recordId', 'revision', 'summary').limit(1001).get(),
        reference.collection('legacySources').limit(1001).get()]);
      if (docs.size > 1000 || old.size > 1000) fail('resource-exhausted', '급여 개정 이력이 너무 많습니다.');
      const revisions = docs.docs.map(doc => { const row = owned(doc.data(), user);
        if (row.recordId !== reference.id || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.summary?.companyId !== user.companyId || row.summary?.id !== reference.id || row.summary?.revision !== row.revision) fail('failed-precondition', '급여 개정 목록의 소속을 확인해 주세요.');
        return { ...row.summary, companyId: user.companyId,
        kind: 'APPROVED', revision: row.revision, active: row.revision === selected.activeRevision, pdfAvailable: true }; });
      if (!revisions.some(row => row.revision === selected.revision)) revisions.push({ ...recordSummary({ ...selected.raw, id: selected.rootId }, user.companyId),
        kind: 'APPROVED', active: true, pdfAvailable: true });
      for (const doc of old.docs) {
        const row = owned(doc.data(), user), snapshot = row.snapshot;
        if (row.recordId !== reference.id || row.dataHash !== hash(snapshot)) fail('failed-precondition', '기존 집계 이력의 무결성을 확인해 주세요.');
        revisions.push({ id: doc.id, legacyRecordId: row.legacyId, companyId: user.companyId, year: snapshot.year, month: snapshot.month, kind: 'LEGACY', revision: 0,
          legacy: true, pdfAvailable: false, active: false, totals: partialLegacyTotals(snapshot), approvedByName: nullableText(snapshot.approvedByName, 100) });
      }
      await current(request, user); return { revisions: revisions.sort((a, b) => b.revision - a.revision) };
    }
    inputShape(input, ['action', 'id', 'revision']);
    const selected = await resolveRevision(user, identifier(input.id), input.revision);
    if (input.action === 'getRevision') { await current(request, user); return { record: { ...selected.checked, active: selected.revision === selected.activeRevision } }; }
    const bytes = await renderMonthlyPdf(selected.checked, branding(user));
    await current(request, user);
    const latest = await resolveRevision(user, input.id, input.revision);
    if (latest.fingerprint !== selected.fingerprint) fail('aborted', '급여 개정본이 변경되었습니다. 다시 조회해 주세요.');
    await current(request, user);
    return pdfFile(bytes, `${selected.checked.year}년_${String(selected.checked.month).padStart(2, '0')}월_급여대장_개정${selected.revision}.pdf`);
  };
}

module.exports = { createPayrollWorkflow, editableAmounts, diffRows };
