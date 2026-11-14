import {useEffect,useId,useRef,useState} from 'react';
import {erpService} from '../services/erpService';
import type {ErpRecord,ItemSearchCursor} from '../services/erpService';
import {getErrorMessage} from '../utils/errors';

const label=(item:ErpRecord)=>`${item.code} · ${item.name}`;
export function ErpItemPicker({companyId,item,disabled,onSelect,onClear,onCreate,creating=false,excludeBundles=false}:{companyId:string;item:ErpRecord|null;disabled:boolean;onSelect:(item:ErpRecord)=>void;onClear:()=>void;onCreate?:()=>void;creating?:boolean;excludeBundles?:boolean}){
  const id=useId(),epoch=useRef(0),input=useRef<HTMLInputElement>(null);
  const [query,setQuery]=useState(''),[typed,setTyped]=useState(false),[open,setOpen]=useState(false),[composing,setComposing]=useState(false);
  const [rows,setRows]=useState<ErpRecord[]>([]),[cursor,setCursor]=useState<ItemSearchCursor|null>(null),[page,setPage]=useState<ItemSearchCursor|undefined>();
  const [active,setActive]=useState(-1),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const search=typed?query:'';
  useEffect(()=>{
    const current=++epoch.current;
    if(!open||disabled||composing)return;
    const timer=setTimeout(()=>{
      setBusy(true);setError('');
      void (async()=>{
        let next=page,scanned=0;const found:ErpRecord[]=[];
        do{
          const result=await erpService.searchItems(companyId,search,next);
          if(epoch.current!==current)return;
          found.push(...result.records.filter(row=>!excludeBundles||row.itemType!=='BUNDLE'));scanned+=result.scanned;next=result.nextCursor||undefined;
        }while(next&&found.length<30&&scanned<2000);
        if(epoch.current===current){setRows(previous=>page?[...previous,...found.filter(r=>!previous.some(p=>p.id===r.id))]:found);setCursor(next||null);setActive(-1);}
      })().catch(e=>{if(epoch.current===current)setError(getErrorMessage(e));}).finally(()=>{if(epoch.current===current)setBusy(false);});
    },search?300:0);
    return()=>{clearTimeout(timer);epoch.current=current+1;};
  },[companyId,search,open,disabled,composing,page,retry,excludeBundles]);
  useEffect(()=>{if(open&&active>=0)document.getElementById(`${id}-option-${active}`)?.scrollIntoView({block:'nearest'});},[active,open,id]);
  function close(){epoch.current++;input.current?.focus();setQuery('');setTyped(false);setOpen(false);setBusy(false);setActive(-1);}
  function choose(value:ErpRecord){close();onSelect(value);}
  function chooseNew(){close();onCreate?.();}
  function change(value:string){epoch.current++;setQuery(value);setTyped(true);setOpen(true);setRows([]);setCursor(null);setPage(undefined);setActive(-1);setError('');setBusy(true);if(item||creating)onClear();}
  const shown=open&&!disabled,offset=onCreate?1:0,optionCount=rows.length+offset;
  return <div className="wf-field erp-form-wide erp-item-picker" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget)){setOpen(false);setActive(-1);}}}>
    <label htmlFor={id}>등록 품목 선택 *</label>
    <input ref={input} id={id} className="wf-input" role="combobox" aria-autocomplete="list" aria-expanded={shown} aria-controls={shown?`${id}-list`:undefined}
      aria-activedescendant={shown&&active>=0?`${id}-option-${active}`:undefined} aria-describedby={`${id}-hint`} required disabled={disabled}
      autoComplete="off" maxLength={120} placeholder="코드·모델번호·품목명·규격의 일부 입력" value={typed?query:creating?'신규 품목 등록':item?label(item):query}
      onFocus={()=>{setOpen(true);setPage(undefined);}} onChange={e=>change(e.target.value)}
      onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)}
      onKeyDown={e=>{
        if(e.nativeEvent.isComposing||composing)return;
        if(e.key==='Escape'){e.preventDefault();setOpen(false);setActive(-1);}
        else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setOpen(true);setActive(v=>!optionCount?-1:e.key==='ArrowDown'?Math.min(optionCount-1,v+1):Math.max(0,v<0?optionCount-1:v-1));}
        else if(e.key==='Enter'&&shown){e.preventDefault();if(onCreate&&active===0)chooseNew();else if(active>=offset&&rows[active-offset])choose(rows[active-offset]);}
      }}/>
    <small id={`${id}-hint`} className="wf-muted">일부 문자열로 검색한 뒤 목록에서 선택하세요.{onCreate&&' 새 품목은 목록 맨 위의 ‘신규 품목 등록’을 선택하세요.'} 방향키로 이동하고 Enter로 선택할 수 있습니다.</small>
    {shown&&<div className="erp-item-options">
      <div id={`${id}-list`} role="listbox" aria-label="품목 검색 결과" aria-busy={busy}>
      {onCreate&&<button type="button" role="option" aria-label="신규 품목 등록" id={`${id}-option-0`} tabIndex={-1} aria-selected={active===0} className="erp-item-option" onMouseDown={e=>e.preventDefault()} onClick={chooseNew}><strong>+ 신규 품목 등록</strong><small>새 품목 정보를 직접 입력합니다.</small></button>}
      {rows.map((row,i)=><button type="button" role="option" id={`${id}-option-${i+offset}`} key={row.id} tabIndex={-1}
        aria-selected={active===i+offset} className="erp-item-option" onMouseDown={e=>e.preventDefault()} onClick={()=>choose(row)}>
        <strong>{label(row)}</strong><small>{row.specification||'규격 미입력'} · {row.unit} {row.itemType==='BUNDLE'?'· 세트':''}</small>
      </button>)}</div>
      <p role="status" className="wf-muted">{busy?'회사 품목을 검색하고 있습니다.':error?'검색을 완료하지 못했습니다.':rows.length?`${rows.length}개 표시${cursor?' · 더 검색할 품목이 있습니다.':''}`:cursor?'확인한 구간에 일치하는 품목이 없습니다. 남은 품목을 계속 검색하세요.':'일치하는 사용 중 품목이 없습니다.'}</p>
      {error&&<p role="alert" className="erp-error">{error} <button type="button" className="wf-btn" onClick={()=>setRetry(v=>v+1)}>검색 다시 시도</button></p>}
      {cursor&&!error&&<button type="button" className="wf-btn" disabled={busy} onClick={()=>setPage(cursor)}>{rows.length?'검색 결과 더 보기':'남은 품목 계속 검색'}</button>}
    </div>}
    {!shown&&typed&&!item&&!creating&&<small className="erp-error">검색 결과에서 등록 품목을 선택해 주세요.{onCreate&&' 새 품목은 신규 품목 등록을 선택하세요.'}</small>}
  </div>;
}
