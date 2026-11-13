import {useEffect,useRef,useState} from 'react';
import {FileSpreadsheet,Printer} from 'lucide-react';
import {downloadFinanceReport} from '../services/erpFinanceExportService';
import type {FinanceExportRequest} from '../services/erpFinanceExportService';
import {getErrorMessage} from '../utils/errors';
export function ErpFinanceExportButtons({request,label,disabled=false}:{request:FinanceExportRequest|null;label:string;disabled?:boolean}){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const lock=useRef(false),live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  async function download(format:'XLSX'|'PDF'){
    if(!request||lock.current||disabled)return;lock.current=true;setBusy(true);setMessage('');setError('');
    try{await downloadFinanceReport(request,format);if(live.current)setMessage(format==='PDF'?'PDF를 내려받았습니다. PDF 뷰어에서 인쇄해 주세요.':'전체 내역을 Excel로 내려받았습니다.');}
    catch(e){if(live.current)setError(getErrorMessage(e));}finally{lock.current=false;if(live.current)setBusy(false);}
  }
  return <div className="erp-export-controls" aria-busy={busy}><div className="erp-actions"><button type="button" className="wf-btn" disabled={disabled||busy||!request} onClick={()=>void download('XLSX')}><FileSpreadsheet size={16} aria-hidden="true"/>{label} Excel</button><button type="button" className="wf-btn" disabled={disabled||busy||!request} onClick={()=>void download('PDF')}><Printer size={16} aria-hidden="true"/>{label} PDF·인쇄</button></div><p className="wf-muted">전체 내역 출력 · PDF는 최대 2,000행이며, 초과하면 Excel로 내려받아 주세요.</p>{busy&&<p role="status">전체 원장을 확인하고 보고서를 생성하고 있습니다.</p>}{message&&<p role="status" className="erp-success">{message}</p>}{error&&<p role="alert" className="erp-error">{error}</p>}</div>;
}
