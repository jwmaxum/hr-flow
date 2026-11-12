import React from 'react';
import { NavLink } from 'react-router-dom';
import { Home, CalendarClock, Network, Settings, FileText, FilePenLine, CheckSquare, PieChart, BookOpen, LogIn, LogOut, Users, Banknote, Shield, Building2, CreditCard } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { NotificationBell } from './NotificationBell';
import { useAuthStore } from '../store/authStore';
import { getRoleDisplayName } from '../utils/roleDisplay';
import { ErpEntry } from './ErpEntry';

interface SidebarProps {
  userRole: string;
  userId?: string;
  onItemClick?: () => void;
  appearance?: 'default' | 'workflow';
  showNotifications?: boolean;
}

interface NavItemProps {
  to: string;
  icon: LucideIcon;
  label: string;
  colorClass?: string;
  onItemClick?: () => void;
}

const NavItem = ({ to, icon: Icon, label, colorClass = 'indigo', onItemClick }: NavItemProps) => (
  <NavLink
    to={to}
    onClick={onItemClick}
    className={({ isActive }) => `
      sidebar-link group flex items-center space-x-3 px-4 py-3 rounded-xl transition-all duration-300 relative overflow-hidden
      ${isActive
        ? `bg-${colorClass}-600/10 text-${colorClass}-400 shadow-[inset_0_0_20px_rgba(99,102,241,0.05)]`
        : 'hover:bg-slate-800/50 text-slate-400 hover:text-slate-200'
      }
    `}
  >
    {({ isActive }) => (
      <>
        <Icon className={`w-5 h-5 transition-transform duration-300 group-hover:scale-110 ${isActive ? `text-${colorClass}-400` : 'text-slate-500'}`} />
        <span className="font-semibold tracking-tight">{label}</span>
        {isActive && (
          <div className={`sidebar-active-mark absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-${colorClass}-500 rounded-r-full shadow-[0_0_15px_rgba(99,102,241,0.5)]`} />
        )}
      </>
    )}
  </NavLink>
);

