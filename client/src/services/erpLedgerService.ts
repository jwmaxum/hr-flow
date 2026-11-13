import { httpsCallable } from 'firebase/functions';
import { auth, functions } from '../firebase';
import { useAuthStore } from '../store/authStore';

export type CorrectionType = 'CANCEL' | 'SALES_RETURN' | 'PURCHASE_RETURN' | 'COUNT' | 'VALUE';
export interface CorrectionInput { type: CorrectionType; date: string; reason: string; sourceId?: string; itemId?: string; warehouseId?: string; quantity?: string; value?: string }
export interface TransferInput { type: 'TRANSFER'; date: string; reason: string; warehouseId: string; allocations: { itemId: string; warehouseId: string; quantity: string }[] }
export interface TransferStock { id: string; itemId: string; code: string; name: string; unit: string; active: boolean; quantity: number; value: number }
export interface CorrectionRow { rowNo: number; name: string; code: string; warehouseName: string; transferWarehouseName?: string; unit: string; direction: string; sourceDocumentNo: string;
  beforeQuantity: number; afterQuantity: number; beforeValue: number; afterValue: number; refundKRW?: number; refundSupply?: number; refundTax?: number; currency: string }
export interface Correction { id: string; companyId: string; status: 'PENDING' | 'COMMITTED' | 'AWAITING_APPROVAL'; input: CorrectionInput | TransferInput; rows: CorrectionRow[]; fingerprint: string }
export interface ReportFilters { from: string; to: string; search: string; itemId: string; warehouseId: string }
export interface ReportCursor { offset: number; revision: number; signature: string }
export interface ReportMeta { companyId: string; canManage: boolean; basisDate: string | null; lastDate: string | null; revision: number }
export interface ReportRow {
  itemId: string; warehouseId: string; code: string; name: string; specification: string; unit: string; warehouseCode: string; warehouseName: string;
  openingQuantity?: number; inQuantity?: number; outQuantity?: number; adjustQuantity?: number; closingQuantity?: number;
  transferInQuantity?: number; transferOutQuantity?: number; transferInValue?: number; transferOutValue?: number; transferWarehouseName?: string;
  openingValue?: number; inValue?: number; outValue?: number; adjustValue?: number; closingValue?: number; salesKRW?: number; cogsKRW?: number; marginKRW?: number; averageInPrice?: number | null;
  bundleParentId?: string; stockMode?: string; id?: string; date?: string; order?: number; rowNo?: number; type?: string; operationType?: string; direction?: string; documentNo?: string; sourceId?: string | null;
  sourceDocumentNo?: string; importId?: string | null; operationId?: string | null; quantityDelta?: number; balanceQuantity?: number; partnerName?: string; reason?: string;
  currency?: string; price?: number | null; supply?: number | null; tax?: number | null; total?: number | null; valueDelta?: number; balanceValue?: number;
  refundKRW?: number | null; refundSupply?: number | null; refundTax?: number | null; returnedQuantity?: number; cancelledBy?: string | null;
  createdAt?: string; committedAt?: string | null;
}
export interface ErpReport extends ReportMeta { snapshot?: string; filters: ReportFilters; view: 'summary' | 'detail'; rows: ReportRow[]; totalRows: number;
  totals: Record<string, number | null> | null; unitTotals?: { unit: string; openingQuantity: number; inQuantity: number; outQuantity: number; transferInQuantity?: number; transferOutQuantity?: number; adjustQuantity: number; closingQuantity: number }[]; nextCursor: ReportCursor | null }
const reports = httpsCallable<Record<string, unknown>, unknown>(functions, 'manageErpReport', { timeout: 120000 });
const corrections = httpsCallable<Record<string, unknown>, unknown>(functions, 'manageErpCorrection', { timeout: 120000 });
export function erpScope(companyId: string, write: boolean | 'operator' = false) {
  const { userData, companyData, sessionReady } = useAuthStore.getState();
  if (!auth.currentUser || auth.currentUser.uid !== userData?.uid || !sessionReady || userData.companyId !== companyId ||
    !(write === true ? ['ADMIN'] : ['ADMIN','SUB_ADMIN','MEMBER']).includes(userData.role) || userData.role !== 'ADMIN' && !['INBOUND','OUTBOUND','BOTH'].includes(userData.erpAccess || '') || userData.mustChangePassword ||
    userData.status && userData.status !== 'ACTIVE' || companyData?.id !== companyId || companyData.status !== 'ACTIVE' || companyData.subscriptionStatus === 'EXPIRED') throw new Error('현재 회사의 권한으로 다시 로그인해 주세요.');
  return `${userData.uid}:${companyId}:${userData.role}:${userData.erpAccess || 'NONE'}`;
}
async function call<T>(companyId: string, write: boolean, action: string, data: Record<string, unknown> = {}): Promise<T> {
  const expected = erpScope(companyId, write ? 'operator' : false), result = await (write ? corrections : reports)({ ...data, companyId, action });
  if (expected !== erpScope(companyId, write ? 'operator' : false)) throw new Error('로그인 사용자 또는 회사 권한이 변경되었습니다.');
  return result.data as T;
}
export const erpLedgerService = {
  meta: (companyId: string) => call<ReportMeta>(companyId, false, 'meta'),
  report: (companyId: string, filters: ReportFilters, view: 'summary' | 'detail', cursor?: ReportCursor) => call<ErpReport>(companyId, false, 'report', { filters, view, ...(cursor ? { cursor } : {}) }),
  export: (companyId: string, report: ErpReport) => call<ErpReport>(companyId, false, 'export', { filters: report.filters, view: report.view, revision: report.revision, snapshot: report.snapshot }),
  transferStock: (companyId: string, warehouseId: string, cursor?: string) => call<{ records: TransferStock[]; nextCursor: string | null }>(companyId, true, 'transferStock', { warehouseId, ...(cursor ? { cursor } : {}) }),
  preview: (companyId: string, id: string, input: CorrectionInput | TransferInput) => call<{ correction: Correction }>(companyId, true, 'preview', { id, input }),
  commit: (companyId: string, job: Correction) => call<{ correction: Correction; idempotent: boolean; approvalRequested?: boolean; approvalId?: string }>(companyId, true, 'commit', { id: job.id, fingerprint: job.fingerprint }),
};
