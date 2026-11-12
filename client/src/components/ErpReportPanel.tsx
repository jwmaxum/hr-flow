import { useEffect, useRef, useState } from 'react';
import { Download, ListFilter, RotateCcw } from 'lucide-react';
import { erpService } from '../services/erpService';
import type { ErpCursor, ErpRecord } from '../services/erpService';
import { erpLedgerService, erpScope } from '../services/erpLedgerService';
import type { CorrectionType, ErpReport, ReportFilters, ReportMeta, ReportRow } from '../services/erpLedgerService';
import { ErpCorrectionPanel } from './ErpCorrectionPanel';
import { getErrorMessage } from '../utils/errors';
const number = (value?: number|null) => value==null?'—':value.toLocaleString('ko-KR',{maximumFractionDigits:4});
const today = () => { const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return ['year','month','day'].map(type=>parts.find(p=>p.type===type)!.value).join('-'); };
const nextDay = (value:string) => {const date=new Date(`${value}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+1);return date.toISOString().slice(0,10);};
export function ErpReportPanel({companyId,canManage}:{companyId:string;canManage:boolean}) {
  const [meta,setMeta]=useState<ReportMeta|null>(null),[filters,setFilters]=useState<ReportFilters>({from:today().slice(0,8)+'01',to:today(),search:'',itemId:'',warehouseId:''});
  const [view,setView]=useState<'summary'|'detail'>('summary'),[report,setReport]=useState<ErpReport|null>(null);
  const [warehouses,setWarehouses]=useState<ErpRecord[]>([]),[cursor,setCursor]=useState<ErpCursor|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [editing,setEditing]=useState<{type:CorrectionType;source?:ReportRow;key:string}|null>(null);
  const live=useRef(true);
  useEffect(()=>{live.current=true;void Promise.all([erpLedgerService.meta(companyId),erpService.list(companyId,'warehouses','','name')]).then(([m,w])=>{
    if(!live.current)return;setMeta(m);setWarehouses(w.records);setCursor(w.nextCursor);
    setFilters(current=>{const from=m.basisDate&&current.from<=m.basisDate?nextDay(m.basisDate):current.from;return {...current,from,to:current.to<from?from:current.to};});
  }).catch(failure=>{if(live.current)setError(getErrorMessage(failure));});return()=>{live.current=false;};},[companyId]);
  async function run(action:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setNotice('');try{await action();}catch(failure){if(live.current)setError(getErrorMessage(failure));}finally{if(live.current)setBusy(false);}}
  async function query(selected=filters,selectedView=view){const result=await erpLedgerService.report(companyId,selected,selectedView);if(live.current){setReport(result);setMeta(result);setFilters(selected);setView(selectedView);}}
  function change(patch:Partial<ReportFilters>){setFilters(current=>({...current,...patch}));setReport(null);setEditing(null);}
  const dirty=report&&(report.view!==view||(['from','to','search','itemId','warehouseId'] as const).some(key=>report.filters[key]!==filters[key]));
  function edit(type:CorrectionType,source?:ReportRow){setEditing({type,source,key:crypto.randomUUID()});}
  async function download(){
    if(!report)return;const expected=erpScope(companyId);const data=await erpLedgerService.export(companyId,report);
    const {erpWorkbook}=await import('../utils/erpWorkbook');const blob=await erpWorkbook(data);const latest=await erpLedgerService.meta(companyId);
    if(!live.current||expected!==erpScope(companyId)||latest.canManage!==data.canManage||latest.revision!==data.revision)throw new Error('권한 또는 원장이 변경되었습니다. 다시 조회해 주세요.');
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`${data.view==='summary'?'입출고총괄':'상세원장'}_${data.filters.from}_${data.filters.to}.xlsx`;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    setNotice(`전체 ${data.totalRows}행을 Excel로 내려받았습니다.`);
  }
  return <div className="erp-reports">
    <section className="wf-panel" aria-label="기간별 원장 조회 조건"><div className="erp-list-head"><h2 className="wf-section-title">기간별 입출고 총괄·상세 원장</h2>{canManage&&<button className="wf-btn" disabled={busy||!meta?.basisDate} onClick={()=>edit('COUNT')}>재고 조정</button>}</div>
      <p className="wf-muted">{meta?.basisDate?`기초재고 마감일 ${meta.basisDate} · ${canManage?'금액·원가 조회':'수량 조회 전용'}`:'확정된 기초재고가 있어야 기간별 조회를 시작할 수 있습니다.'}</p>
      <fieldset className="erp-form-fields" disabled={busy}>
        <label className="wf-field"><span>조회 시작일</span><input className="wf-input" type="date" value={filters.from} onChange={e=>change({from:e.target.value})}/></label>
        <label className="wf-field"><span>조회 종료일</span><input className="wf-input" type="date" value={filters.to} onChange={e=>change({to:e.target.value})}/></label>
        <label className="wf-field"><span>품목명·코드 검색</span><input className="wf-input" value={filters.search} maxLength={120} onChange={e=>change({search:e.target.value,itemId:''})} placeholder="품목명 또는 코드의 일부"/></label>
        <label className="wf-field"><span>조회 창고</span><select className="wf-input" value={filters.warehouseId} onChange={e=>change({warehouseId:e.target.value})}><option value="">전체 창고</option>{warehouses.map(row=><option key={row.id} value={row.id}>{row.code} · {row.name}{row.active?'':' (중지)'}</option>)}</select></label>
      </fieldset>
      {cursor&&<button className="wf-btn" disabled={busy} onClick={()=>void run(async()=>{const r=await erpService.list(companyId,'warehouses','','name',cursor);if(live.current){setWarehouses(current=>[...current,...r.records]);setCursor(r.nextCursor);}})}>창고 더 불러오기</button>}
      {filters.itemId&&<p className="erp-notice">선택한 품목으로 조회합니다. <button className="wf-btn" disabled={busy} onClick={()=>change({itemId:''})}>품목 선택 해제</button></p>}
      <div className="erp-actions"><button className="wf-btn" aria-pressed={view==='summary'} disabled={busy} onClick={()=>{setView('summary');setReport(null);setEditing(null);}}>입출고 총괄</button><button className="wf-btn" aria-pressed={view==='detail'} disabled={busy} onClick={()=>{setView('detail');setReport(null);setEditing(null);}}>상세 원장</button><button className="wf-btn wf-btn-primary" disabled={busy||!meta?.basisDate} onClick={()=>void run(()=>query())}><ListFilter size={16}/>{busy?'처리 중…':'원장 조회'}</button></div>
    </section>
    {error&&<p role="alert" className="erp-error">{error}</p>}{notice&&<p role="status" className="erp-success">{notice}</p>}
    {editing&&<ErpCorrectionPanel key={editing.key} companyId={companyId} type={editing.type} source={editing.source} date={meta?.lastDate&&meta.lastDate>today()?meta.lastDate:today()} onClose={()=>setEditing(null)} onCommitted={async()=>{await query();}}/>}
    {report&&!dirty&&<section className="wf-panel" aria-label={report.view==='summary'?'입출고 총괄 결과':'품목별 상세 원장 결과'}>
      <div className="erp-list-head"><div><h2 className="wf-section-title">{report.view==='summary'?'입출고 총괄':'품목별 상세 원장'}</h2><p className="wf-muted">{report.filters.from} ~ {report.filters.to} · 전체 {report.totalRows}행 · {report.rows.length}행 표시</p></div><button className="wf-btn" disabled={busy||!report.rows.length} onClick={()=>void run(download)}><Download size={16}/>전체 Excel 내려받기</button></div>
      <p className="erp-form-note">기초 + 입고 − 출고 + 이동입고 − 이동출고 + 조정 = 기말. 취소·반품은 순액에 포함합니다. 상세 잔량·잔액은 각 품목·창고별 누적값입니다.</p>
      <div className="erp-report-totals">{report.unitTotals?.map(row=><div key={row.unit}><span>기말수량 · {row.unit}</span><strong>{number(row.closingQuantity)}</strong></div>)}{report.canManage&&report.totals&&<><div><span>기말 재고금액</span><strong>{number(report.totals.closingValue)}원</strong></div><div><span>순매출</span><strong>{number(report.totals.salesKRW)}원</strong></div><div><span>매출마진</span><strong>{number(report.totals.marginKRW)}원</strong></div></>}</div>
      <div className="erp-table-scroll" tabIndex={0} role="region" aria-label="원장 표 가로 스크롤"><table className="erp-table erp-report-table">
        {report.view==='summary'?<><thead><tr><th>품목·규격</th><th>창고</th><th>단위</th><th>기초수량</th><th>입고수량</th><th>출고수량</th><th>이동입고수량</th><th>이동출고수량</th><th>조정수량</th><th>기말수량</th>{report.canManage&&<><th>기초금액</th><th>입고금액</th><th>평균입고단가</th><th>출고원가</th><th>이동입고금액</th><th>이동출고금액</th><th>조정금액</th><th>기말금액</th><th>순매출</th><th>매출마진</th></>}<th>조회·처리</th></tr></thead><tbody>{report.rows.map(row=><tr key={`${row.itemId}:${row.warehouseId}`}><td><strong>{row.name}</strong><small className="erp-cell-note">{row.code} · {row.specification}</small></td><td>{row.warehouseName}</td><td>{row.unit}</td>{(['openingQuantity','inQuantity','outQuantity','transferInQuantity','transferOutQuantity','adjustQuantity','closingQuantity'] as const).map(key=><td className="erp-number" key={key}>{number(row[key])}</td>)}{report.canManage&&(['openingValue','inValue','averageInPrice','outValue','transferInValue','transferOutValue','adjustValue','closingValue','salesKRW','marginKRW'] as const).map(key=><td className="erp-number" key={key}>{number(row[key])}</td>)}<td><div className="erp-row-actions"><button className="wf-btn" disabled={busy} onClick={()=>void run(()=>query({...report.filters,itemId:row.itemId,warehouseId:row.warehouseId},'detail'))}>{row.name} 상세 원장</button>{canManage&&<button className="wf-btn" disabled={busy} onClick={()=>edit('COUNT',row)}>실사 조정</button>}</div></td></tr>)}</tbody></>:<><thead><tr><th>거래일·순서</th><th>문서·유형</th><th>품목·창고</th><th>증감수량</th><th>잔량</th>{report.canManage&&<><th>거래처·단가</th><th>증감금액</th><th>잔액</th><th>순매출·원가</th><th>원거래 환불액</th><th>사유·연결</th><th>처리</th></>}</tr></thead><tbody>{report.rows.map(row=><tr key={row.id}><td>{row.date}<small className="erp-cell-note">{row.order} · {row.rowNo}행</small></td><td>{row.documentNo}<small className="erp-cell-note">{row.direction}{row.transferWarehouseName?` · 상대창고 ${row.transferWarehouseName}`:''}{row.cancelledBy?' · 취소됨':''}</small></td><td>{row.name}<small className="erp-cell-note">{row.code} · {row.warehouseName}</small></td><td className="erp-number">{number(row.quantityDelta)} {row.unit}</td><td className="erp-number">{number(row.balanceQuantity)} {row.unit}</td>{report.canManage&&<><td>{row.partnerName||'—'}<small className="erp-cell-note">{number(row.price)} {row.currency}</small></td><td className="erp-number">{number(row.valueDelta)}</td><td className="erp-number">{number(row.balanceValue)}</td><td className="erp-number">{number(row.salesKRW)} / {number(row.cogsKRW)}</td><td className="erp-number">{number(row.refundKRW)}</td><td>{row.reason||'—'}<small className="erp-cell-note">{row.sourceDocumentNo?`원문서 ${row.sourceDocumentNo}`:''}{row.returnedQuantity?` · 누적 반품 ${number(row.returnedQuantity)} ${row.unit}`:''}</small></td><td><div className="erp-row-actions">{!row.cancelledBy&&row.type==='MOVEMENTS'&&<button className="wf-btn" disabled={busy} aria-label={`${row.documentNo} ${row.rowNo}행 반품`} onClick={()=>edit(row.direction==='출고'?'SALES_RETURN':'PURCHASE_RETURN',row)}>반품</button>}{!row.cancelledBy&&row.operationType!=='CANCEL'&&<button className="wf-btn" disabled={busy} aria-label={`${row.documentNo} ${row.rowNo}행 문서 취소`} onClick={()=>edit('CANCEL',row)}><RotateCcw size={14}/>문서 취소</button>}</div></td></>}</tr>)}</tbody></>}
      </table></div>
      {!report.rows.length&&<p className="erp-empty">조회 기간에 표시할 원장이 없습니다.</p>}
      {report.nextCursor&&<button className="wf-btn" disabled={busy} onClick={()=>void run(async()=>{const r=await erpLedgerService.report(companyId,report.filters,report.view,report.nextCursor!);if(live.current)setReport({...r,rows:[...report.rows,...r.rows]});})}>원장 더 보기</button>}
      <p className="erp-form-note">금액은 별도 표기 없는 경우 원화입니다. 매출마진은 순매출에서 순매출원가를 뺀 값이며, 실사·장부금액 조정 및 매입반품 원가차이는 포함하지 않습니다.</p>
    </section>}
  </div>;
}
