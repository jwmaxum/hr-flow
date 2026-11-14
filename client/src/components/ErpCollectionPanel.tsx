import {useEffect,useId,useRef,useState} from 'react';
import {erpFinance as api,erpToday,erpMoney as money,erpChoices} from '../services/erpAccountService';
import type {CollectionInput,CollectionJob,CollectionTarget,SettlementReport} from '../services/erpAccountService';
import type {ErpRecord} from '../services/erpService';
import {getErrorMessage} from '../utils/errors';
import {collectionMinor,collectionDraft} from '../utils/erpCollectionDraft';
import {erpInputLocation} from '../utils/erpInputErrors';
import type {ErpInputLocation} from '../utils/erpInputErrors';
const units=(amount:number,currency:string)=>String(amount/(['KRW','JPY'].includes(currency)?1:100));

export function ErpCollectionPanel({companyId,target={},onSaved,onDocument}:{companyId:string;target?:CollectionTarget;onSaved:()=>Promise<void>;onDocument?:(documentNo:string)=>void}){
  const amountHintId=useId();
  const [data,setData]=useState<SettlementReport|null>(null),[partners,setPartners]=useState<ErpRecord[]>([]);
  const [input,setInput]=useState<CollectionInput>({mode:target.receiptId?'EXISTING':'NEW',partnerId:target.partnerId||'',currency:target.currency||'KRW',date:erpToday(),receivedDate:erpToday(),amount:'',method:'BANK',reference:'',receiptId:target.receiptId||'',notes:'',confirmDistinct:false,lines:[]});
  const [job,setJob]=useState<CollectionJob|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmed,setConfirmed]=useState(false);
  const live=useRef(true),lock=useRef(false),attempt=useRef(crypto.randomUUID()),initial=useRef(target),heading=useRef<HTMLHeadingElement>(null);
  const resultHeading=useRef<HTMLHeadingElement>(null),errorSummary=useRef<HTMLDivElement>(null),refreshWarning=useRef<HTMLDivElement>(null),controls=useRef<Record<string,HTMLElement|null>>({});
  const [errorLocation,setErrorLocation]=useState<ErpInputLocation>(),[refreshError,setRefreshError]=useState('');
  const dateEpoch=useRef(0),[dateLoading,setDateLoading]=useState(false),[dateError,setDateError]=useState('');
  useEffect(()=>{if(!busy){if(error)errorSummary.current?.focus();else if(refreshError)refreshWarning.current?.focus();else if(job)resultHeading.current?.focus();}},[busy,error,refreshError,job]);
  useEffect(()=>{let active=true;live.current=true;void Promise.all([api.settlements(companyId,erpToday()),erpChoices(companyId,'partners')]).then(async([report,p])=>{
    const date=[erpToday(),report.lastDate||''].sort().at(-1)!;
    if(date>report.asOf)report=await api.settlements(companyId,date);
    if(!active)return;setData(report);setPartners(p);
    const doc=report.documents.find(d=>d.id===initial.current.documentId),r=report.receipts.find(r=>r.id===initial.current.receiptId);
    setInput(v=>({...v,date,partnerId:doc?.partnerId||r?.partnerId||v.partnerId,currency:doc?.currency||r?.currency||v.currency,lines:doc&&doc.balance>0?[{documentId:doc.id,amount:units(doc.balance,doc.currency)}]:[]}));
    if(Object.values(initial.current).some(Boolean))heading.current?.focus();
  }).catch(e=>{if(active)setError(getErrorMessage(e));}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;live.current=false;};},[companyId]);
  const receipt=data?.receipts.find(r=>r.id===input.receiptId),group=data?.summaries.find(g=>g.partnerId===input.partnerId&&g.currency===input.currency);
  const receipts=data?.receipts.filter(r=>r.partnerId===input.partnerId&&r.currency===input.currency&&!r.cancelled&&r.allocatable>0)||[];
  const documents=data?.documents.filter(d=>d.partnerId===input.partnerId&&d.currency===input.currency&&d.balance>0)||[];
  const done=job?.status==='COMMITTED';
  const stale=!!data&&data.asOf!==input.date,draft=collectionDraft(input,receipt?.allocatable||0);
  function focusError(){if(!errorLocation)return;const row=errorLocation.row?request().lines[errorLocation.row-1]:undefined;const key=errorLocation.field==='collectionAllocation'?`allocation-${row?.documentId}`:errorLocation.field;controls.current[key]?.focus();controls.current[key]?.scrollIntoView({block:'center'});}
  function change(patch:Partial<CollectionInput>){setInput(v=>({...v,...patch}));setJob(null);setConfirmed(false);setNotice('');setError('');setErrorLocation(undefined);setRefreshError('');attempt.current=crypto.randomUUID();}
  async function run(work:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');setErrorLocation(undefined);try{await work();}catch(e){if(live.current){setError(getErrorMessage(e));setErrorLocation(erpInputLocation(e));}}finally{lock.current=false;if(live.current)setBusy(false);}}
  async function refreshParent(){try{await onSaved();if(live.current)setRefreshError('');}catch{if(live.current)setRefreshError('수금·배분은 반영되었습니다. 목록 조회를 다시 시도해 주세요. 같은 입금을 다시 등록하지 마세요.');}}
  async function changeDate(value:string){
    change({date:value});const epoch=++dateEpoch.current;setDateError('');
    if(!/^20\d{2}-\d{2}-\d{2}$/.test(value)||value<(data?.lastDate||'')){setDateLoading(false);return;}
    setDateLoading(true);
    try{const r=await api.settlements(companyId,value);if(live.current&&epoch===dateEpoch.current)setData(r);}
    catch(e){if(live.current&&epoch===dateEpoch.current)setDateError(getErrorMessage(e));}
    finally{if(live.current&&epoch===dateEpoch.current)setDateLoading(false);}
  }
  async function reload(){const epoch=++dateEpoch.current;const r=await api.settlements(companyId,input.date);if(live.current&&epoch===dateEpoch.current){setData(r);setDateLoading(false);setDateError('');setJob(null);setConfirmed(false);attempt.current=crypto.randomUUID();}}
  function request():CollectionInput {const common={mode:input.mode,partnerId:input.partnerId,currency:input.currency,date:input.date,notes:input.notes,confirmDistinct:input.mode==='NEW'&&input.confirmDistinct,lines:input.lines.filter(l=>l.amount.trim())};return input.mode==='NEW'?{...common,receivedDate:input.receivedDate,amount:input.amount,method:input.method,reference:input.reference}:{...common,receiptId:input.receiptId};}
  function distribute(){
    if(stale)return;
    try{let remaining=input.mode==='EXISTING'?receipt?.allocatable||0:collectionMinor(input.amount||'',input.currency);if(!Number.isSafeInteger(remaining)||remaining<=0)throw new Error('배분할 입금액 또는 재사용할 수금을 선택해 주세요.');
      const lines=documents.slice().sort((a,b)=>(a.dueDate||a.date).localeCompare(b.dueDate||b.date)||a.id.localeCompare(b.id)).slice(0,50).flatMap(d=>{const value=Math.min(remaining,d.balance);remaining-=value;return value?[{documentId:d.id,amount:units(value,input.currency)}]:[];});change({lines});setNotice(`${lines.length}개 문서에 배분액을 입력했습니다. 남은 ${money(remaining,input.currency)} ${input.currency}는 미배분 수금으로 남습니다. 검증 후 확정해 주세요.`);
    }catch(e){setError(getErrorMessage(e));setErrorLocation({field:input.mode==='NEW'?'collectionAmount':'collectionReceipt'});}
  }
  return <section className="wf-panel erp-collection" aria-label="통합 수금 등록" aria-busy={busy||dateLoading}>
    <div className="erp-list-head"><h3 ref={heading} tabIndex={-1} className="wf-section-title">수금 등록·기존 수금 재사용</h3><button className="wf-btn" disabled={busy||done||dateLoading} onClick={()=>void run(reload)}>최신 잔액·수금 조회</button></div>
    <p className="wf-muted">은행 확인은 회사가 직접 합니다. 기존에 등록한 입금은 재사용하고, 별도 입금만 새로 기록하세요.</p>
    {data&&<p className="wf-muted">잔액 조회 기준일 {data.asOf}</p>}
    {!done&&stale&&<p role={dateLoading?'status':'alert'} className="erp-notice">{dateLoading?'반영일에 맞는 잔액을 조회하고 있습니다.':'반영일과 잔액 조회일이 다릅니다. 날짜를 확인하거나 ‘최신 잔액·수금 조회’를 눌러 주세요.'} 입력한 입금액과 메모는 유지됩니다.{dateError&&` ${dateError}`}</p>}
    {!done&&<form onSubmit={e=>{e.preventDefault();void run(async()=>{if(stale)throw new Error('반영일에 맞는 최신 잔액을 먼저 조회해 주세요.');const r=await api.previewCollection(companyId,attempt.current,request());if(live.current){setJob(r.job);setConfirmed(false);}});}}>
      <fieldset className="erp-form-fields" disabled={busy||done}>
        <label className="wf-field"><span>수금 거래처 *</span><select ref={node=>{controls.current.partnerId=node;}} aria-label="수금 거래처" required className="wf-input" value={input.partnerId} onChange={e=>{change({partnerId:e.target.value,receiptId:'',lines:[],amount:'',reference:'',notes:'',confirmDistinct:false});setNotice('거래처를 변경하여 입금액·참조번호·메모·배분을 비웠습니다.');}}><option value="">거래처 선택</option>{partners.filter(p=>p.active).map(p=><option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label>
        <label className="wf-field"><span>수금 통화</span><select aria-label="수금 통화" className="wf-input" value={input.currency} onChange={e=>{change({currency:e.target.value,receiptId:'',lines:[],amount:'',reference:'',notes:'',confirmDistinct:false});setNotice('통화를 변경하여 입금액·참조번호·메모·배분을 비웠습니다.');}}>{['KRW','USD','EUR','JPY','CNY'].map(c=><option key={c}>{c}</option>)}</select></label>
        <p className="erp-form-wide">거래처 미수잔액 {money(done?job.summary.after:group?.balance||0,input.currency)} · 미배분 순수금 {money(done?job.summary.unallocatedAfter:group?.unallocated||0,input.currency)} {input.currency}</p>
        <label className="wf-field"><span>수금 방식</span><select aria-label="수금 방식" className="wf-input" value={input.mode} onChange={e=>change({mode:e.target.value as CollectionInput['mode'],confirmDistinct:false,receiptId:''})}><option value="NEW">새 입금 등록</option><option value="EXISTING">기존 수금 재사용</option></select></label>
        <label className="wf-field"><span>{input.mode==='NEW'?'원장 반영일 *':'배분 적용일 *'}</span><input ref={node=>{controls.current.date=node;}} className="wf-input" required type="date" value={input.date} min={data?.lastDate||undefined} onChange={e=>void changeDate(e.target.value)}/></label>
        {receipts.length>0&&input.mode==='NEW'&&<p className="erp-notice erp-form-wide">재사용 가능한 기존 수금이 {receipts.length}건 있습니다. 같은 입금을 다시 기록하지 않도록 확인하세요. <button type="button" className="wf-btn" onClick={()=>change({mode:'EXISTING',confirmDistinct:false,receiptId:receipts[0].id})}>기존 수금 선택</button></p>}
        {input.mode==='NEW'?<>
          <label className="wf-field"><span>실제 입금일 *</span><input ref={node=>{controls.current.receivedDate=node;}} className="wf-input" type="date" required max={input.date} value={input.receivedDate} onChange={e=>change({receivedDate:e.target.value,confirmDistinct:false})}/></label>
          <label className="wf-field"><span>새 입금액 *</span><input ref={node=>{controls.current.collectionAmount=node;}} aria-label="새 입금액 *" aria-describedby={amountHintId} className="wf-input" inputMode="decimal" required value={input.amount} onChange={e=>change({amount:e.target.value,confirmDistinct:false})}/><small id={amountHintId}>{['KRW','JPY'].includes(input.currency)?'정수 금액':'소수점 2자리까지'} · 쉼표 사용 가능 (예: 1,100)</small></label>
          <label className="wf-field"><span>수금 방법</span><select aria-label="수금 방법" className="wf-input" value={input.method} onChange={e=>change({method:e.target.value})}>{[['BANK','은행 입금'],['CASH','현금'],['CARD','카드'],['OTHER','기타']].map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
          <label className="wf-field"><span>입금 참조번호</span><input className="wf-input" maxLength={100} value={input.reference} onChange={e=>change({reference:e.target.value,confirmDistinct:false})}/></label>
          <p className="wf-muted erp-form-wide">실제 입금일과 원장 반영일을 구분합니다. 이미 마감한 과거 장부는 바꾸지 않습니다.</p>
        </>:<label className="wf-field erp-form-wide"><span>재사용할 수금 *</span><select ref={node=>{controls.current.collectionReceipt=node;}} aria-label="재사용할 수금" className="wf-input" required value={input.receiptId} onChange={e=>change({receiptId:e.target.value})}><option value="">기존 수금 선택</option>{receipts.map(r=><option key={r.id} value={r.id}>입금 {r.receivedDate||r.date} · 반영 {r.date} · {r.reference||r.id} · 배분 가능 {money(r.allocatable,r.currency)} {r.currency}</option>)}</select></label>}
        <div className="erp-form-wide"><h4>출고 문서별 배분</h4><p>같은 거래처·통화의 문서에 최대 50건까지 배분합니다. 새 입금에서 배분하지 않은 금액은 미배분 수금으로 남습니다.</p><div className="erp-actions"><button type="button" className="wf-btn" disabled={stale} onClick={distribute}>기일순 자동배분</button><button type="button" className="wf-btn" onClick={()=>change({lines:[]})}>배분액 비우기</button></div>
          <div className="erp-notice" aria-label="입력 중 배분 합계" aria-live="polite">{draft.error?<p>{draft.error}</p>:<><p>선택 수금액 {money(draft.source!,input.currency)} · 배분 합계 {money(draft.total!,input.currency)} {input.currency}</p><p className={draft.remaining!<0?'erp-error':''}>{draft.remaining!<0?'배분 초과':'배분 후 남는 수금'} {money(Math.abs(draft.remaining!),input.currency)} {input.currency}{draft.remaining!<0?' · 배분액을 줄이거나 자동배분으로 다시 계산하세요.':''}</p></>}<small>입력 중인 참고 합계입니다. 최신 잔액과 중복 여부는 검증·확정 시 다시 확인합니다.</small></div>
          {documents.map(d=><label className="wf-field" key={d.id}><span>{d.documentNo} · 미수 {money(d.balance,d.currency)} {d.currency}</span><input ref={node=>{controls.current[`allocation-${d.id}`]=node;}} className="wf-input" aria-label={`수금 배분액 ${d.documentNo}`} inputMode="decimal" value={input.lines.find(l=>l.documentId===d.id)?.amount||''} onChange={e=>change({lines:[...input.lines.filter(l=>l.documentId!==d.id),{documentId:d.id,amount:e.target.value}]})}/></label>)}{!documents.length&&<p>배분할 미수 문서가 없습니다.</p>}
        </div>
        <label className="wf-field erp-form-wide"><span>입금 확인 메모 *</span><input ref={node=>{controls.current.collectionNotes=node;}} className="wf-input" required maxLength={500} value={input.notes} onChange={e=>change({notes:e.target.value})}/></label>
        <button className="wf-btn wf-btn-primary" disabled={!input.partnerId||stale}>수금 검증·미리보기</button>
      </fieldset>
    </form>}
    {job&&<div className="erp-notice" aria-label="수금·배분 결과"><h4 ref={resultHeading} tabIndex={-1}>{done?'수금·배분 반영 완료':'수금·배분 미리보기'} · {job.summary.partnerName}</h4><p>거래처 미수잔액: {money(job.summary.before,job.summary.currency)} → {money(job.summary.after,job.summary.currency)} {job.summary.currency}</p><p>새 입금 {money(job.summary.newReceipt,job.summary.currency)} · 기존 수금 재사용 {money(job.summary.reused,job.summary.currency)} · 배분 합계 {money(job.summary.allocated,job.summary.currency)} {job.summary.currency}</p><p>미배분 순수금: {money(job.summary.unallocatedBefore,job.summary.currency)} → {money(job.summary.unallocatedAfter,job.summary.currency)} {job.summary.currency}</p>
      {job.summary.lines.map(l=><p key={l.documentId}>{l.documentNo} · 배분 {money(l.amountMinor,job.summary.currency)} · 남은 미수 {money(l.after,job.summary.currency)} {job.summary.currency} · {l.after===0?'완납':'부분수금'}{onDocument&&<button type="button" className="wf-btn" onClick={()=>onDocument(l.documentNo)}>출고 상세 보기</button>}</p>)}
      {job.summary.duplicates.length>0&&<div role="alert"><strong>중복 의심 수금을 확인하세요.</strong>{job.summary.duplicates.map(r=><p key={r.id}>{r.date} · {r.reference||r.id} · {money(r.amount,job.summary.currency)} {job.summary.currency}{!done&&receipts.some(available=>available.id===r.id)&&<button className="wf-btn" disabled={busy} onClick={()=>change({mode:'EXISTING',receiptId:r.id,confirmDistinct:false})}>이 수금 재사용</button>}</p>)}{!done&&!input.confirmDistinct&&<label className="erp-active-field"><input type="checkbox" disabled={busy} checked={false} onChange={()=>change({confirmDistinct:true})}/>위 수금과 별개인 실제 입금임을 확인했습니다. 다시 미리보기합니다.</label>}</div>}
      {!done&&job.summary.canCommit&&<><label className="erp-active-field"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>실제 입금·재사용 수금과 문서별 배분 결과를 확인했습니다.</label><button className="wf-btn wf-btn-primary" disabled={busy||!confirmed} onClick={()=>void run(async()=>{const r=await api.commitCollection(companyId,job);if(!live.current)return;setJob(r.job);setNotice('수금과 문서 배분을 함께 반영했습니다.');await refreshParent();})}>수금·배분 확정</button></>}
      {done&&<button className="wf-btn" disabled={busy} onClick={()=>void run(async()=>{await reload();if(live.current){change({amount:'',reference:'',notes:'',receiptId:'',lines:[],confirmDistinct:false});heading.current?.focus();}})}>다음 수금 입력</button>}
    </div>}
    {error&&<div ref={errorSummary} tabIndex={-1} role="alert" className="erp-error"><p>{error}</p>{errorLocation&&<button type="button" className="wf-btn" onClick={focusError}>입력란으로 이동</button>}</div>}
    {refreshError&&<div ref={refreshWarning} tabIndex={-1} role="alert" className="erp-notice"><p>{refreshError}</p><button type="button" className="wf-btn" disabled={busy} onClick={()=>void run(refreshParent)}>반영 결과 다시 조회</button></div>}
    {notice&&<p role="status" className="erp-success">{notice}</p>}
  </section>;
}
