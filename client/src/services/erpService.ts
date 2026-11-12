import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { erpScope } from './erpLedgerService';

export type ErpKind = 'items' | 'warehouses' | 'partners';
export interface ErpRecord {
  id: string; code: string; name: string; active: boolean; revision: number; updatedAt: string;
  notes?: string; specification?: string; unit?: string; purchasePrice?: number; salePrice?: number;
  taxType?: string; group?: string; address?: string; type?: string; country?: string;
  registrationNumber?: string; contactName?: string; email?: string; phone?: string;
  itemType?: 'STOCK' | 'BUNDLE'; components?: {itemId: string; quantityScaled: number}[];
}
export interface ErpValues { code: string; name: string; active: boolean; notes: string; [key: string]: string | number | boolean | {itemId: string; quantity: string}[] }
export interface ErpCursor { key: string; id: string }
export interface ErpList { records: ErpRecord[]; canManage: boolean; nextCursor: ErpCursor | null }
export interface InventoryResult {
  item: ErpRecord; status: 'RECORDED' | 'UNINITIALIZED' | 'PENDING_COST'; quantity: number | null; value?: number | null;
  pendingOpening?: {basisDate: string; quantity: number | null; source: string; unit: string} | null;
  currency?: string; averagePrice?: number | null; checkedAt: string;
  virtual?: boolean;
  warehouses: { warehouseId: string; warehouseCode: string; warehouseName: string; warehouseActive: boolean;
    quantity: number; value?: number; updatedAt: string | null }[];
}
export interface PurchaseHistory {
  rows: { id: string; date: string; documentNo: string; warehouseName: string; quantity: number; price: number | null;
    currency: string; priceBasis: string; value: number; costPerUnit: number | null; cancelled: boolean; returnedQuantity: number }[];
  nextCursor: string | null;
}
const callable = httpsCallable<Record<string, unknown>, unknown>(functions, 'manageErp');
async function call<T>(companyId: string, action: string, data: Record<string, unknown>): Promise<T> {
  const write = action === 'save' || action === 'purchaseHistory' || data.kind === 'partners';
  const expected = erpScope(companyId, write), result = await callable({ ...data, companyId, action });
  if (erpScope(companyId, write) !== expected) throw new Error('로그인 사용자 또는 회사 권한이 변경되었습니다.');
  return result.data as T;
}
export const erpService = {
  list: (companyId: string, kind: ErpKind, search: string, searchBy: 'name' | 'code', cursor?: ErpCursor) =>
    call<ErpList>(companyId, 'list', { kind, search, searchBy, ...(cursor ? { cursor } : {}) }),
  save: (companyId: string, kind: ErpKind, id: string, expectedRevision: number, values: ErpValues) =>
    call<{ record: ErpRecord }>(companyId, 'save', { kind, id, expectedRevision, values }),
  inventory: (companyId: string, itemId: string) => call<InventoryResult>(companyId, 'inventory', { itemId }),
  purchaseHistory: (companyId: string, itemId: string, cursor?: string) => call<PurchaseHistory>(companyId, 'purchaseHistory', { itemId, ...(cursor ? { cursor } : {}) }),
};
