import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { erpScope } from './erpLedgerService';
import { erpService } from './erpService';
import type { ErpKind, ErpRecord, ErpCursor } from './erpService';

export const erpToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
export const erpMoney = (minor: number, currency: string) => (minor / (['KRW', 'JPY'].includes(currency) ? 1 : 100)).toLocaleString('ko-KR', { maximumFractionDigits: 2 });
async function call<T>(name: string, companyId: string, action: string, data: Record<string, unknown> = {}): Promise<T> {
  const scope = erpScope(companyId, true);
  const result = await httpsCallable<Record<string, unknown>, T>(functions, name, { timeout: 120000 })({ ...data, action, companyId });
  if (erpScope(companyId, true) !== scope) throw new Error('회사 권한이 변경되었습니다.');
  const response = result.data as {companyId?: string; job?: {companyId?: string}} | null;
  if ((response?.job?.companyId || response?.companyId) !== companyId) throw new Error('원장 응답의 소속 회사를 확인할 수 없습니다.');
  return result.data;
}
export async function erpChoices(companyId: string, kind: ErpKind): Promise<ErpRecord[]> {
  const records: ErpRecord[] = []; let cursor: ErpCursor | undefined;
  do { const result = await erpService.list(companyId, kind, '', 'name', cursor); records.push(...result.records); cursor = result.nextCursor || undefined;
    if (records.length > 5000) throw new Error('선택 자료가 5,000개를 초과했습니다. 검색 조회 확장이 필요합니다.');
  } while (cursor);
  return records;
}
export interface ReceiptInput { type: 'RECEIPT' | 'REFUND' | 'CANCEL'; date: string; partnerId?: string; currency?: string; amount?: string; method?: string; reference?: string; notes: string; sourceId?: string }
export interface ReceiptJob { id: string; companyId: string; fingerprint: string; status: 'PENDING' | 'COMMITTED'; before: number; after: number; entry: { partnerName: string; currency: string; amountMinor: number; type: string; date: string; method: string }; input: ReceiptInput }
export interface ReceivableRow { partnerId: string; partnerName: string; currency: string; opening: number; sales: number; tax: number; billed: number; receipts: number; balance: number }
export interface ReceivableEvent { id: string; partnerId: string; partnerName: string; currency: string; date: string; kind: string; documentNo: string; supply: number; tax: number; gross: number; receipt: number; method?: string; notes?: string }
export interface ReceivableReport { companyId: string; snapshot: string; rows: ReceivableRow[]; events: ReceivableEvent[]; nextOffset: number | null; lastDate: string | null }
export const erpFinance = {
  report: (companyId: string, from: string, to: string, partnerId = '', offset = 0, snapshot?: string) => call<ReceivableReport>('manageErpFinance', companyId, 'report', { from, to, partnerId, offset, ...(snapshot ? {snapshot} : {}) }),
  preview: (companyId: string, id: string, input: ReceiptInput) => call<{job: ReceiptJob}>('manageErpFinance', companyId, 'preview', {id, input}),
  commit: (companyId: string, job: ReceiptJob) => call<{job: ReceiptJob}>('manageErpFinance', companyId, 'commit', {id: job.id, fingerprint: job.fingerprint}),
};
export interface CustodyLot { id: string; itemId: string; code: string; name: string; warehouseId: string; warehouseName: string; ownerPartnerId: string; ownerName: string; availableQuantityScaled: number; borrowedQuantityScaled: number; deliveredQuantityScaled: number; reference: string; date: string; cancelled?: boolean }
export interface Borrowing { id: string; lotId: string; name: string; code: string; warehouseName: string; ownerName: string; buyerName: string; outstandingQuantityScaled: number; outstandingValue: number; date: string }
export interface CustodyInput { type: 'REGISTER' | 'DELIVER' | 'REPAY' | 'CANCEL'; date: string; notes: string; quantity?: string; itemId?: string; warehouseId?: string; ownerPartnerId?: string; lotId?: string; borrowingId?: string; sourceId?: string; reference?: string }
export interface CustodySummary { type: string; quantity: number; name: string; ownerName: string; warehouseName: string; notice?: string; remaining?: number; actualCost?: number; evaluationCost?: number; costDifference?: number }
export interface CustodyJob { id: string; companyId: string; fingerprint: string; status: 'PENDING' | 'COMMITTED'; input: CustodyInput; summary: CustodySummary }
export interface CustodyList { companyId: string; lots: CustodyLot[]; borrowings: Borrowing[]; operations: { id: string; input: CustodyInput; summary: CustodySummary; cancelledBy: string | null }[] }
export const erpCustody = {
  list: (companyId: string) => call<CustodyList>('manageErpCustody', companyId, 'list'),
  preview: (companyId: string, id: string, input: CustodyInput) => call<{job: CustodyJob}>('manageErpCustody', companyId, 'preview', {id, input}),
  commit: (companyId: string, job: CustodyJob) => call<{job: CustodyJob}>('manageErpCustody', companyId, 'commit', {id: job.id, fingerprint: job.fingerprint}),
};
