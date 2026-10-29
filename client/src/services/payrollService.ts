import { httpsCallable } from 'firebase/functions';
import { auth, functions } from '../firebase';
import { useAuthStore } from '../store/authStore';
import type { PayrollDraft, PayrollDraftRowUpdate, PayrollDraftSummary, PayrollDraftVersion, PayrollListResult,
  PayrollPdfFile, PayrollRecordSummary, PayrollRevision, PayrollSourceFile, PayrollSourceInput, PayrollSourceSelector } from '../utils/payrollStatements';

const manage = httpsCallable<Record<string, unknown>, unknown>(functions, 'managePayroll');
export function payrollSessionKey(): string {
  const { userData, companyData, sessionReady } = useAuthStore.getState();
  return JSON.stringify([auth.currentUser?.uid, userData?.uid, userData?.companyId, userData?.role,
    userData?.status, userData?.mustChangePassword, companyData?.id, companyData?.status,
    companyData?.accessUntil, companyData?.subscriptionStatus, sessionReady]);
}
export function assertPayrollSession(expected?: string): string {
  const { userData, companyData, sessionReady } = useAuthStore.getState();
  const hasDeadline = companyData?.accessUntil !== undefined && companyData.accessUntil !== null;
  const deadline = hasDeadline ? Date.parse(companyData!.accessUntil!) : NaN;
  const expired = hasDeadline ? !Number.isFinite(deadline) || deadline <= Date.now() : companyData?.subscriptionStatus === 'EXPIRED';
  if (!auth.currentUser || auth.currentUser.uid !== userData?.uid || userData.role !== 'ADMIN' ||
      (userData.status && userData.status !== 'ACTIVE') || userData.mustChangePassword || !sessionReady ||
      !userData.companyId || companyData?.id !== userData.companyId || companyData.status !== 'ACTIVE' || expired ||
      (expected !== undefined && expected !== payrollSessionKey())) throw new Error('로그인 또는 소속 정보가 변경되었습니다. 다시 확인해 주세요.');
  return userData.companyId;
}
async function request<T>(action: string, data: Record<string, unknown>): Promise<T> {
  const scope = payrollSessionKey();
  assertPayrollSession(scope);
  await auth.currentUser!.getIdToken();
  assertPayrollSession(scope);
  const response = await manage({ action, ...data });
  assertPayrollSession(scope);
  return response.data as T;
}
function assertDraftCompany(draft: PayrollDraft | PayrollDraftSummary, companyId: string): void {
  if (!draft || draft.companyId !== companyId || typeof draft.id !== 'string' || !Number.isSafeInteger(draft.draftVersion) || draft.draftVersion < 1 ||
    !['PENDING', 'APPROVED', 'CANCELLED'].includes(draft.status)) throw new Error('급여 검토 자료의 소속 정보를 확인할 수 없습니다.');
  if ('rows' in draft && (!Array.isArray(draft.rows) || draft.rows.length > 2000 || draft.rows.some(row => row.companyId !== companyId))) {
    throw new Error('급여 상세자료의 소속 정보를 확인할 수 없습니다.');
  }
}
async function draftRequest(action: string, data: Record<string, unknown>): Promise<{ draft: PayrollDraft }> {
  const companyId = assertPayrollSession();
  const result = await request<{ draft: PayrollDraft }>(action, data);
  assertDraftCompany(result.draft, companyId);
  return result;
}
export const payrollService = {
  preview: (year: number, month: number) => request<{ fingerprint: string; employeeCount: number; totalGross: number; totalNet: number; totalDeductions: number; zeroCount: number; taxTable: { source: string; fileName?: string } }>('preview', { year, month }),
  async list(year: number): Promise<PayrollListResult> {
    const companyId = assertPayrollSession();
    const result = await request<PayrollListResult>('list', { year });
    if (!Array.isArray(result.records) || !Array.isArray(result.employees) ||
        result.records.some(record => record.companyId !== companyId) || result.employees.some(employee => employee.companyId !== companyId)) {
      throw new Error('급여 이력의 소속 정보를 확인할 수 없습니다.');
    }
    return result;
  },
  async approve(year: number, month: number, expectedFingerprint: string): Promise<{ record: PayrollRecordSummary }> {
    const companyId = assertPayrollSession();
    const result = await request<{ record: PayrollRecordSummary }>('approve', { year, month, expectedFingerprint });
    if (result.record?.companyId !== companyId) throw new Error('저장 결과의 소속 정보를 확인할 수 없습니다.');
    return result;
  },
  monthlyPdf: (id: string, revision?: number) => request<PayrollPdfFile>('monthlyPdf', revision === undefined ? { id } : { id, revision }),
  annualPdf: (year: number, employeeId: string) => request<PayrollPdfFile>('annualPdf', { year, employeeId }),
  importSource: (year: number, month: number, reason: string, source: PayrollSourceInput) => draftRequest('importSource', { year, month, reason, source }),
  startCorrection: (recordId: string, reason: string) => draftRequest('startCorrection', { recordId, reason }),
  getDraft: (id: string) => draftRequest('getDraft', { id }),
  updateDraft: (id: string, expectedDraftVersion: number, reason: string, rows: PayrollDraftRowUpdate[]) =>
    draftRequest('updateDraft', { id, expectedDraftVersion, reason, rows }),
  cancelDraft: (id: string, expectedDraftVersion: number, reason: string) => draftRequest('cancelDraft', { id, expectedDraftVersion, reason }),
  getDraftVersion: (id: string, draftVersion: number) => draftRequest('getDraftVersion', { id, draftVersion }),
  async listDrafts(year: number): Promise<{ drafts: PayrollDraftSummary[] }> {
    const companyId = assertPayrollSession();
    const result = await request<{ drafts: PayrollDraftSummary[] }>('listDrafts', { year });
    if (!Array.isArray(result.drafts)) throw new Error('급여 검토 목록을 확인할 수 없습니다.');
    result.drafts.forEach(draft => assertDraftCompany(draft, companyId));
    return result;
  },
  async approveDraft(id: string, expectedDraftVersion: number): Promise<{ record: PayrollRecordSummary; draftId: string; revision: number; idempotent?: boolean }> {
    const companyId = assertPayrollSession();
    const result = await request<{ record: PayrollRecordSummary; draftId: string; revision: number; idempotent?: boolean }>('approveDraft', { id, expectedDraftVersion });
    if (result.record?.companyId !== companyId || result.draftId !== id || !Number.isSafeInteger(result.revision)) {
      throw new Error('급여 재승인 결과의 소속 정보를 확인할 수 없습니다.');
    }
    return result;
  },
  async listRevisions(id: string): Promise<{ revisions: PayrollRevision[] }> {
    const companyId = assertPayrollSession();
    const result = await request<{ revisions: PayrollRevision[] }>('listRevisions', { id });
    if (!Array.isArray(result.revisions) || result.revisions.some(item => item.companyId !== companyId)) throw new Error('급여 개정 이력의 소속 정보를 확인할 수 없습니다.');
    return result;
  },
  async listDraftVersions(id: string): Promise<{ versions: PayrollDraftVersion[] }> {
    const companyId = assertPayrollSession();
    const result = await request<{ versions: PayrollDraftVersion[] }>('listDraftVersions', { id });
    if (!Array.isArray(result.versions) || result.versions.some(item => item.companyId !== companyId)) throw new Error('급여 검토 이력의 소속 정보를 확인할 수 없습니다.');
    return result;
  },
  sourceDownload: (selector: PayrollSourceSelector) => request<PayrollSourceFile>('sourceDownload', 'draftId' in selector
    ? { draftId: selector.draftId } : selector.revision === undefined ? { recordId: selector.recordId } : { recordId: selector.recordId, revision: selector.revision }),
};

