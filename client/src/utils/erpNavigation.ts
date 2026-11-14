import type {ErpAccess} from './erpAccess';
export type ErpMenu='dashboard'|'stock'|'inbound'|'sales'|'receivables'|'admin';
export type ErpView='today'|'dashboard'|'items'|'report'|'transfer'|'custody'|'inbound'|'outbound'|'import'|'opening'|'shipments'|'documents'|'finance'|'warehouses'|'partners'|'access'|'approvals'|'close'|'history'|'closing';
export const erpMenus:{id:ErpMenu;label:string;description:string}[]=[
  {id:'dashboard',label:'대시보드',description:'담당 업무별 오늘 할 일과 월별 현황을 확인합니다.'},
  {id:'stock',label:'품목·재고',description:'일반·세트 품목, 창고별 재고와 입출고 이력을 확인합니다.'},
  {id:'inbound',label:'입고',description:'입고를 등록하고 매입 내역과 Excel 이관 자료를 확인합니다.'},
  {id:'sales',label:'판매·출고',description:'출고 등록부터 수금·반품·명세표까지 이어서 처리합니다.'},
  {id:'receivables',label:'미수금·수금',description:'거래처별 미수잔액과 수금·배분·회수 일정을 관리합니다.'},
  {id:'admin',label:'관리자 관리',description:'창고·거래처 설정과 권한·승인·월마감 업무를 관리합니다.'},
];
type Task={view:ErpView;label:string;allow:(access:ErpAccess)=>boolean};
const all=(a:ErpAccess)=>a!=='NONE',admin=(a:ErpAccess)=>a==='ADMIN';
export const erpInbound=(a:ErpAccess)=>['ADMIN','MANAGER','BOTH','INBOUND'].includes(a);
export const erpOutbound=(a:ErpAccess)=>['ADMIN','MANAGER','BOTH','OUTBOUND'].includes(a);
const both=(a:ErpAccess)=>['ADMIN','MANAGER','BOTH'].includes(a);
const report:Task={view:'report',label:'입출고 총괄·원장',allow:all},upload:Task={view:'import',label:'Excel 업로드',allow:admin};
export const erpTasks:Record<ErpMenu,Task[]>={
  dashboard:[{view:'today',label:'오늘 할 일',allow:all},{view:'dashboard',label:'월별 대시보드',allow:admin}],
  stock:[{view:'items',label:'품목·재고현황',allow:all},report,{view:'transfer',label:'창고 이동',allow:both},{view:'custody',label:'보관·차용',allow:admin}],
  inbound:[{view:'inbound',label:'입고등록',allow:erpInbound},report,upload,{view:'opening',label:'기초재고 원가 확정',allow:admin}],
  sales:[{view:'outbound',label:'출고등록',allow:erpOutbound},{view:'shipments',label:'출고 문서 관리',allow:admin},report,{view:'documents',label:'거래서류 발행',allow:admin},upload],
  receivables:[{view:'finance',label:'거래처 미수금·수금',allow:admin}],
  admin:[{view:'warehouses',label:'창고 관리',allow:all},{view:'partners',label:'거래처 관리',allow:all},{view:'access',label:'담당자 권한',allow:admin},{view:'approvals',label:'승인 요청',allow:all},{view:'close',label:'월마감·보고서 보관',allow:admin},{view:'closing',label:'월마감 일정',allow:all},{view:'history',label:'수정·삭제 이력',allow:admin}],
};
export const erpDefaultView=(menu:ErpMenu,access:ErpAccess)=>erpTasks[menu]?.find(t=>t.allow(access))?.view;
export const erpMenuFor=(view:ErpView):ErpMenu=>erpMenus.find(m=>erpTasks[m.id].some(t=>t.view===view))?.id||'stock';
export function erpPath(view:ErpView,menu=erpMenuFor(view),source='',draft=''){
  const params=new URLSearchParams({menu,view});if(source)params.set('source',source);if(draft)params.set('draft',draft);return `/erp?${params}`;
}
export function erpRoute(search:string,access:ErpAccess){
  const params=new URLSearchParams(search),legacy=params.get('panel');
  const raw=params.get('view')||(legacy==='approvals'?'approvals':legacy==='closing'?'closing':params.has('menu')?(erpDefaultView(params.get('menu') as ErpMenu,access)||'unknown'):'today');
  const view=Object.values(erpTasks).flat().some(t=>t.view===raw)?raw as ErpView:null;
  const rawMenu=params.get('menu'),menu=erpMenus.find(m=>m.id===rawMenu)?.id||(view?erpMenuFor(view):'stock');
  const task=erpTasks[menu].find(t=>t.view===view);
  return {menu,view,denied:!task?.allow(access),source:(params.get('source')||'').slice(0,120),draft:(params.get('draft')||'').slice(0,128)};
}
