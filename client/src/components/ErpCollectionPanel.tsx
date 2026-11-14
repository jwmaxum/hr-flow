import {useEffect,useRef,useState} from 'react';
import {erpFinance as api,erpToday,erpMoney as money,erpChoices} from '../services/erpAccountService';
import type {CollectionInput,CollectionJob,CollectionTarget,SettlementReport} from '../services/erpAccountService';
import type {ErpRecord} from '../services/erpService';
import {getErrorMessage} from '../utils/errors';
const units=(amount:number,currency:string)=>String(amount/(['KRW','JPY'].includes(currency)?1:100));

export function ErpCollectionPanel({companyId,target={},onSaved,onDocument}:{companyId:string;target?:CollectionTarget;onSaved:()=>Promise<void>;onDocument?:(documentNo:string)=>void}){
  const [data,setData]=useState<SettlementReport|null>(null),[partners,setPartners]=useState<ErpRecord[]>([]);
  const [input,setInput]=useState<CollectionInput>({mode:target.receiptId?'EXISTING':'NEW',partnerId:target.partnerId||'',currency:target.currency||'KRW',date:erpToday(),receivedDate:erpToday(),amount:'',method:'BANK',reference:'',receiptId:target.receiptId||'',notes:'',confirmDistinct:false,lines:[]});
  const [job,setJob]=useState<CollectionJob|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[confirmed,setConfirmed]=useState(false);
  const live=useRef(true),lock=useRef(false),attempt=useRef(crypto.randomUUID()),initial=useRef(target),heading=useRef<HTMLHeadingElement>(null);
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
  function change(patch:Partial<CollectionInput>){setInput(v=>({...v,...patch}));setJob(null);setConfirmed(false);setNotice('');setError('');attempt.current=crypto.randomUUID();}
  async function run(work:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await work();}catch(e){if(live.current)setError(getErrorMessage(e));}finally{lock.current=false;if(live.current)setBusy(false);}}
  async function reload(){const r=await api.settlements(companyId,input.date);if(live.current){setData(r);setJob(null);setConfirmed(false);attempt.current=crypto.randomUUID();}}
  function request():CollectionInput {const common={mode:input.mode,partnerId:input.partnerId,currency:input.currency,date:input.date,notes:input.notes,confirmDistinct:input.mode==='NEW'&&input.confirmDistinct,lines:input.lines.filter(l=>l.amount.trim())};return input.mode==='NEW'?{...common,receivedDate:input.receivedDate,amount:input.amount,method:input.method,reference:input.reference}:{...common,receiptId:input.receiptId};}
  function distribute(){let remaining=input.mode==='EXISTING'?receipt?.allocatable||0:Math.round(Number(input.amount)*(['KRW','JPY'].includes(input.currency)?1:100));if(!Number.isSafeInteger(remaining)||remaining<=0)return;
    const lines=documents.slice().sort((a,b)=>(a.dueDate||a.date).localeCompare(b.dueDate||b.date)||a.id.localeCompare(b.id)).slice(0,50).flatMap(d=>{const value=Math.min(remaining,d.balance);remaining-=value;return value?[{documentId:d.id,amount:units(value,input.currency)}]:[];});change({lines});}
  return <section className="wf-panel erp-collection" aria-label="통합 수금 등록" aria-busy={busy}>
    <div className="erp-list-head"><h3 ref={heading} tabIndex={-1} className="wf-section-title">수금 등록·기존 수금 재사용</h3><button className="wf-btn" disabled={busy||done} onClick={()=>void run(reload)}>최신 잔액·수금 조회</button></div>
    <p className="wf-muted">은행 확인은 회사가 직접 합니다. 기존에 등록한 입금은 재사용하고, 별도 입금만 새로 기록하세요.</p>
    {!done&&<form onSubmit={e=>{e.preventDefault();void run(async()=>{const r=await api.previewCollection(companyId,attempt.current,request());if(live.current){setJob(r.job);setConfirmed(false);}});}}>
      <fieldset className="erp-form-fields" disabled={busy||done}>
        <label className="wf-field"><span>수금 거래처 *</span><select aria-label="수금 거래처" required className="wf-input" value={input.partnerId} onChange={e=>change({partnerId:e.target.value,receiptId:'',lines:[],confirmDistinct:false})}><option value="">거래처 선택</option>{partners.filter(p=>p.active).map(p=><option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label>
        <label className="wf-field"><span>수금 통화</span><select aria-label="수금 통화" className="wf-input" value={input.currency} onChange={e=>change({currency:e.target.value,receiptId:'',lines:[],amount:'',confirmDistinct:false})}>{['KRW','USD','EUR','JPY','CNY'].map(c=><option key={c}>{c}</option>)}</select></label>
        <p className="erp-form-wide">거래처 미수잔액 {money(done?job.summary.after:group?.balance||0,input.currency)} · 미배분 순수금 {money(done?job.summary.unallocatedAfter:group?.unallocated||0,input.currency)} {input.currency}</p>
        <label className="wf-field"><span>수금 방식</span><select aria-label="수금 방식" className="wf-input" value={input.mode} onChange={e=>change({mode:e.target.value as CollectionInput['mode'],confirmDistinct:false,receiptId:''})}><option value="NEW">새 입금 등록</option><option value="EXISTING">기존 수금 재사용</option></select></label>
        <label className="wf-field"><span>{input.mode==='NEW'?'원장 반영일 *':'배분 적용일 *'}</span><input className="wf-input" required type="date" value={input.date} min={data?.lastDate||undefined} onChange={e=>change({date:e.target.value})}/></label>
        {receipts.length>0&&input.mode==='NEW'&&<p className="erp-notice erp-form-wide">재사용 가능한 기존 수금이 {receipts.length}건 있습니다. 같은 입금을 다시 기록하지 않도록 확인하세요. <button type="button" className="wf-btn" onClick={()=>change({mode:'EXISTING',confirmDistinct:false,receiptId:receipts[0].id})}>기존 수금 선택</button></p>}
        {input.mode==='NEW'?<>
          <label className="wf-field"><span>실제 입금일 *</span><input className="wf-input" type="date" required max={input.date} value={input.receivedDate} onChange={e=>change({receivedDate:e.target.value,confirmDistinct:false})}/></label>
          <label className="wf-field"><span>새 입금액 *</span><input className="wf-input" inputMode="decimal" required value={input.amount} onChange={e=>change({amount:e.target.value,confirmDistinct:false})}/></label>
          <label className="wf-field"><span>수금 방법</span><select aria-label="수금 방법" className="wf-input" value={input.method} onChange={e=>change({method:e.target.value})}>{[['BANK','은행 입금'],['CASH','현금'],['CARD','카드'],['OTHER','기타']].map(([v,t])=><option key={v} value={v}>{t}</option>)}</select></label>
          <label className="wf-field"><span>입금 참조번호</span><input className="wf-input" maxLength={100} value={input.reference} onChange={e=>change({reference:e.target.value,confirmDistinct:false})}/></label>
          <p className="wf-muted erp-form-wide">실제 입금일과 원장 반영일을 구분합니다. 이미 마감한 과거 장부는 바꾸지 않습니다.</p>
        </>:<label className="wf-field erp-form-wide"><span>재사용할 수금 *</span><select aria-label="재사용할 수금" className="wf-input" required value={input.receiptId} onChange={e=>change({receiptId:e.target.value})}><option value="">기존 수금 선택</option>{receipts.map(r=><option key={r.id} value={r.id}>입금 {r.receivedDate||r.date} · 반영 {r.date} · {r.reference||r.id} · 배분 가능 {money(r.allocatable,r.currency)} {r.currency}</option>)}</select></label>}
        <div className="erp-form-wide"><h4>출고 문서별 배분</h4><p>같은 거래처·통화의 문서에 배분합니다. 새 입금에서 배분하지 않은 금액은 미배분 수금으로 남습니다.</p><div className="erp-actions"><button type="button" className="wf-btn" onClick={distribute}>기일순 자동배분</button><button type="button" className="wf-btn" onClick={()=>change({lines:[]})}>배분액 비우기</button></div>
          {documents.map(d=><label className="wf-field" key={d.id}><span>{d.documentNo} · 미수 {money(d.balance,d.currency)} {d.currency}</span><input className="wf-input" aria-label={`수금 배분액 ${d.documentNo}`} inputMode="decimal" value={input.lines.find(l=>l.documentId===d.id)?.amount||''} onChange={e=>change({lines:[...input.lines.filter(l=>l.documentId!==d.id),{documentId:d.id,amount:e.target.value}]})}/></label>)}{!documents.length&&<p>배분할 미수 문서가 없습니다.</p>}
        </div>
        <label className="wf-field erp-form-wide"><span>입금 확인 메모 *</span><input className="wf-input" required maxLength={500} value={input.notes} onChange={e=>change({notes:e.target.value})}/></label>
        <button className="wf-btn wf-btn-primary" disabled={!input.partnerId}>수금 검증·미리보기</button>
      </fieldset>
    </form>}
    {job&&<div className="erp-notice" aria-label="수금·배분 결과"><h4>{done?'수금·배분 반영 완료':'수금·배분 미리보기'} · {job.summary.partnerName}</h4><p>거래처 미수잔액: {money(job.summary.before,job.summary.currency)} → {money(job.summary.after,job.summary.currency)} {job.summary.currency}</p><p>새 입금 {money(job.summary.newReceipt,job.summary.currency)} · 기존 수금 재사용 {money(job.summary.reused,job.summary.currency)} · 배분 합계 {money(job.summary.allocated,job.summary.currency)} {job.summary.currency}</p><p>미배분 순수금: {money(job.summary.unallocatedBefore,job.summary.currency)} → {money(job.summary.unallocatedAfter,job.summary.currency)} {job.summary.currency}</p>
      {job.summary.lines.map(l=><p key={l.documentId}>{l.documentNo} · 배분 {money(l.amountMinor,job.summary.currency)} · 남은 미수 {money(l.after,job.summary.currency)} {job.summary.currency} · {l.after===0?'완납':'부분수금'}{onDocument&&<button type="button" className="wf-btn" onClick={()=>onDocument(l.documentNo)}>출고 상세 보기</button>}</p>)}
      {job.summary.duplicates.length>0&&<div role="alert"><strong>중복 의심 수금을 확인하세요.</strong>{job.summary.duplicates.map(r=><p key={r.id}>{r.date} · {r.reference||r.id} · {money(r.amount,job.summary.currency)} {job.summary.currency}{!done&&receipts.some(available=>available.id===r.id)&&<button className="wf-btn" disabled={busy} onClick={()=>change({mode:'EXISTING',receiptId:r.id,confirmDistinct:false})}>이 수금 재사용</button>}</p>)}{!done&&!input.confirmDistinct&&<label className="erp-active-field"><input type="checkbox" disabled={busy} checked={false} onChange={()=>change({confirmDistinct:true})}/>위 수금과 별개인 실제 입금임을 확인했습니다. 다시 미리보기합니다.</label>}</div>}
      {!done&&job.summary.canCommit&&<><label className="erp-active-field"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>실제 입금·재사용 수금과 문서별 배분 결과를 확인했습니다.</label><button className="wf-btn wf-btn-primary" disabled={busy||!confirmed} onClick={()=>void run(async()=>{const r=await api.commitCollection(companyId,job);if(!live.current)return;setJob(r.job);setNotice('수금과 문서 배분을 함께 반영했습니다.');await onSaved();})}>수금·배분 확정</button></>}
      {done&&<button className="wf-btn" disabled={busy} onClick={()=>void run(async()=>{await reload();if(live.current)change({amount:'',reference:'',notes:'',receiptId:'',lines:[],confirmDistinct:false});})}>다음 수금 입력</button>}
    </div>}
    {error&&<p role="alert" className="erp-error">{error}</p>}{notice&&<p role="status" className="erp-success">{notice}</p>}
  </section>;
}
