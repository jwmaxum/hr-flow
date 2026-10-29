const { createHash } = require('node:crypto');
const { Timestamp } = require('firebase-admin/firestore');
const { authorizeContext, fail } = require('./security-context');
const { createPayrollCalculator } = require('./payroll-calculation.mjs');
const officialTable = require('./data/withholdingTaxTable2026.json');
const { createPayrollWorkflow } = require('./payroll-workflow');
const {
  normalizePayrollIdentity, normalizePayrollRow, sumPayrollRows, validatePayrollRecord, buildAnnualPayrollReport,
} = require('./payroll-report-model');

const MAX_EMPLOYEES = 2000;
const MAX_RECORDS = 1000;
const MAX_SNAPSHOT_BYTES = 900 * 1024;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const safeText = (value, max = 120) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
function dateOnly(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('failed-precondition', '직원의 입·퇴사일 설정을 확인해 주세요.');
  const parsed = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('failed-precondition', '직원의 입·퇴사일 설정을 확인해 주세요.');
  return value;
}
function yearInput(value) {
  if (!Number.isInteger(value) || value < 2000 || value > 2200) fail('invalid-argument', '급여 연도를 확인해 주세요.');
  return value;
}
function monthInput(value) {
  if (!Number.isInteger(value) || value < 1 || value > 12) fail('invalid-argument', '급여 월을 확인해 주세요.');
  return value;
}
function identifier(value) {
  if (!validId(value)) fail('invalid-argument', '급여 문서 또는 직원 ID를 확인해 주세요.');
  return value;
}
function inputShape(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) {
    fail('invalid-argument', '급여 요청의 입력 항목을 확인해 주세요.');
  }
}
function payrollRecordId(companyId, year, month) {
  return 'payroll-' + createHash('sha256').update(JSON.stringify([companyId, year, month])).digest('hex');
}
function snapshotData(snapshot) { return { ...snapshot.data(), id: snapshot.id }; }
function canonicalJson(value) {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
}
function fingerprint(snapshot) {
  const values = snapshot.docs ? snapshot.docs.map(doc => [doc.id, doc.data()]).sort((a, b) => a[0].localeCompare(b[0])) : snapshot.exists ? snapshot.data() : null;
  return createHash('sha256').update(canonicalJson(values)).digest('hex');
}
function approvalIso(record) {
  if (typeof record.approvedAtIso === 'string' && Number.isFinite(Date.parse(record.approvedAtIso))) return new Date(record.approvedAtIso).toISOString();
  if (record.approvedAt && typeof record.approvedAt.toDate === 'function') return record.approvedAt.toDate().toISOString();
  if (Number.isFinite(record.approvedAt?.seconds)) return new Date(record.approvedAt.seconds * 1000).toISOString();
  return '';
}
function recordSummary(record, companyId) {
  if (record.companyId !== companyId || !validId(record.id)) fail('permission-denied', '소속 회사의 급여 문서만 조회할 수 있습니다.');
  yearInput(record.year); monthInput(record.month);
  if (record.schemaVersion === 2) {
    let checked;
    try { checked = validatePayrollRecord(record, companyId); }
    catch { fail('failed-precondition', '승인 급여 상세자료의 형식을 확인해 주세요.'); }
    const extra = record.taxTable || {};
    return { id: checked.id, companyId, year: checked.year, month: checked.month, schemaVersion: 2, legacy: false,
      employeeCount: checked.rows.length, approvedAtIso: checked.approvedAtIso, approvedByName: checked.approvedByName,
      revision: checked.revision, totalGross: checked.sums.monthlyGross, totalNet: checked.sums.netPay,
      totalDeductions: checked.sums.totalDeductions, sums: checked.sums,
      ...(checked.origin ? { origin: checked.origin } : {}), ...(checked.reason ? { reason: checked.reason } : {}),
      ...(checked.source ? { source: checked.source } : {}), ...(checked.dataHash ? { dataHash: checked.dataHash } : {}),
      taxTable: { ...checked.taxTable, uploadedInvalid: extra.uploadedInvalid === true,
        fallbackReason: safeText(extra.fallbackReason, 300), highIncomeSource: safeText(extra.highIncomeSource, 80) } };
  }
  // Keep the old aggregate values, but never turn them into employee amounts.
  if (![record.totalGross, record.totalNet].every(Number.isSafeInteger) || record.totalGross < 0 ||
      !Number.isInteger(record.employeeCount) || record.employeeCount < 0) {
    fail('failed-precondition', '기존 급여 집계자료의 금액과 인원 정보를 확인해 주세요.');
  }
  return { id: record.id, companyId, year: record.year, month: record.month, schemaVersion: 1, legacy: true,
    employeeCount: record.employeeCount, totalGross: record.totalGross, totalNet: record.totalNet,
    ...(Number.isSafeInteger(record.totalDeductions) ? { totalDeductions: record.totalDeductions } : {}),
    approvedAtIso: approvalIso(record), approvedByName: safeText(record.approvedByName, 100) };
}

