import {useEffect,useRef,useState} from 'react';
import {downloadEvidence,erpControl,uploadEvidence} from '../services/erpControlService';
import type {CloseChecklist} from '../services/erpControlService';
import {getErrorMessage} from '../utils/errors';

export function ErpClosingChecklist({companyId,month,disabled,refresh,onChanged,onPendingChange}:{companyId:string;month:string;disabled:boolean;refresh:number;onChanged:()=>void;onPendingChange:(value:boolean)=>void}){
  const [draft,setDraft]=useState<CloseChecklist|null>(null),[locked,setLocked]=useState(false),[busy,setBusy]=useState(true),[dirty,setDirty]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[attempt,setAttempt]=useState(0),[removeReason,setRemoveReason]=useState('');
  const [chosen,setChosen]=useState<{file:File;id:string}|null>(null);
  const live=useRef(true),operation=useRef(false),fileInput=useRef<HTMLInputElement>(null);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{let active=true;setBusy(true);setError('');
    void erpControl<{checklist:CloseChecklist;locked:boolean}>(companyId,'checklistGet',{month}).then(r=>{if(active){setDraft(r.checklist);setLocked(r.locked);setDirty(false);}}).catch(e=>{if(active){setDraft(null);setError(getErrorMessage(e));}}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};
  },[companyId,month,attempt,refresh]);
  useEffect(()=>{onPendingChange(busy||dirty||!draft);},[busy,dirty,draft,onPendingChange]);
  async function run(action:()=>Promise<void>){if(operation.current||busy||disabled)return;operation.current=true;setBusy(true);setError('');setNotice('');try{await action();}catch(e){if(live.current)setError(getErrorMessage(e));}finally{operation.current=false;if(live.current)setBusy(false);}}
  function accepted(value:CloseChecklist,message:string){if(!live.current)return;setDraft(value);setDirty(false);setNotice(message);onChanged();}
  const blocked=busy||disabled||locked;
  return <section className="erp-close-checklist" aria-label="월마감 체크리스트 및 증빙" aria-busy={busy}>
    <div className="erp-list-head"><h3 className="wf-section-title">월마감 체크리스트·증빙</h3><button className="wf-btn" disabled={busy||disabled} onClick={()=>{if(!dirty||window.confirm('저장하지 않은 확인 내용을 버리고 다시 조회할까요?'))setAttempt(n=>n+1);}}>체크리스트 다시 조회</button></div>
    <p className="wf-muted">재고·거래·미수금 확인 사항을 저장해 주세요. 증빙은 최대 5개, 파일당 5MB·합계 20MB입니다. 미첨부 시에는 사유를 기록합니다.</p>
    {locked&&<p className="erp-notice">마감된 월입니다. 기존 기록은 보관함에서 확인하고, 변경하려면 ADMIN이 재개방해야 합니다.</p>}
    {error&&<p role="alert" className="erp-error">{error}</p>}{notice&&<p role="status" className="erp-success">{notice}</p>}
    {draft&&<>
      <fieldset disabled={blocked} className="erp-checklist-items">{draft.items.map(item=><div key={item.key} className="erp-checklist-item">
        <label className="erp-active-field"><input type="checkbox" checked={item.checked} onChange={e=>{setDraft({...draft,items:draft.items.map(r=>r.key===item.key?{...r,checked:e.target.checked}:r)});setDirty(true);}}/>{item.label}</label>
        <label className="wf-field"><span>{item.label} 메모</span><input className="wf-input" maxLength={500} value={item.note} onChange={e=>{setDraft({...draft,items:draft.items.map(r=>r.key===item.key?{...r,note:e.target.value}:r)});setDirty(true);}}/></label>
        {item.checkedAt&&<small className="wf-muted">최근 저장 확인: {item.checkedByName} · {new Date(item.checkedAt).toLocaleString('ko-KR')}</small>}
      </div>)}</fieldset>
      <label className="wf-field"><span>증빙 미첨부 사유</span><input className="wf-input" disabled={blocked} maxLength={500} value={draft.noEvidenceReason} placeholder="증빙이 없으면 3자 이상 입력" onChange={e=>{setDraft({...draft,noEvidenceReason:e.target.value});setDirty(true);}}/></label>
      <button className="wf-btn" disabled={blocked||!dirty} onClick={()=>void run(async()=>{const r=await erpControl<{checklist:CloseChecklist}>(companyId,'checklistSave',{month,revision:draft.revision,items:draft.items.map(({key,checked,note})=>({key,checked,note})),noEvidenceReason:draft.noEvidenceReason});accepted(r.checklist,'체크리스트를 저장했습니다.');})}>체크리스트 저장</button>
      {dirty&&<p className="erp-notice">변경한 확인 사항을 먼저 저장해 주세요. 저장 전에는 마감 확정과 증빙 변경을 할 수 없습니다.</p>}
      {!locked&&<div className="erp-evidence-upload"><label className="wf-field"><span>월마감 증빙 파일</span><input ref={fileInput} type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.webp" disabled={blocked||dirty||draft.evidence.length>=5} onChange={e=>{const file=e.target.files?.[0];setChosen(file?{file,id:crypto.randomUUID()}:null);}}/></label>
        <button className="wf-btn" disabled={blocked||dirty||!chosen||draft.evidence.length>=5} onClick={()=>void run(async()=>{if(!chosen)return;const r=await uploadEvidence(companyId,month,draft.revision,chosen.id,chosen.file);accepted(r.checklist,'증빙 원본을 첨부했습니다.');setChosen(null);if(fileInput.current)fileInput.current.value='';})}>증빙 첨부</button></div>}
      <ul className="erp-evidence-list">{draft.evidence.map(file=><li key={file.id}><div><strong>{file.name}</strong><small>{(file.size/1024).toFixed(1)}KB · {file.uploadedByName} · {new Date(file.uploadedAt).toLocaleString('ko-KR')}</small></div><div className="erp-actions">
        <button className="wf-btn" disabled={busy||disabled} onClick={()=>void run(()=>downloadEvidence(companyId,month,file.id))} aria-label={`${file.name} 증빙 내려받기`}>내려받기</button>
        {!locked&&<button className="wf-btn" disabled={blocked||dirty||removeReason.trim().length<3} aria-label={`${file.name} 증빙 제외`} onClick={()=>void run(async()=>{const r=await erpControl<{checklist:CloseChecklist}>(companyId,'evidenceRemove',{month,revision:draft.revision,id:file.id,reason:removeReason});accepted(r.checklist,'현재 체크리스트에서 증빙을 제외했습니다. 이전 보관본은 유지됩니다.');setRemoveReason('');})}>제외</button>}
      </div></li>)}</ul>
      {!locked&&!!draft.evidence.length&&<label className="wf-field"><span>증빙 제외 사유</span><input className="wf-input" maxLength={500} disabled={blocked||dirty} value={removeReason} onChange={e=>setRemoveReason(e.target.value)} placeholder="제외할 경우 3자 이상 입력"/></label>}
    </>}
  </section>;
}

