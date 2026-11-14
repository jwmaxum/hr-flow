const fields=['date','warehouseId','partnerId','movementLine','collectionAmount','receivedDate','collectionNotes','collectionReceipt','collectionAllocation'] as const;
export type ErpInputLocation={field:typeof fields[number];row?:number};
export function erpInputLocation(error:unknown):ErpInputLocation|undefined{
  if(!error||typeof error!=='object'||!('details' in error))return;
  const d=error.details;
  if(!d||typeof d!=='object'||!('kind' in d)||d.kind!=='ERP_INPUT'||!('field' in d)||!fields.some(f=>f===d.field))return;
  const row='row' in d?d.row:undefined;
  if(row!==undefined&&(typeof row!=='number'||!Number.isInteger(row)||row<1||row>50))return;
  return {field:d.field as ErpInputLocation['field'],...(typeof row==='number'?{row}:{})};
}
