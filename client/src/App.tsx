import { lazy, useEffect } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginModal } from './components/LoginModal';
import { useAuthStore } from './store/authStore';
import { LoadingSplash } from './components/LoadingSplash';
import { LandingPage } from './pages/LandingPage';
import { ProfileSetup } from './pages/ProfileSetup';
import { RouteContent } from './components/RouteContent';
import './utils/documentNavigationGuards';
import './styles/AuthStates.css';

const WorkspaceShell = lazy(() => import('./components/WorkspaceShell').then(module => ({ default: module.WorkspaceShell })));
const OrganizationAdmin = lazy(() => import('./pages/OrganizationAdmin').then(module => ({ default: module.OrganizationAdmin })));
const ExpenseAdminDashboard = lazy(() => import('./pages/ExpenseAdminDashboard').then(module => ({ default: module.ExpenseAdminDashboard })));
const ExpenseForm = lazy(() => import('./pages/ExpenseForm').then(module => ({ default: module.ExpenseForm })));
const AttendanceDashboard = lazy(() => import('./pages/AttendanceDashboard').then(module => ({ default: module.AttendanceDashboard })));
const NoticeBoard = lazy(() => import('./pages/NoticeBoard').then(module => ({ default: module.NoticeBoard })));
const AdminSettings = lazy(() => import('./pages/AdminSettings').then(module => ({ default: module.AdminSettings })));
const AdminApprovals = lazy(() => import('./pages/AdminApprovals').then(module => ({ default: module.AdminApprovals })));
const LeaveApplication = lazy(() => import('./pages/LeaveApplication').then(module => ({ default: module.LeaveApplication })));
const EmployeeManagement = lazy(() => import('./pages/EmployeeManagement').then(module => ({ default: module.EmployeeManagement })));
const SalaryManagement = lazy(() => import('./pages/SalaryManagement').then(module => ({ default: module.SalaryManagement })));
const SuperAdminDashboard = lazy(() => import('./pages/SuperAdminDashboard').then(module => ({ default: module.SuperAdminDashboard })));
const SubscriptionManagement = lazy(() => import('./pages/SubscriptionManagement').then(module => ({ default: module.SubscriptionManagement })));
const SubscriptionRequired = lazy(() => import('./pages/SubscriptionRequired').then(module => ({ default: module.SubscriptionRequired })));
const OfficialLetters = lazy(() => import('./pages/OfficialLetters').then(module => ({ default: module.OfficialLetters })));
const Drafting = lazy(() => import('./pages/Drafting').then(module => ({ default: module.Drafting })));

