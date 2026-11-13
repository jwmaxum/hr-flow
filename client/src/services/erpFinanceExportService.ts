import {httpsCallable} from 'firebase/functions';
import {functions} from '../firebase';
import {erpScope} from './erpLedgerService';

export type FinanceExportRequest={companyId:string;snapshot:string}&({kind:'DASHBOARD';month:string}|{kind:'STATEMENT';to:string;partnerId:string});
export interface FinanceExportReport {
  companyId:string;kind:'DASHBOARD'|'STATEMENT';companyName:string;partnerId:string;partnerName:string;month:string;from:string;asOf:string;generatedAt:string;sourceSnapshot:string;snapshot:string;title:string;name:string;notes:string[];
  sections:{name:string;note:string;columns:{label:string;width:number;numeric:boolean}[];rows:(string|number|null)[][]}[];
}
interface ExportPdf extends Pick<FinanceExportReport,'companyId'|'kind'|'month'|'asOf'|'partnerId'|'sourceSnapshot'|'snapshot'|'name'>{mimeType:string;size:number;sha256:string;base64:string}
const invoke=httpsCallable<Record<string,unknown>,FinanceExportReport|ExportPdf>(functions,'manageErpFinance',{timeout:120000});
const validHash=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
export async function downloadFinanceReport(request:FinanceExportRequest,format:'XLSX'|'PDF'){
  const scope=erpScope(request.companyId,true);
  if(!validHash(request.snapshot))throw Error('다시 조회한 후 출력해 주세요.');
  const {companyId,snapshot}=request;
  const input=request.kind==='DASHBOARD'?{action:'dashboardExport',month:request.month}:{action:'statementExport',to:request.to,partnerId:request.partnerId};
  const result=(await invoke({...input,companyId,snapshot,format:format==='PDF'?'PDF':'DATA'})).data;
  const checkScope=()=>{if(scope!==erpScope(companyId,true))throw Error('사용자·회사 권한이 변경되었습니다.');};
  checkScope();
  if(!result||result.companyId!==companyId||result.kind!==request.kind||result.sourceSnapshot!==snapshot||!validHash(result.snapshot)||
    (request.kind==='DASHBOARD'?result.month!==request.month||result.partnerId!=='':result.asOf!==request.to||result.partnerId!==request.partnerId))throw Error('출력 자료의 회사·조회 조건이 일치하지 않습니다.');
  if(typeof result.name!=='string'||!/^[^\\/:*?"<>|]{1,180}$/.test(result.name)||/\p{Cc}/u.test(result.name))throw Error('파일명을 확인할 수 없습니다.');
  let blob:Blob,name:string;
  if(format==='PDF'){
    const pdf=result as ExportPdf;
    if(pdf.mimeType!=='application/pdf'||!pdf.name.endsWith('.pdf')||!Number.isSafeInteger(pdf.size)||pdf.size<5||pdf.size>5*1024*1024||!validHash(pdf.sha256)||typeof pdf.base64!=='string'||pdf.base64.length>7*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(pdf.base64))throw Error('PDF 파일 정보를 확인할 수 없습니다.');
    const bytes=Uint8Array.from(atob(pdf.base64),c=>c.charCodeAt(0));
    if(bytes.length!==pdf.size||String.fromCharCode(...bytes.slice(0,5))!=='%PDF-')throw Error('PDF 형식이 올바르지 않습니다.');
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==pdf.sha256)throw Error('PDF 무결성 검증에 실패했습니다.');
    blob=new Blob([bytes],{type:'application/pdf'});name=pdf.name;
  }else{
    const report=result as FinanceExportReport;
    if(!Array.isArray(report.sections)||!report.sections.length||report.sections.length>12||!Array.isArray(report.notes)||report.notes.some(n=>typeof n!=='string'))throw Error('Excel 보고서 구성이 올바르지 않습니다.');
    const seen=new Set();
    for(const s of report.sections){
      if(typeof s.name!=='string'||!s.name||s.name.length>31||['\\','/','?','*','[',']',':'].some(c=>s.name.includes(c))||seen.has(s.name)||!Array.isArray(s.columns)||!s.columns.length||s.columns.length>12||!Array.isArray(s.rows)||s.rows.length>20000)throw Error('Excel 시트 구성이 올바르지 않습니다.');seen.add(s.name);
      if(s.columns.some(c=>typeof c.label!=='string'||!Number.isFinite(c.width)||c.width<=0)||s.rows.some(r=>!Array.isArray(r)||r.length!==s.columns.length||r.some(v=>v!==null&&typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v)))))throw Error('Excel 셀 데이터가 올바르지 않습니다.');
    }
    const {financeWorkbook}=await import('../utils/erpFinanceWorkbook');
    blob=await financeWorkbook(report);name=report.name+'.xlsx';
  }
  checkScope();const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;
  try{link.click();}finally{setTimeout(()=>URL.revokeObjectURL(url),10000);}
}
