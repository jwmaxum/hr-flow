import {useEffect,useRef,useState} from 'react';
import {erpControl,type ReviewPolicy} from '../services/erpControlService';
import {getErrorMessage} from '../utils/errors';

export function ErpReviewPolicySettings({companyId,onSaved}:{companyId:string;onSaved:()=>void}){
  const [open,setOpen]=useState(false),[policy,setPolicy]=useState<ReviewPolicy|null>(null),[aged,setAged]=useState(''),[urgent,setUrgent]=useState(''),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const live=useRef(true),lock=useRef(false);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  function accept(value:ReviewPolicy){setPolicy(value);setAged(String(value.agedDays));setUrgent(String(value.urgentDays));setReason('');}
  async function load(){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');
    try{const result=await erpControl<ReviewPolicy>(companyId,'reviewPolicyGet');if(live.current)accept(result);}
    catch(e){if(live.current)setError(getErrorMessage(e));}
    finally{lock.current=false;if(live.current)setBusy(false);}
  }
  async function save(reset=false){
    if(lock.current||!policy)return;
    const agedDays=Number(aged),urgentDays=Number(urgent);
    if(!reset&&(!Number.isSafeInteger(agedDays)||!Number.isSafeInteger(urgentDays)||agedDays<1||urgentDays>3650||urgentDays<=agedDays)){setError('1~3650일의 정수를 입력하고, 우선 확인은 장기 미확인보다 크게 설정해 주세요.');return;}
    if(reason.trim().length<3){setError('변경 사유를 3자 이상 입력해 주세요.');return;}
    lock.current=true;setBusy(true);setError('');setNotice('');
    try{
      const result=await erpControl<ReviewPolicy>(companyId,'reviewPolicySave',{revision:policy.revision,reason:reason.trim(),...(reset?{reset:true}:{agedDays,urgentDays})});
      if(!live.current)return;accept(result);setNotice(`저장되었습니다. 장기 미확인 ${result.agedDays}일 · 우선 확인 ${result.urgentDays}일 기준을 적용합니다.`);onSaved();
    }catch(e){if(live.current)setError(getErrorMessage(e)+' 저장 결과가 불확실하면 현재 기준 다시 조회로 확인해 주세요.');}
    finally{lock.current=false;if(live.current)setBusy(false);}
  }
  return <div className="erp-review-policy">
    <button type="button" className="wf-btn" aria-expanded={open} disabled={busy} onClick={()=>{setOpen(!open);if(!open&&!policy)void load();}}>알림 기준 설정</button>
    {open&&<section aria-label="회사별 알림 기준 설정" aria-busy={busy}>
      <h3>회사별 알림 기준</h3>
      <p className="wf-muted">이 회사의 ADMIN만 변경할 수 있습니다. 미설정 시 장기 미확인 14일(2주), 우선 확인 30일을 적용합니다. 이전 변경 내역에도 새 기준이 적용됩니다.</p>
      {notice&&<p role="status" className="erp-notice">{notice}</p>}{error&&<p role="alert" className="erp-error">{error}</p>}{busy&&<p role="status">알림 기준을 확인하고 있습니다.</p>}
      {policy&&<form onSubmit={e=>{e.preventDefault();void save();}}>
        <p>{policy.configured?'회사별 설정 사용 중':'기본값 사용 중'}{policy.updatedAt?` · 마지막 변경 ${policy.updatedByName} · ${new Date(policy.updatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}`:''}</p>
        <div className="erp-review-policy-fields">
          <label className="wf-field"><span>장기 미확인 기준(일)</span><input className="wf-input" type="number" min={1} max={3649} step={1} required disabled={busy} value={aged} onChange={e=>setAged(e.target.value)}/></label>
          <label className="wf-field"><span>우선 확인 기준(일)</span><input className="wf-input" type="number" min={2} max={3650} step={1} required disabled={busy} value={urgent} onChange={e=>setUrgent(e.target.value)}/></label>
        </div>
        <p className="wf-muted">해당 일수 이상인 미확인 변경을 표시합니다. 우선 확인 일수는 장기 미확인보다 커야 하며, 우선 확인 건수는 장기 미확인 건수에 포함됩니다.</p>
        <label className="wf-field"><span>기준 변경 사유</span><input className="wf-input" required minLength={3} maxLength={500} disabled={busy} value={reason} onChange={e=>setReason(e.target.value)} placeholder="예: 회사 점검 주기 변경"/></label>
        <div className="erp-actions"><button type="submit" className="wf-btn wf-btn-primary" disabled={busy}>알림 기준 저장</button><button type="button" className="wf-btn" disabled={busy} onClick={()=>void save(true)}>기본값으로 복원</button></div>
      </form>}
      <button type="button" className="wf-btn" disabled={busy} onClick={()=>void load()}>현재 기준 다시 조회</button>
      <p className="wf-muted">다시 조회하면 작성 중인 입력을 현재 저장값으로 바꿉니다. 기준 변경은 거래·재고·확인 완료 기록과 월마감에 영향을 주지 않습니다. 변경 전후와 사유는 관리자 관리의 변경 이력에 보관합니다.</p>
    </section>}
  </div>;
}
