import React, { useState } from 'react';
import { reload, sendEmailVerification } from 'firebase/auth';
import { useAuthStore } from '../store/authStore';
import { accountSecurity, clearCompanySignup, readCompanySignup, saveCompanySignup } from '../services/accountSecurityService';
import { AlertCircle, Building2, User, Globe, ArrowRight, Loader2, LogOut, CheckCircle2, Mail } from 'lucide-react';
import { Button, Input, Panel, PageTitle, StatusBadge } from '../components/ui';
import '../styles/WorkflowTheme.css';
import './ProfileSetup.css';

export const ProfileSetup: React.FC = () => {
  const { user, logout, refreshSession } = useAuthStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [draft] = useState(() => readCompanySignup(user?.email || ''));
  const [name, setName] = useState(draft.name);
  const [orgKo, setOrgKo] = useState(draft.nameKo);
  const [orgEn, setOrgEn] = useState(draft.nameEn);
  const [verified, setVerified] = useState(!!user?.emailVerified);
  const [notice, setNotice] = useState('');

  if (!user) return null;

  const checkVerification = async (resend: boolean) => {
    setError(''); setNotice(''); setLoading(true);
    try {
      if (resend) { await sendEmailVerification(user); setNotice('인증 메일을 보냈습니다. 받은편지함과 스팸함을 확인해 주세요.'); }
      else {
        await reload(user); await user.getIdToken(true); setVerified(user.emailVerified);
        if (!user.emailVerified) setError('이메일 인증이 아직 확인되지 않았습니다. 인증 메일의 링크를 누른 후 다시 확인해 주세요.');
        else setNotice('이메일 인증을 확인했습니다. 아래 조직 등록을 완료해 주세요.');
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : '이메일 인증 상태를 확인하지 못했습니다.'); }
    finally { setLoading(false); }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (!name.trim() || !orgKo.trim() || !orgEn.trim()) {
      setError('모든 정보를 입력해주세요.');
      return;
    }

    setLoading(true);
    try {
      const company = { name: name.trim(), nameKo: orgKo.trim(), nameEn: orgEn.trim() };
      saveCompanySignup(user.email || '', company);
      await reload(user); await user.getIdToken(true); setVerified(user.emailVerified);
      if (!user.emailVerified) { setError('조직 등록 전에 이메일 인증을 완료해 주세요.'); return; }
      await accountSecurity.createCompany(company);
      clearCompanySignup(user.email || '');
      await refreshSession();
      if (useAuthStore.getState().authError) throw new Error(useAuthStore.getState().authError || '계정 상태를 다시 확인해 주세요.');
      window.location.hash = '/dashboard';
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : '프로필 생성 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="workflow-theme profile-setup-screen">
      <div className="profile-setup-layout">
        <div className="profile-setup-brand"><span aria-hidden="true">HF</span><strong>HR FLOW</strong></div>
        <Panel className="profile-setup-card">
          <header className="profile-setup-heading"><p>COMPANY WORKSPACE</p><PageTitle>프로필 설정</PageTitle><span>이메일을 인증하고 회사·조직 등록을 완료하세요.</span></header>
          <div className="profile-setup-note"><AlertCircle aria-hidden="true" /><div><strong>이메일 인증 후 조직 등록을 완료해 주세요.</strong><p>회사 식별자와 관리자 프로필은 서버에서 생성합니다. 기존 등록 복구는 해당 회사의 원래 소유자만 할 수 있습니다.</p></div></div>
          <section className="profile-setup-verification" aria-label="이메일 인증 상태">
            <div className="profile-setup-email"><Mail aria-hidden="true" /><span>{user.email}</span></div>
            <StatusBadge className={verified ? 'wf-status-success' : 'wf-status-warning'}>{verified ? <CheckCircle2 size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}{verified ? '인증 완료' : '인증 대기'}</StatusBadge>
            <p>{verified ? '이메일 인증 완료' : '이메일 인증이 필요합니다. 인증 메일의 링크를 누른 뒤 확인해 주세요.'}</p>
            <div className="profile-setup-verification-actions"><Button type="button" disabled={loading} onClick={() => { void checkVerification(false); }}>이메일 인증 확인</Button>{!verified && <Button type="button" disabled={loading} className="wf-btn-quiet" onClick={() => { void checkVerification(true); }}>인증 메일 다시 보내기</Button>}</div>
            {notice && <p role="status" className="profile-setup-notice">{notice}</p>}
          </section>
          <form onSubmit={handleSetup} className="profile-setup-form" aria-busy={loading}>
            <label className="wf-field" htmlFor="profile-setup-name">사용자 이름<span className="profile-setup-input"><User aria-hidden="true" /><Input id="profile-setup-name" type="text" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="성함을 입력하세요" required /></span></label>
            <label className="wf-field" htmlFor="profile-setup-name-ko">조직 이름 (한글)<span className="profile-setup-input"><Building2 aria-hidden="true" /><Input id="profile-setup-name-ko" type="text" maxLength={120} value={orgKo} onChange={(e) => setOrgKo(e.target.value)} placeholder="예: (주)에이테르노" required /></span></label>
            <label className="wf-field" htmlFor="profile-setup-name-en">조직 이름 (영문)<span className="profile-setup-input"><Globe aria-hidden="true" /><Input id="profile-setup-name-en" type="text" maxLength={120} value={orgEn} onChange={(e) => setOrgEn(e.target.value)} placeholder="예: Aeterno Co., Ltd." required /></span></label>
            {error && <p role="alert" className="profile-setup-error"><AlertCircle aria-hidden="true" /><span>{error}</span></p>}
            <Button type="submit" disabled={loading || !verified} className="wf-btn-primary profile-setup-submit">{loading ? <Loader2 className="profile-setup-spinner" aria-hidden="true" /> : <>설정 완료 및 시작하기<ArrowRight aria-hidden="true" /></>}</Button>
          </form>
          <footer className="profile-setup-footer"><Button type="button" className="wf-btn-quiet" onClick={() => logout()}><LogOut aria-hidden="true" />다른 계정으로 로그인</Button></footer>
        </Panel>
      </div>
    </main>
  );
};
