import {useEffect,useRef,useState} from 'react';
import {erpFinance as api,erpMoney as money} from '../services/erpAccountService';
import type {RecoveryInput,RecoveryJob,ShipmentDetail} from '../services/erpAccountService';
import {getErrorMessage} from '../utils/errors';

export function ErpRecoveryPanel({companyId,detail,onSaved,onStatements}:{companyId:string;detail:ShipmentDetail;onSaved:()=>Promise<void>;onStatements:()=>void}){
  const {document:doc,recovery:r}=detail;
  const [mode,setMode]=useState<'RELEASE'|'REFUND'>(r.excess>0?'RELEASE':'REFUND');
  const [input,setInput]=useState({date:detail.suggestedDate,amount:'',notes:'',method:'BANK',reference:'',confirmPaid:false});
  const [job,setJob]=useState<RecoveryJob|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const live=useRef(true),lock=useRef(false),attempt=useRef(crypto.randomUUID());
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  function change(patch:Partial<typeof input>){setInput(v=>({...v,...patch}));setJob(null);setConfirmed(false);setNotice('');attempt.current=crypto.randomUUID();}
  function choose(next:typeof mode){setMode(next);change({amount:'',notes:'',confirmPaid:false,reference:''});setError('');}
  async function run(action:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await action();}catch(e){if(live.current)setError(getErrorMessage(e));}finally{lock.current=false;if(live.current)setBusy(false);}}
  const limit=mode==='RELEASE'?r.excess:r.refundable,label=mode==='RELEASE'?'초과 배분 해제':'실제 환불 등록';
  return <section className="wf-panel" aria-label="반품 후 정산"><h3 className="wf-section-title">반품 후 정산</h3>
    <p className="wf-muted">반품 시 미수금과 초과 배분을 함께 정리합니다. 남은 미수금과 반환 예정액을 확인하고 거래명세표를 바로 정정하세요. 반환 예정액은 실제 지급 완료를 뜻하지 않습니다.</p>
    <dl className="erp-stock-totals"><div><dt>남은 문서 미수금</dt><dd>{money(Math.max(0,doc.balance),doc.currency)}<small>{doc.currency}</small></dd></div><div><dt>이 문서 반환 대상 잔액</dt><dd>{money(r.credit,doc.currency)}<small>{doc.currency}</small></dd></div><div><dt>거래처 반환 예정액</dt><dd>{money(Math.max(0,-r.partnerBalance),doc.currency)}<small>{doc.currency}</small></dd></div></dl>
    <p>거래처 전체 미수금 {money(Math.max(0,r.partnerBalance),doc.currency)} · 미배분 순수금 {money(r.unallocated,doc.currency)} {doc.currency}</p>
    <p className="wf-muted">거래처 반환 예정액은 같은 거래처·통화의 전체 거래를 기준으로 계산합니다. 다른 출고의 미수금이 있으면 문서별 반환 대상 잔액과 다를 수 있습니다.</p>
    <button className="wf-btn wf-btn-primary" disabled={busy} onClick={onStatements}>거래명세표 정정</button>
    <details><summary>기존 배분·실제 반환 기록 (선택)</summary><p className="wf-muted">이전 반품의 초과 배분이나 실제 지급 내역을 기록할 때 사용하세요. 명세표 정정에 필요한 선행 절차가 아닙니다.</p>
    <div className="erp-actions"><button className="wf-btn" disabled={busy} aria-pressed={mode==='RELEASE'} onClick={()=>choose('RELEASE')}>초과 배분 해제</button><button className="wf-btn" disabled={busy} aria-pressed={mode==='REFUND'} onClick={()=>choose('REFUND')}>실제 반환 기록</button></div>
    <h4>{label}</h4>
    {limit<=0?<p className="erp-notice">{mode==='RELEASE'?'이 문서에서 해제할 초과 배분이 없습니다.':r.excess>0?'초과 배분을 먼저 해제한 뒤 환불 가능액을 확인해 주세요.':'현재 이 문서에서 환불할 수 있는 금액이 없습니다. 이미 환불했거나 다른 문서의 미수금에 사용할 수금이 남아 있을 수 있습니다.'}</p>:<form onSubmit={e=>{e.preventDefault();void run(async()=>{
      const value:RecoveryInput={type:mode,documentId:doc.id,date:input.date,amount:input.amount,notes:input.notes,...(mode==='REFUND'?{method:input.method,reference:input.reference,confirmPaid:input.confirmPaid}:{})};
      const result=await api.previewRecovery(companyId,attempt.current,value);if(live.current){setJob(result.job);setConfirmed(false);}
    });}}>
      <fieldset className="erp-form-fields" disabled={busy||job?.status==='COMMITTED'}>
        <label className="wf-field"><span>정산 처리일 *</span><input className="wf-input" required type="date" value={input.date} onChange={e=>change({date:e.target.value})}/></label>
        <label className="wf-field"><span>{mode==='RELEASE'?'해제할 금액':'실제 지급한 환불액'} *</span><input className="wf-input" required inputMode="decimal" value={input.amount} onChange={e=>change({amount:e.target.value})}/></label>
        <button className="wf-btn" type="button" onClick={()=>change({amount:String(limit/(['KRW','JPY'].includes(doc.currency)?1:100))})}>가능 금액 전액 입력</button>
        {mode==='REFUND'&&<><label className="wf-field"><span>환불 방법</span><select className="wf-input" value={input.method} onChange={e=>change({method:e.target.value})}><option value="BANK">은행 송금</option><option value="CASH">현금</option><option value="CARD">카드 취소</option><option value="OTHER">기타</option></select></label><label className="wf-field"><span>환불 참조번호</span><input className="wf-input" maxLength={100} value={input.reference} onChange={e=>change({reference:e.target.value})}/></label></>}
        <label className="wf-field erp-form-wide"><span>정산 처리 사유 *</span><textarea className="wf-input" aria-label="정산 처리 사유 *" required maxLength={500} rows={2} value={input.notes} onChange={e=>change({notes:e.target.value})}/></label>
        {mode==='REFUND'&&<label className="erp-active-field erp-form-wide"><input type="checkbox" checked={input.confirmPaid} onChange={e=>change({confirmPaid:e.target.checked})}/>은행내역 등을 확인했으며 실제 환불 지급을 완료했습니다.</label>}
      </fieldset><button className="wf-btn wf-btn-primary" disabled={busy||job?.status==='COMMITTED'||mode==='REFUND'&&!input.confirmPaid}>{label} 미리보기</button>
    </form>}
    {job&&<div className="erp-document-preview" aria-label="반품 정산 미리보기"><h4>{job.summary.type==='RELEASE'?'배분 해제':'실제 환불'} {money(job.summary.amountMinor,doc.currency)} {doc.currency}</h4>
      <p>이 문서 미수잔액: {money(job.summary.documentBefore,doc.currency)} → {money(job.summary.documentAfter,doc.currency)}</p><p>거래처 미수잔액: {money(job.summary.partnerBefore,doc.currency)} → {money(job.summary.partnerAfter,doc.currency)}</p><p>미배분 순수금: {money(job.summary.unallocatedBefore,doc.currency)} → {money(job.summary.unallocatedAfter,doc.currency)} {doc.currency}</p>
      {job.summary.type==='RELEASE'&&<><p>원수금은 유지됩니다. 다음 배분액은 그대로 남습니다.</p>{job.summary.preserved.flatMap(p=>p.remainingLines.map(l=><p key={`${p.sourceId}:${l.documentId}`}>{l.documentNo} · {money(l.amountMinor,doc.currency)} {doc.currency}</p>))}</>}
      {job.status==='PENDING'?<><label className="erp-active-field"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>처리 금액과 변경 후 잔액을 확인했습니다.</label><button className="wf-btn wf-btn-primary" disabled={busy||!confirmed} onClick={()=>void run(async()=>{const result=await api.commitRecovery(companyId,job);if(live.current){setJob(result.job);setNotice(job.input.type==='RELEASE'?'초과 배분을 해제했습니다. 환불 가능액을 확인한 후 실제 환불을 등록해 주세요.':'실제 환불을 기록했습니다. 거래명세표 정정을 확인해 주세요.');await onSaved();}})}>{label} 확정</button></>:<button className="wf-btn" disabled={busy} onClick={()=>job.input.type==='RELEASE'?choose('REFUND'):onStatements()}>{job.input.type==='RELEASE'?'환불 등록으로 계속':'거래명세표 정정으로 계속'}</button>}
    </div>}
    </details>
    {error&&<p role="alert" className="erp-error">{error}</p>}{notice&&<p role="status" className="erp-success">{notice}</p>}
    <details><summary>이 문서의 배분 해제·환불 이력 ({r.historyCount}건)</summary><p className="wf-muted">최근 100건을 표시합니다. 실제 환불 취소는 미수금·수금 관리에서 원환불에 연결해 처리합니다.</p>{r.history.map(row=><p key={row.id}>{row.date} · {row.type==='RELEASE'?'배분 해제':row.type==='REFUND_CANCELLED'?'환불 취소됨':'실제 환불'} · {money(row.amountMinor,doc.currency)} {doc.currency} · {row.reference} {row.notes}</p>)}</details>
  </section>;
}
