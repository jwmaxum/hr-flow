import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

export type ErpKind = 'items' | 'warehouses' | 'partners';
export interface ErpRecord {
  id: string; code: string; name: string; active: boolean; revision: number; updatedAt: string;
  notes?: string; specification?: string; unit?: string; purchasePrice?: number; salePrice?: number;
  taxType?: string; group?: string; address?: string; type?: string; country?: string;
  registrationNumber?: string; contactName?: string; email?: string; phone?: string;
}
export interface ErpValues { code: string; name: string; active: boolean; notes: string; [key: string]: string | number | boolean }
export interface ErpCursor { key: string; id: string }
export interface ErpList { records: ErpRecord[]; canManage: boolean; nextCursor: ErpCursor | null }
export interface InventoryResult {
  item: ErpRecord; status: 'RECORDED' | 'UNINITIALIZED'; quantity: number | null; value?: number | null;
  currency?: string; checkedAt: string;
  warehouses: { warehouseId: string; warehouseCode: string; warehouseName: string; warehouseActive: boolean;
    quantity: number; value?: number; updatedAt: string | null }[];
}
const callable = httpsCallable<Record<string, unknown>, unknown>(functions, 'manageErp');
async function call<T>(companyId: string, action: string, data: Record<string, unknown>): Promise<T> {
  return (await callable({ ...data, companyId, action })).data as T;
}
export const erpService = {
  list: (companyId: string, kind: ErpKind, search: string, searchBy: 'name' | 'code', cursor?: ErpCursor) =>
    call<ErpList>(companyId, 'list', { kind, search, searchBy, ...(cursor ? { cursor } : {}) }),
  save: (companyId: string, kind: ErpKind, id: string, expectedRevision: number, values: ErpValues) =>
    call<{ record: ErpRecord }>(companyId, 'save', { kind, id, expectedRevision, values }),
  inventory: (companyId: string, itemId: string) => call<InventoryResult>(companyId, 'inventory', { itemId }),
};
