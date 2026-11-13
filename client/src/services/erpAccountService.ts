import type {ReportRow} from './erpLedgerService';
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
export interface SettlementInput {type: 'ALLOCATE' | 'RELEASE' | 'TERMS' | 'FOLLOW_UP'; expectedDate?: string; assigneeId?: string; date: string; notes: string; receiptId?: string; lines?: {documentId: string; amount: string}[]; sourceId?: string; documentId?: string; dueDate?: string}
export interface SettlementJob {id: string; companyId: string; fingerprint: string; status: 'PENDING' | 'COMMITTED'; input: SettlementInput; summary: {type: string; partnerName: string; currency: string; total?: number; before?: number; after?: number; lines?: {documentId: string; documentNo: string; amountMinor: number}[]; documentNo?: string; previousDueDate?: string; dueDate?: string; previousExpectedDate?: string; expectedDate?: string; previousAssigneeName?: string; assigneeName?: string}}
export interface SettlementReport {
  snapshot:string;
  totals:{currency:string;balance:number;refundDue:number}[];
  companyId: string; asOf: string; lastDate: string | null; followUpLastDate: string | null; assignees: {id: string; name: string}[]; followUps: {id: string; date: string; documentNo: string; partnerName: string; expectedDate: string; assigneeName: string; notes: string}[];
  documents: {paymentTerms: 'CREDIT'|'PAID'|'UNCONFIRMED'; paymentStatus: string; id: string; documentNo: string; date: string; partnerId: string; partnerName: string; currency: string; billed: number; allocated: number; balance: number; dueDate: string; overdueDays: number; overdueAmount: number; credit: number; expectedDate: string; assigneeId: string; assigneeName: string; assigneeActive: boolean; followUpDate: string; followUpNotes: string; promiseOverdueDays: number}[];
  receipts: {id: string; date: string; reference: string; partnerId: string; partnerName: string; currency: string; amount: number; allocated: number; available: number; allocatable: number; cancelled: boolean}[];
  allocations: {id: string; date: string; receiptId: string; partnerName: string; currency: string; active: boolean; released: boolean; receiptCancelled: boolean; releaseDate: string; releaseNotes: string; notes: string; lines: {documentId: string; documentNo: string; amountMinor: number}[]}[];
  terms: {id: string; date: string; documentNo: string; partnerName: string; dueDate: string; notes: string}[];
  summaries: {partnerId: string; partnerName: string; currency: string; documentBalance: number; unallocated: number; balance: number; overdueAmount: number; credit: number; undated: number}[];
}
export interface PaymentOptions {receiptMode:'REUSE_FIRST'|'NEW';confirmNew:boolean;notes:string}
export interface PaymentInput extends PaymentOptions {documentId:string;date:string;amount?:string;method?:string;reference?:string}
export interface PaymentSummary {documentId:string;documentNo:string;partnerName:string;currency:string;date:string;billed:number;before:number;after:number;reused:number;newReceipt:number;receiptMode:string;allocations:{receiptReference:string;amount:number}[]}
export interface PaymentJob {id:string;companyId:string;status:'PENDING'|'COMMITTED';fingerprint:string;input:PaymentInput;summary:PaymentSummary}
export interface DashboardCurrency {currency:string;sales:number;salesGross:number;purchases:number;purchasesGross:number;creditSalesGross:number;unconfirmedSalesGross:number;receipts:number;outstanding:number;refundDue:number;documentOutstanding:number;unallocated:number}
export interface DashboardTrade {id:string;date:string;documentNo:string;partnerName:string;kind:string;currency:string;supply:number;tax:number;gross:number;amountKRW:number}
export interface ErpDashboard {companyId:string;companyName:string;snapshot:string;month:string;from:string;asOf:string;partialMonth:boolean;basisDate:string|null;inventoryValue:number;salesKRW:number;purchasesKRW:number;marginKRW:number;currencies:DashboardCurrency[];trend:{month:string;inventoryValue:number;salesKRW:number;purchasesKRW:number;outstandingKRW:number}[];assets:{itemId:string;warehouseId:string;code:string;name:string;unit:string;warehouseName:string;closingQuantity:number;closingValue:number}[];assetCount:number;sales:DashboardTrade[];saleCount:number;purchases:DashboardTrade[];purchaseCount:number;partners:SettlementReport['summaries'];partnerCount:number;pendingCount:number}
export interface ShipmentFilters {from:string;to:string;search:string;status:'ALL'|'OPEN'|'PAID'|'REFUND'}
export type ShipmentDocument = SettlementReport['documents'][number];
export interface ShipmentList {companyId:string;asOf:string;snapshot:string;rows:ShipmentDocument[];total:number;nextOffset:number|null}
export interface ShipmentLine extends ReportRow {quantity:number;returnableQuantity:number;supplyMinor:number;taxMinor:number;grossMinor:number;priceBasis:string;taxType:string;cost:number}
export interface ShipmentDetail {companyId:string;asOf:string;document:ShipmentDocument & {supplyMinor:number;taxMinor:number};rows:ShipmentLine[];events:ReceivableEvent[];allocations:SettlementReport['allocations'];unallocated:number;partnerBalance:number;suggestedDate:string}
export const erpFinance = {
  shipments:(companyId:string,filters:ShipmentFilters,offset=0,snapshot?:string)=>call<ShipmentList>('manageErpFinance',companyId,'shipmentList',{...filters,offset,...(snapshot?{snapshot}:{})}),
  shipment:(companyId:string,documentId:string)=>call<ShipmentDetail>('manageErpFinance',companyId,'shipmentDetail',{documentId}),
  dashboard:(companyId:string,month:string)=>call<ErpDashboard>('manageErpFinance',companyId,'dashboard',{month}),
  previewPayment:(companyId:string,id:string,input:PaymentInput)=>call<{job:PaymentJob}>('manageErpFinance',companyId,'paymentPreview',{id,input}),
  commitPayment:(companyId:string,job:PaymentJob)=>call<{job:PaymentJob}>('manageErpFinance',companyId,'paymentCommit',{id:job.id,fingerprint:job.fingerprint}),
  report: (companyId: string, from: string, to: string, partnerId = '', offset = 0, snapshot?: string) => call<ReceivableReport>('manageErpFinance', companyId, 'report', { from, to, partnerId, offset, ...(snapshot ? {snapshot} : {}) }),
  preview: (companyId: string, id: string, input: ReceiptInput) => call<{job: ReceiptJob}>('manageErpFinance', companyId, 'preview', {id, input}),
  commit: (companyId: string, job: ReceiptJob) => call<{job: ReceiptJob}>('manageErpFinance', companyId, 'commit', {id: job.id, fingerprint: job.fingerprint}),
  settlements: (companyId: string, to: string, partnerId = '') => call<SettlementReport>('manageErpFinance', companyId, 'settlementReport', {to, partnerId}),
  previewSettlement: (companyId: string, id: string, input: SettlementInput) => call<{job: SettlementJob}>('manageErpFinance', companyId, 'settlementPreview', {id,input}),
  commitSettlement: (companyId: string, job: SettlementJob) => call<{job: SettlementJob}>('manageErpFinance', companyId, 'settlementCommit', {id:job.id,fingerprint:job.fingerprint}),
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