export const Sidebar: React.FC<SidebarProps> = ({ userRole, onItemClick, appearance = 'default', showNotifications = true }) => {
  const { user, userData, companyData, logout, setLoginModalOpen } = useAuthStore();
  const isSuperAdmin = userData?.role === 'SUPER_ADMIN';
  const isDirector = userRole === 'ADMIN';
  const isManagement = userRole === 'ADMIN' || userRole === 'SUB_ADMIN'; // 결재함은 둘 다 가능

  return (
    <div className="sidebar-root w-64 h-full bg-slate-900 flex flex-col p-6 border-r border-slate-800/50 relative overflow-hidden">
      {/* Decorative Gradient Background */}
      <div className="sidebar-decoration absolute top-0 left-0 w-full h-64 bg-gradient-to-b from-indigo-600/5 to-transparent opacity-50 pointer-events-none"></div>

      <div className="sidebar-brand flex items-center justify-between mb-6 relative z-10 shrink-0">
        <NavLink to="/" className="flex min-w-0 items-center gap-3 group cursor-pointer">
          <div className="sidebar-brand-mark w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center font-black text-white italic shadow-lg shadow-indigo-900/20 group-hover:scale-110 transition-transform">HF</div>
          <div className="sidebar-brand-title text-2xl font-black tracking-tighter text-white group-hover:text-indigo-400 transition-colors">{appearance === 'workflow' ? 'HR Flow' : <>HR <span className="text-indigo-400">FLOW</span></>}</div>
        </NavLink>
        {user && userData?.companyId && !isSuperAdmin && <span className="erp-sidebar-entry"><ErpEntry onNavigate={onItemClick} /></span>}
        {!isSuperAdmin && showNotifications && <NotificationBell currentUserId={user?.uid || ''} onNavigate={onItemClick} />}
      </div>

      {/* 회사 정보 표시 */}
      {companyData && companyData.id === userData?.companyId && !isSuperAdmin && (
        <div className="sidebar-company mb-6 px-3 py-2 bg-indigo-600/10 rounded-xl border border-indigo-500/20 relative z-10 shrink-0">
          <div className="flex items-center gap-2">
            <Building2 className="w-3.5 h-3.5 text-indigo-400" />
            <span className="text-xs font-bold text-indigo-300 truncate">{companyData.nameKo}</span>
          </div>
          <span className="text-[10px] text-slate-500 ml-5.5">{companyData.domain}</span>
        </div>
      )}
      
      <nav className="sidebar-navigation flex-1 space-y-2 relative z-10 overflow-y-auto pr-2 custom-scrollbar no-scrollbar hover:no-scrollbar md:hover:block">
        <style>{`
          .custom-scrollbar::-webkit-scrollbar {
            width: 4px;
          }
          .custom-scrollbar::-webkit-scrollbar-track {
            background: transparent;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb {
            background: rgba(99, 102, 241, 0.1);
            border-radius: 10px;
          }
          .custom-scrollbar:hover::-webkit-scrollbar-thumb {
            background: rgba(99, 102, 241, 0.3);
          }
        `}</style>
        {isSuperAdmin ? (
          /* SUPER_ADMIN 전용 메뉴 */
          <>
            <NavItem onItemClick={onItemClick} to="/super-admin" icon={Shield} label="플랫폼 관리" colorClass="violet" />
          </>
        ) : (
          /* 일반 사용자 메뉴 */
          <>
            <NavItem onItemClick={onItemClick} to="/dashboard" icon={Home} label="대시보드" />
            <NavItem onItemClick={onItemClick} to="/leave" icon={CalendarClock} label="휴가신청" />
            <NavItem onItemClick={onItemClick} to="/drafting" icon={FilePenLine} label="기안(업무보고)" />
            <NavItem onItemClick={onItemClick} to="/expense" icon={FileText} label="지출결의 신청" colorClass="emerald" />
            <NavItem onItemClick={onItemClick} to="/documents" icon={FileText} label="서류발급" />
            <NavItem onItemClick={onItemClick} to="/board" icon={BookOpen} label="공지 게시판" colorClass="rose" />

            {isManagement && (
              <div className="sidebar-management pt-8 pb-3 px-4">
                <p className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">{appearance === 'workflow' ? '관리' : 'Management'}</p>
              </div>
            )}

            {isManagement && <NavItem onItemClick={onItemClick} to="/admin/approvals" icon={CheckSquare} label="결재/승인 관리함" />}
            {isDirector && <NavItem onItemClick={onItemClick} to="/admin/organization" icon={Network} label="조직관리" />}
            {isDirector && <NavItem onItemClick={onItemClick} to="/admin/salary" icon={Banknote} label="급여관리" colorClass="indigo" />}
            {isDirector && <NavItem onItemClick={onItemClick} to="/admin/finance-stats" icon={PieChart} label="지출결의 조회" colorClass="emerald" />}
            {isDirector && <NavItem onItemClick={onItemClick} to="/admin/employees" icon={Users} label="인사관리" colorClass="indigo" />}
            {isDirector && <NavItem onItemClick={onItemClick} to="/admin/settings" icon={Settings} label="시스템 설정" colorClass="slate" />}
            {isDirector && <NavItem onItemClick={onItemClick} to="/subscription" icon={CreditCard} label="결제/구독 관리" colorClass="amber" />}
          </>
        )}
      </nav>

      <div className="sidebar-footer mt-auto pt-6 border-t border-slate-800 relative z-10 shrink-0">
        {/* 현재 사용자 정보 */}
        {userData && (
          <div className="sidebar-user mb-4 px-2">
            <p className="text-xs font-bold text-slate-400 truncate">{userData.name}</p>
            <p className="text-[10px] text-slate-600 truncate">{userData.email}</p>
            <span className={`text-[9px] font-black px-2 py-0.5 rounded-full uppercase mt-1 inline-block ${
              userData.role === 'SUPER_ADMIN' ? 'bg-violet-500/20 text-violet-400' :
              userData.role === 'ADMIN' ? 'bg-indigo-500/20 text-indigo-400' :
              userData.role === 'SUB_ADMIN' ? 'bg-emerald-500/20 text-emerald-400' :
              'bg-slate-700 text-slate-400'
            }`}>
              {getRoleDisplayName(userData, companyData ?? undefined)}
            </span>
          </div>
        )}

        {!user ? (
          <button 
            onClick={() => setLoginModalOpen(true)}
            className="sidebar-session-button flex w-full items-center space-x-3 px-4 py-3 text-slate-400 hover:text-white transition-all rounded-xl hover:bg-slate-800/50 group"
          >
            <LogIn className="w-5 h-5 text-indigo-400 group-hover:translate-x-1 transition-transform" />
            <span className="font-bold tracking-tight">로그인</span>
          </button>
        ) : (
          <button 
            onClick={() => logout()}
            className="sidebar-session-button flex w-full items-center space-x-3 px-4 py-3 text-slate-500 hover:text-rose-400 transition-all rounded-xl hover:bg-rose-500/5 group"
          >
            <LogOut className="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
            <span className="font-bold tracking-tight">로그아웃</span>
          </button>
        )}
      </div>
    </div>
  );
};
