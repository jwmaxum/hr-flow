import {useEffect,useRef,useState} from 'react';
import {ErpReviewPolicySettings} from './ErpReviewPolicySettings';
import {erpControl,type ReviewPolicy} from '../services/erpControlService';
import {getErrorMessage} from '../utils/errors';
import {useAuthStore} from '../store/authStore';
type Cursor={at:string;key:string;snapshot:string};
interface Row {id:string;fingerprint:string;at:string;ageDays:number;actorName:string;authorization:string;reason:string;documents:string[];categories:string[];changeCount:number}
interface Detail {changes:{label:string;warehouseName:string;values:{label:string;before:string;after:string}[]}[]}
interface Inbox {policy:ReviewPolicy;ready:boolean;processed?:number;today:string;checkedAt:string;pendingCount:number;agedCount:number;urgentCount:number;previousMonthCount:number;oldestAgeDays:number;filteredTotal:number;rows:Row[];nextCursor:Cursor|null}
const categories:Record<string,string>={STOCK:'재고 변동',TRADE:'거래 수정·정산',DELETE:'취소·삭제·사용중지',DOCUMENT:'거래서류 변경',MASTER:'기준정보·단가'};
function Details({companyId,row}:{companyId:string;row:Row}){
  const [data,setData]=useState<Detail|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const live=useRef(true),lock=useRef(false);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  async function load(){if(lock.current||data)return;lock.current=true;setBusy(true);setError('');try{const r=await erpControl<Detail>(companyId,'reviewInboxDetail',{id:row.id,fingerprint:row.fingerprint});if(live.current)setData(r);}catch(e){if(live.current)setError(getErrorMessage(e));}finally{lock.current=false;if(live.current)setBusy(false);}}
  return <details onToggle={e=>{if(e.currentTarget.open)void load();}}><summary>변경 전후 {row.changeCount}개 항목</summary>{busy&&<p role="status">원본 변경 내용을 확인하고 있습니다.</p>}{error&&<><p role="alert" className="erp-error">{error}</p><button className="wf-btn" disabled={busy} onClick={()=>void load()}>상세 조회 재시도</button></>}{data&&<>{data.changes.map((c,i)=><div key={i}><h4>{c.label}{c.warehouseName?' · '+c.warehouseName:''}</h4><table className="erp-table"><thead><tr><th>항목</th><th>변경 전</th><th>변경 후</th></tr></thead><tbody>{c.values.map((v,j)=><tr key={j}><td>{v.label}</td><td>{v.before}</td><td>{v.after}</td></tr>)}</tbody></table></div>)}{row.changeCount>data.changes.length&&<p>앞 {data.changes.length}개 항목 표시 · 나머지는 전체 변경 이력에서 확인하세요.</p>}</>}</details>;
}
export function ErpReviewInboxPanel({companyId,focusOnReady=false}:{companyId:string;focusOnReady?:boolean}){
  const isAdmin=useAuthStore(s=>s.userData?.role==='ADMIN');
  const [filter,setFilter]=useState('ALL'),[data,setData]=useState<Inbox|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[selected,setSelected]=useState<string[]>([]),[reload,setReload]=useState(0),[cursor,setCursor]=useState<Cursor|undefined>();
  const live=useRef(true),lock=useRef(false),heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{if(!focusOnReady)return;const frame=requestAnimationFrame(()=>heading.current?.focus());return()=>cancelAnimationFrame(frame);},[focusOnReady]);
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>|undefined;live.current=true;
    async function load(){setBusy(true);setError('');setSelected([]);setData(null);
      try{const r=await erpControl<Inbox>(companyId,'reviewInbox',{filter,...(cursor?{cursor}:{})});if(!active)return;setData(r);if(!r.ready){timer=setTimeout(()=>void load(),300);return;}}
      catch(e){if(active)setError(getErrorMessage(e));}
      if(active)setBusy(false);
    }
    void load();return()=>{active=false;live.current=false;clearTimeout(timer);};
  },[companyId,filter,reload,cursor]);
  function refresh(){setCursor(undefined);setReload(n=>n+1);}
  async function confirm(rows:Row[]){
    if(!isAdmin||busy||lock.current||!rows.length)return;lock.current=true;setBusy(true);setError('');setNotice('');
    try{const r=await erpControl<{confirmed:number;alreadyConfirmed:number}>(companyId,'reviewConfirm',{items:rows.map(({id,fingerprint})=>({id,fingerprint}))});if(!live.current)return;setNotice(`확인 완료 ${r.confirmed}건${r.alreadyConfirmed?' · 이미 확인된 '+r.alreadyConfirmed+'건':''}. 확인 기록은 저장되었습니다. 원본 거래와 재고는 바뀌지 않습니다.`);setData(null);setSelected([]);refresh();}
    catch(e){if(live.current){setData(null);setSelected([]);setError(getErrorMessage(e));setBusy(false);}}
    finally{lock.current=false;}
  }
  return <section className="wf-panel erp-change-review" aria-label="누적 미확인 점검함" aria-busy={busy}>
    <div className="erp-list-head"><h2 ref={heading} tabIndex={-1} className="wf-section-title">누적 미확인 점검함</h2><button className="wf-btn" disabled={busy} onClick={refresh}>점검함 새로고침</button></div>
    <p className="wf-muted">이전 달을 포함한 모든 미확인 중요 변경을 오래된 순서로 표시합니다. 한국시간 처리일과 오늘의 날짜 차이로 경과일을 계산합니다. ADMIN 확인 완료는 거래 승인과 별개입니다.</p>
    {isAdmin&&<ErpReviewPolicySettings key={companyId} companyId={companyId} onSaved={refresh}/>}
    <label className="wf-field"><span>미확인 경과일</span><select className="wf-input" value={filter} disabled={busy} onChange={e=>{setFilter(e.target.value);setCursor(undefined);setNotice('');}}><option value="ALL">전체 미확인</option><option value="AGED">{data?.policy.agedDays??14}일 이상 · 장기 미확인</option><option value="URGENT">{data?.policy.urgentDays??30}일 이상 · 우선 점검</option></select></label>
    {notice&&<p role="status" className="erp-notice">{notice}</p>}{error&&<p role="alert" className="erp-error">{error}{notice?' 확인은 이미 저장되었습니다. 점검함 새로고침으로 목록만 다시 확인해 주세요.':''}</p>}
    {busy&&<p role="status">{data&&!data.ready?`이전 이력을 연결하고 있습니다 (${data.processed||0}개 기록 확인). 완료 전에는 전체 건수를 표시하지 않습니다.`:'누적 미확인 내역을 확인하고 있습니다.'}</p>}
    {data?.ready&&<>
      <div className="erp-review-counts">{[['누적 미확인',data.pendingCount],['이전 달까지 미확인',data.previousMonthCount],[data.policy.agedDays+'일 이상 장기 미확인',data.agedCount],[data.policy.urgentDays+'일 이상 우선 점검',data.urgentCount]].map(([label,count])=><article key={label}><span>{label}</span><strong>{count}건</strong></article>)}</div>
      <p className="wf-muted">기준일 {data.today} · 가장 오래된 미확인 {data.oldestAgeDays}일 · {data.policy.urgentDays}일 이상은 {data.policy.agedDays}일 이상에 포함됩니다. 선택 조건 {data.filteredTotal}건</p>
      {isAdmin&&data.rows.length>0&&<div className="erp-actions"><label><input type="checkbox" disabled={busy} checked={selected.length===data.rows.length} onChange={e=>setSelected(e.target.checked?data.rows.map(r=>r.id):[])}/> 현재 페이지 모두 선택</label><button className="wf-btn wf-btn-primary" disabled={busy||!selected.length} onClick={()=>void confirm(data.rows.filter(r=>selected.includes(r.id)))}>선택 {selected.length}건 확인 완료</button></div>}
      {!data.rows.length?<p>선택한 조건의 미확인 중요 변경이 없습니다.</p>:<div className="erp-table-scroll" tabIndex={0} role="region" aria-label="누적 미확인 변경 표"><table className="erp-table erp-review-table"><caption>이전 달을 포함한 미확인 중요 변경</caption><thead><tr><th>경과일·ADMIN 확인</th><th>처리 시각·담당자</th><th>유형·문서</th><th>사유·변경 전후</th></tr></thead><tbody>{data.rows.map(row=><tr key={row.id+row.fingerprint}><td><strong className={row.ageDays>=data.policy.agedDays?'erp-error':''}>{row.ageDays>=data.policy.urgentDays?'우선 점검':row.ageDays>=data.policy.agedDays?'장기 미확인':'미확인'} · {row.ageDays}일</strong>{isAdmin&&<><label className="erp-cell-note"><input type="checkbox" disabled={busy} aria-label={'변경 '+row.id+' 확인 대상으로 선택'} checked={selected.includes(row.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,row.id]:ids.filter(id=>id!==row.id))}/> 확인 대상 선택</label><button className="wf-btn" disabled={busy} onClick={()=>void confirm([row])}>이 변경 확인 완료</button></>}</td><td>{new Date(row.at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}<strong className="erp-cell-note">{row.actorName}</strong>{row.authorization==='ERP_MANAGER_DIRECT'&&<small className="erp-cell-note">ERP관리자 직접 처리</small>}</td><td>{row.categories.map(c=>categories[c]||c).join(' · ')}<small className="erp-cell-note">{row.documents.join(' / ')||'업무 처리'}</small></td><td><p>{row.reason||'신규 등록 또는 업무 처리'}</p><Details companyId={companyId} row={row}/></td></tr>)}</tbody></table></div>}
      <div className="erp-actions">{cursor&&<button className="wf-btn" disabled={busy} onClick={refresh}>처음으로</button>}{data.nextCursor&&<button className="wf-btn" disabled={busy} onClick={()=>setCursor(data.nextCursor!)}>다음 미확인 보기</button>}</div>
      <p className="wf-muted">한 페이지 최대 30건을 확인합니다. 확인자·확인 시각은 기간별 변경 이력의 확인 완료 필터에서 조회합니다. ERP관리자는 조회할 수 있으며 확인 완료 표시는 회사 ADMIN만 할 수 있습니다.</p>
    </>}
  </section>;
}
