import {httpsCallable} from 'firebase/functions';
import {functions} from '../firebase';
import {erpScope} from './erpLedgerService';
import {downloadErpFile} from './erpImportService';
export type ErpAccess='NONE'|'VIEW'|'INBOUND'|'OUTBOUND'|'BOTH'|'ADMIN';
export interface CloseTask {key:string;label:string;assigneeUid:string;assigneeName:string;confirmed:boolean;submission:{by:string;name:string;at:string;note:string}|null}
export interface ClosePlan {companyId:string;month:string;revision:number;status:'OPEN'|'CLOSED';dueDate:string;ownerUid:string;ownerName:string;notes:string;items:CloseTask[];pendingCount:number;myPendingCount:number;actionCount:number;awaitingAdminCount:number;overdue:boolean;today:string}
export interface CloseAlerts {pendingCount:number;overdueCount:number;hasMore:boolean;checkedAt:string}
export interface CloseState {revision:number;closedThrough:string;lastClosedMonth:string}
export interface ErpOperator {uid:string;name:string;email:string;role:string;status:string;access:ErpAccess}
export interface Approval {id:string;domain:string;requestedBy:string;requesterName:string;status:string;createdAt:string;date:string;reason:string;decidedBy?:string;decisionReason?:string;summary:Record<string,unknown>[]}
export interface ChecklistItem {key:string;label:string;checked:boolean;note:string;checkedBy:string|null;checkedByName:string|null;checkedAt:string|null}
export interface Evidence {id:string;name:string;mimeType:string;size:number;sha256:string;uploadedAt:string;uploadedByName:string}
export interface CloseChecklist {companyId:string;month:string;revision:number;items:ChecklistItem[];evidence:Evidence[];noEvidenceReason:string}
export interface ApprovalAlerts {pendingCount:number;hasMore:boolean;checkedAt:string;items:{id:string;requesterName:string;domain:string;createdAt:string;date:string}[]}
export interface Archive {id:string;month:string;version:number;closedAt:string;closedByName:string;reason:string;inventoryValue:number;salesKRW:number;purchasesKRW:number;pendingCount:number;files:{name:string;mimeType:string;size:number;sha256:string}[];checklist?:CloseChecklist}
export interface Change {path:string;before:Record<string,unknown>|null;after:Record<string,unknown>|null}
export interface History {id:string;at:string;actorName:string;action:string;domain:string;reason:string;approvedBy:string|null;requestedBy:string;changes:Change[]}
export interface ClosePreview {revision:number;version:number;checklist:CloseChecklist;checklistReady:boolean;dashboard:{month:string;snapshot:string;inventoryValue:number;salesKRW:number;purchasesKRW:number;pendingCount:number}}
const callable=httpsCallable<Record<string,unknown>,unknown>(functions,'manageErpControl',{timeout:300000});
export async function erpControl<T>(companyId:string,action:string,data:Record<string,unknown>={}):Promise<T>{
  const admin=!['status','approvals','closePlans','closeAlerts','closePlanGet','closeTaskSubmit'].includes(action),mode=admin?true:false;
  const scope=erpScope(companyId,mode),response=await callable({...data,companyId,action});
  if(scope!==erpScope(companyId,mode))throw new Error('로그인 사용자 또는 ERP 권한이 변경되었습니다.');
  if(action==='decide')window.dispatchEvent(new Event('erp:approvals-changed'));
  if(['closePlanSave','closeTaskSubmit','closeTaskReset','checklistSave','reopen','close'].includes(action))window.dispatchEvent(new Event('erp:closing-changed'));
  return response.data as T;
}
export async function downloadClose(companyId:string,id:string,fileIndex:number){
  return verifiedDownload(companyId,'download',{id,fileIndex},['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
}
async function verifiedDownload(companyId:string,action:string,data:Record<string,unknown>,types:string[]){
  const scope=erpScope(companyId,true);
  const file=await erpControl<{companyId:string;name:string;mimeType:string;size:number;sha256:string;base64:string}>(companyId,action,data);
  if(file.companyId!==companyId||!Number.isSafeInteger(file.size)||file.size<1||file.size>5*1024*1024||typeof file.base64!=='string'||file.base64.length>Math.ceil(5*1024*1024/3)*4||!types.includes(file.mimeType)||!/^[^/\\]+\.(xlsx|pdf|png|jpe?g|gif|webp)$/i.test(file.name)||[...file.name].some(c=>c.charCodeAt(0)<32))throw new Error('보관 파일 정보를 확인할 수 없습니다.');
  const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==file.sha256||bytes.length!==file.size||scope!==erpScope(companyId,true))throw new Error('보관 파일 또는 현재 권한이 변경되었습니다.');
  downloadErpFile(file);
}
export function downloadEvidence(companyId:string,month:string,id:string,archiveId?:string){
  return verifiedDownload(companyId,'evidenceDownload',{month,id,...(archiveId?{archiveId}:{})},['application/pdf','image/png','image/jpeg','image/gif','image/webp']);
}
export async function uploadEvidence(companyId:string,month:string,revision:number,id:string,file:File){
  const scope=erpScope(companyId,true);
  if(!file.size||file.size>5*1024*1024||!['application/pdf','image/png','image/jpeg','image/gif','image/webp'].includes(file.type))throw new Error('5MB 이하 PDF·이미지 파일을 선택해 주세요.');
  const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('증빙 파일을 읽지 못했습니다.'));reader.readAsDataURL(file);});
  if(scope!==erpScope(companyId,true))throw new Error('ERP 권한이 변경되었습니다.');
  return erpControl<{checklist:CloseChecklist}>(companyId,'evidenceUpload',{month,revision,id,name:file.name,mimeType:file.type,base64});
}