const MAX_SOURCE_BYTES = 3 * 1024 * 1024;
const SOURCE_MIMES = new Set(['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
export async function readPayrollSourceFile(file: File, expectedScope: string): Promise<PayrollSourceInput> {
  assertPayrollSession(expectedScope);
  if (!file || file.size < 1 || file.size > MAX_SOURCE_BYTES || !/\.(?:csv|xlsx)$/i.test(file.name)) {
    throw new Error('3MB 이하의 CSV 또는 XLSX 표준양식을 선택해 주세요.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertPayrollSession(expectedScope);
  if (bytes.length !== file.size || bytes.length > MAX_SOURCE_BYTES) throw new Error('파일을 다시 선택해 주세요.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const mimeType = /\.xlsx$/i.test(file.name) ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
  assertPayrollSession(expectedScope);
  return { name: file.name, mimeType, base64: btoa(binary) };
}

export async function downloadPayrollSourceFile(file: PayrollSourceFile, expectedScope: string): Promise<void> {
  assertPayrollSession(expectedScope);
  const mimeType = file?.mimeType?.split(';')[0];
  if (!SOURCE_MIMES.has(mimeType) || typeof file.base64 !== 'string' || file.base64.length > 4 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('급여 원본 파일 정보를 확인할 수 없습니다.');
  const bytes = Uint8Array.from(atob(file.base64), character => character.charCodeAt(0));
  if (bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES || (file.size !== undefined && file.size !== bytes.length)) throw new Error('급여 원본 파일 크기가 올바르지 않습니다.');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
  assertPayrollSession(expectedScope);
  if (hex !== file.sha256) throw new Error('급여 원본 파일이 보관된 해시와 일치하지 않습니다.');
  if (mimeType.includes('spreadsheet') && (bytes[0] !== 0x50 || bytes[1] !== 0x4b)) throw new Error('급여 원본 XLSX 형식이 올바르지 않습니다.');
  const extension = mimeType.includes('spreadsheet') ? '.xlsx' : '.csv';
  const stem = (typeof file.filename === 'string' ? file.filename : '급여원자료').replace(/\.(?:csv|xlsx)$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_').replace(/\p{Cc}/gu, '_').slice(0, 150) || '급여원자료';
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url; link.download = stem + extension;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadPayrollPdf(file: PayrollPdfFile, expectedScope: string): void {
  assertPayrollSession(expectedScope);
  if (file?.mimeType !== 'application/pdf' || typeof file.base64 !== 'string' || file.base64.length > 14 * 1024 * 1024 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64)) throw new Error('PDF 파일의 형식 또는 크기를 확인해 주세요.');
  const binary = atob(file.base64);
  if (!binary.startsWith('%PDF-') || binary.length > 10 * 1024 * 1024) throw new Error('올바른 급여 PDF가 아닙니다.');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = (typeof file.filename === 'string' ? file.filename : '급여명세서.pdf').replace(/[\\/]/g, '_').replace(/\p{Cc}/gu, '_').slice(0, 180);
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
