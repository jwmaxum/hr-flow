import type {ErpAccess} from './erpAccess';
import type {ErpView} from './erpNavigation';
export function erpStartActions(access:ErpAccess):{view:ErpView;label:string}[]{
  const stock={view:'items' as const,label:'품목·재고 조회'},inbound={view:'inbound' as const,label:'입고 등록하기'},outbound={view:'outbound' as const,label:'출고 등록하기'},report={view:'report' as const,label:'입출고 원장 조회'};
  switch(access){
    case 'ADMIN':return [inbound,outbound,{view:'shipments',label:'출고 문서 관리'},{view:'dashboard',label:'월별 현황 보기'}];
    case 'MANAGER':return [inbound,outbound,{view:'report',label:'입출고 원장·정정'},{view:'transfer',label:'창고 이동하기'}];
    case 'BOTH':return [inbound,outbound,{view:'transfer',label:'창고 이동하기'},stock];
    case 'INBOUND':return [inbound,stock,report];
    case 'OUTBOUND':return [outbound,stock,report];
    case 'VIEW':return [stock,report];
    default:return [];
  }
}
