export type ErpAccess = 'NONE' | 'VIEW' | 'INBOUND' | 'OUTBOUND' | 'BOTH' | 'MANAGER' | 'ADMIN';
export function erpAccessOf(user: {role?:string;erpAccess?:string;status?:string}|null|undefined):ErpAccess {
  if(!user || user.status && user.status!=='ACTIVE')return 'NONE';
  if(user.role==='ADMIN')return 'ADMIN';
  if(user.role==='SUB_ADMIN'&&user.erpAccess==='MANAGER')return 'MANAGER';
  return ['SUB_ADMIN','MEMBER'].includes(user.role||'')&&['VIEW','INBOUND','OUTBOUND','BOTH'].includes(user.erpAccess||'')?user.erpAccess as ErpAccess:'NONE';
}
export const erpAccessNames:Record<ErpAccess,string>={NONE:'접근 없음',VIEW:'조회 전용',INBOUND:'입고 담당',OUTBOUND:'출고 담당',BOTH:'입출고 전체',MANAGER:'ERP관리자',ADMIN:'ADMIN 전체 관리'};
export const erpCanOperate=(access:ErpAccess)=>['ADMIN','MANAGER','BOTH','INBOUND','OUTBOUND'].includes(access);
