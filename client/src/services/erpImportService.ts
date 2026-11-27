import {erpAccessOf,erpCanOperate} from '../utils/erpAccess';
import type {PaymentOptions,PaymentSummary} from './erpAccountService';
import { httpsCallable } from 'firebase/functions';
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { auth, functions } from '../firebase';
import { useAuthStore } from '../store/authStore';

export type ErpImportType = 'OPENING' | 'MOVEMENTS';
export interface ManualLine { code: string; name: string; specification: string; unit: string; taxType: string; quantity: string; price: string; notes: string; vatMode?: 'INCLUDED' | 'EXCLUDED' | 'EXEMPT' | 'ZERO'; amountMode?: 'UNIT' | 'TOTAL'; totalAmount?: string; fulfillment?: 'DIRECT' | 'HOLD' | 'BORROW'; custodyLotId?: string; borrowValue?: string }
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
export interface ErpBootstrapSummary {
  warehouseCode: string; warehouseName: string; basisDate: string;
  totalItems: number; positiveItems: number; zeroItems: number;
  ownedQuantity: number; ownedValue: number;
  borrowingCount: number; borrowedQuantity: number; borrowedValue: number;
  netBookQuantity: number; netBookValue: number;
  partnerCount: number; receivableCount: number;
  receivableTotals: { currency: string; amountMinor: number }[];
}
export interface ErpLedgerComparison {
  inventoryQuantity: number; inventoryValue: number;
  receivableTotals: { currency: string; amountMinor: number }[];
  bundleCount: number; pendingQuantity: number; pendingUnknownCount?: number; monthCloseCount: number; approvalCount: number;
}
export interface ErpBootstrapJob {
  stage?: {versionId: string; status: 'VERIFIED' | 'MISMATCH' | 'PREPARING'; documentCount: number};
  stageConflict?: {challengeIssuedAt: string; challenge: string} | null;
  comparison?: {previous: ErpLedgerComparison; incoming: ErpLedgerComparison};

