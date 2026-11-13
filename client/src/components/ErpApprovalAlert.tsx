import {useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {ClipboardCheck} from 'lucide-react';
import {erpControl} from '../services/erpControlService';
import type {ApprovalAlerts} from '../services/erpControlService';

export function ErpApprovalAlert({companyId,onNavigate}:{companyId:string;onNavigate?:()=>void}){
  const navigate=useNavigate();
  const [alerts,setAlerts]=useState<ApprovalAlerts|null>(null),[error,setError]=useState(false);
  useEffect(()=>{
    let active=true,running=false,again=false;
    async function refresh(){
      if(!active||document.visibilityState==='hidden')return;
      if(running){again=true;return;}running=true;
      try{const data=await erpControl<ApprovalAlerts>(companyId,'approvalAlerts');if(active){setAlerts(data);setError(false);}}
      catch{if(active){setAlerts(null);setError(true);}}
      finally{running=false;if(again&&active){again=false;void refresh();}}
    }
    const update=()=>{void refresh();};update();
    const timer=setInterval(update,60000);
    window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);window.addEventListener('erp:approvals-changed',update);
    return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);window.removeEventListener('erp:approvals-changed',update);};
  },[companyId]);
  const count=alerts?(alerts.hasMore?'100+':String(alerts.pendingCount)):'?';
  const label=alerts?`ERP 승인 대기 ${count}건`:`ERP 승인 알림 ${error?'연결 확인 필요':'확인 중'}`;
  return <button type="button" className="relative inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-2 text-xs text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2" aria-label={label}
    title={`${label} · 화면을 보고 있는 동안 1분마다 갱신합니다.`} onClick={()=>{
      const path='/erp?panel=approvals';const event=new CustomEvent('hr-flow:before-navigation',{cancelable:true,detail:{path}});
      if(!window.dispatchEvent(event))return;navigate(path);onNavigate?.();
    }}><ClipboardCheck size={18} aria-hidden="true"/><span>ERP</span>{(!alerts||alerts.pendingCount>0)&&<span className="rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] text-white">{count}</span>}<span className="sr-only" role="status" aria-live="polite">{label}</span></button>;
}
