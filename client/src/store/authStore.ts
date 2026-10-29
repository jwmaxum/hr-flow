import { create } from 'zustand';
import { onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { accountSecurity } from '../services/accountSecurityService';

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'SUB_ADMIN' | 'MEMBER';

export interface TeamHistory {
  teamId: string;
  teamName: string;
  joinedAt: string;
  leftAt: string;
}

export interface CompanyData {
  id: string;
  nameKo: string;
  nameEn: string;
  domain: string;
  adminUid: string;
  createdAt: string;
  status: 'ACTIVE' | 'SUSPENDED';
  subscriptionStatus?: 'ACTIVE' | 'EXPIRED' | 'TRIAL';
  subscriptionEndDate?: string;
  planType?: 'MONTHLY' | 'YEARLY';
  lastPaymentDate?: string;
  lastBackupAt?: string;
  accessUntil?: string;
}

export interface UserData {
  uid: string;
  email: string;
  name: string;
  role: Role;
  companyId: string; // 소속 회사 ID (SUPER_ADMIN은 'PLATFORM')
  teamId?: string;
  divisionId?: string;
  teamHistory?: TeamHistory[];
  joinDate?: string; // 입사일 (YYYY-MM-DD)
  annualLeaveTotal?: number; // 총 발생 연차
  usedLeave?: number; // 사용한 연차
  mustChangePassword?: boolean; // 최초 로그인 시 비밀번호 변경 여부
  status?: 'ACTIVE' | 'RESIGNED'; // 계정 상태
  annualSalary?: number; // 연봉/월급 (원)
  salaryType?: 'ANNUAL' | 'MONTHLY'; // 연봉 혹은 월급
  isSeveranceIncluded?: boolean; // 퇴직금 포함 여부
  dependents?: number; // 부양가족 수 (본인 포함)
  childrenUnder20?: number; // 기존 필드명 유지: 간이세액표 자녀 공제 대상인 8~20세 자녀 수
  nonTaxable?: number; // 비과세액 (기본 200,000원)
  rrn?: string; // 등록된 인사정보: 국민연금 연령 판정용, 급여 PDF에 포함하지 않음
  additionalLeave?: number; // 관리자가 부여한 추가 연차
}

interface AuthState {
  user: User | null;
  userData: UserData | null;
  companyData: CompanyData | null; // 현재 소속 회사 정보
  loading: boolean;
  isLoginModalOpen: boolean;
  isManualChangeMode: boolean;
  sessionReady: boolean;
  authError: string | null;
  initAuth: () => (() => void);
  refreshSession: () => Promise<void>;
  fetchCompanyDomain: (companyId: string) => Promise<void>;
  setUserData: (userData: UserData | null) => void;
  setLoginModalOpen: (isOpen: boolean) => void;
  openPasswordChange: () => void;
  logout: () => Promise<void>;
  getDisplayEmail: (email?: string | null) => string;
}


export const useAuthStore = create<AuthState>((set, get) => {
  let generation = 0;
  let unsubscribeAuth: (() => void) | null = null;
  let unsubscribeProfile: (() => void) | null = null;
  let unsubscribeCompany: (() => void) | null = null;
  let accessTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: { uid: string; promise: Promise<void>; token: symbol } | null = null;
  const stopData = () => {
    unsubscribeProfile?.(); unsubscribeProfile = null;
    unsubscribeCompany?.(); unsubscribeCompany = null;
    if (accessTimer) clearTimeout(accessTimer); accessTimer = null;
  };
  const empty = { userData: null, companyData: null, sessionReady: false, isLoginModalOpen: false, isManualChangeMode: false };
  const current = (epoch: number, uid: string) => epoch === generation && auth.currentUser?.uid === uid;
  const binding = (profile: UserData) => JSON.stringify([profile.companyId, profile.role, profile.status || 'ACTIVE',
    !!profile.mustChangePassword, profile.teamId || '', profile.divisionId || '']);
  const denied = (failure: unknown) => typeof failure === 'object' && failure !== null && 'code' in failure &&
    ['permission-denied', 'unauthenticated', 'failed-precondition', 'not-found', 'auth/user-disabled', 'auth/user-token-expired'].includes(String(failure.code).replace(/^functions\//, ''));

  function loadSession(user: User): Promise<void> {
    if (pending?.uid === user.uid) return pending.promise;
    const epoch = ++generation; const token = Symbol(); stopData();
    set({ ...empty, user, loading: true, authError: null });
    const promise = (async () => {
      try {
        const session = await accountSecurity.session();
        if (!current(epoch, user.uid)) return;
        const profile = session.profile;
        if (profile && (profile.uid !== user.uid || !['SUPER_ADMIN', 'ADMIN', 'SUB_ADMIN', 'MEMBER'].includes(profile.role) ||
          (profile.status && profile.status !== 'ACTIVE') || (session.company && session.company.status !== 'ACTIVE'))) {
          throw Object.assign(new Error('현재 계정으로 서비스를 이용할 수 없습니다.'), { code: 'permission-denied' });
        }
        const ready = !!profile && session.businessAllowed === true && !profile.mustChangePassword;
        const company = session.company && !session.businessAllowed && !profile?.mustChangePassword
          ? { ...session.company, subscriptionStatus: 'EXPIRED' as const } : session.company;
        set({ user, userData: profile, companyData: company, loading: false, sessionReady: ready,
          isLoginModalOpen: !!profile?.mustChangePassword, isManualChangeMode: false, authError: null });
        if (!ready || !profile) return;

        const approvedBinding = binding(profile);
        const recheck = () => {
          if (!current(epoch, user.uid)) return;
          pending = null; void loadSession(user);
        };
        unsubscribeProfile = onSnapshot(doc(db, 'UserProfile', user.uid), snapshot => {
          if (!current(epoch, user.uid)) return;
          if (!snapshot.exists()) { recheck(); return; }
          const next = { ...snapshot.data(), uid: user.uid } as UserData;
          if (binding(next) !== approvedBinding) { recheck(); return; }
          set({ userData: next });
        }, recheck);
        if (profile.companyId !== 'PLATFORM') {
          let first = true;
          unsubscribeCompany = onSnapshot(doc(db, 'companies', profile.companyId), snapshot => {
            if (!current(epoch, user.uid)) return;
            if (!snapshot.exists() || snapshot.data().status !== 'ACTIVE') { recheck(); return; }
            if (first) { first = false; return; }
            recheck();
          }, recheck);
        }
        const expiresAt = company?.accessUntil ? new Date(company.accessUntil).getTime() : NaN;
        if (Number.isFinite(expiresAt)) accessTimer = setTimeout(recheck, Math.min(2147483647, Math.max(1000, expiresAt - Date.now() + 50)));
      } catch (failure) {
        if (!current(epoch, user.uid)) return;
        stopData();
        const authError = failure instanceof Error ? failure.message : '계정 상태를 확인하지 못했습니다. 다시 시도해 주세요.';
        set({ ...empty, loading: false, authError });
        if (denied(failure)) {
          try { await auth.signOut(); } catch { /* Cached access remains cleared even if sign-out fails. */ }
          if (epoch === generation) set({ user: null });
        }
      } finally { if (pending?.token === token) pending = null; }
    })();
    pending = { uid: user.uid, promise, token };
    return promise;
  }

  return {
    user: null, ...empty, loading: true, authError: null,
    setUserData: userData => set({ userData }),
    setLoginModalOpen: isOpen => {
      if (!isOpen && get().userData?.mustChangePassword && !get().isManualChangeMode) return;
      set({ isLoginModalOpen: isOpen, isManualChangeMode: isOpen ? get().isManualChangeMode : false });
    },
    openPasswordChange: () => set({ isLoginModalOpen: true, isManualChangeMode: true }),
    getDisplayEmail: email => email || 'ID 미표기',
    logout: async () => {
      generation++; pending = null; stopData();
      set({ ...empty, user: null, loading: false, authError: null });
      try { await auth.signOut(); } catch { set({ authError: '로그아웃을 완료하지 못했습니다. 페이지를 닫고 다시 로그인해 주세요.' }); }
    },
    refreshSession: async () => {
      const user = auth.currentUser;
      if (user) await loadSession(user);
      else { generation++; stopData(); set({ ...empty, user: null, loading: false }); }
    },
    fetchCompanyDomain: async companyId => {
      if (companyId === get().userData?.companyId) await get().refreshSession();
    },
    initAuth: () => {
      if (unsubscribeAuth) return () => {};
      unsubscribeAuth = onAuthStateChanged(auth, user => {
        if (user) { void loadSession(user); return; }
        generation++; pending = null; stopData();
        set({ ...empty, user: null, loading: false });
      });
      return () => { generation++; pending = null; unsubscribeAuth?.(); unsubscribeAuth = null; stopData(); };
    },
  };
});