function App() {
  const { initAuth, userData, companyData, user, loading, sessionReady, authError, refreshSession, logout } = useAuthStore();

  useEffect(() => {
    const unsubscribe = initAuth();
    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [initAuth]);

  if (loading) {
    return <LoadingSplash />;
  }

  const isSuperAdmin = userData?.role === 'SUPER_ADMIN';
  const isExpired = !isSuperAdmin && companyData?.subscriptionStatus === 'EXPIRED';

  if (user && authError) {
    return <div className="workflow-theme auth-state-screen"><div className="wf-panel auth-state-card">
      <span className="auth-state-brand" aria-hidden="true">HF</span><h1>로그인 상태 확인</h1>
      <p role="alert" className="auth-state-error">{authError}</p><div className="auth-state-actions"><button onClick={() => void refreshSession()} className="wf-btn wf-btn-primary">다시 확인</button>
      <button onClick={() => void logout()} className="wf-btn">로그아웃</button></div>
    </div></div>;
  }

  if (user && userData && (userData.mustChangePassword || (!sessionReady && !isExpired))) {
    return <HashRouter><div className="workflow-theme auth-state-screen"><div className="wf-panel auth-state-card"><span className="auth-state-brand" aria-hidden="true">HF</span><h1>계정 보안 설정</h1><p>비밀번호 변경을 완료한 후 업무를 시작할 수 있습니다.</p></div></div><LoginModal /></HashRouter>;
  }

  if (user && !loading && !userData) {
    return <ProfileSetup />;
  }

  return (
    <HashRouter>
      <LoginModal />
      <Routes>
        <Route path="/" element={
          !user ? <LandingPage /> : 
          (userData ? <Navigate to={isSuperAdmin ? '/super-admin' : '/dashboard'} replace /> : 
           (loading ? <LoadingSplash /> : <Navigate to="/profile-setup" replace />))
        } />
        <Route path="/login" element={
          user ? (userData ? <Navigate to={isSuperAdmin ? '/super-admin' : '/dashboard'} replace /> : <Navigate to="/profile-setup" replace />) : <Login />
        } />
        <Route path="/profile-setup" element={user && !userData ? <ProfileSetup /> : <Navigate to="/" replace />} />
        <Route path="/subscription-required" element={<RouteContent fullPage><SubscriptionRequired /></RouteContent>} />
        
        <Route path="/*" element={
          !user ? <Navigate to="/login" replace /> : !userData ? <Navigate to="/profile-setup" replace /> : (
            <RouteContent key={`${userData.uid}:${userData.companyId}:${userData.role}:${userData.divisionId || ''}`} fullPage>
            <WorkspaceShell key={`${userData.uid}:${userData.companyId}:${userData.role}:${userData.divisionId || ''}`} profile={userData} company={companyData}>
                  <Routes>
                    {/* SUPER_ADMIN 전용 */}
                    <Route path="super-admin" element={<ProtectedRoute requireSuperAdmin><RouteContent><SuperAdminDashboard /></RouteContent></ProtectedRoute>} />

                    {/* 구독 관리 (전용) - 블로킹 대상 제외 */}
                    <Route path="subscription" element={<ProtectedRoute requireAdmin><RouteContent><SubscriptionManagement /></RouteContent></ProtectedRoute>} />

                    {/* 일반 사용자 및 블로킹 로직 */}
                    {isExpired ? (
                      <Route path="*" element={<Navigate to="/subscription-required" replace />} />
                    ) : (
                      <>
                        <Route path="/" element={<RouteContent><AttendanceDashboard /></RouteContent>} />
                        <Route path="dashboard" element={<RouteContent><AttendanceDashboard /></RouteContent>} />
                        <Route path="leave" element={<ProtectedRoute><RouteContent><LeaveApplication /></RouteContent></ProtectedRoute>} />
                        <Route path="drafting" element={<ProtectedRoute><RouteContent><Drafting key={`${userData.uid}:${userData.companyId}:${userData.role}:${userData.divisionId || ''}`} /></RouteContent></ProtectedRoute>} />
                        <Route path="expense" element={<ProtectedRoute><RouteContent><ExpenseForm /></RouteContent></ProtectedRoute>} />
                        <Route path="documents" element={<ProtectedRoute><RouteContent><OfficialLetters key={`${userData.uid}:${userData.companyId}:${userData.role}:${userData.divisionId || ''}`} /></RouteContent></ProtectedRoute>} />
                        <Route path="official-letters" element={<ProtectedRoute><RouteContent><OfficialLetters key={`${userData.uid}:${userData.companyId}:${userData.role}:${userData.divisionId || ''}`} /></RouteContent></ProtectedRoute>} />
                        <Route path="board" element={<ProtectedRoute><RouteContent><NoticeBoard userRole={userData?.role || 'MEMBER'} currentUserId={userData?.uid || ''} /></RouteContent></ProtectedRoute>} />

                        <Route path="admin/organization" element={<ProtectedRoute requireMasterAdmin><RouteContent><OrganizationAdmin /></RouteContent></ProtectedRoute>} />
                        <Route path="admin/approvals" element={<ProtectedRoute requireAdmin><RouteContent><AdminApprovals key={`${userData.uid}:${userData.companyId}:${userData.role}:${userData.divisionId || ''}`} /></RouteContent></ProtectedRoute>} />
                        <Route path="admin/finance-stats" element={<ProtectedRoute requireMasterAdmin><RouteContent><ExpenseAdminDashboard /></RouteContent></ProtectedRoute>} />
                        <Route path="admin/employees" element={<ProtectedRoute requireMasterAdmin><RouteContent><EmployeeManagement /></RouteContent></ProtectedRoute>} />
                        <Route path="admin/salary" element={<ProtectedRoute requireMasterAdmin><RouteContent><SalaryManagement /></RouteContent></ProtectedRoute>} />
                        <Route path="admin/settings" element={<ProtectedRoute requireMasterAdmin><RouteContent><AdminSettings /></RouteContent></ProtectedRoute>} />
                        
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </>
                    )}
                  </Routes>
            </WorkspaceShell>
            </RouteContent>
          )
        } />
      </Routes>
    </HashRouter>
  );
}

export default App;
