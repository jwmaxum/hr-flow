import { useEffect, useRef, useState } from 'react';
import { erpImportService as api } from '../services/erpImportService';
import type { ErpImport, PendingOpeningList } from '../services/erpImportService';
import { erpChoices } from '../services/erpAccountService';
import type { ErpRecord } from '../services/erpService';
import { getErrorMessage } from '../utils/errors';
const number=(value:number)=>value.toLocaleString('ko-KR',{maximumFractionDigits:4});

export function ErpOpeningPanel({companyId,initialItemId='',onInventory}:{companyId:string;initialItemId?:string;onInventory:()=>void}) {
  const [data,setData]=useState<PendingOpeningList|null>(null),[warehouses,setWarehouses]=useState<ErpRecord[]>([]);
  const [selected,setSelected]=useState<string[]>([]),[prices,setPrices]=useState<Record<string,string>>({}),[quantities,setQuantities]=useState<Record<string,string>>({});
  const [date,setDate]=useState(''),[warehouseId,setWarehouseId]=useState(''),[reason,setReason]=useState(''),[zero,setZero]=useState(false);
  const [job,setJob]=useState<ErpImport|null>(null),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const live=useRef(true),lock=useRef(false),attempt=useRef(crypto.randomUUID());
  useEffect(()=>{live.current=true;void Promise.all([api.openingList(companyId),erpChoices(companyId,'warehouses')]).then(([r,w])=>{if(live.current){setData(r);setWarehouses(w);setDate(r.suggestedDate);setWarehouseId(w.find(row=>row.active&&row.code==='OPENING')?.id||'');setSelected(r.records.some(row=>row.id===initialItemId&&row.pendingOpening.status==='PENDING_COST')?[initialItemId]:[]);}}).catch(e=>{if(live.current)setError(getErrorMessage(e));}).finally(()=>{if(live.current)setBusy(false);});return()=>{live.current=false;};},[companyId,initialItemId]);
  function changed(){setJob(null);setConfirm(false);setError('');attempt.current=crypto.randomUUID();}
  async function run(work:()=>Promise<void>){if(busy||lock.current)return;lock.current=true;setBusy(true);setError('');try{await work();}catch(e){if(live.current)setError(getErrorMessage(e));}finally{lock.current=false;if(live.current)setBusy(false);}}
  async function reload(){const r=await api.openingList(companyId);if(live.current)setData(r);}
  const pending=data?.records.filter(row=>row.pendingOpening.status==='PENDING_COST')||[],done=job?.status==='COMMITTED';
  return <div className="erp-movement"><section className="wf-panel" aria-label="기초재고 원가 확정" aria-busy={busy}>
    <h2 className="wf-section-title">기초재고 원가 확정</h2>
    <p className="wf-muted">원가 미확정으로 이관 대기 중인 품목을 선택하고 실제 원가를 입력하세요. 공란 원가를 0원으로 처리하지 않습니다. 원본 수량이 있는 품목은 그대로 사용하며, 원본 수량 공란은 확인한 수량을 입력합니다.</p>
    {data?.lastDate&&<p className="erp-notice">입출고가 이미 시작되어 마지막 거래일 {data.lastDate} 이후의 반영일에 재고 증가로 기록합니다. 원본 기준일은 증빙으로 보존하며 과거 기간의 기초재고를 바꾸지 않습니다.</p>}
    <form onSubmit={e=>{e.preventDefault();void run(async()=>{const rows=pending.filter(row=>selected.includes(row.id));const result=await api.openingPreview(companyId,attempt.current,{date,warehouseId,reason,zeroCostConfirmed:zero,lines:rows.map(row=>({itemId:row.id,quantity:row.pendingOpening.quantity==null?quantities[row.id]||'':String(row.pendingOpening.quantity),price:prices[row.id]||''}))});if(live.current){setJob(result.import);setConfirm(false);}});}}>
      <fieldset className="erp-form-fields" disabled={busy||done}>
        <label className="wf-field"><span>확정 창고 *</span><select className="wf-input" required value={warehouseId} onChange={e=>{setWarehouseId(e.target.value);changed();}}><option value="">창고 선택</option>{warehouses.filter(w=>w.active).map(w=><option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>
        <label className="wf-field"><span>재고 반영일 *</span><input className="wf-input" type="date" required value={date} onChange={e=>{setDate(e.target.value);changed();}} /></label>
        <div className="erp-form-wide erp-table-scroll"><table className="erp-table"><caption>원가 미확정 이관 대기 품목</caption><thead><tr><th>선택</th><th>품목·원본 위치</th><th>원본 기준일</th><th>확정 수량</th><th>실제 원가 (원/단위)</th></tr></thead><tbody>{pending.map(row=><tr key={row.id}><td><input type="checkbox" aria-label={`${row.code} 확정 선택`} disabled={!row.active} checked={selected.includes(row.id)} onChange={e=>{setSelected(ids=>e.target.checked?[...ids,row.id]:ids.filter(id=>id!==row.id));changed();}} /></td><td>{row.code} · {row.name}<small className="erp-cell-note">{row.pendingOpening.source}{!row.active?' · 사용 중지':''}</small></td><td>{row.pendingOpening.basisDate}</td><td>{row.pendingOpening.quantity==null?<input className="wf-input" aria-label={`${row.code} 원본 공란 수량`} inputMode="decimal" maxLength={30} required={selected.includes(row.id)} disabled={!selected.includes(row.id)} value={quantities[row.id]||''} onChange={e=>{setQuantities(values=>({...values,[row.id]:e.target.value}));changed();}} />:number(row.pendingOpening.quantity)} {row.pendingOpening.unit}</td><td><input className="wf-input" aria-label={`${row.code} 실제 원가`} inputMode="decimal" maxLength={30} required={selected.includes(row.id)} disabled={!selected.includes(row.id)} value={prices[row.id]||''} placeholder="실제 원가 입력" onChange={e=>{setPrices(values=>({...values,[row.id]:e.target.value}));changed();}} /></td></tr>)}</tbody></table></div>
        {!pending.length&&!busy&&<p>원가 확정을 기다리는 품목이 없습니다.</p>}
        <label className="wf-field erp-form-wide"><span>원가 확인 근거 *</span><input className="wf-input" required minLength={3} maxLength={500} value={reason} placeholder="매입 증빙번호·원가 확인 내용" onChange={e=>{setReason(e.target.value);changed();}} /></label>
        <label className="erp-active-field erp-form-wide"><input type="checkbox" checked={zero} onChange={e=>{setZero(e.target.checked);changed();}} />0원 입력 품목은 실제 무상 재고이며 확인 근거를 입력했습니다.</label>
        <div className="erp-actions"><button className="wf-btn wf-btn-primary" disabled={!selected.length||selected.length>50}>원가 검증·미리보기</button><span>{selected.length}개 선택 / 최대 50개</span></div>
      </fieldset>
    </form>
    {job&&<div aria-label="기초재고 원가 미리보기"><h3>원가·수량·반영일 확인</h3><p>원본 기준일 {job.basisDate} · 확정 후 입력 원가는 기본 매입단가에도 반영됩니다.</p>
      {job.preview.errors.map((issue,i)=><p className="erp-error" key={i}>{issue.row}행: {issue.message}</p>)}{job.preview.warnings.map((issue,i)=><p className="erp-notice" key={i}>{issue.message}</p>)}
      <div className="erp-table-scroll"><table className="erp-table"><thead><tr><th>품목·창고</th><th>반영일·유형</th><th>수량</th><th>원가</th><th>재고금액</th></tr></thead><tbody>{job.preview.rows.map((row,i)=><tr key={i}><td>{row.code} · {row.name}<small className="erp-cell-note">{row.warehouseName}</small></td><td>{row.date} · {row.postingMode==='ADJUSTMENT'?'당일 재고 증가':'기초재고'}</td><td>{number(row.quantity)} {row.unit}</td><td>{number(row.price||0)}원</td><td>{row.value==null?'검증 필요':`${number(row.value)}원`}</td></tr>)}</tbody></table></div>
      {done?<p role="status" className="erp-success">기초재고 원가 확정 완료</p>:<><label className="erp-active-field"><input type="checkbox" disabled={busy||!job.preview.canCommit} checked={confirm} onChange={e=>setConfirm(e.target.checked)} />원본 수량·실제 원가·창고·반영일과 재고자산 증가를 확인했습니다.</label><button className="wf-btn wf-btn-primary" disabled={busy||!confirm||!job.preview.canCommit} onClick={()=>void run(async()=>{const r=await api.commit(companyId,job);if(live.current)setJob(r.import);await reload();})}>기초재고 원가 확정</button></>}
      <div className="erp-actions"><button className="wf-btn" disabled={busy} onClick={()=>{changed();setSelected([]);setPrices({});setReason('');setZero(false);}}>{done?'다른 품목 원가 입력':'입력 재검토'}</button><button className="wf-btn" disabled={busy} onClick={onInventory}>재고현황 확인</button></div>
    </div>}
    <div className="erp-actions"><button className="wf-btn" disabled={busy} onClick={()=>void run(async()=>{await reload();changed();setSelected([]);})}>대기 목록 새로고침</button></div>
    {error&&<p role="alert" className="erp-error">{error}</p>}{busy&&<p role="status">기초재고 원가 자료를 확인하고 있습니다.</p>}
  </section>
  <section className="wf-panel"><h2 className="wf-section-title">원가 확정 이력</h2><p className="wf-muted">확정 이력은 보존합니다. 확정 후 수량 오류는 실사조정, 원가 오류는 금액조정에서 바로잡습니다.</p><div className="erp-table-scroll"><table className="erp-table"><thead><tr><th>품목</th><th>원본 기준일</th><th>반영일</th><th>창고</th><th>확정 수량</th><th>원가·재고금액</th><th>확인 근거</th></tr></thead><tbody>{data?.records.filter(r=>r.pendingOpening.status==='CONFIRMED').map(r=><tr key={r.id}><td>{r.code} · {r.name}</td><td>{r.pendingOpening.basisDate}</td><td>{r.pendingOpening.postingDate}</td><td>{r.pendingOpening.warehouseName}</td><td>{number(r.pendingOpening.confirmedQuantity||0)} {r.unit}</td><td>{number(r.pendingOpening.price||0)}원 · {number(r.pendingOpening.value||0)}원</td><td>{r.pendingOpening.reason}</td></tr>)}</tbody></table></div></section></div>;
}
