import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import {erpFinance as api, erpToday, erpMoney as money} from '../services/erpAccountService';
import type {PaymentInput, PaymentJob, ShipmentDetail, ShipmentFilters, ShipmentLine, ShipmentList} from '../services/erpAccountService';
import {ErpPaymentOptions, ErpPaymentSummary} from './ErpPaymentControls';
import {ErpCorrectionPanel} from './ErpCorrectionPanel';
import {getErrorMessage} from '../utils/errors';
const Documents=lazy(()=>import('./ErpDocumentsPanel').then(m=>({default:m.ErpDocumentsPanel})));
const number=(value:number)=>value.toLocaleString('ko-KR',{maximumFractionDigits:4});
const statuses:Record<string,string>={PAID:'입금완료',PARTIAL:'부분수금',UNPAID:'미수',CREDIT:'외상',UNCONFIRMED:'기존 출고',REFUND_DUE:'환불·배분 확인',NO_BALANCE:'잔액 없음'};

function ReceiptForm({companyId,detail,onSaved}:{companyId:string;detail:ShipmentDetail;onSaved:()=>Promise<void>}) {
  const doc=detail.document;
  const [input,setInput]=useState<PaymentInput>({documentId:doc.id,date:detail.suggestedDate,amount:'',method:'BANK',reference:'',receiptMode:'REUSE_FIRST',confirmNew:false,notes:''});
  const [job,setJob]=useState<PaymentJob|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const live=useRef(true),lock=useRef(false),attempt=useRef(crypto.randomUUID());
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  function change(patch:Partial<PaymentInput>){setInput(v=>({...v,...patch}));setJob(null);setConfirmed(false);setNotice('');attempt.current=crypto.randomUUID();}
  async function run(action:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await action();}catch(e){if(live.current)setError(getErrorMessage(e));}finally{lock.current=false;if(live.current)setBusy(false);}}
  return <section className="wf-panel" aria-label="출고 문서 수금 등록"><h3 className="wf-section-title">이 문서에 수금 등록</h3>
    <p>미수잔액 {money(doc.balance,doc.currency)} {doc.currency} · 거래처의 미배분 순수금 {money(detail.unallocated,doc.currency)} {doc.currency}</p>
    <p className="wf-muted">이 문서에 반영할 금액을 입력하세요. 기존 수금을 우선 반영하면 부족분만 새 입금으로 기록합니다. 신규 수금액과 배분액은 미리보기에서 확인합니다.</p>
    {doc.balance<=0 ? <p className="erp-notice">{doc.balance<0?'반품 후 초과수금이 있습니다. 미수금·수금에서 배분 해제 또는 실제 환불을 처리해 주세요.':'미수잔액이 없어 추가 수금이 필요하지 않습니다.'}</p> : <>
      <form onSubmit={e=>{e.preventDefault();void run(async()=>{const r=await api.previewPayment(companyId,attempt.current,input);if(live.current){setJob(r.job);setConfirmed(false);}});}}>
        <fieldset className="erp-form-fields" disabled={busy||job?.status==='COMMITTED'}>
          <label className="wf-field"><span>수금일 *</span><input className="wf-input" required type="date" value={input.date} onChange={e=>change({date:e.target.value})}/></label>
          <label className="wf-field"><span>이 문서에 반영할 수금액 *</span><input className="wf-input" required inputMode="decimal" value={input.amount} onChange={e=>change({amount:e.target.value})}/></label>
          <button className="wf-btn" type="button" onClick={()=>change({amount:String(doc.balance/(['KRW','JPY'].includes(doc.currency)?1:100))})}>미수잔액 전액 입력</button>
          <label className="wf-field"><span>수금 방법</span><select aria-label="문서 수금 방법" className="wf-input" value={input.method} onChange={e=>change({method:e.target.value})}><option value="BANK">은행 입금</option><option value="CASH">현금</option><option value="CARD">카드</option><option value="OTHER">기타</option></select></label>
          <label className="wf-field"><span>입금 참조번호</span><input className="wf-input" maxLength={100} value={input.reference} onChange={e=>change({reference:e.target.value})}/></label>
          <ErpPaymentOptions value={input} onChange={change}/>
        </fieldset><button className="wf-btn wf-btn-primary" disabled={busy||job?.status==='COMMITTED'}>문서 수금 미리보기</button>
      </form>
      {job&&<><ErpPaymentSummary value={job.summary}/>{job.status==='PENDING'&&<><label className="erp-active-field"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>기존 수금·새 입금액과 문서 잔액을 확인했습니다.</label><button className="wf-btn wf-btn-primary" disabled={busy||!confirmed} onClick={()=>void run(async()=>{const r=await api.commitPayment(companyId,job);if(live.current){setJob(r.job);setNotice('수금과 문서 배분을 함께 반영했습니다.');await onSaved();}})}>문서 수금 확정</button></>}{job.status==='COMMITTED'&&<button className="wf-btn" disabled={busy} onClick={()=>change({amount:'',reference:'',notes:'',confirmNew:false})}>다음 수금 입력</button>}</>}
    </>}{error&&<p role="alert" className="erp-error">{error}</p>}{notice&&<p role="status" className="erp-success">{notice}</p>}
  </section>;
}

