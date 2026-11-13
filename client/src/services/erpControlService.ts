import {httpsCallable} from 'firebase/functions';
import {functions} from '../firebase';
import {erpScope} from './erpLedgerService';
import {downloadErpFile} from './erpImportService';
export type ErpAccess='NONE'|'INBOUND'|'OUTBOUND'|'BOTH'|'ADMIN';
export interface CloseState {revision:number;closedThrough:string;lastClosedMonth:string}
export interface ErpOperator {uid:string;name:string;email:string;role:string;status:string;access:ErpAccess}
export interface Approval {id:string;domain:string;requestedBy:string;requesterName:string;status:string;createdAt:string;date:string;reason:string;decidedBy?:string;decisionReason?:string;summary:Record<string,unknown>[]}
export interface Archive {id:string;month:string;version:number;closedAt:string;closedByName:string;reason:string;inventoryValue:number;salesKRW:number;purchasesKRW:number;pendingCount:number;files:{name:string;mimeType:string;size:number;sha256:string}[]}
export interface Change {path:string;before:Record<string,unknown>|null;after:Record<string,unknown>|null}
export interface History {id:string;at:string;actorName:string;action:string;domain:string;reason:string;approvedBy:string|null;requestedBy:string;changes:Change[]}
export interface ClosePreview {revision:number;version:number;dashboard:{month:string;snapshot:string;inventoryValue:number;salesKRW:number;purchasesKRW:number;pendingCount:number}}
const callable=httpsCallable<Record<string,unknown>,unknown>(functions,'manageErpControl',{timeout:300000});
export async function erpControl<T>(companyId:string,action:string,data:Record<string,unknown>={}):Promise<T>{
  const admin=!['status','approvals'].includes(action),mode=admin?true:'operator' as const;
  const scope=erpScope(companyId,mode),response=await callable({...data,companyId,action});
  if(scope!==erpScope(companyId,mode))throw new Error('로그인 사용자 또는 ERP 권한이 변경되었습니다.');
  return response.data as T;
}
export async function downloadClose(companyId:string,id:string,fileIndex:number){
  const scope=erpScope(companyId,true);
  const file=await erpControl<{companyId:string;name:string;mimeType:string;size:number;sha256:string;base64:string}>(companyId,'download',{id,fileIndex});
  if(file.companyId!==companyId||file.size>5*1024*1024||!['application/pdf','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(file.mimeType)||!/^[^/\\]+\.(xlsx|pdf)$/.test(file.name)||[...file.name].some(c=>c.charCodeAt(0)<32))throw new Error('보관 파일 정보를 확인할 수 없습니다.');
  const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==file.sha256||bytes.length!==file.size||scope!==erpScope(companyId,true))throw new Error('보관 파일 또는 현재 권한이 변경되었습니다.');
  downloadErpFile(file);
}
