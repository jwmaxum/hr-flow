import React, { useState, useEffect, useRef } from 'react';
import { collection, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuthStore } from '../store/authStore';
import { getRoleDisplayName } from '../utils/roleDisplay';
import { getErrorCode, getErrorMessage } from '../utils/errors';
import type { TaxTable } from '../utils/payroll';
import type { CompanyData, UserData } from '../store/authStore';
import { 
  Shield, Building2, Users, Globe, Search, 
  ToggleLeft, ToggleRight, Crown, Calendar,
  TrendingUp, Briefcase, AlertTriangle, Key, Trash2, Lock, Loader2, CreditCard
} from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { setDoc } from 'firebase/firestore';
import { functions, auth } from '../firebase';
import { Button, Input, PageHeading, PageTitle, Panel, StatusBadge } from '../components/ui';
import './SuperAdminDashboard.css';

interface BackendStatus { version: string; deployedAt: string }
interface PaymentRecord {
  id: string;
  companyName?: string;
  adminName?: string;
  adminEmail?: string;
  adminUid?: string;
  transactionId?: string;
  amount?: number | string;
  currency?: string;
  createdAt?: { seconds: number };
}
interface PaymentClaim extends Pick<PaymentRecord, 'companyName' | 'adminName' | 'createdAt'> {
  id: string;
  orderId: string;
}
type TaxBracket = NonNullable<NonNullable<TaxTable>['brackets']>[number];