function createPayrollService({ db, auth, bucket, now = () => new Date(), parseSourceFile,
  calculator = createPayrollCalculator(officialTable), renderMonthlyPdf, renderAnnualPdf }) {
  const authorize = request => authorizeContext({ db, request, now, roles: ['ADMIN'] });
  async function verifySession(request) {
    if (!request.auth?.uid) fail('unauthenticated', '로그인이 필요합니다.');
    const bearer = /^Bearer ([^\s]+)$/.exec(request.rawRequest?.headers?.authorization || '');
    if (!bearer || typeof auth?.verifyIdToken !== 'function') fail('unauthenticated', '로그인을 다시 확인해 주세요.');
    try {
      const decoded = await auth.verifyIdToken(bearer[1], true);
      if (decoded.uid !== request.auth.uid) throw new Error('identity');
    } catch { fail('unauthenticated', '로그인을 다시 확인해 주세요.'); }
  }
  async function current(request, original) {
    await verifySession(request);
    const user = await authorize(request);
    if (original && (user.uid !== original.uid || user.companyId !== original.companyId || user.role !== original.role)) {
      fail('permission-denied', '계정 또는 소속 회사가 변경되었습니다. 다시 조회해 주세요.');
    }
    return user;
  }
  const profilesQuery = companyId => db.collection('UserProfile').where('companyId', '==', companyId).limit(MAX_EMPLOYEES + 1);
  const historyQuery = (companyId, year) => db.collection('payroll_records').where('companyId', '==', companyId).where('year', '==', year).limit(MAX_RECORDS + 1);
  const scopedMap = (snapshot, companyId) => new Map(snapshot.docs.filter(doc => doc.data().companyId === companyId).map(doc => [doc.id, doc.data()]));
  function identity(profile, uid, companyId, divisions = new Map(), teams = new Map()) {
    if (profile.companyId !== companyId || !validId(uid)) fail('permission-denied', '소속 회사의 직원만 처리할 수 있습니다.');
    const team = teams.get(profile.teamId);
    const division = divisions.get(profile.divisionId);
    return normalizePayrollIdentity({ userId: uid, companyId, name: safeText(profile.name, 100),
      employeeNumber: safeText(profile.employeeNumber, 80), joinDate: dateOnly(profile.joinDate), resignDate: dateOnly(profile.resignDate),
      position: safeText(profile.position, 100), divisionName: safeText(division?.name), teamName: safeText(team?.name) }, companyId);
  }
  function limited(snapshot, maximum, message) { if (snapshot.size > maximum) fail('resource-exhausted', message); }
  function validatedRows(profiles, divisions, teams, companyId, period, table) {
    const monthEnd = new Date(Date.UTC(period.year, period.month, 0)).toISOString().slice(0, 10);
    const rows = [];
    for (const doc of profiles.docs) {
      const profile = doc.data();
      if (profile.companyId !== companyId || !['ADMIN', 'SUB_ADMIN', 'MEMBER'].includes(profile.role) || profile.status === 'RESIGNED') continue;
      if (dateOnly(profile.joinDate) > monthEnd) continue;
      if (profile.isSeveranceIncluded === true) fail('failed-precondition', '기존 퇴직급여 포함 설정의 급여 금액을 확인하고 설정을 저장해 주세요.');
      const salary = profile.annualSalary ?? 0;
      if (!Number.isSafeInteger(salary) || salary < 0) fail('failed-precondition', '직원의 저장된 급여 금액을 확인해 주세요.');
      let result;
      try { result = calculator.calculateNetPay({ ...profile, annualSalary: salary, currentVal: salary, isSeveranceIncluded: false }, table, period); }
      catch { fail('failed-precondition', '직원의 급여와 공제 설정을 확인해 주세요.'); }
      const policy = result || calculator.calculateNetPay({ annualSalary: 12, nonTaxable: 0 }, table, period);
      if (policy?.metadata?.policyPeriodSupported !== true) fail('failed-precondition', '선택한 기간은 현재 세액·보험 기준으로 확정할 수 없습니다. 지원하는 급여 기준을 확인해 주세요.');
      const nonTaxable = result ? Math.min(result.monthlyGross, result.nonTaxable) : 0;
      const amounts = result ? { monthlyGross: result.monthlyGross, basePay: result.monthlyGross - nonTaxable, nonTaxable,
        pension: result.pension, health: result.health, longTerm: result.longTerm, employment: result.employment,
        incomeTax: result.incomeTax, localTax: result.localTax, totalInsurance: result.totalInsurance,
        totalDeductions: result.totalDeductions, netPay: result.netPay } : Object.fromEntries([
        'monthlyGross', 'basePay', 'nonTaxable', 'pension', 'health', 'longTerm', 'employment', 'incomeTax', 'localTax', 'totalInsurance', 'totalDeductions', 'netPay',
      ].map(field => [field, 0]));
      const counts = calculator.getDeductionCounts(profile);
      try { rows.push(normalizePayrollRow({ ...identity(profile, doc.id, companyId, divisions, teams), amounts,
        calculation: { dependents: counts.dependents, children: counts.children,
          tableSource: result?.metadata.tableSource || policy.metadata.tableSource } }, companyId)); }
      catch { fail('failed-precondition', '직원의 급여 상세 설정을 확인해 주세요.'); }
    }
    if (!rows.length) fail('failed-precondition', '승인할 재직 직원이 없습니다.');
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.userId.localeCompare(b.userId));
  }
  async function readHistory(companyId, year) {
    const snapshot = await historyQuery(companyId, year).get();
    limited(snapshot, MAX_RECORDS, '해당 연도의 급여 이력이 너무 많습니다. 관리자에게 문의해 주세요.');
    return snapshot;
  }
  async function pdfFile(bytes, filename) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.subarray(0, 5).toString() !== '%PDF-') fail('internal', '급여 PDF를 생성하지 못했습니다.');
    if (bytes.length > MAX_PDF_BYTES) fail('resource-exhausted', 'PDF가 너무 큽니다. 관리자에게 문의해 주세요.');
    return { filename, mimeType: 'application/pdf', base64: bytes.toString('base64') };
  }
  const branding = user => ({ companyName: safeText(user.company.nameKo || user.company.nameEn, 120) || '회사',
    address: safeText(user.company.address, 300), representative: safeText(user.company.representative, 100) });

  async function prepareApproval(transaction, request, user, period) {
    const caller = await authorizeContext({ db, request, reader: transaction, now, roles: ['ADMIN'] });
    if (caller.companyId !== user.companyId || caller.role !== user.role) fail('permission-denied', '계정 또는 소속 회사가 변경되었습니다.');
    const id = payrollRecordId(caller.companyId, period.year, period.month);
    const reference = db.collection('payroll_records').doc(id);
    const [existing, profiles, divisionDocs, teamDocs, taxDoc] = await Promise.all([
      transaction.get(reference), transaction.get(profilesQuery(caller.companyId)),
      transaction.get(db.collection('divisions').where('companyId', '==', caller.companyId)),
      transaction.get(db.collection('teams').where('companyId', '==', caller.companyId)),
      transaction.get(db.collection('system_config').doc('tax_table')),
    ]);
    if (existing.exists) fail('already-exists', '해당 월의 급여대장이 이미 승인되었습니다. 승인된 PDF와 이력을 확인해 주세요.');
    limited(profiles, MAX_EMPLOYEES, '승인 대상 직원이 너무 많아 한 문서에 저장할 수 없습니다. 관리자에게 문의해 주세요.');
    const table = taxDoc.exists ? taxDoc.data() : null;
    const tableStatus = calculator.getTaxTableStatus(table);
    const rows = validatedRows(profiles, scopedMap(divisionDocs, caller.companyId), scopedMap(teamDocs, caller.companyId), caller.companyId, period, table);
    let sums;
    try { sums = sumPayrollRows(rows); }
    catch { fail('failed-precondition', '급여 합계가 정확하게 계산할 수 있는 금액 범위를 초과했습니다. 저장된 급여 설정을 확인해 주세요.'); }
    const taxTable = { source: tableStatus.source, version: safeText(tableStatus.updateDate || tableStatus.effectiveFrom, 100),
      fileName: safeText(tableStatus.fileName, 240), highIncomeSource: safeText(tableStatus.highIncomeSource, 80),
      uploadedInvalid: table != null && !tableStatus.valid, fallbackReason: safeText(tableStatus.reason, 300) };
    // Exclude the approval time so a confirmation can be compared against fresh transactional reads.
    const expected = createHash('sha256').update(canonicalJson({ companyId: caller.companyId, ...period, rows, taxTable,
      taxDocument: fingerprint(taxDoc),
      calculationBasis: 'FULL_MONTH_SAVED_SETTINGS', employmentProration: 'NOT_APPLIED' })).digest('hex');
    return { id, reference, caller, rows, sums, taxTable, fingerprint: expected };
  }

  const workflow = createPayrollWorkflow({ db, auth, bucket, now, parseSourceFile }, { current, verifySession, recordSummary,
    payrollRecordId, identifier, inputShape, yearInput, monthInput, renderMonthlyPdf, branding, pdfFile });

  return async request => {
    const user = await current(request);
    const input = request.data;
    const handled = await workflow(request, user);
    if (handled !== null) return handled;
    if (input?.action === 'preview' || input?.action === 'approve') {
      inputShape(input, input.action === 'preview' ? ['action', 'year', 'month'] : ['action', 'year', 'month', 'expectedFingerprint']);
      const period = { year: yearInput(input.year), month: monthInput(input.month) };
      if (input.action === 'approve' && (typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint))) {
        fail('invalid-argument', '급여 승인 전 최신 미리보기를 확인해 주세요.');
      }
      const record = await db.runTransaction(async transaction => {
        const prepared = await prepareApproval(transaction, request, user, period);
        const { id, reference, caller, rows, sums, taxTable } = prepared;
        if (input.action === 'preview') return { fingerprint: prepared.fingerprint, employeeCount: rows.length,
          totalGross: sums.monthlyGross, totalNet: sums.netPay, totalDeductions: sums.totalDeductions,
          zeroCount: rows.filter(row => row.amounts.monthlyGross === 0).length, taxTable };
        if (prepared.fingerprint !== input.expectedFingerprint) {
          fail('aborted', '직원의 저장된 급여 설정 또는 세액표가 변경되었습니다. 최신 미리보기를 확인한 뒤 다시 승인해 주세요.');
        }
        const approvedDate = now();
        const data = { schemaVersion: 2, scope: 'COMPANY', companyId: caller.companyId, ...period, rows,
          sums, approvedAtIso: approvedDate.toISOString(), approvedAt: Timestamp.fromDate(approvedDate),
          approvedBy: caller.uid, approvedByName: safeText(caller.name, 100), revision: 1,
          taxTable,
          calculationBasis: 'FULL_MONTH_SAVED_SETTINGS', employmentProration: 'NOT_APPLIED',
          divisionId: 'ALL', divisionName: '전체 본부', employeeCount: rows.length,
        };
        Object.assign(data, { totalGross: data.sums.monthlyGross, totalNet: data.sums.netPay, totalDeductions: data.sums.totalDeductions,
          totalTax: data.sums.incomeTax + data.sums.localTax, totalInsurance: data.sums.totalInsurance });
        try { validatePayrollRecord({ ...data, id }, caller.companyId); }
        catch { fail('failed-precondition', '급여 상세자료의 합계와 설정을 확인해 주세요.'); }
        if (Buffer.byteLength(JSON.stringify(data)) > MAX_SNAPSHOT_BYTES) fail('resource-exhausted', '급여 상세자료가 한 문서의 저장 한도를 초과했습니다. 관리자에게 문의해 주세요.');
        await verifySession(request);
        transaction.create(reference, data);
        return { ...data, id };
      });
      await current(request, user);
      return input.action === 'preview' ? record : { record: recordSummary(record, user.companyId) };
    }
    if (input?.action === 'list') {
      inputShape(input, ['action', 'year']);
      const year = yearInput(input.year);
      const [history, profiles, divisions, teams] = await Promise.all([
        readHistory(user.companyId, year), profilesQuery(user.companyId).get(),
        db.collection('divisions').where('companyId', '==', user.companyId).get(),
        db.collection('teams').where('companyId', '==', user.companyId).get(),
      ]);
      limited(profiles, MAX_EMPLOYEES, '조회 대상 직원이 너무 많습니다. 관리자에게 문의해 주세요.');
      const records = history.docs.map(doc => recordSummary(snapshotData(doc), user.companyId)).sort((a, b) =>
        b.month - a.month || b.approvedAtIso.localeCompare(a.approvedAtIso) || b.id.localeCompare(a.id));
      const identities = new Map();
      const divisionMap = scopedMap(divisions, user.companyId), teamMap = scopedMap(teams, user.companyId);
      for (const doc of history.docs) {
        if (doc.data().schemaVersion !== 2) continue;
        const record = validatePayrollRecord(snapshotData(doc), user.companyId);
        for (const row of record.rows) identities.set(row.userId, normalizePayrollIdentity(row, user.companyId));
      }
      for (const doc of profiles.docs) {
        const profile = doc.data();
        if (profile.companyId !== user.companyId || !['ADMIN', 'SUB_ADMIN', 'MEMBER'].includes(profile.role)) continue;
        if (!identities.has(doc.id)) identities.set(doc.id, identity(profile, doc.id, user.companyId, divisionMap, teamMap));
      }
      await current(request, user);
      const result = { records, employees: [...identities.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko')) };
      if (Buffer.byteLength(JSON.stringify(result)) > 3 * 1024 * 1024) fail('resource-exhausted', '급여 목록이 너무 큽니다. 관리자에게 문의해 주세요.');
      return result;
    }
    if (input?.action === 'monthlyPdf') {
      inputShape(input, ['action', 'id']);
      const reference = db.collection('payroll_records').doc(identifier(input.id));
      const snapshot = await reference.get();
      if (!snapshot.exists) fail('not-found', '급여 문서를 찾을 수 없습니다.');
      const record = snapshotData(snapshot);
      if (record.companyId !== user.companyId) fail('permission-denied', '소속 회사의 급여 문서만 조회할 수 있습니다.');
      if (record.schemaVersion !== 2) fail('failed-precondition', '이전 집계 기록에는 직원별 상세자료가 없어 급여대장 PDF를 생성할 수 없습니다.');
      let checked;
      try { checked = validatePayrollRecord(record, user.companyId); }
      catch { fail('failed-precondition', '승인 급여 상세자료의 형식을 확인해 주세요.'); }
      const bytes = await renderMonthlyPdf(checked, branding(user));
      await current(request, user);
      const latest = await reference.get();
      if (!latest.exists) fail('not-found', '급여 문서가 삭제되었습니다.');
      if (latest.data().companyId !== user.companyId) fail('permission-denied', '급여 문서의 소속 회사가 변경되었습니다.');
      if (fingerprint(snapshot) !== fingerprint(latest)) fail('aborted', '급여 문서가 변경되었습니다. 다시 조회해 주세요.');
      await current(request, user);
      return pdfFile(bytes, `${checked.year}년_${String(checked.month).padStart(2, '0')}월_급여대장.pdf`);
    }
    if (input?.action === 'annualPdf') {
      inputShape(input, ['action', 'year', 'employeeId']);
      const year = yearInput(input.year), employeeId = identifier(input.employeeId);
      const snapshot = await readHistory(user.companyId, year);
      let report;
      try { report = buildAnnualPayrollReport(snapshot.docs.map(snapshotData), user.companyId, year, employeeId); }
      catch { fail('failed-precondition', '승인 급여 상세자료의 형식을 확인해 주세요.'); }
      let identitySnapshot = null;
      if (!report.employee) {
        identitySnapshot = await db.collection('UserProfile').doc(employeeId).get();
        if (!identitySnapshot.exists || identitySnapshot.data().companyId !== user.companyId || !['ADMIN', 'SUB_ADMIN', 'MEMBER'].includes(identitySnapshot.data().role)) {
          fail('not-found', '해당 직원의 소속 회사 급여 자료를 찾을 수 없습니다.');
        }
        try { report.employee = identity(identitySnapshot.data(), employeeId, user.companyId); }
        catch { fail('failed-precondition', '직원 정보를 확인해 주세요.'); }
      }
      const bytes = await renderAnnualPdf(report, branding(user));
      await current(request, user);
      const latest = await readHistory(user.companyId, year);
      if (fingerprint(snapshot) !== fingerprint(latest)) fail('aborted', '급여 이력이 변경되었습니다. 다시 조회해 주세요.');
      if (identitySnapshot) {
        const currentProfile = await identitySnapshot.ref.get();
        if (!currentProfile.exists || currentProfile.data().companyId !== user.companyId || fingerprint(identitySnapshot) !== fingerprint(currentProfile)) {
          fail('aborted', '직원 정보가 변경되었습니다. 다시 조회해 주세요.');
        }
      }
      await current(request, user);
      const name = safeText(report.employee.name, 80).replace(/[\\/:*?"<>|]/g, '_');
      return pdfFile(bytes, `${year}년_${name}_급여명세서.pdf`);
    }
    fail('invalid-argument', '지원하지 않는 급여 요청입니다.');
  };
}

module.exports = { createPayrollService, payrollRecordId, recordSummary, MAX_SNAPSHOT_BYTES, MAX_PDF_BYTES };
