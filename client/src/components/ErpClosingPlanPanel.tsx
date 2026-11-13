import {useEffect,useRef,useState} from 'react';
import {useAuthStore} from '../store/authStore';
import {erpControl} from '../services/erpControlService';
import type {ClosePlan,ErpOperator} from '../services/erpControlService';
import {getErrorMessage} from '../utils/errors';
const previousMonth=()=>{const d=new Date();return new Date(Date.UTC(d.getFullYear(),d.getMonth()-1,1)).toISOString().slice(0,7);};
export function ErpClosingPlanPanel({companyId}:{companyId:string}){
  const admin=useAuthStore(s=>s.userData?.role==='ADMIN');
  const [month,setMonth]=useState(previousMonth),[reload,setReload]=useState(0),[plans,setPlans]=useState<ClosePlan[]>([]),[more,setMore]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true;void erpControl<{plans:ClosePlan[];hasMore:boolean}>(companyId,'closePlans').then(r=>{if(active){setPlans(r.plans);setMore(r.hasMore);setError('');}}).catch(e=>{if(active)setError(getErrorMessage(e));});return()=>{active=false;};},[companyId,reload]);
  return <section className="wf-panel erp-control" aria-label="월마감 일정 및 담당자">
    <div className="erp-list-head"><h2 className="wf-section-title">월마감 일정·담당자</h2><button className="wf-btn" onClick={()=>setReload(n=>n+1)}>일정 새로고침</button></div>
    <p className="wf-muted">{admin?'ADMIN이 마감 예정일과 담당자를 지정합니다. 완료 보고를 검토한 후 체크리스트 확인과 최종 마감을 진행해 주세요.':'본인에게 배정된 항목을 확인하고 완료 보고를 등록해 주세요. 보고 정정·일정 변경과 최종 마감은 ADMIN이 처리합니다.'}</p>
    {error&&<p role="alert" className="erp-error">{error}</p>}
    <div className="erp-plan-list">{plans.map(p=><button key={p.month} className={`wf-btn ${p.overdue?'erp-plan-overdue':''}`} aria-pressed={p.month===month} onClick={()=>setMonth(p.month)}>{p.month} · 예정 {p.dueDate} · {admin?`미확인 ${p.pendingCount}건`:`내 미보고 ${p.myPendingCount}건`}{p.overdue?' · 기한 경과':''}{!p.pendingCount?' · 마감 확정 대기':''}</button>)}</div>
    {more&&<p className="erp-notice">진행 중인 일정이 100건을 초과했습니다. 조회 월을 선택해 개별 일정을 확인해 주세요.</p>}
    <label className="wf-field"><span>일정 조회 월</span><input className="wf-input" type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label>
    {month&&<PlanMonth key={`${companyId}:${month}:${reload}`} companyId={companyId} month={month} admin={admin} onChanged={()=>setReload(n=>n+1)}/>}
  </section>;
}
function PlanMonth({companyId,month,admin,onChanged}:{companyId:string;month:string;admin:boolean;onChanged:()=>void}){
  const uid=useAuthStore(s=>s.userData?.uid),[plan,setPlan]=useState<ClosePlan|null>(null),[loading,setLoading]=useState(true),[working,setWorking]=useState(false),[locked,setLocked]=useState(false);
  const [users,setUsers]=useState<ErpOperator[]>([]),[checks,setChecks]=useState<{key:string;label:string}[]>([]),[dueDate,setDueDate]=useState(''),[ownerUid,setOwnerUid]=useState(''),[assignments,setAssignments]=useState<Record<string,string>>({}),[notes,setNotes]=useState(''),[reason,setReason]=useState(''),[reports,setReports]=useState<Record<string,string>>({}),[error,setError]=useState('');
  const live=useRef(true),operation=useRef(false),busy=loading||working;
  useEffect(()=>{live.current=true;let active=true;void Promise.all([erpControl<{plan:ClosePlan|null;locked:boolean;checks:{key:string;label:string}[]}>(companyId,'closePlanGet',{month}),admin?erpControl<{users:ErpOperator[]}>(companyId,'directory'):Promise.resolve({users:[]})]).then(([r,d])=>{if(!active)return;setPlan(r.plan);setLocked(r.locked);setChecks(r.checks);setUsers(d.users.filter(u=>u.status==='ACTIVE'&&u.access!=='NONE'));setDueDate(r.plan?.dueDate||'');setOwnerUid(r.plan?.ownerUid||'');setNotes(r.plan?.notes||'');setAssignments(Object.fromEntries(r.plan?.items.map(i=>[i.key,i.assigneeUid])||[]));}).catch(e=>{if(active)setError(getErrorMessage(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;live.current=false;};},[companyId,month,admin]);
  async function run(action:string,data:Record<string,unknown>){if(operation.current||busy||locked)return;operation.current=true;setWorking(true);setError('');try{await erpControl(companyId,action,{month,revision:plan?.revision||0,...data});if(live.current)onChanged();}catch(e){if(live.current)setError(getErrorMessage(e));}finally{operation.current=false;if(live.current)setWorking(false);}}
  return <div aria-busy={busy}>
    {error&&<p role="alert" className="erp-error">{error}</p>}{loading&&<p role="status">마감 일정을 불러오고 있습니다.</p>}
    {locked&&<p className="erp-notice">마감된 월입니다. 당시 일정과 담당자 기록은 보관 보고서에 유지됩니다.</p>}
    {admin&&!loading&&<fieldset disabled={busy||locked} className="erp-form-fields">
      <label className="wf-field"><span>마감 예정일</span><input className="wf-input" type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)}/></label>
      <label className="wf-field"><span>총괄 담당자</span><select aria-label="총괄 담당자" className="wf-input" value={ownerUid} onChange={e=>{setOwnerUid(e.target.value);setAssignments(old=>Object.fromEntries(checks.map(c=>[c.key,old[c.key]||e.target.value])));}}><option value="">담당자 선택</option>{users.map(u=><option key={u.uid} value={u.uid}>{u.name} · {u.access==='ADMIN'?'ADMIN':'ERP 접근자'}</option>)}</select></label>
      {checks.map(c=><label className="wf-field" key={c.key}><span>{c.label} 담당자</span><select aria-label={c.label+' 담당자'} className="wf-input" value={assignments[c.key]||''} onChange={e=>setAssignments({...assignments,[c.key]:e.target.value})}><option value="">담당자 선택</option>{users.map(u=><option key={u.uid} value={u.uid}>{u.name}</option>)}</select></label>)}
      <label className="wf-field"><span>일정 메모</span><input className="wf-input" value={notes} maxLength={500} onChange={e=>setNotes(e.target.value)}/></label>
      <label className="wf-field"><span>일정·보고 변경 사유</span><input className="wf-input" value={reason} maxLength={500} onChange={e=>setReason(e.target.value)} placeholder="3자 이상 입력"/></label>
      <button className="wf-btn wf-btn-primary" disabled={!dueDate||!ownerUid||checks.some(c=>!assignments[c.key])||reason.trim().length<3} onClick={()=>void run('closePlanSave',{dueDate,ownerUid,notes,reason,items:checks.map(({key})=>({key,assigneeUid:assignments[key]}))})}>마감 일정 저장</button>
    </fieldset>}
    {plan&&<><p className={plan.overdue?'erp-error':'erp-notice'}>마감 예정 {plan.dueDate} · 총괄 {plan.ownerName} · ADMIN 미확인 {plan.pendingCount}건 · 완료 보고 검토 대기 {plan.awaitingAdminCount}건{plan.overdue?' · 기한 경과':''}</p>
      <div className="erp-plan-tasks">{plan.items.map(item=><article className="erp-notice" key={item.key}><h3>{item.label}</h3><p>담당자 {item.assigneeName} · {item.confirmed?'ADMIN 확인 완료':item.submission?'완료 보고 · ADMIN 확인 대기':'미완료'}</p>
        {item.submission&&<p>{item.submission.note}<small className="erp-cell-note">{item.submission.name} · {new Date(item.submission.at).toLocaleString('ko-KR')}</small></p>}
        {!locked&&!item.confirmed&&!item.submission&&item.assigneeUid===uid&&<><label className="wf-field"><span>{item.label} 완료 보고 메모</span><input className="wf-input" maxLength={500} disabled={busy} value={reports[item.key]||''} onChange={e=>setReports({...reports,[item.key]:e.target.value})}/></label><button className="wf-btn" disabled={busy||(reports[item.key]||'').trim().length<3} onClick={()=>void run('closeTaskSubmit',{key:item.key,note:reports[item.key]})}>{item.label} 완료 보고</button></>}
        {admin&&!locked&&item.submission&&<button className="wf-btn" disabled={busy||reason.trim().length<3} onClick={()=>void run('closeTaskReset',{key:item.key,reason})}>{item.label} 보고 초기화</button>}
      </article>)}</div></>}
    {!loading&&!plan&&!error&&<p>이 월에 등록된 마감 일정이 없습니다.</p>}
  </div>;
}