export function ArchivedChecklist({companyId,archiveId,checklist,disabled}:{companyId:string;archiveId:string;checklist:CloseChecklist;disabled:boolean}){
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),lock=useRef(false),live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  return <details className="erp-archived-checklist"><summary>마감 당시 체크리스트·증빙 {checklist.evidence.length}개</summary>
    <ul>{checklist.items.map(r=><li key={r.key}>{r.label} · {r.checked?'확인':'미확인'} · {r.checkedByName||'—'} · {r.checkedAt?new Date(r.checkedAt).toLocaleString('ko-KR'):'—'}{r.note&&<p>{r.note}</p>}</li>)}</ul>
    {!checklist.evidence.length&&<p>증빙 미첨부 사유: {checklist.noEvidenceReason}</p>}
    {error&&<p role="alert" className="erp-error">{error}</p>}
    <div className="erp-actions">{checklist.evidence.map(file=><button key={file.id} className="wf-btn" disabled={busy||disabled} aria-label={`${file.name} 마감 증빙 원본`} onClick={()=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');void downloadEvidence(companyId,checklist.month,file.id,archiveId).catch(e=>{if(live.current)setError(getErrorMessage(e));}).finally(()=>{lock.current=false;if(live.current)setBusy(false);});}}>{file.name}</button>)}</div>
  </details>;
}
