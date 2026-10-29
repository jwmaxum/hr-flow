import { httpsCallable } from 'firebase/functions';
import { auth, functions } from '../firebase';
import { useAuthStore } from '../store/authStore';
import type { PayrollListResult, PayrollPdfFile, PayrollRecordSummary } from '../utils/payrollStatements';

const manage = httpsCallable<Record<string, unknown>, unknown>(functions, 'managePayroll');
export function payrollSessionKey(): string {
  const { userData, companyData, sessionReady } = useAuthStore.getState();
  return JSON.stringify([auth.currentUser?.uid, userData?.uid, userData?.companyId, userData?.role,
    userData?.status, userData?.mustChangePassword, companyData?.id, companyData?.status, sessionReady]);
}
export function assertPayrollSession(expected?: string): string {
  const { userData, companyData, sessionReady } = useAuthStore.getState();
  if (!auth.currentUser || auth.currentUser.uid !== userData?.uid || userData.role !== 'ADMIN' ||
      (userData.status && userData.status !== 'ACTIVE') || userData.mustChangePassword || !sessionReady ||
      !userData.companyId || companyData?.id !== userData.companyId || companyData.status !== 'ACTIVE' ||
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
  monthlyPdf: (id: string) => request<PayrollPdfFile>('monthlyPdf', { id }),
  annualPdf: (year: number, employeeId: string) => request<PayrollPdfFile>('annualPdf', { year, employeeId }),
};

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
