import {useEffect,useRef,useState} from 'react';
import {erpControl} from '../services/erpControlService';
import {erpToday} from '../services/erpAccountService';
import {getErrorMessage} from '../utils/errors';
type Cursor={offset:number;snapshot:string};
interface ReviewRow {id:string;at:string;actorName:string;actorErpAccess:string;authorization:string;approvedBy:string|null;reason:string;domain:string;action:string;categories:string[];documents:string[];changeCount:number;changes:{label:string;warehouseName:string;currency:string;values:{label:string;before:string;after:string}[]}[]}
interface Review {from:string;to:string;total:number;filteredTotal:number;offset:number;categories:{key:string;label:string;count:number}[];rows:ReviewRow[];nextCursor:Cursor|null}
const categories:Record<string,string>={STOCK:'재고 변동',TRADE:'거래 수정·정산',DELETE:'취소·삭제·사용중지',DOCUMENT:'거래서류 변경',CLOSE:'월마감·승인',MASTER:'기준정보·권한'};
const actions:Record<string,string>={MONTH_CLOSE:'월마감 확정',MONTH_REOPEN:'월마감 재개방',ERP_ACCESS_CHANGED:'ERP 권한 변경',APPROVAL_REJECT:'승인 반려',CLOSE_PLAN_SAVE:'마감 일정 저장',CHECKLIST_SAVE:'체크리스트 저장',save:'저장',commit:'확정',issue:'발행',revise:'정정',cancel:'취소',returnRevision:'반품 정정'};
export function ErpChangeReviewPanel({companyId,month,onHistory}:{companyId:string;month:string;onHistory:()=>void}){
  const end=new Date(Date.UTC(+month.slice(0,4),+month.slice(5,7),0)).toISOString().slice(0,10);
  const [from,setFrom]=useState(month+'-01'),[to,setTo]=useState([end,erpToday()].sort()[0]),[category,setCategory]=useState('ALL');
  const [data,setData]=useState<Review|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState('');
  const live=useRef(true),lock=useRef(false);
  useEffect(()=>{live.current=true;void erpControl<Review>(companyId,'review',{from:month+'-01',to:[end,erpToday()].sort()[0],category:'ALL'}).then(r=>{if(live.current)setData(r);}).catch(e=>{if(live.current)setError(getErrorMessage(e));}).finally(()=>{if(live.current)setBusy(false);});return()=>{live.current=false;};},[companyId,month,end]);
  async function query(cursor?:Cursor){if(busy||lock.current)return;lock.current=true;setBusy(true);setError('');try{const r=await erpControl<Review>(companyId,'review',{from,to,category,...(cursor?{cursor}:{})});if(live.current)setData(r);}catch(e){if(live.current){setData(null);setError(getErrorMessage(e));}}finally{lock.current=false;if(live.current)setBusy(false);}}
  return <section className="wf-panel erp-change-review" aria-label="주요 변경 점검" aria-busy={busy}>
    <div className="erp-list-head"><h2 className="wf-section-title">주요 변경 점검</h2><button className="wf-btn" onClick={onHistory}>전체 변경 이력 보기</button></div>
    <p className="wf-muted">실제 처리한 시각 기준으로 재고·거래·거래서류 변경을 확인합니다. ERP관리자가 직접 처리한 내역도 보존합니다.</p>
    <form className="erp-review-filters" onSubmit={e=>{e.preventDefault();void query();}}>
      <label className="wf-field"><span>변경 시작일</span><input className="wf-input" type="date" required min="2000-01-01" max={to} disabled={busy} value={from} onChange={e=>{setFrom(e.target.value);setData(null);}}/></label>
      <label className="wf-field"><span>변경 종료일</span><input className="wf-input" type="date" required min={from} max={erpToday()} disabled={busy} value={to} onChange={e=>{setTo(e.target.value);setData(null);}}/></label>
      <label className="wf-field"><span>변경 유형</span><select className="wf-input" disabled={busy} value={category} onChange={e=>{setCategory(e.target.value);setData(null);}}><option value="ALL">전체</option>{Object.entries(categories).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <button className="wf-btn wf-btn-primary" disabled={busy}>변경 내역 조회</button>
    </form>
    {busy&&<p role="status">변경 내역을 확인하고 있습니다.</p>}{error&&<p role="alert" className="erp-error">{error}</p>}
    {data&&<><p>{data.from} ~ {data.to} · 전체 <strong>{data.total}건</strong> · 선택 유형 {data.filteredTotal}건</p>
      <div className="erp-review-counts">{data.categories.map(c=><article key={c.key}><span>{c.label}</span><strong>{c.count.toLocaleString('ko-KR')}건</strong></article>)}</div>
      <p className="wf-muted">한 처리에 여러 변경 유형이 포함될 수 있어 유형별 건수의 합은 전체 건수와 다를 수 있습니다. 신규 등록·입출고도 포함합니다.</p>
      {!data.rows.length?<p>조회 기간에 해당하는 변경이 없습니다.</p>:<div className="erp-table-scroll" tabIndex={0} role="region" aria-label="주요 변경 내역 표"><table className="erp-table erp-review-table"><caption>재고·거래·거래서류 변경 내역</caption><thead><tr><th>처리 시각·담당자</th><th>유형·문서</th><th>사유·변경 전후</th></tr></thead><tbody>{data.rows.map(row=><tr key={row.id}><td>{new Date(row.at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}<strong className="erp-cell-note">{row.actorName}</strong><small className="erp-cell-note">{row.authorization==='ERP_MANAGER_DIRECT'?'ERP관리자 직접 처리':row.approvedBy?'승인 반영':row.actorErpAccess==='MANAGER'?'ERP관리자 처리':'처리 완료'}</small></td><td>{row.categories.map(c=>categories[c]).join(' · ')}<small className="erp-cell-note">{row.documents.join(' / ')||actions[row.action]||'업무 처리'}</small></td><td><p>{row.reason||'신규 등록 또는 업무 처리'}</p>{row.changeCount>0&&<details><summary>변경 전후 {row.changeCount}개 항목</summary>{row.changes.map((c,i)=><div key={i}><h4>{c.label}{c.warehouseName?` · ${c.warehouseName}`:''}{c.currency?` (${c.currency})`:''}</h4><table className="erp-table"><thead><tr><th>항목</th><th>변경 전</th><th>변경 후</th></tr></thead><tbody>{c.values.map((v,j)=><tr key={j}><td>{v.label}</td><td>{v.before}</td><td>{v.after}</td></tr>)}</tbody></table></div>)}{row.changeCount>row.changes.length&&<p>변경 {row.changeCount}개 중 {row.changes.length}개 표시 · 나머지는 전체 변경 이력에서 확인하세요.</p>}</details>}</td></tr>)}</tbody></table></div>}
      <div className="erp-actions"><span>{data.rows.length?`${data.offset+1}~${data.offset+data.rows.length} / ${data.filteredTotal}건`:''}</span>{data.offset>0&&<button className="wf-btn" disabled={busy} onClick={()=>void query()}>처음으로</button>}{data.nextCursor&&<button className="wf-btn" disabled={busy} onClick={()=>void query(data.nextCursor!)}>이전 변경 더 보기</button>}</div>
    </>}
  </section>;
}
