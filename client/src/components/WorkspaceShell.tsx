import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ChevronRight, Menu, X } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { NotificationBell } from './NotificationBell';
import type { CompanyData, UserData } from '../store/authStore';
import { getRoleDisplayName } from '../utils/roleDisplay';
import '../styles/WorkflowTheme.css';

const workflowTitles: Record<string, string> = {
  '/dashboard': '대시보드', '/drafting': '기안(업무보고)', '/admin/approvals': '결재/승인 관리함',
  '/admin/organization': '조직관리', '/admin/employees': '인사관리', '/admin/salary': '급여관리',
  '/leave': '휴가신청', '/expense': '지출결의 신청', '/documents': '서류발급',
  '/official-letters': '서류발급', '/board': '공지 게시판',
  '/admin/finance-stats': '지출결의 조회', '/admin/settings': '시스템 설정', '/subscription': '구독 관리',
  '/super-admin': '플랫폼 관리',
};

/** Presentation shell only. Route guards and server authorization remain in their existing layers. */
export function WorkspaceShell({ profile, company, children }: {
  profile: UserData; company: CompanyData | null; children: ReactNode;
}) {
  const { pathname } = useLocation();
  const platformPage = profile.role === 'SUPER_ADMIN' && pathname === '/super-admin';
  const themed = platformPage || (profile.role !== 'SUPER_ADMIN' && Boolean(workflowTitles[pathname]));
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLDivElement>(null);
  const sidebarId = useId();
  const closeMenu = () => {
    setMobileOpen(false);
    requestAnimationFrame(() => menuButton.current?.focus());
  };

  useEffect(() => {
    if (!mobileOpen) return;
    if (window.matchMedia('(max-width: 767px)').matches) sidebar.current?.querySelector<HTMLElement>('a[href],button')?.focus();
    const guard = (event: KeyboardEvent) => {
      if (!window.matchMedia('(max-width: 767px)').matches) return;
      if (event.key === 'Escape') { event.preventDefault(); setMobileOpen(false); menuButton.current?.focus(); return; }
      if (event.key !== 'Tab') return;
      const items = Array.from(sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled)') || [])
        .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
      const first = items[0], last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', guard);
    return () => window.removeEventListener('keydown', guard);
  }, [mobileOpen]);

  return <div className={`workspace-shell flex h-screen overflow-hidden relative font-sans ${themed ? 'workflow-theme' : 'bg-slate-50'}`}>
    {!themed && <div className="md:hidden print:hidden flex items-center justify-between bg-slate-900 text-white p-4 fixed top-0 left-0 w-full z-50 shadow-lg border-b border-indigo-500/20">
      <div className="flex items-center gap-2"><div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center font-black text-white italic">HF</div><div className="text-xl font-black tracking-tight text-white">HR <span className="text-indigo-400">FLOW</span></div></div>
      <button ref={menuButton} type="button" onClick={() => setMobileOpen(value => !value)} aria-label={mobileOpen ? '메뉴 닫기' : '메뉴 열기'} aria-expanded={mobileOpen} aria-controls={sidebarId} className="p-2 hover:bg-slate-800 rounded-xl transition-all active:scale-95">{mobileOpen ? <X className="w-6 h-6 text-indigo-400" /> : <Menu className="w-6 h-6" />}</button>
    </div>}
    <div ref={sidebar} id={sidebarId} className={`workspace-sidebar print:hidden fixed inset-y-0 left-0 z-40 w-64 transform transition-all duration-300 ease-in-out ${mobileOpen ? 'workspace-sidebar-open translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 ${themed ? '' : 'premium-shadow'}`}>
      {themed && <button type="button" className="wf-sidebar-close wf-icon-button" onClick={closeMenu} aria-label="메뉴 닫기"><X size={20} /></button>}
      <Sidebar userRole={profile.role} onItemClick={closeMenu} appearance={themed ? 'workflow' : 'default'} showNotifications={!themed} />
    </div>
    {mobileOpen && <button type="button" aria-label="메뉴 닫기 배경" className={`workspace-overlay fixed inset-0 z-30 md:hidden ${themed ? '' : 'bg-slate-900/60 backdrop-blur-sm'}`} onClick={closeMenu} />}
    <div className={`workspace-content flex-1 min-w-0 h-full ${themed ? 'wf-content' : 'overflow-y-auto mt-[64px] md:mt-0 bg-slate-50 transition-all duration-300'}`}>
      {themed && <header className="wf-topbar">
        <div className="wf-breadcrumb"><span>{platformPage ? '플랫폼 운영' : '회사 업무'}</span><ChevronRight size={14} /><strong>{workflowTitles[pathname]}</strong></div>
        <span className="wf-mobile-company">{platformPage ? '플랫폼 관리' : company?.id === profile.companyId ? company.nameKo : 'HR Flow'}</span>
        <div className="wf-account">
          {!platformPage && <NotificationBell currentUserId={profile.uid} onNavigate={() => setMobileOpen(false)} appearance="workflow" />}
          <div className="wf-profile"><span className="wf-avatar" aria-hidden="true">{profile.name?.slice(0, 1) || 'H'}</span><span>{profile.name}<small>{getRoleDisplayName(profile, company)}</small></span></div>
          <button ref={menuButton} type="button" className="wf-mobile-toggle wf-icon-button" onClick={() => setMobileOpen(value => !value)} aria-label={mobileOpen ? '메뉴 닫기' : '메뉴 열기'} aria-expanded={mobileOpen} aria-controls={sidebarId}>{mobileOpen ? <X size={20} /> : <Menu size={20} />}</button>
        </div>
      </header>}
      <div className={themed ? 'wf-scroll' : undefined}>
        <div className={themed ? 'wf-page-container' : 'max-w-7xl mx-auto min-h-full'}>{children}</div>
      </div>
    </div>
  </div>;
}
