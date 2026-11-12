import type {PaymentOptions,PaymentSummary} from './erpAccountService';
import { httpsCallable } from 'firebase/functions';
import { auth, functions } from '../firebase';
import { useAuthStore } from '../store/authStore';

export type ErpImportType = 'OPENING' | 'MOVEMENTS';
export interface ManualLine { code: string; name: string; specification: string; unit: string; taxType: string; quantity: string; price: string; notes: string; fulfillment?: 'DIRECT' | 'HOLD' | 'BORROW'; custodyLotId?: string; borrowValue?: string }
export interface ManualMovement {
  payment?:{status:'CREDIT'}|({status:'PAID'}&PaymentOptions);
  direction: '입고' | '출고'; date: string; warehouseId: string; partnerId?: string;
  partner?: { code: string; name: string; country: string; registrationNumber: string };
  currency: string; exchangeRate: string; priceBasis: string; lines: ManualLine[]; allowNewItems: boolean; allowNewPartners: boolean;
}
export interface ErpImportOptions {
  defaultWarehouseId: string; warehouseByRow: Record<string, string>; partnerByRow: Record<string, string>;
  allowNewItems: boolean; allowNewPartners: boolean; acceptExistingItems: boolean;
}
export interface ErpImportIssue { row: number; sheet: string; message: string }
export interface ErpImportRow {
  sourceRow: number; itemId?: string; code: string; name: string; direction: string; date: string; documentNo: string;
  quantity: number; unit: string; currency: string; price: number | null; warehouseName: string; partnerName: string;
  newItem?: boolean; newPartner?: boolean; value?: number; supply?: number; tax?: number; total?: number; cost?: number;
  beforeQuantity?: number; beforeValue?: number; afterQuantity?: number; afterValue?: number;
  partnerCandidates: { id: string; code: string; name: string }[];
  postingMode?: 'OPENING' | 'ADJUSTMENT'; stockMode?: string; bundle?: {itemId: string; code: string; name: string; quantityScaled: number; cost: number}[];
}
export interface ErpImport {
  id: string; companyId: string; type: ErpImportType; status: 'PENDING' | 'COMMITTED' | 'CANCELLED';
  basisDate: string; companyLabel: string; source: { kind?: 'XLSX' | 'MANUAL' | 'PENDING_OPENING'; name: string; size: number; sha256: string };
  createdAt: string; committedAt: string | null;
  preview: { payment?:({status:'CREDIT'}|({status:'PAID'}&PaymentSummary))|null; fingerprint: string; rows: ErpImportRow[]; errors: ErpImportIssue[]; warnings: ErpImportIssue[];
    canCommit: boolean; newItems: number; newPartners: number;
    itemTotals?: { itemId: string; name?: string; beforeQuantity: number; beforeValue: number; quantity: number; value: number }[];
    balances: { itemId: string; warehouseId: string; beforeQuantity: number; beforeValue: number; quantity: number; value: number }[] };
}
export interface ErpImportSummary { id: string; type: ErpImportType; sourceKind?: 'XLSX' | 'MANUAL' | 'PENDING_OPENING'; status: ErpImport['status']; name: string; createdAt: string; rowCount: number; errorCount: number }
export interface PendingOpeningRecord {id: string; code: string; name: string; unit: string; active: boolean; pendingOpening: {status: 'PENDING_COST' | 'CONFIRMED'; basisDate: string; quantity: number | null; unit: string; source: string; confirmedQuantity?: number; price?: number; value?: number; warehouseName?: string; postingDate?: string; postingMode?: string; reason?: string}}
export interface PendingOpeningList {companyId: string; records: PendingOpeningRecord[]; basisDate: string; lastDate: string; suggestedDate: string}
export interface PendingOpeningInput {date: string; warehouseId: string; reason: string; zeroCostConfirmed: boolean; lines: {itemId: string; quantity: string; price: string}[]}
export interface ErpSourceFile { name: string; mimeType: string; base64: string }
const callable = httpsCallable<Record<string, unknown>, unknown>(functions, 'manageErpImport', { timeout: 120000 });
function scope(companyId: string) {
  const { userData, companyData, sessionReady } = useAuthStore.getState();
  if (!auth.currentUser || auth.currentUser.uid !== userData?.uid || userData.companyId !== companyId || userData.role !== 'ADMIN' ||
    userData.mustChangePassword || (userData.status && userData.status !== 'ACTIVE') || !sessionReady || companyData?.id !== companyId || companyData.status !== 'ACTIVE' || companyData.subscriptionStatus === 'EXPIRED') throw new Error('현재 회사 관리자로 다시 로그인해 주세요.');
  return `${userData.uid}:${companyId}:${userData.role}`;
}
async function call<T>(companyId: string, action: string, data: Record<string, unknown> = {}): Promise<T> {
  const expected = scope(companyId), result = await callable({ ...data, companyId, action });
  if (scope(companyId) !== expected) throw new Error('로그인 회사가 변경되었습니다.');
  return result.data as T;
}
async function jobCall(companyId: string, action: string, data: Record<string, unknown>) {
  const result = await call<{ import: ErpImport; idempotent?: boolean }>(companyId, action, data);
  if (result.import.companyId !== companyId) throw new Error('업로드 결과의 소속 회사를 확인할 수 없습니다.');
  return result;
}
export const erpImportService = {
  openingList: async (companyId: string) => {const result=await call<PendingOpeningList>(companyId,'openingList');if(result.companyId!==companyId)throw new Error('이관 대기 자료의 소속 회사를 확인할 수 없습니다.');return result;},
  openingPreview: (companyId: string,id: string,opening: PendingOpeningInput) => jobCall(companyId,'openingPreview',{id,opening}),
  manualPreview: (companyId: string, id: string, movement: ManualMovement) => jobCall(companyId, 'manualPreview', { id, movement }),
  preview: (companyId: string, id: string, type: ErpImportType, source: ErpSourceFile, options: ErpImportOptions) => jobCall(companyId, 'preview', { id, type, source, options }),
  get: (companyId: string, id: string) => jobCall(companyId, 'get', { id }),
  commit: (companyId: string, job: ErpImport) => jobCall(companyId, 'commit', { id: job.id, fingerprint: job.preview.fingerprint }),
  cancel: (companyId: string, id: string) => jobCall(companyId, 'cancel', { id }),
  list: (companyId: string) => call<{ imports: ErpImportSummary[] }>(companyId, 'list'),
  template: (companyId: string, type: ErpImportType) => call<ErpSourceFile>(companyId, 'template', { type }),
  source: (companyId: string, id: string) => call<ErpSourceFile>(companyId, 'downloadSource', { id }),
};
export async function readErpFile(companyId: string, file: File): Promise<ErpSourceFile> {
  const expected = scope(companyId);
  if (!/\.xlsx$/i.test(file.name) || !file.size || file.size > 3 * 1024 * 1024) throw new Error('3MB 이하의 .xlsx 파일을 선택해 주세요.');
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다. 다시 선택해 주세요.'));
    reader.readAsDataURL(file);
  });
  if (scope(companyId) !== expected) throw new Error('로그인 회사가 변경되었습니다.');
  return { name: file.name, mimeType: file.type, base64 };
}
export function downloadErpFile(file: ErpSourceFile) {
  const bytes = Uint8Array.from(atob(file.base64), value => value.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const link = document.createElement('a'); link.href = url; link.download = file.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
