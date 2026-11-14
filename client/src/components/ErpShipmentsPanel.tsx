import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import {erpFinance as api, erpToday, erpMoney as money} from '../services/erpAccountService';
import type {ShipmentDetail, ShipmentFilters, ShipmentLine, ShipmentList} from '../services/erpAccountService';
import {ErpCollectionPanel} from './ErpCollectionPanel';
import {ErpCorrectionPanel} from './ErpCorrectionPanel';
import {ErpRecoveryPanel} from './ErpRecoveryPanel';
import {ErpReturnSummary} from './ErpReturnSummary';
import type {ReturnSettlement} from '../services/erpLedgerService';
import {getErrorMessage} from '../utils/errors';
const Documents=lazy(()=>import('./ErpDocumentsPanel').then(m=>({default:m.ErpDocumentsPanel})));
const number=(value:number)=>value.toLocaleString('ko-KR',{maximumFractionDigits:4});
const statuses:Record<string,string>={PAID:'입금완료',PARTIAL:'부분수금',UNPAID:'미수',CREDIT:'외상',UNCONFIRMED:'기존 출고',REFUND_DUE:'반환 예정 확인',NO_BALANCE:'잔액 없음'};

export function ErpShipmentsPanel({companyId,initialDocumentNo='',onFinance}:{companyId:string;initialDocumentNo?:string;onFinance:()=>void}){
  const [filters,setFilters]=useState<ShipmentFilters>({from:initialDocumentNo?'2000-01-01':erpToday().slice(0,8)+'01',to:erpToday(),search:initialDocumentNo,status:'ALL'});
  const [list,setList]=useState<ShipmentList|null>(null),[detail,setDetail]=useState<ShipmentDetail|null>(null),[selected,setSelected]=useState('');
  const [returnResult,setReturnResult]=useState<ReturnSettlement|null>(null);
  const [tab,setTab]=useState<'PAYMENT'|'RETURN'|'RECOVERY'|'STATEMENT'|'DETAIL'>('PAYMENT'),[returnRow,setReturnRow]=useState<ShipmentLine|null>(null);
  const [busy,setBusy]=useState(false),[loadingDetail,setLoadingDetail]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const live=useRef(true),lock=useRef(false),selection=useRef(''),query=useRef(filters),detailEpoch=useRef(0),listEpoch=useRef(0),heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{live.current=true;let active=true;const epoch=++listEpoch.current;void api.shipments(companyId,query.current).then(r=>{if(active&&listEpoch.current===epoch){setList(r);const match=r.rows.find(row=>row.documentNo===initialDocumentNo);if(match)setSelected(match.id);}}).catch(e=>{if(active&&listEpoch.current===epoch)setError(getErrorMessage(e));});return()=>{active=false;live.current=false;};},[companyId,initialDocumentNo]);
  useEffect(()=>{
    let active=true;selection.current=selected;const epoch=++detailEpoch.current;setDetail(null);setReturnRow(null);setReturnResult(null);setNotice('');setLoadingDetail(!!selected);setError('');
    if(selected)void api.shipment(companyId,selected).then(r=>{if(active&&detailEpoch.current===epoch)setDetail(r);}).catch(e=>{if(active&&detailEpoch.current===epoch)setError(getErrorMessage(e));}).finally(()=>{if(active&&detailEpoch.current===epoch)setLoadingDetail(false);});
    return()=>{active=false;};
  },[companyId,selected]);
  async function run(action:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await action();}catch(e){if(live.current)setError(getErrorMessage(e));}finally{lock.current=false;if(live.current)setBusy(false);}}
  async function refresh(){setReturnResult(null);const id=selection.current,epoch=++detailEpoch.current,listVersion=++listEpoch.current;const [l,d]=await Promise.all([api.shipments(companyId,query.current),id?api.shipment(companyId,id):Promise.resolve(null)]);if(live.current){if(listEpoch.current===listVersion)setList(l);if(selection.current===id&&detailEpoch.current===epoch)setDetail(d);}}
  const doc=detail?.document;
  useEffect(()=>{heading.current?.focus();},[doc?.id]);
  return <div className="erp-shipments" aria-busy={busy}>
    <section className="wf-panel" aria-label="출고 문서 조회"><div className="erp-list-head"><h2 className="wf-section-title">출고 문서 통합 관리</h2><button className="wf-btn" disabled={busy} onClick={()=>void run(refresh)}>문서·잔액 새로고침</button></div>
      <p className="wf-muted">출고 문서를 선택해 수금·반품·거래명세표를 처리하세요. 잔액은 현재 기준이며 매출액은 부가세를 포함합니다.</p>
      <form className="erp-form-fields" onSubmit={e=>{e.preventDefault();void run(async()=>{query.current={...filters};const epoch=++listEpoch.current;const r=await api.shipments(companyId,query.current);if(live.current&&listEpoch.current===epoch){setList(r);setSelected('');}});}}>
        <label className="wf-field"><span>출고 시작일</span><input className="wf-input" type="date" required value={filters.from} onChange={e=>setFilters(v=>({...v,from:e.target.value}))}/></label>
        <label className="wf-field"><span>출고 종료일</span><input className="wf-input" type="date" required value={filters.to} onChange={e=>setFilters(v=>({...v,to:e.target.value}))}/></label>
        <label className="wf-field"><span>문서번호·거래처 검색</span><input className="wf-input" maxLength={80} value={filters.search} onChange={e=>setFilters(v=>({...v,search:e.target.value}))}/></label>
        <label className="wf-field"><span>수금 상태</span><select aria-label="출고 문서 수금 상태" className="wf-input" value={filters.status} onChange={e=>setFilters(v=>({...v,status:e.target.value as ShipmentFilters['status']}))}><option value="ALL">전체</option><option value="OPEN">미수 있음</option><option value="PAID">잔액 없음</option><option value="REFUND">반환 예정 확인</option></select></label>
        <button className="wf-btn wf-btn-primary" disabled={busy}>출고 문서 조회</button>
      </form>
      <p className="wf-muted">{list?`${list.total}건 · 잔액 기준일 ${list.asOf}`:'문서를 불러오고 있습니다.'}</p>
      <div className="erp-shipment-list">{list?.rows.map(row=><button type="button" className={`wf-btn erp-shipment-choice ${selected===row.id?'erp-selected':''}`} key={row.id} disabled={busy} aria-label={`${row.documentNo} 상세 보기`} aria-pressed={selected===row.id} onClick={()=>{setSelected(row.id);setTab('PAYMENT');}}><strong>{row.documentNo}</strong><span>{row.date} · {row.partnerName}</span><span>매출 {money(row.billed,row.currency)} · 수금 {money(row.allocated,row.currency)} · 미수 {money(Math.max(0,row.balance),row.currency)} {row.currency}</span><small>{row.recoveryCredit?'반품 정산 잔액 '+money(row.recoveryCredit,row.currency)+' '+row.currency:statuses[row.paymentStatus]||row.paymentStatus}</small></button>)}</div>
      {list&&!list.rows.length&&<p>조회 조건에 맞는 출고 문서가 없습니다.</p>}
      {list?.nextOffset!=null&&<button className="wf-btn" disabled={busy} onClick={()=>void run(async()=>{const r=await api.shipments(companyId,query.current,list.nextOffset!,list.snapshot);if(live.current)setList({...r,rows:[...list.rows,...r.rows]});})}>출고 문서 더 보기</button>}
    </section>
    {error&&<p role="alert" className="erp-error">{error}</p>}{notice&&<p role="status" className="erp-success">{notice}</p>}{loadingDetail&&<p role="status">선택한 문서의 최신 재고·수금 내역을 확인하고 있습니다.</p>}
    {detail&&doc&&<section className="erp-shipment-detail" aria-label="선택 출고 문서"><div className="wf-panel"><h2 ref={heading} tabIndex={-1} className="wf-section-title">{doc.documentNo} · {doc.partnerName}</h2><p>{doc.date} 출고 · {doc.currency} · {statuses[doc.paymentStatus]||doc.paymentStatus}</p>
      <dl className="erp-stock-totals"><div><dt>매출액 (부가세·반품 반영)</dt><dd>{money(doc.billed,doc.currency)}<small>{doc.currency}</small></dd><small>공급가액 {money(doc.supplyMinor,doc.currency)} + 부가세 {money(doc.taxMinor,doc.currency)}</small></div><div><dt>이 문서 수금액</dt><dd>{money(doc.allocated,doc.currency)}<small>{doc.currency}</small></dd></div><div><dt>남은 문서 미수금</dt><dd>{money(Math.max(0,doc.balance),doc.currency)}<small>{doc.currency}</small></dd></div><div><dt>거래처 반환 예정액</dt><dd>{money(Math.max(0,-detail.partnerBalance),doc.currency)}<small>{doc.currency}</small></dd></div></dl>
      <p className="wf-muted">지급기일 {doc.dueDate||'미설정'} · 연체 {doc.overdueDays}일 · 연체금액 {money(doc.overdueAmount,doc.currency)} {doc.currency}</p>
      {(detail.recovery.excess>0||detail.recovery.credit>0)&&<p className="erp-notice">반품 후 정산을 확인해 주세요. <button className="wf-btn" onClick={()=>setTab('RECOVERY')}>미수금·반환 예정액 확인</button></p>}<button className="wf-btn" onClick={onFinance}>거래처 전체 수금 관리</button>
      <div className="erp-actions" aria-label="선택 문서 업무">{([['DETAIL','품목·매출·원가'],['PAYMENT','수금 등록·내역'],['RETURN','반품 처리'],['RECOVERY','반품 후 정산'],['STATEMENT','거래명세표 발행·정정']] as const).map(([key,label])=><button className="wf-btn" key={key} aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
    </div>
      {returnResult&&<ErpReturnSummary value={returnResult}/>}
      {tab==='DETAIL'&&<section className="wf-panel" aria-label="출고 품목과 매출 원가"><h3>원출고 품목·구성품</h3><p>원출고 공급가액 {money(detail.originalAmounts.salesKRW,'KRW')}원 · 출고원가 {money(detail.originalAmounts.costKRW,'KRW')}원 · 매출총이익 {money(detail.originalAmounts.salesKRW-detail.originalAmounts.costKRW,'KRW')}원</p><p className="wf-muted">출고 당시 원장 기준입니다. 반품·취소 후 현재 청구액과 미수잔액은 위 요약에 표시합니다. 세트 원가는 구성품 차감 원가의 합계이며 이중 합산하지 않습니다.</p>{detail.rows.map(row=><article key={row.id} className="erp-notice"><strong>{row.code} · {row.name}</strong><p>{row.warehouseName} · 출고 {number(row.quantity)} {row.unit} · 반품 {number(row.returnedQuantity||0)} · 원출고 청구액 {money(row.grossMinor,doc.currency)} {doc.currency} · 원가 {money(row.cost,'KRW')}원</p>{row.components.length>0&&<details><summary>구성품 차감 내역 {row.components.length}종</summary>{row.components.map(c=><p key={c.id}>{c.code} · {c.name} · {c.warehouseName} · {number(c.quantity)} {c.unit} · {money(c.cost,'KRW')}원</p>)}</details>}</article>)}<h3>매출·반품·취소 원장</h3>{detail.events.map(e=><p key={e.id}>{e.date} · {e.kind==='SALE'?'출고':e.kind==='SALES_RETURN'?'반품':e.kind==='CANCEL'?'취소':e.kind} · {money(e.gross,e.currency)} {e.currency}</p>)}</section>}
      {tab==='PAYMENT' &&<><ErpCollectionPanel key={doc.id} companyId={companyId} target={{documentId:doc.id,partnerId:doc.partnerId,currency:doc.currency}} onSaved={refresh}/><section className="wf-panel" aria-label="문서 수금 배분 내역"><h3>문서 수금 배분 내역</h3>{detail.allocations.map(a=><p key={a.id}>{a.receiptId&&<strong>{detail.receipts.find(r=>r.id===a.receiptId)?.reference||a.receiptId} · </strong>}{a.date} · {money(a.lines.filter(l=>l.documentId===doc.id).reduce((sum,l)=>sum+l.amountMinor,0),a.currency)} {a.currency} · {a.active?'반영':'해제·취소'}{a.notes?` · ${a.notes}`:''}</p>)}{!detail.allocations.length&&<p>배분된 수금이 없습니다.</p>}<details><summary>연결된 원수금 {detail.receipts.length}건</summary>{detail.receipts.map(r=><p key={r.id}>실제 입금일 {r.receivedDate||r.date} · {r.reference||r.id} · 원수금 {money(r.amount,r.currency)} · 미배분 {money(r.available,r.currency)} {r.currency}{r.cancelled?' · 취소됨':''}</p>)}</details></section></>}
      {tab==='RETURN'&&<><section className="wf-panel" aria-label="문서 반품 품목"><h3>반품할 품목 선택</h3><p className="wf-muted">반품 확정 시 원출고의 재고·원가를 복원하고 미수금과 초과 배분을 함께 정리합니다. 반환 예정액을 확인하고 거래명세표를 바로 정정할 수 있습니다.</p><div className="erp-bundle-parts">{detail.rows.map(row=><article className="erp-bundle-part" key={row.id}><h4>{row.name}</h4><p>{row.code} · {row.warehouseName}</p><p>출고 {number(row.quantity)} · 반품 {number(row.returnedQuantity||0)} · 반품 가능 {number(row.returnableQuantity)} {row.unit}</p><p>원출고 매출 {money(row.grossMinor,doc.currency)} {doc.currency}</p><button className="wf-btn" disabled={!row.returnableQuantity} aria-label={`${row.code} 반품 처리`} onClick={()=>setReturnRow(row)}>반품 처리</button></article>)}</div></section>{returnRow&&<ErpCorrectionPanel key={returnRow.id} companyId={companyId} type="SALES_RETURN" source={returnRow} date={detail.suggestedDate} onClose={()=>setReturnRow(null)} onCommitted={async correction=>{await refresh();if(live.current&&selection.current===doc.id&&correction.status==='COMMITTED'){setReturnResult(correction.settlement||null);setReturnRow(null);setTab('STATEMENT');setNotice('반품과 미수금 정산을 반영했습니다. 반환 예정액을 확인하고 거래명세표를 정정해 주세요.');}}}/>}</>}
      {tab==='RECOVERY'&&<ErpRecoveryPanel key={doc.id} companyId={companyId} detail={detail} onSaved={refresh} onStatements={()=>setTab('STATEMENT')}/>}
      {tab==='STATEMENT'&&<Suspense fallback={<p role="status">거래명세표를 불러오고 있습니다.</p>}><Documents key={doc.id} companyId={companyId} initialSourceDocumentNo={doc.documentNo} embedded returnWorkflow/></Suspense>}
    </section>}
  </div>;
}