export const SuperAdminDashboard: React.FC = () => {
  const { userData } = useAuthStore();
  const [companies, setCompanies] = useState<(CompanyData & { id: string })[]>([]);
  const [allUsers, setAllUsers] = useState<UserData[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'COMPANIES' | 'PAYMENTS' | 'USERS'>('COMPANIES');
  
  // 비밀번호 초기화 모달 상태
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetTarget, setResetTarget] = useState<{uid: string, name: string} | null>(null);
  const [newPassword, setNewPassword] = useState('');

  // 조직 삭제 모달 상태
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null); // companyId
  const [adminPassword, setAdminPassword] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [isUploadingTaxTable, setIsUploadingTaxTable] = useState(false);
  const [taxTableInfo, setTaxTableInfo] = useState<{ updateDate: string; count: number; fileName?: string } | null>(null);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [paymentClaims, setPaymentClaims] = useState<PaymentClaim[]>([]);

  // 구독 기간 연장 모달 상태
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [subscriptionTarget, setSubscriptionTarget] = useState<{ id: string, name: string, currentEndDate: string } | null>(null);
  const [subscriptionDaysToAdd, setSubscriptionDaysToAdd] = useState<number>(30);
  const [subscriptionPassword, setSubscriptionPassword] = useState('');
  const [isUpdatingSubscription, setIsUpdatingSubscription] = useState(false);

  useEffect(() => {
    checkBackend();
  }, []);

  const checkBackend = async () => {
    try {
      const checkFn = httpsCallable<unknown, BackendStatus>(functions, 'checkDeploymentStatus');
      const result = await checkFn();
      setBackendStatus(result.data);
    } catch (e) {
      console.warn("Backend status check failed:", e);
    }
  };

  useEffect(() => {
    if (userData?.role !== 'SUPER_ADMIN') return;

    console.log("[SuperAdmin] Requesting companies collection...");
    const unsubCompanies = onSnapshot(collection(db, 'companies'), (snap) => {
      console.log(`[SuperAdmin] Successfully fetched ${snap.docs.length} companies.`);
      const data = snap.docs.filter(d => d.data().status !== 'DELETED').map(d => ({ id: d.id, ...d.data() } as CompanyData & { id: string }));
      setCompanies(data.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setLoading(false);
    }, (err) => {
      console.error("[SuperAdmin] Failed to fetch companies:", err);
      setLoading(false);
    });

    const unsubUsers = onSnapshot(collection(db, 'UserProfile'), (snap) => {
      console.log(`[SuperAdmin] Successfully fetched ${snap.docs.length} users.`);
      const data = snap.docs.map(d => ({ uid: d.id, ...d.data() } as UserData));
      setAllUsers(data);
    }, (err) => {
      console.error("[SuperAdmin] Failed to fetch users:", err);
    });

    const unsubTax = onSnapshot(doc(db, 'system_config', 'tax_table'), (doc) => {
      if (doc.exists()) {
        const data = doc.data();
        setTaxTableInfo({ 
          updateDate: data.updateDate, 
          count: data.brackets?.length || 0,
          fileName: data.fileName
        });
      }
    });

    const unsubPayments = onSnapshot(collection(db, 'payments'), (snap) => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as PaymentRecord));
      setPayments(data.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    });

    const unsubClaims = onSnapshot(collection(db, 'payment_claims'), (snap) => {
      const data = snap.docs.map(d => ({ id: d.id, ...d.data() } as PaymentClaim));
      setPaymentClaims(data.sort((a, b) =>
        (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));
    });

    return () => { unsubCompanies(); unsubUsers(); unsubTax(); unsubPayments(); unsubClaims(); };
  }, [userData]);

  const handleToggleStatus = async (companyId: string, currentStatus: string) => {
    const newStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    const action = newStatus === 'SUSPENDED' ? '정지' : '활성화';
    if (!window.confirm(`이 조직을 ${action}하시겠습니까?`)) return;

    try {
      await updateDoc(doc(db, 'companies', companyId), { status: newStatus });
    } catch (err) {
      alert('상태 변경 실패: ' + (err as Error).message);
    }
  };

  const getUsersForCompany = (companyId: string) => 
    allUsers.filter(u => u.companyId === companyId);

  const filteredCompanies = companies.filter(c => 
    !searchQuery || 
    c.nameKo?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.nameEn?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.domain?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const totalUsers = allUsers.filter(u => u.role !== 'SUPER_ADMIN').length;
  const activeCompanies = companies.filter(c => c.status === 'ACTIVE').length;

  const handleResetPassword = async () => {
    if (!resetTarget || !newPassword) return;
    if (newPassword.length < 12) {
      alert('비밀번호는 최소 12자 이상이어야 합니다.');
      return;
    }

    try {
      const confirmationPassword = window.prompt('보안 확인을 위해 플랫폼 관리자 비밀번호를 입력해 주세요.');
      if (!confirmationPassword || !auth.currentUser?.email) return;
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, confirmationPassword));
      await auth.currentUser.getIdToken(true);
      const resetFn = httpsCallable(functions, 'adminResetPassword');
      await resetFn({ uid: resetTarget.uid, password: newPassword });
      alert(`[성공] ${resetTarget.name}님의 비밀번호가 '${newPassword}'로 초기화되었습니다.`);
      setShowResetModal(false);
      setResetTarget(null);
      setNewPassword('');
    } catch (err) {
      alert('비밀번호 초기화 실패: ' + (err as Error).message);
    }
  };

  const handleSubscriptionUpdateWithAuth = async () => {
    if (!subscriptionTarget || !subscriptionPassword || !auth.currentUser?.email) return;
    
    setIsUpdatingSubscription(true);
    try {
      // 1. SUPER_ADMIN 비밀번호 재확인 (보안)
      const credential = EmailAuthProvider.credential(auth.currentUser.email, subscriptionPassword);
      await reauthenticateWithCredential(auth.currentUser, credential);

      await auth.currentUser.getIdToken(true);
      const changeSubscription = httpsCallable(functions, 'accountSecurity');
      await changeSubscription({ action: 'extendSubscription', companyId: subscriptionTarget.id, days: subscriptionDaysToAdd });
      
      alert(`[완료] 해당 조직의 구독 기간이 ${subscriptionDaysToAdd}일 연장되었습니다.`);
      setShowSubscriptionModal(false);
      setSubscriptionTarget(null);
      setSubscriptionPassword('');
      setSubscriptionDaysToAdd(30);
    } catch (err) {
      console.error('[Subscription Update Error]', err);
      const message = getErrorMessage(err, '알 수 없는 오류가 발생했습니다.');
      let msg = message;
      if (getErrorCode(err) === 'auth/wrong-password' || message.includes('password')) {
        msg = '비밀번호가 일치하지 않습니다. 다시 확인해주세요.';
      }
      alert('기간 연장 실패:\n' + msg);
    } finally {
      setIsUpdatingSubscription(false);
    }
  };

  const handleDeleteCompanyData = async () => {
    if (!deleteTarget || !adminPassword || !auth.currentUser?.email) return;
    
    setIsDeleting(true);
    try {
      // 1. SUPER_ADMIN 비밀번호 재확인 (보안)
      const credential = EmailAuthProvider.credential(auth.currentUser.email, adminPassword);
      await reauthenticateWithCredential(auth.currentUser, credential);
      await auth.currentUser.getIdToken(true);

      // 2. 백엔드 삭제 함수 호출
      const deleteFn = httpsCallable(functions, 'adminDeleteCompanyData');
      await deleteFn({ companyId: deleteTarget });
      
      alert('[완료] 해당 조직의 모든 데이터가 영구적으로 삭제되었습니다.');
      setShowDeleteModal(false);
      setDeleteTarget(null);
      setAdminPassword('');
    } catch (err) {
      console.error('[AdminDeleteCompanyData Error]', err);
      const message = getErrorMessage(err, '알 수 없는 오류가 발생했습니다.');
      let msg = message;
      if (getErrorCode(err) === 'auth/wrong-password' || message.includes('password')) {
        msg = '비밀번호가 일치하지 않습니다. 다시 확인해주세요.';
      }
      // HttpsError의 상세 메시지를 사용자에게 직접 표시하여 디버깅 정보 제공
      alert('데이터 삭제 실패:\n' + msg);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleTaxTableUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert('세액표 파일은 5MB 이하여야 합니다.');
      e.target.value = '';
      return;
    }

    if (!window.confirm(`'${file.name}' 파일로 세액표를 업데이트하시겠습니까?\n이 작업은 즉시 모든 직원의 급여산출에 반영됩니다.`)) {
      e.target.value = '';
      return;
    }

    setIsUploadingTaxTable(true);
    
    // 헬퍼 함수: 값 파싱
    const parseValue = (val: unknown): number => {
      if (val === '-' || val === null || val === undefined) return 0;
      if (typeof val === 'string') return parseInt(val.replace(/,/g, ''), 10) || 0;
      return typeof val === 'number' ? val : 0;
    };

    try {
      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const { default: readExcelFile } = await import('read-excel-file/browser').catch(() => {
            throw new Error('엑셀 도구를 불러오지 못했습니다. 연결을 확인하고 화면을 새로고침한 뒤 다시 시도해 주세요.');
          });
          const workbook = await readExcelFile(event.target?.result as ArrayBuffer);
          const allBrackets: TaxBracket[] = [];

          // 처음 2개 시트 처리 (요청 사항: 엑셀 파일 내 sheet 2개 분석)
          for (let i = 0; i < Math.min(2, workbook.length); i++) {
            const rows = workbook[i].data;
            
            for (const row of rows) {
              const min = parseValue(row[0]);
              const max = parseValue(row[1]);
              
              if (typeof min === 'number' && min >= 770) {
                const numericCells = [row[1], ...row.slice(2, 13)];
                if (numericCells.some(value => value !== null && value !== undefined &&
                  typeof value !== 'number' && typeof value !== 'string')) {
                  throw new Error('세액표 구간의 상한과 세액에는 숫자, 숫자 문자열 또는 빈 셀만 사용할 수 있습니다.');
                }
              }

              // 숫자인 유효한 구간 데이터만 추출 (770원 이상)
              if (typeof min === 'number' && min >= 770 && (max > min || max === 0)) {
                const taxes = [];
                for (let j = 2; j <= 12; j++) {
                  taxes.push(parseValue(row[j]));
                }
                allBrackets.push({ min, max: max || null, taxes });
              }
            }
          }

          // 중복 제거 및 정렬 (소득 구간별)
          const sortedBrackets = allBrackets
            .filter((v, i, a) => a.findIndex(t => t.min === v.min) === i)
            .sort((a, b) => a.min - b.min);

          if (sortedBrackets.length < 500) { // 국세청 표준은 보통 600개 이상의 구간이 있음
            throw new Error(`추출된 데이터가 너무 적습니다 (${sortedBrackets.length}개). 엑셀 파일의 형식이 국세청 표준과 맞는지 확인하세요.`);
          }

          // Firestore 업데이트
          await setDoc(doc(db, 'system_config', 'tax_table'), {
            updateDate: new Date().toISOString().split('T')[0],
            fileName: file.name,
            brackets: sortedBrackets,
            lastUpdatedBy: userData?.email || 'unknown'
          });

          alert(`[업로드 성공]\n파일명: ${file.name}\n반영된 구간: ${sortedBrackets.length}개\n\n이제 모든 사용자의 급여 산출에 최신 세액표가 실시간 적용됩니다.`);
        } catch (innerErr) {
          alert('데이터 처리 오류: ' + getErrorMessage(innerErr));
        } finally {
          setIsUploadingTaxTable(false);
          e.target.value = '';
        }
      };
      reader.onerror = () => {
        alert('파일 읽기 오류가 발생했습니다.');
        setIsUploadingTaxTable(false);
      };
      reader.readAsArrayBuffer(file);
    } catch (err) {
      alert('세액표 업로드 실패: ' + getErrorMessage(err));
      setIsUploadingTaxTable(false);
    }
  };

  const calculateRemainingDays = (endDateStr?: string) => {
    if (!endDateStr) return null;
    const end = new Date(endDateStr);
    const now = new Date();
    const diffTime = end.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  if (loading) {
    return (
      <div className="wf-page platform-admin-screen platform-loading" role="status" aria-live="polite">
        <Loader2 className="platform-spinner" aria-hidden="true" />
        <p>플랫폼 데이터 로딩 중...</p>
      </div>
    );
  }

  return (
    <div className="wf-page platform-admin-screen">
      <div className="platform-content">
        <PageHeading className="platform-heading">
          <div className="platform-heading-copy">
            <span className="platform-eyebrow"><Shield aria-hidden="true" /> {userData ? getRoleDisplayName(userData) : 'SYSTEM_ADMIN'}</span>
            <PageTitle>플랫폼 관리 센터</PageTitle>
            <p className="wf-muted">전체 조직의 이용 현황과 사용자, 결제 및 구독을 관리합니다.</p>
            {backendStatus && (
              <p className="platform-backend">Backend v{backendStatus.version} · 배포 {new Date(backendStatus.deployedAt).toLocaleString()}</p>
            )}
          </div>
          <label className="platform-search" htmlFor="platform-company-search">
            <span className="platform-sr-only">조직명 또는 도메인 검색</span>
            <Search aria-hidden="true" />
            <Input id="platform-company-search" type="search" placeholder="조직 검색..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
          </label>
        </PageHeading>

        <div className="platform-metrics" aria-label="플랫폼 이용 현황">
          <Panel className="platform-stat">
            <div className="platform-stat-label"><Building2 aria-hidden="true" /><span>전체 조직</span></div>
            <p><strong>{companies.length}</strong><span>개</span></p>
          </Panel>
          <Panel className="platform-stat">
            <div className="platform-stat-label"><TrendingUp aria-hidden="true" /><span>활성 조직</span></div>
            <p><strong>{activeCompanies}</strong><span>개</span></p>
          </Panel>
          <Panel className="platform-stat">
            <div className="platform-stat-label"><Users aria-hidden="true" /><span>전체 사용자</span></div>
            <p><strong>{totalUsers}</strong><span>명</span></p>
          </Panel>
          <Panel className="platform-stat">
            <div className="platform-stat-label"><AlertTriangle aria-hidden="true" /><span>정지 조직</span></div>
            <p><strong>{companies.length - activeCompanies}</strong><span>개</span></p>
          </Panel>
        </div>

        <nav className="platform-tabs" aria-label="플랫폼 관리 구분">
          <Button aria-pressed={activeTab === 'COMPANIES'} onClick={() => setActiveTab('COMPANIES')}><Building2 aria-hidden="true" />조직 관리</Button>
          <Button aria-pressed={activeTab === 'PAYMENTS'} onClick={() => setActiveTab('PAYMENTS')}><CreditCard aria-hidden="true" />결제 및 구독 내역</Button>
          <Button aria-pressed={activeTab === 'USERS'} onClick={() => setActiveTab('USERS')}><Users aria-hidden="true" />전체 사용자 관리</Button>
        </nav>

        {activeTab === 'COMPANIES' && (
          <div className="platform-section-stack">
            <Panel as="section" className="platform-tax" aria-labelledby="platform-tax-title">
              <div className="platform-tax-copy">
                <span className="platform-section-icon"><Calendar aria-hidden="true" /></span>
                <div>
                  <h2 id="platform-tax-title" className="wf-section-title">국세청 근로소득 간이세액표 관리</h2>
                  <div className="platform-tax-meta">
                    <StatusBadge className="wf-status-info">현재 버전: {taxTableInfo?.updateDate || '미등록'}</StatusBadge>
                    <span>데이터 수: {taxTableInfo?.count || 0}개 구간</span>
                    {taxTableInfo?.fileName && <span className="platform-tax-file"><Briefcase aria-hidden="true" />적용 파일: {taxTableInfo.fileName}</span>}
                  </div>
                  <p className="wf-muted">국세청 제공 엑셀 서식(.xlsx)을 업로드하세요.</p>
                </div>
              </div>
              <label className={`wf-btn wf-btn-primary platform-tax-upload ${isUploadingTaxTable ? 'platform-upload-busy' : ''}`}>
                {isUploadingTaxTable ? <Loader2 className="platform-spinner" aria-hidden="true" /> : <Globe aria-hidden="true" />}
                {isUploadingTaxTable ? '세액표 처리 중...' : '최신 세액표 엑셀 업로드'}
                <input type="file" accept=".xlsx" onChange={handleTaxTableUpload} disabled={isUploadingTaxTable} className="platform-file-input" aria-label="최신 세액표 엑셀 업로드" />
              </label>
            </Panel>

            <Panel as="section" className="platform-companies" aria-labelledby="platform-companies-title">
              <div className="wf-panel-head platform-panel-head">
                <div className="platform-section-heading"><Briefcase aria-hidden="true" /><h2 id="platform-companies-title" className="wf-section-title">등록된 조직 목록</h2><StatusBadge>{filteredCompanies.length}개</StatusBadge></div>
                <span className="wf-muted platform-panel-note">조직을 선택하면 소속 사용자를 확인할 수 있습니다.</span>
              </div>
              {filteredCompanies.length === 0 ? (
                <div className="platform-empty"><Building2 aria-hidden="true" /><p>등록된 조직이 없습니다</p><span>회원가입을 통해 새 조직이 생성됩니다</span></div>
              ) : (
                <div className="platform-company-list">
                  {filteredCompanies.map((company) => {
                    const companyUsers = getUsersForCompany(company.id);
                    const isExpanded = selectedCompany === company.id;
                    return (
                      <article key={company.id} className="platform-company">
                        <div className="platform-company-row">
                          <button type="button" className="platform-company-summary" aria-expanded={isExpanded} aria-controls={`platform-company-${company.id}`} onClick={() => setSelectedCompany(isExpanded ? null : company.id)}>
                            <span className={`platform-company-avatar ${company.status === 'ACTIVE' ? 'platform-company-active' : ''}`}>{company.nameEn?.[0]?.toUpperCase() || 'C'}</span>
                            <span className="platform-company-copy">
                              <span className="platform-company-title"><span className="platform-company-name">{company.nameKo}</span><span className="platform-company-english">{company.nameEn}</span><StatusBadge className={company.status === 'ACTIVE' ? 'wf-status-success' : 'wf-status-error'}>{company.status}</StatusBadge></span>
                              <span className="platform-company-meta">
                                <span><Globe aria-hidden="true" />{company.domain}</span>
                                <span><Users aria-hidden="true" />{companyUsers.length}명</span>
                                <StatusBadge className={company.subscriptionStatus === 'ACTIVE' ? 'wf-status-success' : company.subscriptionStatus === 'EXPIRED' ? 'wf-status-error' : 'wf-status-info'}>{company.subscriptionStatus || 'TRIAL'}</StatusBadge>
                                {calculateRemainingDays(company.subscriptionEndDate) !== null && (
                                  <StatusBadge className={calculateRemainingDays(company.subscriptionEndDate)! > 0 ? 'wf-status-info' : 'wf-status-error'}>
                                    {calculateRemainingDays(company.subscriptionEndDate)! > 0 ? `${calculateRemainingDays(company.subscriptionEndDate)}일 남음` : '만료됨'}
                                    {company.subscriptionEndDate && ` (~${new Date(company.subscriptionEndDate).toLocaleDateString()})`}
                                  </StatusBadge>
                                )}
                              </span>
                              <span className="platform-company-expand">{isExpanded ? '소속 사용자 접기' : '소속 사용자 보기'}</span>
                            </span>
                          </button>
                          <div className="platform-company-actions">
                            <Button className="platform-extend" onClick={(e) => { e.stopPropagation(); setSubscriptionTarget({ id: company.id, name: company.nameKo || '', currentEndDate: company.subscriptionEndDate || '' }); setShowSubscriptionModal(true); }}><Calendar aria-hidden="true" />기간 연장</Button>
                            <Button className={company.status === 'ACTIVE' ? 'wf-btn-danger' : 'platform-activate'} onClick={(e) => { e.stopPropagation(); handleToggleStatus(company.id, company.status); }}>
                              {company.status === 'ACTIVE' ? <><ToggleRight aria-hidden="true" />정지</> : <><ToggleLeft aria-hidden="true" />활성화</>}
                            </Button>
                            <Button className="platform-company-delete" onClick={(e) => { e.stopPropagation(); setDeleteTarget(company.id); setShowDeleteModal(true); }} title="모든 데이터 삭제" aria-label={`${company.nameKo} 모든 데이터 삭제`}><Trash2 aria-hidden="true" /></Button>
                          </div>
                        </div>
                        {isExpanded && (
                          <div id={`platform-company-${company.id}`} className="platform-company-details">
                            <h3 className="platform-detail-title"><Crown aria-hidden="true" />소속 사용자 목록</h3>
                            {companyUsers.length === 0 ? <p className="platform-inline-empty">사용자가 없습니다</p> : (
                              <div className="platform-users-grid">
                                {companyUsers.map(user => (
                                  <div key={user.uid} className="platform-user-card">
                                    <span className={`platform-user-avatar ${user.role === 'ADMIN' ? 'platform-admin-avatar' : ''}`}>{user.name?.[0] || '?'}</span>
                                    <div className="platform-user-copy"><p className="platform-user-name" title={user.name}>{user.name}</p><p className="platform-user-email" title={user.email}>{user.email}</p><StatusBadge>{getRoleDisplayName(user, company)}</StatusBadge></div>
                                    {user.role === 'ADMIN' && <Button className="platform-reset-button" onClick={(e) => { e.stopPropagation(); setResetTarget({uid: user.uid, name: user.name || ''}); setShowResetModal(true); }}><Key aria-hidden="true" />PW 초기화</Button>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </Panel>
          </div>
        )}

        {activeTab === 'USERS' && (
          <Panel as="section" className="platform-all-users" aria-labelledby="platform-users-title">
            <div className="wf-panel-head platform-panel-head"><div className="platform-section-heading"><Users aria-hidden="true" /><h2 id="platform-users-title" className="wf-section-title">전체 사용자 목록</h2><StatusBadge>{allUsers.length}명</StatusBadge></div></div>
            <div className="platform-users-grid platform-users-content">
              {allUsers.sort((a,b) => (a.companyId || '').localeCompare(b.companyId || '')).map(user => (
                <div key={user.uid} className="platform-user-card">
                  <span className={`platform-user-avatar ${user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' ? 'platform-admin-avatar' : ''}`}>{user.name?.[0] || '?'}</span>
                  <div className="platform-user-copy"><p className="platform-user-name" title={user.name}>{user.name}</p><p className="platform-user-email" title={user.email}>{user.email}</p><div className="platform-user-tags"><StatusBadge>{user.companyId || 'No Company'}</StatusBadge><span>{getRoleDisplayName(user, companies.find(company => company.id === user.companyId))}</span></div></div>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {showSubscriptionModal && (
          <PlatformDialog titleId="platform-subscription-title" busy={isUpdatingSubscription} onClose={() => { setShowSubscriptionModal(false); setSubscriptionPassword(''); }}>
              <div className="platform-modal-heading"><span className="platform-section-icon"><Calendar aria-hidden="true" /></span><div><h2 id="platform-subscription-title">사용기간 변경</h2><p>{subscriptionTarget?.name}</p></div></div>
              <div className="platform-modal-body">
                <label className="wf-field" htmlFor="platform-subscription-days">연장할 기간 (일)</label>
                <div className="platform-day-presets">{[30, 90, 365].map(days => <Button key={days} aria-pressed={subscriptionDaysToAdd === days} onClick={() => setSubscriptionDaysToAdd(days)}>{days}일</Button>)}</div>
                <Input id="platform-subscription-days" type="number" value={subscriptionDaysToAdd} onChange={(e) => setSubscriptionDaysToAdd(parseInt(e.target.value) || 0)} />
                <label className="wf-field platform-password-field" htmlFor="platform-subscription-password"><span><Lock aria-hidden="true" />본인 비밀번호 재확인</span><Input id="platform-subscription-password" type="password" value={subscriptionPassword} onChange={(e) => setSubscriptionPassword(e.target.value)} placeholder="비밀번호를 입력하세요" autoComplete="current-password" autoFocus data-platform-initial-focus /></label>
              </div>
              <div className="platform-modal-actions"><Button className="wf-btn-primary" disabled={isUpdatingSubscription || !subscriptionPassword} onClick={handleSubscriptionUpdateWithAuth}>{isUpdatingSubscription ? <><Loader2 className="platform-spinner" aria-hidden="true" />저장 중...</> : '변경사항 저장'}</Button><Button disabled={isUpdatingSubscription} onClick={() => { setShowSubscriptionModal(false); setSubscriptionPassword(''); }}>취소</Button></div>
          </PlatformDialog>
        )}

        {showResetModal && (
          <PlatformDialog titleId="platform-reset-title" onClose={() => setShowResetModal(false)}>
              <div className="platform-modal-heading"><span className="platform-section-icon"><Key aria-hidden="true" /></span><div><h2 id="platform-reset-title">비밀번호 초기화</h2><p>{resetTarget?.name}님</p></div></div>
              <div className="platform-modal-body"><label className="wf-field" htmlFor="platform-reset-password">새 임시 비밀번호<Input id="platform-reset-password" type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="최소 12자 이상" autoComplete="off" autoFocus data-platform-initial-focus /></label></div>
              <div className="platform-modal-actions"><Button className="wf-btn-primary" onClick={handleResetPassword}>변경사항 저장</Button><Button onClick={() => setShowResetModal(false)}>취소</Button></div>
          </PlatformDialog>
        )}

        {showDeleteModal && (
          <PlatformDialog titleId="platform-delete-title" descriptionId="platform-delete-warning" className="platform-delete-modal" busy={isDeleting} onClose={() => { setShowDeleteModal(false); setAdminPassword(''); }}>
              <div className="platform-modal-heading"><span className="platform-section-icon platform-danger-icon"><Trash2 aria-hidden="true" /></span><div><h2 id="platform-delete-title">조직 데이터 전체 삭제</h2><p>이 작업은 영구적이며 복구할 수 없습니다.</p></div></div>
              <div className="platform-modal-body"><p id="platform-delete-warning" className="platform-delete-warning">해당 조직과 관련된 모든 데이터(직원, 근태, 결재, 휴가 등)가 파기되며, 소속된 모든 사용자의 인증 계정도 영구 삭제됩니다.</p><label className="wf-field platform-password-field" htmlFor="platform-delete-password"><span><Lock aria-hidden="true" />본인 비밀번호 재확인 ({userData ? getRoleDisplayName(userData) : 'SYSTEM_ADMIN'})</span><Input id="platform-delete-password" type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="비밀번호를 입력하세요" autoComplete="current-password" autoFocus data-platform-initial-focus /></label></div>
              <div className="platform-modal-actions"><Button className="wf-btn-danger" disabled={isDeleting || !adminPassword} onClick={handleDeleteCompanyData}>{isDeleting ? <><Loader2 className="platform-spinner" aria-hidden="true" />삭제 중...</> : '영구 삭제 실행'}</Button><Button disabled={isDeleting} onClick={() => { setShowDeleteModal(false); setAdminPassword(''); }}>취소</Button></div>
          </PlatformDialog>
        )}

        {activeTab === 'PAYMENTS' && (
          <Panel as="section" className="platform-payments" aria-labelledby="platform-claims-title">
            <section className="platform-payment-section">
              <h2 id="platform-claims-title" className="wf-section-title">결제 확인 요청</h2>
              <p className="wf-muted">아래 거래 ID는 고객 브라우저에서 접수된 신고입니다. PayPal 관리 화면에서 거래와 금액을 확인한 뒤 조직별 구독 기간을 연장하세요.</p>
              <div className="platform-table-wrap" role="region" aria-label="결제 확인 요청 목록" tabIndex={0}>
                <table className="platform-table"><caption className="platform-sr-only">접수된 PayPal 결제 확인 요청</caption><thead><tr><th scope="col">조직 / 관리자</th><th scope="col">PayPal 거래 ID</th><th scope="col">접수 시각</th></tr></thead><tbody>
                  {paymentClaims.map(claim => <tr key={claim.id}><td>{claim.companyName} ({claim.adminName})</td><td className="platform-transaction">{claim.orderId}</td><td>{claim.createdAt?.seconds ? new Date(claim.createdAt.seconds * 1000).toLocaleString() : '-'}</td></tr>)}
                  {paymentClaims.length === 0 && <tr><td colSpan={3} className="platform-table-empty">접수된 요청이 없습니다.</td></tr>}
                </tbody></table>
              </div>
            </section>
            <section className="platform-payment-section" aria-labelledby="platform-payments-title">
              <h2 id="platform-payments-title" className="wf-section-title platform-section-heading"><CreditCard aria-hidden="true" />기존 결제 기록</h2>
              <p className="wf-muted">각 조직의 ADMIN이 PayPal을 통해 결제한 내역입니다. 실제 입금 여부를 대조하여 구독 상태를 관리하세요.</p>
              <div className="platform-table-wrap" role="region" aria-label="기존 결제 기록 목록" tabIndex={0}>
                <table className="platform-table"><caption className="platform-sr-only">조직별 기존 결제 기록</caption><thead><tr><th scope="col">조직 / 관리자</th><th scope="col">거래 ID</th><th scope="col">금액 / 통화</th><th scope="col">날짜</th></tr></thead><tbody>
                  {payments.map(p => <tr key={p.id}><td><strong>{p.companyName}</strong><span className="platform-table-subtext">{p.adminName} ({p.adminEmail || p.adminUid})</span></td><td className="platform-transaction">{p.transactionId}</td><td><strong>${p.amount || '29.99'}</strong><span className="platform-currency">{p.currency}</span></td><td>{p.createdAt ? new Date(p.createdAt.seconds * 1000).toLocaleString() : '-'}</td></tr>)}
                  {payments.length === 0 && <tr><td colSpan={4} className="platform-table-empty">결제 내역이 아직 없습니다.</td></tr>}
                </tbody></table>
              </div>
            </section>
          </Panel>
        )}
      </div>
    </div>
  );
};

function PlatformDialog({ children, titleId, descriptionId, className = '', busy = false, onClose }: {
  children: React.ReactNode;
  titleId: string;
  descriptionId?: string;
  className?: string;
  busy?: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    element?.querySelector<HTMLElement>('[data-platform-initial-focus]')?.focus({ preventScroll: true });
    return () => {
      if (element?.open) element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog ref={dialog} className={`wf-panel platform-modal ${className}`} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]'))
          .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
        const index = elements.indexOf(document.activeElement as HTMLElement);
        if (!elements.length) { event.preventDefault(); event.currentTarget.focus(); }
        else if (event.shiftKey && index <= 0) { event.preventDefault(); elements[elements.length - 1].focus(); }
        else if (!event.shiftKey && (index === -1 || index === elements.length - 1)) { event.preventDefault(); elements[0].focus(); }
      }}>
      {children}
    </dialog>
  );
}
