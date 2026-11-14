import {ChartColumn,PackageSearch,PackagePlus,Truck,Wallet,Settings} from 'lucide-react';
import type {ErpAccess} from '../utils/erpAccess';
import {erpDefaultView,erpMenus,erpTasks} from '../utils/erpNavigation';
import type {ErpMenu,ErpView} from '../utils/erpNavigation';
const icons={dashboard:ChartColumn,stock:PackageSearch,inbound:PackagePlus,sales:Truck,receivables:Wallet,admin:Settings};
export function ErpNavigation({menu,view,access,onOpen}:{menu:ErpMenu;view:ErpView|null;access:ErpAccess;onOpen:(view:ErpView,menu:ErpMenu)=>void}){
  return <div className="erp-navigation"><div className="erp-menu-row"><nav className="erp-main-menu" aria-label="ERP 주 메뉴">
    {erpMenus.filter(m=>m.id!=='admin').map(m=>{const Icon=icons[m.id],target=erpDefaultView(m.id,access);return <button type="button" key={m.id} aria-current={menu===m.id?'page':undefined} disabled={!target} title={!target?'회사 ADMIN 업무':m.description} onClick={()=>target&&onOpen(target,m.id)}><Icon size={19} aria-hidden="true"/>{m.label}</button>;})}
    </nav><button type="button" className="wf-btn erp-admin-menu" aria-current={menu==='admin'?'page':undefined} onClick={()=>onOpen(access==='ADMIN'?'access':'approvals','admin')}><Settings size={18} aria-hidden="true"/>관리자 관리</button></div>
    {access!=='ADMIN'&&<p className="wf-muted erp-menu-permissions">월별 대시보드·미수금·문서 발행·권한 부여·승인·월마감 확정은 회사 ADMIN 업무입니다. 기준정보와 본인 요청·담당 마감 업무는 관리자 관리에서 확인하세요.</p>}
    <nav className="erp-tabs erp-sub-menu" aria-label="ERP 세부 업무">{erpTasks[menu].filter(t=>t.allow(access)).map(t=><button type="button" key={t.view} aria-pressed={view===t.view} onClick={()=>onOpen(t.view,menu)}>{t.view==='approvals'&&access!=='ADMIN'?'내 승인 요청':t.label}</button>)}</nav>
  </div>;
}