export function ErpShipmentsPanel({companyId,initialDocumentNo='',onFinance}:{companyId:string;initialDocumentNo?:string;onFinance:()=>void}){
  const [filters,setFilters]=useState<ShipmentFilters>({from:initialDocumentNo?'2000-01-01':erpToday().slice(0,8)+'01',to:erpToday(),search:initialDocumentNo,status:'ALL'});
  const [list,setList]=useState<ShipmentList|null>(null),[detail,setDetail]=useState<ShipmentDetail|null>(null),[selected,setSelected]=useState('');
  const [tab,setTab]=useState<'PAYMENT'|'RETURN'|'STATEMENT'>('PAYMENT'),[returnRow,setReturnRow]=useState<ShipmentLine|null>(null);
  const [busy,setBusy]=useState(false),[loadingDetail,setLoadingDetail]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const live=useRef(true),lock=useRef(false),selection=useRef(''),query=useRef(filters),detailEpoch=useRef(0),listEpoch=useRef(0),heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{live.current=true;let active=true;const epoch=++listEpoch.current;void api.shipments(companyId,query.current).then(r=>{if(active&&listEpoch.current===epoch){setList(r);const match=r.rows.find(row=>row.documentNo===initialDocumentNo);if(match)setSelected(match.id);}}).catch(e=>{if(active&&listEpoch.current===epoch)setError(getErrorMessage(e));});return()=>{active=false;live.current=false;};},[companyId,initialDocumentNo]);
  useEffect(()=>{
    let active=true;selection.current=selected;const epoch=++detailEpoch.current;setDetail(null);setReturnRow(null);setNotice('');setLoadingDetail(!!selected);setError('');
    if(selected)void api.shipment(companyId,selected).then(r=>{if(active&&detailEpoch.current===epoch)setDetail(r);}).catch(e=>{if(active&&detailEpoch.current===epoch)setError(getErrorMessage(e));}).finally(()=>{if(active&&detailEpoch.current===epoch)setLoadingDetail(false);});
    return()=>{active=false;};
  },[companyId,selected]);
  async function run(action:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await action();}catch(e){if(live.current)setError(getErrorMessage(e));}finally{lock.current=false;if(live.current)setBusy(false);}}
  async function refresh(){const id=selection.current,epoch=++detailEpoch.current,listVersion=++listEpoch.current;const [l,d]=await Promise.all([api.shipments(companyId,query.current),id?api.shipment(companyId,id):Promise.resolve(null)]);if(live.current){if(listEpoch.current===listVersion)setList(l);if(selection.current===id&&detailEpoch.current===epoch)setDetail(d);}}
  const doc=detail?.document;
  useEffect(()=>{heading.current?.focus();},[doc?.id]);
  return <div className="erp-shipments" aria-busy={busy}>
    <section className="wf-panel" aria-label="출고 문서 조회"><div className="erp-list-head"><h2 className="wf-section-title">출고 문서 통합 관리</h2><button className="wf-btn" disabled={busy} onClick={()=>void run(refresh)}>문서·잔액 새로고침</button></div>
      <p className="wf-muted">출고 문서를 선택해 수금·반품·거래명세표를 처리하세요. 잔액은 현재 기준이며 매출액은 부가세를 포함합니다.</p>
      <form className="erp-form-fields" onSubmit={e=>{e.preventDefault();void run(async()=>{query.current={...filters};const epoch=++listEpoch.current;const r=await api.shipments(companyId,query.current);if(live.current&&listEpoch.current===epoch){setList(r);setSelected('');}});}}>
        <label className="wf-field"><span>출고 시작일</span><input className="wf-input" type="date" required value={filters.from} onChange={e=>setFilters(v=>({...v,from:e.target.value}))}/></label>
        <label className="wf-field"><span>출고 종료일</span><input className="wf-input" type="date" required value={filters.to} onChange={e=>setFilters(v=>({...v,to:e.target.value}))}/></label>
        <label className="wf-field"><span>문서번호·거래처 검색</span><input className="wf-input" maxLength={80} value={filters.search} onChange={e=>setFilters(v=>({...v,search:e.target.value}))}/></label>
        <label className="wf-field"><span>수금 상태</span><select aria-label="출고 문서 수금 상태" className="wf-input" value={filters.status} onChange={e=>setFilters(v=>({...v,status:e.target.value as ShipmentFilters['status']}))}><option value="ALL">전체</option><option value="OPEN">미수 있음</option><option value="PAID">잔액 없음</option><option value="REFUND">환불·배분 확인</option></select></label>
        <button className="wf-btn wf-btn-primary" disabled={busy}>출고 문서 조회</button>
      </form>
      <p className="wf-muted">{list?`${list.total}건 · 잔액 기준일 ${list.asOf}`:'문서를 불러오고 있습니다.'}</p>
      <div className="erp-shipment-list">{list?.rows.map(row=><button type="button" className={`wf-btn erp-shipment-choice ${selected===row.id?'erp-selected':''}`} key={row.id} disabled={busy} aria-label={`${row.documentNo} 상세 보기`} aria-pressed={selected===row.id} onClick={()=>{setSelected(row.id);setTab('PAYMENT');}}><strong>{row.documentNo}</strong><span>{row.date} · {row.partnerName}</span><span>매출 {money(row.billed,row.currency)} · 수금 {money(row.allocated,row.currency)} · 미수 {money(row.balance,row.currency)} {row.currency}</span><small>{statuses[row.paymentStatus]||row.paymentStatus}</small></button>)}</div>
      {list&&!list.rows.length&&<p>조회 조건에 맞는 출고 문서가 없습니다.</p>}
      {list?.nextOffset!=null&&<button className="wf-btn" disabled={busy} onClick={()=>void run(async()=>{const r=await api.shipments(companyId,query.current,list.nextOffset!,list.snapshot);if(live.current)setList({...r,rows:[...list.rows,...r.rows]});})}>출고 문서 더 보기</button>}
    </section>
    {error&&<p role="alert" className="erp-error">{error}</p>}{notice&&<p role="status" className="erp-success">{notice}</p>}{loadingDetail&&<p role="status">선택한 문서의 최신 재고·수금 내역을 확인하고 있습니다.</p>}
    {detail&&doc&&<section className="erp-shipment-detail" aria-label="선택 출고 문서"><div className="wf-panel"><h2 ref={heading} tabIndex={-1} className="wf-section-title">{doc.documentNo} · {doc.partnerName}</h2><p>{doc.date} 출고 · {doc.currency} · {statuses[doc.paymentStatus]||doc.paymentStatus}</p>
      <dl className="erp-stock-totals"><div><dt>매출액 (부가세·반품 반영)</dt><dd>{money(doc.billed,doc.currency)}<small>{doc.currency}</small></dd><small>공급가액 {money(doc.supplyMinor,doc.currency)} + 부가세 {money(doc.taxMinor,doc.currency)}</small></div><div><dt>이 문서 수금액</dt><dd>{money(doc.allocated,doc.currency)}<small>{doc.currency}</small></dd></div><div><dt>미수잔액</dt><dd>{money(doc.balance,doc.currency)}<small>{doc.currency}</small></dd></div></dl>
      <p className="wf-muted">지급기일 {doc.dueDate||'미설정'} · 연체 {doc.overdueDays}일 · 연체금액 {money(doc.overdueAmount,doc.currency)} {doc.currency}</p>
      {doc.balance<0&&<p className="erp-notice">반품 후 초과수금 {money(-doc.balance,doc.currency)} {doc.currency} · 실제 환불과 문서 배분은 별도로 정리해 주세요. <button className="wf-btn" onClick={onFinance}>미수금·수금 관리 열기</button></p>}
      <div className="erp-actions" aria-label="선택 문서 업무">{([['PAYMENT','수금 등록·내역'],['RETURN','반품 처리'],['STATEMENT','거래명세표 발행']] as const).map(([key,label])=><button className="wf-btn" key={key} aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
    </div>
      {tab==='PAYMENT'&&<><ReceiptForm key={doc.id} companyId={companyId} detail={detail} onSaved={refresh}/><section className="wf-panel" aria-label="문서 수금 배분 내역"><h3>문서 수금 배분 내역</h3>{detail.allocations.map(a=><p key={a.id}>{a.date} · {money(a.lines.filter(l=>l.documentId===doc.id).reduce((sum,l)=>sum+l.amountMinor,0),a.currency)} {a.currency} · {a.active?'반영':'해제·취소'}{a.notes?` · ${a.notes}`:''}</p>)}{!detail.allocations.length&&<p>배분된 수금이 없습니다.</p>}</section></>}
      {tab==='RETURN'&&<><section className="wf-panel" aria-label="문서 반품 품목"><h3>반품할 품목 선택</h3><p className="wf-muted">반품은 원출고의 구성·원가를 복원합니다. 기발행 거래명세표는 발행 탭에서 취소·정정하며, 실제 환불은 수금 원장에서 별도로 기록합니다.</p><div className="erp-bundle-parts">{detail.rows.map(row=><article className="erp-bundle-part" key={row.id}><h4>{row.name}</h4><p>{row.code} · {row.warehouseName}</p><p>출고 {number(row.quantity)} · 반품 {number(row.returnedQuantity||0)} · 반품 가능 {number(row.returnableQuantity)} {row.unit}</p><p>원출고 매출 {money(row.grossMinor,doc.currency)} {doc.currency}</p><button className="wf-btn" disabled={!row.returnableQuantity} aria-label={`${row.code} 반품 처리`} onClick={()=>setReturnRow(row)}>반품 처리</button></article>)}</div></section>{returnRow&&<ErpCorrectionPanel key={returnRow.id} companyId={companyId} type="SALES_RETURN" source={returnRow} date={detail.suggestedDate} onClose={()=>setReturnRow(null)} onCommitted={async()=>{await refresh();if(live.current){setReturnRow(null);setNotice('반품을 반영하고 재고·매출·미수잔액을 갱신했습니다.');}}}/>}</>}
      {tab==='STATEMENT'&&<Suspense fallback={<p role="status">거래명세표를 불러오고 있습니다.</p>}><Documents key={doc.id} companyId={companyId} initialSourceDocumentNo={doc.documentNo} embedded/></Suspense>}
    </section>}
  </div>;
}
