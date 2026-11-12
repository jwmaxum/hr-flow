import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { erpScope } from './erpLedgerService';

export type DocumentKind = 'PROFORMA' | 'INVOICE' | 'STATEMENT';
export interface PrintProfile { companyNameEn: string; addressEn: string; representativeEn: string; registrationNumber: string; businessType: string; businessItem: string; bankDetails: string; version: number }
export interface DocumentLineInput { itemId?: string; description?: string; quantity: string; price?: string; taxType?: string; taxRate?: string; priceBasis?: string; sourceId?: string; notes: string }
export interface DocumentInput { kind: DocumentKind; issueDate: string; validUntil: string; partnerId: string; buyerNameEn: string; buyerAddressEn: string;
  currency: string; sourceDocumentNo: string; lines: DocumentLineInput[]; paymentTerms: string; deliveryTerms: string; tradeTerms: string; notes: string }
export interface DocumentRow { rowNo: number; sourceId: string; code: string; description: string; specification: string; unit: string;
  quantityScaled: number; priceScaled: number; supplyMinor: number; taxMinor: number; notes: string }
export interface PrintBranding { companyName: string; companyNameKo: string; address: string; representative: string; registrationNumber: string;
  sealRegistered: boolean; sealWidthMm: number; sealHeightMm: number; settingsVersion: number; profileVersion: number }
export interface DocumentSnapshot { kind: DocumentKind; issueDate: string; currency: string; rows: DocumentRow[]; branding: PrintBranding;
  buyer: { name: string; address: string }; totals: { supplyMinor: number; taxMinor: number; totalMinor: number } }
export interface TradeDocument { id: string; companyId: string; kind: DocumentKind; status: 'DRAFT' | 'ISSUED' | 'CANCELLED'; revision: number; edition: number;
  number: string; issueDate: string; buyerName: string; currency: string; totalMinor: number | null; pdfReady: boolean; updatedAt: string; createdAt: string;
  replacesId: string; replacesNumber: string; replacementId: string; cancelledAt: string; cancelReason: string;
  input?: DocumentInput; preview?: DocumentSnapshot | null; fingerprint?: string }
export interface DocumentMeta { profile: PrintProfile; branding: PrintBranding; companyNameEn: string; canIssue: boolean }
export interface DocumentCursor { updatedAt: string; id: string }
export interface SourceDocument { documentNo: string; date: string; currency: string; partnerId: string; partnerName: string;
  rows: { id: string; code: string; name: string; specification: string; unit: string; price: number; quantity: number; available: number }[] }
export interface DocumentResult { document: TradeDocument; idempotent?: boolean; warning?: string }
export interface DocumentPdf { document?: TradeDocument; name: string; mimeType: string; base64: string }
const invoke = httpsCallable<Record<string, unknown>, unknown>(functions, 'manageErpDocuments', { timeout: 120000 });
async function call<T>(companyId: string, action: string, data: Record<string, unknown> = {}): Promise<T> {
  const scope = erpScope(companyId, true), result = await invoke({ ...data, action, companyId });
  if (scope !== erpScope(companyId, true)) throw new Error('로그인 사용자·회사·권한이 변경되었습니다.');
  return result.data as T;
}
export const erpDocumentService = {
  meta: (companyId: string) => call<DocumentMeta>(companyId, 'meta'),
  saveProfile: (companyId: string, profile: PrintProfile) => { const { version, ...values } = profile; return call<{ profile: PrintProfile }>(companyId, 'saveProfile', { profile: values, expectedVersion: version }); },
  list: (companyId: string, cursor?: DocumentCursor) => call<{ documents: TradeDocument[]; cursor: DocumentCursor | null }>(companyId, 'list', cursor ? { cursor } : {}),
  get: (companyId: string, id: string) => call<DocumentResult>(companyId, 'get', { id }),
  sources: (companyId: string, documentNo: string, kind: DocumentKind) => call<SourceDocument>(companyId, 'sources', { documentNo, kind }),
  save: (companyId: string, id: string, expectedRevision: number, input: DocumentInput) => call<DocumentResult>(companyId, 'save', { id, expectedRevision, input }),
  issue: (companyId: string, document: TradeDocument) => call<DocumentResult>(companyId, 'issue', { id: document.id, expectedRevision: document.revision, fingerprint: document.fingerprint, confirm: true }),
  pdf: (companyId: string, document: TradeDocument, preview = false) => call<DocumentPdf>(companyId, preview ? 'previewPdf' : 'pdf', { id: document.id, ...(preview ? { expectedRevision: document.revision } : {}) }),
  cancel: (companyId: string, document: TradeDocument, reason: string) => call<DocumentResult>(companyId, 'cancel', { id: document.id, expectedRevision: document.revision, reason, confirm: true }),
  revise: (companyId: string, id: string, sourceId: string) => call<DocumentResult>(companyId, 'revise', { id, sourceId }),
};