  id: string; companyId: string; status: 'PREPARING' | 'PENDING' | 'COMMITTED' | 'CANCELLED';
  companyLabel: string; basisDate: string;
  source: { kind: 'BOOTSTRAP'; name: string; size: number; sha256: string };
  summary: ErpBootstrapSummary; fingerprint: string;
  protection?: { hasExistingData: boolean; existingDocumentCount: number; challengeIssuedAt: string; repairChallengeIssuedAt?: string | null };
  backup?: {
    id: string;
    counts: Record<string, number>;
    reconciliation: {
      verified: boolean;
      documentCount: number;
      checks: Record<'inventory' | 'receivables' | 'bundles' | 'pendingCosts' | 'monthCloses' | 'approvals', { count: number; digest: string }>;
    };
  } | null;
  borrowings: { code: string; name: string; warehouseName: string; quantity: number; evaluationValue: number; ownerName: string; buyerName: string; date: string }[];
  receivables: { date: string; partnerCode: string; partnerName: string; currency: string; amountMinor: number; documentNo: string }[];
  createdAt: string; committedAt: string | null;
}
const callable = httpsCallable<Record<string, unknown>, unknown>(functions, 'manageErpImport', { timeout: 120000 });
const bootstrapCallable = httpsCallable<Record<string, unknown>, unknown>(functions, 'manageErpBootstrap', { timeout: 1830000 });
function scope(companyId: string) {
  const { userData, companyData, sessionReady } = useAuthStore.getState();
  if (!auth.currentUser || auth.currentUser.uid !== userData?.uid || userData.companyId !== companyId || !erpCanOperate(erpAccessOf(userData)) ||
    userData.mustChangePassword || (userData.status && userData.status !== 'ACTIVE') || !sessionReady || companyData?.id !== companyId || companyData.status !== 'ACTIVE' || companyData.subscriptionStatus === 'EXPIRED') throw new Error('현재 회사 관리자로 다시 로그인해 주세요.');
  return `${userData.uid}:${companyId}:${userData.role}:${userData.erpAccess || 'NONE'}`;
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
async function bootstrapCall(companyId: string, action: string, data: Record<string, unknown>) {
  const expected = scope(companyId);
  const { userData } = useAuthStore.getState();
  if (userData?.role !== 'ADMIN') throw new Error('회사 ADMIN만 초기화·통합 이관을 실행할 수 있습니다.');
  const result = await bootstrapCallable({ ...data, companyId, action });
  if (scope(companyId) !== expected) throw new Error('로그인 회사가 변경되었습니다.');
  const response = result.data as { bootstrap: ErpBootstrapJob; idempotent?: boolean; pending?: boolean; stageMismatch?: boolean };
  if (response.bootstrap.companyId !== companyId) throw new Error('통합 이관 응답의 소속 회사를 확인할 수 없습니다.');
  return response;
}
async function finishBootstrap(companyId: string, job: ErpBootstrapJob, consent: Record<string, unknown>,
  assertCurrent: () => void, onPending?: (job: ErpBootstrapJob) => void) {
  for (;;) {
    assertCurrent();
    const result = await bootstrapCall(companyId, 'commit', {
      id: job.id, fingerprint: job.fingerprint, confirmPhrase: BOOTSTRAP_CONFIRM_PHRASE, ...consent
    });
    assertCurrent();
    if (!result.pending || result.stageMismatch || result.bootstrap.stageConflict) return result;
    if (!result.bootstrap.stageConflict) {
      delete consent.repairStage;
      delete consent.repairWarningAccepted;
      delete consent.repairChallenge;
    }
    onPending?.(result.bootstrap);
    await new Promise(resolve => setTimeout(resolve, 350));
  }
}
export const erpBootstrapService = {
  get: (companyId: string, id: string) => bootstrapCall(companyId, 'get', { id }),
  preview: (companyId: string, id: string, source: ErpSourceFile) => bootstrapCall(companyId, 'preview', { id, source }),
  commit: async (companyId: string, job: ErpBootstrapJob, stillCurrent = () => true, onPending?: (job: ErpBootstrapJob) => void) => {
    if (job.companyId !== companyId || job.protection?.hasExistingData !== false || job.stageConflict || job.protection?.repairChallengeIssuedAt || job.stage?.status === 'MISMATCH') {
      throw new Error('기존 장부가 있거나 보호 상태를 확인할 수 없습니다. 미리보기를 다시 확인해 주세요.');
    }
    const actor = scope(companyId);
    return finishBootstrap(companyId, job, {}, () => {
      if (!stillCurrent() || scope(companyId) !== actor) throw new Error('로그인 상태 또는 이관 화면이 변경되었습니다.');
    }, onPending);
  },
  reset: async (companyId: string, job: ErpBootstrapJob, warningAccepted: boolean, password: string, stillCurrent: () => boolean, onPending?: (job: ErpBootstrapJob) => void) => {
    const expected = scope(companyId);
    const administrator = auth.currentUser;
    const conflict = job.stageConflict;
    const challenge = Date.parse(conflict?.challengeIssuedAt ?? job.protection?.repairChallengeIssuedAt ?? job.protection?.challengeIssuedAt ?? '');
    if (!stillCurrent() || useAuthStore.getState().userData?.role !== 'ADMIN' || !administrator?.email ||
        job.companyId !== companyId || job.status !== 'PENDING' || !job.protection || (!job.protection.hasExistingData && !conflict && !job.protection.repairChallengeIssuedAt) ||
        (job.stage?.status === 'MISMATCH' && !conflict?.challenge) ||
        !Number.isFinite(challenge) || warningAccepted !== true || !password) {
      throw new Error('전체 초기화 경고를 확인하고 회사 ADMIN 비밀번호를 입력해 주세요.');
    }
    const assertCurrent = () => {
      if (!stillCurrent() || auth.currentUser?.uid !== administrator.uid || scope(companyId) !== expected) {
        throw new Error('로그인 상태 또는 이관 화면이 변경되었습니다. 다시 미리보기해 주세요.');
      }
    };
    // Auth timestamps have second precision. Start after a full second has
    // elapsed since receiving the preview, independent of the device clock.
    await new Promise(resolve => setTimeout(resolve, 1100));
    assertCurrent();
    try {
      await reauthenticateWithCredential(administrator, EmailAuthProvider.credential(administrator.email, password));
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') throw new Error('ADMIN 비밀번호가 일치하지 않습니다. 다시 입력해 주세요.');
      throw error;
    }
    assertCurrent();
    await administrator.getIdToken(true);
    assertCurrent();
    const consent = {
      ...(job.protection.hasExistingData ? {resetExisting: true, warningAccepted: true} : {}),
      ...(conflict ? {repairStage: true, repairWarningAccepted: true, repairChallenge: conflict.challenge} : {})
    };
    return finishBootstrap(companyId, job, consent, assertCurrent, onPending);
  },
  cancel: (companyId: string, id: string) => bootstrapCall(companyId, 'cancel', { id }),
};
export const BOOTSTRAP_CONFIRM_PHRASE = '기존 ERP 삭제 후 이관';
export async function readErpFile(companyId: string, file: File, bootstrap = false): Promise<ErpSourceFile> {
  const expected = scope(companyId);
  const limit = bootstrap ? 12 : 3;
  if (!/\.xlsx$/i.test(file.name) || !file.size || file.size > limit * 1024 * 1024) throw new Error(`${limit}MB 이하의 .xlsx 파일을 선택해 주세요.`);
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
