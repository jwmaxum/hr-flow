import {useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {CalendarClock} from 'lucide-react';
import {erpControl} from '../services/erpControlService';
import type {CloseAlerts} from '../services/erpControlService';
export function ErpClosingAlert({companyId,onNavigate}:{companyId:string;onNavigate?:()=>void}){
  const navigate=useNavigate(),[value,setValue]=useState<CloseAlerts|null>(null);
  useEffect(()=>{let active=true,running=false,again=false;
    async function update(){if(!active||document.visibilityState==='hidden')return;if(running){again=true;return;}running=true;try{const r=await erpControl<CloseAlerts>(companyId,'closeAlerts');if(active)setValue(r);}catch{if(active)setValue(null);}finally{running=false;if(active&&again){again=false;void update();}}}
    const refresh=()=>{void update();};refresh();const timer=setInterval(refresh,60000);
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);window.addEventListener('erp:closing-changed',refresh);
    return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('erp:closing-changed',refresh);};
  },[companyId]);
  const count=value?(value.hasMore?'100+':String(value.pendingCount)):'?',label=value?`월마감 미완료 ${count}건 · 기한 경과 ${value.overdueCount}건`:'월마감 알림 연결 확인 중';
  return <button className="relative inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-2 text-xs text-slate-600 hover:bg-slate-100" type="button" title={`${label} · 1분마다 갱신`} aria-label={label} onClick={()=>{const path='/erp?panel=closing';if(!window.dispatchEvent(new CustomEvent('hr-flow:before-navigation',{cancelable:true,detail:{path}})))return;navigate(path);onNavigate?.();}}><CalendarClock size={18} aria-hidden="true"/>{(!value||value.pendingCount>0)&&<span className={`rounded-full px-1.5 py-0.5 text-[10px] text-white ${value?.overdueCount?'bg-rose-600':'bg-violet-700'}`}>{count}</span>}<span className="sr-only" role="status" aria-live="polite">{label}</span></button>;
}
