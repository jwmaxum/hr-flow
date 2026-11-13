import {useRef,useState} from 'react';
import {erpControl} from '../services/erpControlService';
import type {ErpAccess} from '../services/erpControlService';
import {getErrorMessage} from '../utils/errors';
const erpAccessLabels:Record<ErpAccess,string>={NONE:'접근 없음',VIEW:'조회 전용',INBOUND:'입고 담당',OUTBOUND:'출고 담당',BOTH:'입출고 전체',ADMIN:'ADMIN 자동 접근'};
export function ErpEmployeeAccess({companyId,uid,role,currentAccess,active,canManage}:{companyId:string;uid:string;role:string;currentAccess?:string;active:boolean;canManage:boolean}){
  const effective:ErpAccess=role==='ADMIN'?'ADMIN':(['VIEW','INBOUND','OUTBOUND','BOTH'].includes(currentAccess||'')?currentAccess:'NONE') as ErpAccess;
  const [access,setAccess]=useState(effective==='ADMIN'?'BOTH':effective),[reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),lock=useRef(false);
  const editable=canManage&&active&&['SUB_ADMIN','MEMBER'].includes(role);
  return <section className="rounded-xl border border-slate-200 p-4" aria-label="직원 ERP 접근 옵션"><h3 className="font-bold">ERP 접근 권한</h3><p className="text-sm text-slate-500">HR 역할과 별도로 지정합니다. ADMIN은 자동 접근하며, 기존 입출고·가격의 수정과 삭제 반영은 ADMIN만 승인합니다.</p><p className="my-2">현재: {erpAccessLabels[effective]}</p>
    {editable&&<><label className="flex items-center gap-2"><input type="checkbox" style={{width:18,height:18,minHeight:18,padding:0,flexShrink:0}} checked={access!=='NONE'} disabled={busy} onChange={e=>setAccess(e.target.checked?'VIEW':'NONE')}/>ERP 접근 허용</label>
      {access!=='NONE'&&<label className="wf-field"><span>ERP 담당 업무 옵션</span><select aria-label="ERP 담당 업무 옵션" className="wf-input" value={access} disabled={busy} onChange={e=>setAccess(e.target.value as Exclude<ErpAccess,'ADMIN'>)}>{(['VIEW','INBOUND','OUTBOUND','BOTH'] as const).map(v=><option key={v} value={v}>{erpAccessLabels[v]}</option>)}</select></label>}
      <label className="wf-field"><span>ERP 권한 변경 사유</span><input className="wf-input" maxLength={500} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)}/></label>
      <button className="wf-btn" disabled={busy||access===effective||reason.trim().length<3} onClick={()=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');void erpControl(companyId,'grant',{uid,access,expectedAccess:effective,reason}).then(()=>setNotice('ERP 접근 권한을 저장했습니다.')).catch(e=>setError(getErrorMessage(e))).finally(()=>{lock.current=false;setBusy(false);});}}>ERP 접근 옵션 저장</button></>}
    {error&&<p role="alert" className="erp-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </section>;
}
