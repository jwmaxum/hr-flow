import {erpAccessOf} from '../utils/erpAccess';
import {useAuthStore} from '../store/authStore';
import { useEffect, useRef, useState } from 'react';
import { erpService } from '../services/erpService';
import type { ErpCursor, ErpRecord } from '../services/erpService';
import { erpLedgerService } from '../services/erpLedgerService';
import type { Correction, CorrectionInput, CorrectionType, ReportRow } from '../services/erpLedgerService';
import { getErrorMessage } from '../utils/errors';
import {ErpReturnSummary} from './ErpReturnSummary';
const labels: Record<CorrectionType,string> = { CANCEL:'문서 전체 취소', SALES_RETURN:'판매반품', PURCHASE_RETURN:'매입반품', COUNT:'실사 수량 조정', VALUE:'장부금액 조정' };
const number = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits:4 });
export function ErpCorrectionPanel({ companyId, type: initialType, source, date: initialDate, onClose, onCommitted, onStatement }: {
  companyId: string; type: CorrectionType; source?: ReportRow; date: string; onClose: () => void; onCommitted: (correction:Correction) => Promise<void>;onStatement?:(documentNo:string)=>void;
}) {
  const access=useAuthStore(s=>erpAccessOf(s.userData));
  const [type,setType] = useState(initialType), [date,setDate] = useState(initialDate), [reason,setReason] = useState('');
  const [quantity,setQuantity] = useState(''), [value,setValue] = useState('');
  const [itemId,setItemId] = useState(source?.itemId || ''), [warehouseId,setWarehouseId] = useState(source?.warehouseId || '');
  const [items,setItems] = useState<ErpRecord[]>([]), [warehouses,setWarehouses] = useState<ErpRecord[]>([]);
  const [itemCursor,setItemCursor] = useState<ErpCursor|null>(null), [warehouseCursor,setWarehouseCursor] = useState<ErpCursor|null>(null);
  const [preview,setPreview] = useState<Correction|null>(null), [dirty,setDirty] = useState(false), [confirmed,setConfirmed] = useState(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const live = useRef(true), heading = useRef<HTMLHeadingElement>(null), attempt = useRef<{key:string;id:string}|null>(null);
  const adjusting = type === 'COUNT' || type === 'VALUE';
  const canConfirm=access==='ADMIN'||access==='MANAGER'&&(type!=='CANCEL'||source?.type==='MOVEMENTS');
  useEffect(() => {
    live.current = true; heading.current?.focus();
    if (initialType === 'COUNT' || initialType === 'VALUE') void Promise.all([erpService.list(companyId,'items','','name'),erpService.list(companyId,'warehouses','','name')]).then(([a,b]) => {
      if (!live.current) return; setItems(a.records.filter(row=>row.active)); setWarehouses(b.records.filter(row=>row.active)); setItemCursor(a.nextCursor); setWarehouseCursor(b.nextCursor);
    }).catch(failure=>{if(live.current)setError(getErrorMessage(failure));});
    return () => { live.current = false; };
  },[companyId,initialType]);
  function changed() { setDirty(true); setConfirmed(false); }
  async function run(action:()=>Promise<void>) {
    if(busy)return; setBusy(true);setError('');setNotice('');
    try{await action();}catch(failure){if(live.current)setError(getErrorMessage(failure));}finally{if(live.current)setBusy(false);}
  }
  async function validate() {
    const input: CorrectionInput = {type,date,reason};
    if(adjusting) { Object.assign(input,{itemId,warehouseId}); if(type==='COUNT')input.quantity=quantity; if(value!=='')input.value=value; }
    else { input.sourceId=source?.id; if(type!=='CANCEL')input.quantity=quantity; }
    const key=JSON.stringify(input);if(attempt.current?.key!==key)attempt.current={key,id:crypto.randomUUID()};
    const result=await erpLedgerService.preview(companyId,attempt.current.id,input);
    if(!live.current)return;attempt.current=null;setPreview(result.correction);setDirty(false);setConfirmed(false);
    setNotice('미리보기입니다. 아래 내용을 확인한 뒤 확정해 주세요.');
  }
  return <section className="wf-panel erp-correction" aria-label="취소 반품 조정 처리">
    <div className="erp-list-head"><h2 ref={heading} tabIndex={-1} className="wf-section-title">{labels[type]}</h2><button className="wf-btn" disabled={busy} onClick={onClose}>처리 닫기</button></div>
    {source && <p className="wf-muted">선택: {source.documentNo || source.code} · {source.name} · {source.warehouseName}</p>}
    <p className="erp-form-note">{type==='CANCEL'?'선택 행이 속한 문서 전체를 반대로 기록합니다. 원장은 보존하며, 같은 품목·창고에 후속 거래나 연결된 반품이 있으면 취소를 차단합니다.':type==='SALES_RETURN'?'원출고의 단가와 출고원가에 비례해 반품합니다. 누적 반품수량은 원출고 수량을 넘을 수 없습니다.':type==='PURCHASE_RETURN'?'현재 이동평균 원가로 재고를 차감합니다. 원매입 기준 환불액은 재고 차감금액과 구분하여 표시합니다.':type==='COUNT'?'실제 확인한 재고수량을 입력하세요. 감소분은 이동평균 원가로 차감합니다. 증가하는 경우 증가분의 재고금액을 함께 입력하세요.':'수량을 유지하고 조정 후의 총 장부금액을 입력합니다. 재고수량이 0이면 금액도 0이어야 합니다.'}</p>
    <fieldset disabled={busy || !!preview && preview.status!=='PENDING'} className="erp-form-fields">
      {adjusting && <><label className="wf-field"><span>조정 방식</span><select className="wf-input" value={type} onChange={e=>{setType(e.target.value as CorrectionType);setValue('');changed();}}><option value="COUNT">실사 수량 조정</option><option value="VALUE">장부금액 조정</option></select></label><div />
        <label className="wf-field"><span>조정 품목</span><select className="wf-input" value={itemId} onChange={e=>{setItemId(e.target.value);changed();}}><option value="">품목 선택</option>{source?.itemId&&!items.some(r=>r.id===source.itemId)&&<option value={source.itemId}>{source.code} · {source.name}</option>}{items.map(row=><option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
        <label className="wf-field"><span>조정 창고</span><select className="wf-input" value={warehouseId} onChange={e=>{setWarehouseId(e.target.value);changed();}}><option value="">창고 선택</option>{source?.warehouseId&&!warehouses.some(r=>r.id===source.warehouseId)&&<option value={source.warehouseId}>{source.warehouseName}</option>}{warehouses.map(row=><option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
        {itemCursor&&<button className="wf-btn" onClick={()=>void run(async()=>{const r=await erpService.list(companyId,'items','','name',itemCursor);if(live.current){setItems(current=>[...current,...r.records.filter(row=>row.active)]);setItemCursor(r.nextCursor);}})}>품목 더 불러오기</button>}
        {warehouseCursor&&<button className="wf-btn" onClick={()=>void run(async()=>{const r=await erpService.list(companyId,'warehouses','','name',warehouseCursor);if(live.current){setWarehouses(current=>[...current,...r.records.filter(row=>row.active)]);setWarehouseCursor(r.nextCursor);}})}>창고 더 불러오기</button>}
      </>}
      <label className="wf-field"><span>처리일</span><input className="wf-input" type="date" value={date} min="2000-01-01" max="2099-12-31" onChange={e=>{setDate(e.target.value);changed();}} /></label>
      {type!=='CANCEL'&&type!=='VALUE'&&<label className="wf-field"><span>{type==='COUNT'?'실사 후 총수량':'반품 수량'}</span><input className="wf-input" inputMode="decimal" value={quantity} onChange={e=>{setQuantity(e.target.value);changed();}} /></label>}
      {adjusting&&<label className="wf-field"><span>{type==='COUNT'?'수량 증가분 재고금액 (원)':'조정 후 총 장부금액 (원)'}</span><input className="wf-input" inputMode="numeric" value={value} onChange={e=>{setValue(e.target.value);changed();}} placeholder={type==='COUNT'?'수량 감소 시 비워 두세요':''} /></label>}
      <label className="wf-field erp-form-wide"><span>처리 사유</span><textarea className="wf-input" rows={3} maxLength={500} value={reason} onChange={e=>{setReason(e.target.value);changed();}} placeholder="사유를 3자 이상 입력하세요." /></label>
    </fieldset>
    {error&&<p role="alert" className="erp-error">{error}</p>}{notice&&<p role="status" className="erp-success">{notice}</p>}
    {(!preview || preview.status==='PENDING')&&<button className="wf-btn wf-btn-primary" disabled={busy||reason.trim().length<3} onClick={()=>void run(validate)}>{busy?'처리 중…':'변동 미리보기'}</button>}
    {preview&&<div className="erp-correction-preview"><h3 className="wf-section-title">변동 미리보기 · {preview.rows.length}행</h3><div className="erp-table-scroll" tabIndex={0} role="region" aria-label="조정 전후 재고"><table className="erp-table"><thead><tr><th>품목·창고</th><th>처리</th><th>수량 전 → 후</th><th>금액 전 → 후 (원)</th><th>원거래 반품 공급가</th></tr></thead><tbody>{preview.rows.map(row=><tr key={row.rowNo}><td>{row.name}<small className="erp-cell-note">{row.warehouseName}</small></td><td>{row.direction}</td><td>{number(row.beforeQuantity)} → {number(row.afterQuantity)} {row.unit}</td><td>{number(row.beforeValue)} → {number(row.afterValue)}</td><td>{row.refundKRW==null?'—':`${number(row.refundKRW)}원`}<small className="erp-cell-note">{row.refundSupply==null?'':`${number(row.refundSupply)} + 세액 ${number(row.refundTax||0)} ${row.currency}`}</small></td></tr>)}</tbody></table></div>
      {preview.settlement&&<ErpReturnSummary value={preview.settlement} pending={preview.status!=='COMMITTED'}/>}
      {preview.status==='COMMITTED'&&preview.settlement&&onStatement&&<button className="wf-btn wf-btn-primary" onClick={()=>onStatement(preview.settlement!.documentNo)}>거래명세표 정정</button>}
      {preview.status==='AWAITING_APPROVAL'?<p role="status" className="erp-notice">ADMIN 승인 대기 중입니다. 승인 전에는 재고가 변경되지 않습니다.</p>:preview.status==='COMMITTED'?<p role="status" className="erp-success">처리 완료. 원장과 재고가 함께 반영되었습니다.</p>:<><label className="erp-active-field"><input type="checkbox" checked={confirmed} disabled={busy||dirty} onChange={e=>setConfirmed(e.target.checked)} />사유와 전체 변동 내역을 확인했습니다.</label>{dirty&&<p className="erp-notice">입력이 변경되었습니다. 미리보기를 다시 실행해 주세요.</p>}<button className="wf-btn wf-btn-primary" disabled={busy||dirty||!confirmed} onClick={()=>void run(async()=>{const result=await erpLedgerService.commit(companyId,preview);if(!live.current)return;setPreview(result.correction);setConfirmed(false);await onCommitted(result.correction);})}>{canConfirm?'취소·반품·조정 확정':'ADMIN 승인 요청'}</button></>}
    </div>}
  </section>;
}
