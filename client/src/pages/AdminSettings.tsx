import { Button, Input, PageTitle, Panel, StatusBadge } from '../components/ui';
import { isValidNewPassword, PASSWORD_LENGTH_ERROR, PASSWORD_LENGTH_LABEL, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../../functions/password-policy.mjs';
import React, { useState, useEffect } from 'react';
import { Settings, Lock, AlertCircle, CheckCircle2, ShieldCheck, Key, Globe, Layout, Fingerprint, ShieldAlert, Users, Database, Clock, CloudDownload } from 'lucide-react';
import { auth, db, functions } from '../firebase';
import { doc, setDoc, collection, getDocs } from 'firebase/firestore';
import { EmailAuthProvider, reauthenticateWithCredential, verifyBeforeUpdateEmail } from 'firebase/auth';
import { accountSecurity } from '../services/accountSecurityService';
import { httpsCallable } from 'firebase/functions';
import { useAuthStore } from '../store/authStore';
import { query, where } from 'firebase/firestore';
import { getErrorCode, getErrorMessage } from '../utils/errors';
import './AdminSettings.css';

export const AdminSettings: React.FC = () => {
  // Password Reset State
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Domain Config State
  const { fetchCompanyDomain, companyData } = useAuthStore();
  const [tempDomain, setTempDomain] = useState('');
  const [verifyPassword, setVerifyPassword] = useState('');
  
  const { userData } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });

  // 시스템 도메인이 로드되면 입력창의 임시 상태 초기화
  useEffect(() => {
    if (companyData?.domain) {
      setTempDomain(companyData.domain);
    }
  }, [companyData]);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setMessage({ type: 'error', text: '입력하신 두 비밀번호가 일치하지 않습니다.' });
      return;
    }
    if (!isValidNewPassword(newPassword)) {
      setMessage({ type: 'error', text: PASSWORD_LENGTH_ERROR });
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });
    try {
      if (auth.currentUser) {
        // 보안 정책 준수를 위한 관리자 재인증 (verifyAdmin 내부에서 세션 갱신)
        await verifyAdmin();
        
        await accountSecurity.changePassword(newPassword);
        await useAuthStore.getState().logout();
        setNewPassword('');
        setConfirmPassword('');
        setVerifyPassword(''); // 사용한 검증 비밀번호 초기화
      } else {
        setMessage({ type: 'error', text: '인증 세션이 만료되었습니다. 다시 로그인해주세요.' });
      }
    } catch (err) {
      if (getErrorCode(err) === 'auth/requires-recent-login') {
        setMessage({ type: 'error', text: '보안 정책상 최근 로그인이 필요합니다. 로그아웃 후 다시 시도해주세요.' });
      } else {
        setMessage({ type: 'error', text: '비밀번호 변경 중 오류가 발생했습니다: ' + getErrorMessage(err) });
      }
    } finally {
      setLoading(false);
    }
  };

  // 0. 관리자 비밀번호 공통 검증 로직
  const verifyAdmin = async () => {
    if (!verifyPassword) {
      throw new Error("관리자 비밀번호를 입력해주세요.");
    }
    try {
      const administrator = auth.currentUser;
      if (!administrator?.email) throw new Error("인증 정보가 없습니다.");
      // 보안 재인증 수행
      await reauthenticateWithCredential(administrator, EmailAuthProvider.credential(administrator.email, verifyPassword));
      await administrator.getIdToken(true);
      return true;
    } catch (err) {
      if (getErrorCode(err) === 'auth/too-many-requests') {
        throw new Error("보안 정책상 너무 많은 요청이 발생했습니다. 잠시 후(약 10~30분) 다시 시도해 주세요.");
      }
      if (getErrorCode(err) === 'auth/wrong-password' || getErrorCode(err) === 'auth/invalid-credential') {
        throw new Error("비밀번호가 일치하지 않습니다. 다시 확인해주세요.");
      }
      throw err;
    }
  };

  const handleUpdateDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempDomain || !tempDomain.includes('.')) {
      setMessage({ type: 'error', text: '유효한 회사 도메인 형식을 입력해주세요 (예: bzpeer.com)' });
      return;
    }
    if (!verifyPassword) {
      setMessage({ type: 'error', text: '설정 변경을 위해 관리자 비밀번호를 입력해주세요.' });
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });
    try {
      // 1. 비밀번호 재검증 (공통 로직 사용)
      await verifyAdmin();

      // 1.5 도메인 중복 체크 (Cloud Function 호출)
      const cleanDomain = tempDomain.replace('@', '').trim();
      const checkDomain = httpsCallable(functions, 'checkDomainAvailability');
      const result = await checkDomain({ 
        domain: cleanDomain, 
        currentCompanyId: userData?.companyId 
      });
      
      const { available, message: domainMsg } = result.data as { available: boolean; message?: string };
      if (!available) {
        setMessage({ type: 'error', text: domainMsg || '이미 사용 중인 도메인입니다.' });
        return;
      }

      const administrator = auth.currentUser;
      if (!administrator?.email) throw new Error('관리자 인증 상태를 확인해 주세요.');
      await administrator.reload();
      await administrator.getIdToken(true);
      if (!administrator.emailVerified || administrator.email.toLowerCase().split('@')[1] !== cleanDomain.toLowerCase()) {
        const verificationEmail = `${administrator.email.split('@')[0]}@${cleanDomain.toLowerCase()}`;
        await verifyBeforeUpdateEmail(administrator, verificationEmail);
        setMessage({ type: 'success', text: `${verificationEmail}로 인증 메일을 보냈습니다. 메일의 링크를 완료한 뒤 새 이메일로 다시 로그인하고 도메인 저장을 눌러 주세요.` });
        return;
      }

      // Domain ownership and reservation are changed atomically by the server.
      if (!userData?.companyId) throw new Error("회사 정보가 없습니다.");
      
      const syncDomain = httpsCallable(functions, 'adminSyncCompanyDomain');
      await syncDomain({ newDomain: cleanDomain });

      // 3. 스토어 갱신 (저장된 최신 값 반영)
      await fetchCompanyDomain(userData.companyId);
      
      setMessage({ type: 'success', text: `회사 도메인과 사용자 로그인 ID가 @${cleanDomain}으로 동기화되었습니다.` });
      setVerifyPassword('');
    } catch (err) {
      console.error("[AdminSettings] Domain update error:", err);
      setMessage({ type: 'error', text: '도메인 변경 중 오류: ' + getErrorMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  const handleSyncAllUsersDomain = async () => {
    if (!window.confirm("모든 기존 사용자의 로그인 ID(Auth)와 프로필 도메인을 현재 설정된 도메인으로 일괄 동기화하시겠습니까? \n\n※ 주의: 동기화 완료 후 직원들은 변경된 도메인 이메일로 로그인해야 합니다.")) return;
    if (!verifyPassword) {
      setMessage({ type: 'error', text: '동기화를 위해 관리자 비밀번호를 입력해주세요.' });
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });
    try {
      // 1. 비밀번호 재검증 (공통 로직 사용)
      await verifyAdmin();

      // 2. Cloud Function 호출 (Auth 이메일 + Firestore 일괄 업데이트)
      // tempDomain(입력창)을 우선 사용, 없으면 스토어의 companyData.domain 사용
      const domainToSync = (tempDomain || companyData?.domain || '').replace('@', '').trim();
      if (!domainToSync) throw new Error("먼저 회사 도메인을 설정하고 저장해주세요.");
      
      console.log("[AdminSettings] Syncing users to domain:", domainToSync);
      const syncDomain = httpsCallable(functions, 'adminSyncCompanyDomain');
      const result = await syncDomain({ 
        newDomain: domainToSync 
      });

      const { success, message: syncMsg, successCount, failCount } = result.data as { 
        success: boolean; 
        message: string;
        successCount: number;
        failCount: number;
      };

      if (success) {
        setMessage({ 
          type: 'success', 
          text: syncMsg || `${successCount}명의 사용자 도메인 동기화가 완료되었습니다.${failCount > 0 ? ` (실패: ${failCount}명)` : ""}` 
        });
      } else {
        throw new Error(syncMsg || "동기화 중 오류가 발생했습니다.");
      }

      setVerifyPassword('');
    } catch (err) {
      console.error("Sync Error Detailed:", err);
      // Firebase HttpsError의 경우 err.message에 서버의 메시지가 담깁니다.
      const errorMsg = getErrorMessage(err);
      setMessage({ type: 'error', text: '동기화 중 오류: ' + errorMsg });
    } finally {
      setLoading(false);
    }
  };

  const handleRequestBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifyPassword) {
      setMessage({ type: 'error', text: '백업 시작을 위해 관리자 비밀번호를 입력해주세요.' });
      return;
    }

    setLoading(true);
    setMessage({ type: '', text: '' });
    try {
      // 1. 관리자 비밀번호 재검증
      await verifyAdmin();

      if (!userData?.companyId) throw new Error("회사 정보가 없습니다.");
      const companyId = userData.companyId;

      setMessage({ type: 'success', text: '데이터를 수집 중입니다. 잠시만 기다려주세요...' });

      // 2. 회사 관련 전체 데이터 수집 (Client-Side)
      const collectionsToBackup = [
        'UserProfile', 'divisions', 'teams', 'expenses', 
        'leaves', 'attendance', 'payroll_records', 'notices', 'AuditLogs'
      ];
      
      const backupData: Record<string, Record<string, unknown>[]> = {};

      for (const colName of collectionsToBackup) {
        const q = query(collection(db, colName), where('companyId', '==', companyId));
        const snap = await getDocs(q);
        backupData[colName] = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      }

      // 회사 기본 정보도 포함
      const companyDataObj = companyData ? { ...companyData } : {};
      const finalBackup = {
        companyInfo: companyDataObj,
        exportDate: new Date().toISOString(),
        exportedBy: userData.email,
        data: backupData
      };

      // 3. JSON 파일 생성 및 다운로드 (Blob)
      const dataStr = JSON.stringify(finalBackup, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      
      const dateString = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup_${companyData?.domain || companyId}_${dateString}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // 4. 마지막 백업 일시 업데이트
      await setDoc(doc(db, 'companies', companyId), {
        lastBackupAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      // 5. backup_tasks에도 기록 남기기
      await setDoc(doc(collection(db, 'backup_tasks')), {
        companyId: companyId,
        requestedBy: userData.uid,
        requestedAt: new Date().toISOString(),
        status: 'completed',
        type: 'FULL_EXPORT_DOWNLOAD'
      });

      // 스토어 갱신 (마지막 백업 일시 화면 반영)
      await fetchCompanyDomain(companyId);

      setMessage({ 
        type: 'success', 
        text: '백업 데이터 다운로드가 완료되었습니다. 안전한 곳에 보관해 주세요.' 
      });
      setVerifyPassword('');
    } catch (err) {
      setMessage({ type: 'error', text: '백업 처리 중 오류: ' + getErrorMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="settings-screen wf-page">
      <div className="settings-workspace">
        
        {/* Page Header */}
        <div className="settings-page-head">
          <div className="flex items-center gap-3">
            <div className="settings-heading-icon">
              <Settings className="w-6 h-6" />
            </div>
            <PageTitle className="wf-title">시스템 환경 설정</PageTitle>
          </div>
          <p className="settings-description">인사 시스템 기본 정보 및 관리자 보안 옵션을 구성합니다.</p>
        </div>

        {/* Status Message */}
        {message.text && (
          <Panel role="status" aria-live="polite" className={`settings-message wf-panel ${
            message.type === 'success' ? 'settings-message-success' : 'settings-message-error'
          }`}>
            <div className="settings-message-icon">
              {message.type === 'success' ? <CheckCircle2 className="w-6 h-6" /> : <ShieldAlert className="w-6 h-6" />}
            </div>
            <div>
              <p className="settings-message-title">
                {message.type === 'success' ? '환경 설정 업데이트 완료' : '시스템 경고'}
              </p>
              <p className="settings-message-text">{message.text}</p>
            </div>
          </Panel>
        )}

        <div className="settings-grid">
          
          {/* System Default Domain Section - Replacing External DB per user request */}
          <Panel className="settings-section wf-panel">
             <div className="settings-section-head wf-panel-head">
                <div className="flex items-center gap-3">
                  <div className="settings-section-icon">
                    <Globe className="w-5 h-5" />
                  </div>
                  <h2 className="wf-section-title">시스템 기본 도메인 설정</h2>
                </div>
                <div className="flex items-center gap-2">
                   <ShieldCheck className="w-4 h-4 text-indigo-500" />
                   <span className="settings-section-label">Global Policy</span>
                </div>
             </div>

             <form onSubmit={handleUpdateDomain} className="settings-section-body settings-form">
                <div className="settings-fields">
                   <div className="wf-field settings-field">
                      <label htmlFor="settings-domain" className="settings-label">
                        회사 공용 도메인 (Email Domain)
                      </label>
                      <div className="settings-domain-input">
                         <span className="settings-domain-prefix">@</span>
                         <Input
                           id="settings-domain"
                           type="text"
                           value={tempDomain}
                           onChange={(e) => setTempDomain(e.target.value.replace('@', ''))}
                           placeholder="bzpeer.com"
                           className="wf-input"
                         />
                      </div>
                      <p className="settings-help">입력 시 자동 완성 및 기본 ID 배정에 사용됩니다.</p>
                   </div>

                   <div className="wf-field settings-field">
                      <label htmlFor="settings-domain-password" className="settings-label">
                        <Key className="w-4 h-4" /> 정보 변경 승인 (관리자 암호)
                      </label>
                      <Input
                           id="settings-domain-password"
                           type="password"
                        required
                        value={verifyPassword}
                        onChange={(e) => setVerifyPassword(e.target.value)}
                        placeholder="현재 접속된 관리자 비밀번호 입력"
                        className="wf-input"
                      />
                   </div>

                   <div className="settings-note">
                      <div className="flex items-start gap-3">
                         <AlertCircle className="w-4 h-4 text-indigo-500 mt-0.5" />
                         <div className="space-y-1">
                            <p className="settings-note-title">도메인 변경 시 주의사항</p>
                            <p className="settings-note-text">
                              도메인을 변경하면 새로 생성되는 직원의 ID에 즉시 적용됩니다.<br/>
                              기존 사용자의 도메인도 아래 버튼으로 일괄 전환할 수 있습니다.
                            </p>
                         </div>
                      </div>
                   </div>
                </div>

                <Button
                  type="submit"
                  disabled={loading}
                  className="wf-btn wf-btn-primary settings-action"
                >
                   {loading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ShieldCheck className="w-5 h-5" />}
                   <span>시스템 도메인 변경 적용</span>
                </Button>

                <div className="settings-secondary-actions">
                  <Button
                    type="button"
                    onClick={handleSyncAllUsersDomain}
                    disabled={loading}
                    className="wf-btn settings-action settings-secondary"
                  >
                    <Users className="w-4 h-4" />
                    <span>기존 사용자 도메인 일체화 수행</span>
                  </Button>
                </div>
             </form>
          </Panel>

          {/* Security & Access Protection Section */}
          <Panel className="settings-section wf-panel">
            <div className="settings-section-head wf-panel-head">
              <div className="flex items-center gap-3">
                <div className="settings-section-icon">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <h2 className="wf-section-title">코어 보안 프로토콜</h2>
              </div>
              <StatusBadge className="wf-status settings-section-badge">
                Protected
              </StatusBadge>
            </div>

            <form onSubmit={handleChangePassword} className="settings-section-body settings-form">
              <div className="settings-fields">
                <div className="wf-field settings-field">
                  <label htmlFor="settings-new-password" className="settings-label">
                    <Fingerprint className="w-4 h-4 text-emerald-500" /> 신규 마스터 비밀번호
                  </label>
                  <Input
                           id="settings-new-password"
                           type="password"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={PASSWORD_LENGTH_LABEL}
                    className="wf-input"
                  />
                </div>
                <div className="wf-field settings-field">
                  <label htmlFor="settings-confirm-password" className="settings-label">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" /> 비밀번호 재검증
                  </label>
                  <Input
                           id="settings-confirm-password"
                           type="password"
                    required
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="재입력 확인"
                    className="wf-input"
                  />
                </div>
              </div>

              <Button
                type="submit"
                disabled={loading}
                className="wf-btn wf-btn-primary settings-action"
              >
                {loading ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Lock className="w-5 h-5" />}
                <span>보안 키 업데이트 적용</span>
              </Button>
            </form>
          </Panel>

          {/* Data Backup & Recovery Section */}
          <Panel className="settings-section wf-panel">
            <div className="settings-section-head wf-panel-head">
              <div className="flex items-center gap-3">
                <div className="settings-section-icon">
                  <Database className="w-5 h-5" />
                </div>
                <h2 className="wf-section-title">데이터 백업 및 보안 보관</h2>
              </div>
              <div className="flex items-center gap-2">
                <CloudDownload className="w-4 h-4 text-indigo-400" />
                <span className="settings-section-label">Archive Protocol</span>
              </div>
            </div>

            <div className="settings-section-body settings-form">
              <div className="settings-backup-summary">
                <div className="settings-backup-icon">
                  <Clock className="w-6 h-6" />
                </div>
                <div>
                  <p className="settings-help">최종 HR 데이터 다운로드 일시</p>
                  <p className="settings-backup-date">
                    {companyData?.lastBackupAt 
                      ? new Date(companyData.lastBackupAt).toLocaleString('ko-KR', { 
                          year: 'numeric', month: '2-digit', day: '2-digit', 
                          hour: '2-digit', minute: '2-digit' 
                        })
                      : '백업 기록 없음'}
                  </p>
                </div>
              </div>

              <form onSubmit={handleRequestBackup} className="settings-fields">
                <div className="wf-field settings-field">
                  <label htmlFor="settings-backup-password" className="settings-label">
                    <Lock className="w-4 h-4 text-indigo-500" /> 백업 실행 승인 (관리자 암호)
                  </label>
                  <Input
                           id="settings-backup-password"
                           type="password"
                    required
                    value={verifyPassword}
                    onChange={(e) => setVerifyPassword(e.target.value)}
                    placeholder="보안을 위해 비밀번호를 입력하세요"
                    className="wf-input"
                  />
                </div>

                <div className="settings-note settings-backup-note">
                  <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="settings-note-text">
                    회사 기본 정보와 인사·급여·휴가·지출 등 HR 데이터를 JSON 파일로 다운로드합니다. <br/>
                    ERP 재고·입출고·발행 문서와 인감·첨부 파일은 포함되지 않습니다. ERP 복구에는 별도 DB·파일 백업이 필요합니다. <br/>
                    데이터 크기에 따라 수 초에서 수십 초가 소요될 수 있으니 창을 닫지 말고 기다려주세요.
                  </p>
                </div>

                <Button
                  type="submit"
                  disabled={loading}
                  className="wf-btn wf-btn-primary settings-action"
                >
                  {loading ? (
                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <CloudDownload className="w-5 h-5" />
                  )}
                  <span>HR 데이터 로컬 백업 다운로드</span>
                </Button>
              </form>
            </div>
          </Panel>

          {/* System Infrastructure Info - Added to replace/restore previous External DB info */}
          <Panel className="settings-infrastructure wf-panel">
            <div className="settings-section-head wf-panel-head">
               <div className="flex items-center gap-3">
                 <div className="settings-section-icon">
                   <Layout className="w-5 h-5" />
                 </div>
                 <h2 className="wf-section-title">시스템 백본 및 인프라 상태</h2>
               </div>
               <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                  <span className="settings-section-label">Core Engine Active</span>
               </div>
            </div>
            <div className="settings-info-grid">
               <div className="space-y-2">
                  <p className="settings-info-label">주력 데이터베이스 엔진</p>
                  <div className="settings-info-card">
                     <div className="settings-info-icon">F</div>
                     <div>
                        <p className="settings-info-title">Firebase Firestore</p>
                        <p className="settings-info-description">Cloud Native NoSQL</p>
                     </div>
                  </div>
               </div>
               <div className="space-y-2">
                  <p className="settings-info-label">인증 보안 프로토콜</p>
                  <div className="settings-info-card">
                     <div className="settings-info-icon">
                        <ShieldCheck className="w-5 h-5" />
                     </div>
                     <div>
                        <p className="settings-info-title">Firebase Auth</p>
                        <p className="settings-info-description">JWT / OAuth 2.0</p>
                     </div>
                  </div>
               </div>
               <div className="space-y-2">
                  <p className="settings-info-label">파일 서버 스토리지</p>
                  <div className="settings-info-card">
                     <div className="settings-info-icon">
                        <Globe className="w-5 h-5" />
                     </div>
                     <div>
                        <p className="settings-info-title">Firebase Storage</p>
                        <p className="settings-info-description">GCP Infrastructure</p>
                     </div>
                  </div>
               </div>
            </div>
          </Panel>

        </div>

        {/* Footer info */}
        <div className="settings-footer">
           <p className="settings-help">System Version 2.0.4 Premium Core</p>
        </div>
      </div>
    </div>
  );
};
