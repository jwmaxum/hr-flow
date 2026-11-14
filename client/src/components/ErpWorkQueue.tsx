import {useEffect,useState} from 'react';
import {ArrowRight,RefreshCw} from 'lucide-react';
import {erpControl} from '../services/erpControlService';
import type {ErpAccess} from '../utils/erpAccess';
import {erpAccessNames} from '../utils/erpAccess';
import type {ErpView} from '../utils/erpNavigation';
import {erpStartActions} from '../utils/erpStart';
import {getErrorMessage} from '../utils/errors';

type Kind='approvals'|'recovery'|'borrowed'|'opening'|'closing'|'statements';
type Row={id:string;title:string;detail:string;date:string;dateLabel:string;badge:string;priority:number;view:ErpView;source:string;draftId?:string;quantity?:number|null;unit?:string;amountMinor?:number;currency?:string;unallocatedMinor?:number};
interface WorkQueue {companyId:string;access:ErpAccess;today:string;checkedAt:string;sections:{key:Kind;status:'READY'|'ERROR';count:number|null;hasMore:boolean;rows:Row[];message?:string}[]}
const names:Record<Kind,string>={approvals:'승인 대기',recovery:'미수금 회수·수금 배분',borrowed:'차용 반환',opening:'원가 확정',closing:'월마감 담당 업무',statements:'정정 명세표 발행'};
const views:Record<Kind,ErpView>={approvals:'approvals',recovery:'finance',borrowed:'custody',opening:'opening',closing:'closing',statements:'documents'};
const number=(value:number)=>value.toLocaleString('ko-KR',{maximumFractionDigits:4});
const money=(value:number,currency:string)=>`${number(value/(['KRW','JPY'].includes(currency)?1:100))} ${currency}`;
export function ErpWorkQueue({companyId,access,onOpen}:{companyId:string;access:ErpAccess;onOpen:(view:ErpView,source?:string,draftId?:string)=>void}){
  const [value,setValue]=useState<WorkQueue|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[reload,setReload]=useState(0);
  useEffect(()=>{
    let live=true,running=false,last=0;
    async function refresh(){
      if(!live||running||document.visibilityState==='hidden')return;
      running=true;last=Date.now();setBusy(true);setError('');setValue(null);
      try{const result=await erpControl<WorkQueue>(companyId,'workQueue');if(result.companyId!==companyId||result.access!==access)throw new Error('ERP 권한이 변경되었습니다. 페이지를 새로고침해 주세요.');if(live)setValue(result);}
      catch(e){if(live)setError(getErrorMessage(e));}
      finally{running=false;if(live)setBusy(false);}
    }
    const focus=()=>{if(Date.now()-last>=60000)void refresh();};void refresh();
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{live=false;window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[companyId,access,reload]);
  return <section className="erp-work-home" aria-label="담당 업무 시작 화면">
    <section className="wf-panel erp-start" aria-label="담당 업무 바로가기"><h2 className="wf-section-title">{erpAccessNames[access]} 시작 화면</h2>
      <p className="wf-muted">{access==='VIEW'?'품목·재고와 입출고 이력을 조회합니다.':access==='INBOUND'?'입고 등록과 입고 후 재고 확인부터 시작하세요.':access==='OUTBOUND'?'출고 등록과 구성품 재고 확인부터 시작하세요.':'자주 처리하는 업무를 선택하거나 아래 미완료 업무를 확인하세요.'}</p>
      <div className="erp-start-actions">{erpStartActions(access).map((a,i)=><button type="button" key={a.view} className={`wf-btn ${i===0?'wf-btn-primary':''}`} onClick={()=>onOpen(a.view)}>{a.label}<ArrowRight size={16} aria-hidden="true"/></button>)}</div>
    </section>
    <section className="wf-panel" aria-label="오늘 할 일" aria-busy={busy}>
      <div className="erp-list-head"><h2 className="wf-section-title">오늘 할 일</h2><button type="button" className="wf-btn" disabled={busy} onClick={()=>setReload(n=>n+1)}><RefreshCw size={16} aria-hidden="true"/>할 일 새로고침</button></div>
      <p className="wf-muted">한국시간 오늘을 기준으로 미완료 업무와 향후 예정 업무를 함께 표시합니다. 목록에서 완료 처리하지 않고 각 업무 화면에서 확인·처리합니다.</p>
      {access!=='ADMIN'&&<p className="erp-notice">본인 승인 요청과 배정된 마감 업무를 표시합니다. 미수금·차용 반환·원가 확정과 최종 승인은 회사 ADMIN 업무입니다.</p>}
      {busy&&<p role="status">담당 업무를 확인하고 있습니다.</p>}{error&&<p role="alert" className="erp-error">{error}</p>}
      {value&&<><p className="wf-muted">기준일 {value.today} · 조회 {new Date(value.checkedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})} · 창을 다시 볼 때 1분 이상 지났으면 갱신합니다.</p>
        <div className="erp-work-grid">{value.sections.map(s=><section className="erp-work-card" key={s.key} aria-label={names[s.key]}>
          <div className="erp-list-head"><h3>{s.key==='approvals'&&access!=='ADMIN'?'내 승인 대기':names[s.key]}</h3><strong>{s.count===null?'확인 필요':`${number(s.count)}${s.hasMore?'+':''}건`}</strong></div>
          {s.status==='ERROR'?<p role="alert" className="erp-error">{s.message}</p>:s.count===0?<p className="wf-muted">현재 확인할 업무가 없습니다.</p>:<ul className="erp-work-list">{s.rows.map(row=><li key={row.id}>
            <span className={`wf-status ${row.priority===0?'wf-status-warning':''}`}>{row.badge}</span><h4>{row.title}</h4><p>{row.detail}</p>
            <p className="wf-muted">{row.dateLabel}{row.date?` ${row.date}`:''}</p>
            {row.quantity!==undefined&&<p>수량 {row.quantity===null?'원본 수량 미입력':`${number(row.quantity)} ${row.unit}`}</p>}
            {row.amountMinor!==undefined&&row.currency&&<><p>문서 잔액 {money(row.amountMinor,row.currency)}</p>{!!row.unallocatedMinor&&<p className="wf-muted">거래처 미배분 수금 {money(row.unallocatedMinor,row.currency)} · 문서별 배분 전 금액입니다.</p>}</>}
            <button type="button" className="wf-btn" aria-label={`${row.title} 업무 열기`} onClick={()=>onOpen(row.view,row.source,row.draftId)}>업무 열기<ArrowRight size={14} aria-hidden="true"/></button>
          </li>)}</ul>}
          {(s.hasMore||(s.count||0)>s.rows.length)&&<p className="wf-muted">일부 항목을 표시했습니다. 전체 목록에서 나머지 업무를 확인하세요.</p>}
          <button type="button" className="wf-btn" onClick={()=>onOpen(views[s.key])}>{names[s.key]} 전체 보기</button>
        </section>)}</div>
      </>}
    </section>
  </section>;
}
