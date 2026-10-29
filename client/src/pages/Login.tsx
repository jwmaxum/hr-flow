import React, { useState } from 'react';
import { auth } from '../firebase';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification } from 'firebase/auth';
import { useAuthStore } from '../store/authStore';
import { passwordChangeWait, saveCompanySignup } from '../services/accountSecurityService';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Loader2, LogIn, UserPlus, AlertCircle, Mail, Lock, User, Building2, Globe, ArrowRight } from 'lucide-react';

import { Button, Input, Panel, PageTitle } from '../components/ui';
import '../styles/WorkflowTheme.css';
import './Login.css';

type TabMode = 'login' | 'register';

export const Login: React.FC = () => {
  const { refreshSession, authError } = useAuthStore();
  const [mode, setMode] = useState<TabMode>('login');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [registerSuccess, setRegisterSuccess] = useState(false);
  const navigate = useNavigate();

  // 로그인 폼
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // 회원가입 폼
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');
  const [regName, setRegName] = useState('');
  const [regOrgKo, setRegOrgKo] = useState('');
  const [regOrgEn, setRegOrgEn] = useState('');

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (passwordChangeWait() > 0) { setError('비밀번호 변경 처리를 마친 뒤 1초 후에 다시 로그인해 주세요.'); return; }
    setLoading(true);

    try {
      await signInWithEmailAndPassword(auth, loginEmail.trim().toLowerCase(), loginPassword);
      await refreshSession();
      const session = useAuthStore.getState();
      if (session.authError) throw new Error(session.authError);
      navigate(!session.userData ? '/profile-setup' : session.userData.role === 'SUPER_ADMIN' ? '/super-admin' : '/dashboard', { replace: true });
    } catch (err: unknown) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : '';
      if (code === 'auth/user-not-found' || code === 'auth/invalid-credential') {
        setError('이메일 또는 비밀번호가 올바르지 않습니다.');
      } else if (code === 'auth/too-many-requests') {
        setError('보안 정책상 잠시 후 다시 시도해주세요.');
      } else {
        setError(err instanceof Error ? err.message : '로그인 중 오류가 발생했습니다.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // 유효성 검증
    if (regPassword !== regConfirmPassword) {
      setError('비밀번호가 일치하지 않습니다.');
      return;
    }
    if (regPassword.length < 12 || regPassword.length > 128) {
      setError('비밀번호는 12~128자로 입력해 주세요.');
      return;
    }
    if (!regName.trim() || !regOrgKo.trim() || !regOrgEn.trim()) {
      setError('관리자 이름과 조직 이름(한글, 영문)을 모두 입력해 주세요.');
      return;
    }
    if (!regEmail.includes('@') || !regEmail.includes('.')) {
      setError('유효한 이메일 주소를 입력해주세요.');
      return;
    }

    setLoading(true);
    try {
      const normalizedEmail = regEmail.trim().toLowerCase();
      saveCompanySignup(normalizedEmail, { name: regName.trim(), nameKo: regOrgKo.trim(), nameEn: regOrgEn.trim() });
      const userCredential = await createUserWithEmailAndPassword(auth, normalizedEmail, regPassword);
      await sendEmailVerification(userCredential.user);
      await refreshSession();
      setRegisterSuccess(true);
      navigate('/profile-setup', { replace: true });
    } catch (err: unknown) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : '';
      if (code === 'auth/email-already-in-use') {
        setError('이미 등록된 이메일입니다. 로그인을 시도해주세요.');
      } else {
        setError(err instanceof Error ? err.message : '회원가입 중 오류가 발생했습니다.');
      }
    } finally {
      setLoading(false);
    }
  };

  if (registerSuccess) {
    return (
      <main className="workflow-theme auth-entry auth-entry-success">
        <Panel as="section" className="auth-entry-success-card" role="status" aria-live="polite">
          <span className="auth-entry-success-icon"><CheckCircle2 aria-hidden="true" /></span>
          <PageTitle>이메일을 확인해 주세요</PageTitle>
          <p>인증 메일을 확인한 뒤 조직 등록을 완료할 수 있습니다.</p>
          <Loader2 className="auth-entry-spinner" aria-hidden="true" />
        </Panel>
      </main>
    );
  }

  return (
    <div className="workflow-theme auth-entry">
      <header className="auth-entry-header">
        <div className="auth-entry-header-inner">
          <button type="button" onClick={() => navigate('/')} className="auth-entry-brand" aria-label="HR FLOW 홈">
            <span className="auth-entry-brand-mark" aria-hidden="true">HF</span><span>HR FLOW</span>
          </button>
          <span className="auth-entry-header-note">회사 업무를 한곳에서</span>
        </div>
      </header>
      <main className="auth-entry-main">
        <div className="auth-entry-heading">
          <p className="auth-entry-eyebrow">HR FLOW ACCOUNT</p>
          <PageTitle>{mode === 'login' ? '로그인' : '회원가입'}</PageTitle>
          <p>{mode === 'login' ? '조직의 성장을 가속화하는 지능형 HR 솔루션' : '회사를 등록하고 조직에 맞는 업무 환경을 시작하세요.'}</p>
        </div>
        <Panel className="auth-entry-card">
          <nav className="auth-entry-switch" aria-label="계정 이용 방식">
            <Button type="button" aria-pressed={mode === 'login'} onClick={() => { setMode('login'); setError(''); }}><LogIn aria-hidden="true" />로그인</Button>
            <Button type="button" aria-pressed={mode === 'register'} onClick={() => { setMode('register'); setError(''); }}><UserPlus aria-hidden="true" />회원가입</Button>
          </nav>
          {(error || authError) && <div className="auth-entry-alert" role="alert"><AlertCircle aria-hidden="true" /><span>{error || authError}</span></div>}
          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="auth-entry-form" aria-busy={loading}>
              <div className="auth-entry-field">
                <label htmlFor="login-email">이메일</label>
                <div className="auth-entry-control"><Mail aria-hidden="true" /><Input id="login-email" type="email" required maxLength={254} value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="admin@yourcompany.com" autoComplete="username" inputMode="email" /></div>
              </div>
              <div className="auth-entry-field">
                <label htmlFor="login-password">비밀번호</label>
                <div className="auth-entry-control"><Lock aria-hidden="true" /><Input id="login-password" type="password" required value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="비밀번호 입력" autoComplete="current-password" /></div>
              </div>
              <Button type="submit" disabled={loading} className="wf-btn-primary auth-entry-submit">{loading ? <Loader2 className="auth-entry-spinner" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}{loading ? '로그인 중...' : '로그인'}</Button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="auth-entry-form" aria-busy={loading}>
              <p className="auth-entry-form-intro">이메일 인증 후 조직 등록을 완료하면 회사 관리자 계정이 생성됩니다.</p>
              <div className="auth-entry-field">
                <label htmlFor="register-name">관리자 이름</label>
                <div className="auth-entry-control"><User aria-hidden="true" /><Input id="register-name" type="text" required maxLength={100} value={regName} onChange={(e) => setRegName(e.target.value)} placeholder="홍길동" autoComplete="name" /></div>
              </div>
              <div className="auth-entry-field">
                <label htmlFor="register-email">이메일 (로그인 ID)</label>
                <div className="auth-entry-control"><Mail aria-hidden="true" /><Input id="register-email" type="email" required maxLength={254} value={regEmail} onChange={(e) => setRegEmail(e.target.value)} placeholder="admin@yourcompany.com" autoComplete="email" inputMode="email" aria-describedby="register-email-note" /></div>
                <p id="register-email-note" className="auth-entry-field-note">본인이 확인할 수 있는 이메일을 입력해 주세요.</p>
              </div>
              <div className="auth-entry-password-grid">
                <div className="auth-entry-field">
                  <label htmlFor="register-password">비밀번호</label>
                  <div className="auth-entry-control"><Lock aria-hidden="true" /><Input id="register-password" type="password" required minLength={12} maxLength={128} value={regPassword} onChange={(e) => setRegPassword(e.target.value)} placeholder="12자 이상" autoComplete="new-password" aria-describedby="register-password-note" /></div>
                </div>
                <div className="auth-entry-field">
                  <label htmlFor="register-password-confirm">비밀번호 확인</label>
                  <div className="auth-entry-control"><Lock aria-hidden="true" /><Input id="register-password-confirm" type="password" required minLength={12} maxLength={128} value={regConfirmPassword} onChange={(e) => setRegConfirmPassword(e.target.value)} placeholder="재입력" autoComplete="new-password" aria-invalid={!!regConfirmPassword && regPassword !== regConfirmPassword} className={regConfirmPassword && regPassword !== regConfirmPassword ? 'auth-entry-invalid' : undefined} /></div>
                </div>
              </div>
              <p id="register-password-note" className="auth-entry-field-note auth-entry-password-note">비밀번호는 12~128자로 입력해 주세요.</p>
              <div className="auth-entry-section-label"><Building2 aria-hidden="true" /><span>조직 정보</span></div>
              <div className="auth-entry-field">
                <label htmlFor="register-company-ko">조직명 (한글)</label>
                <div className="auth-entry-control"><Building2 aria-hidden="true" /><Input id="register-company-ko" type="text" required maxLength={120} value={regOrgKo} onChange={(e) => setRegOrgKo(e.target.value)} placeholder="에테르노" autoComplete="organization" /></div>
              </div>
              <div className="auth-entry-field">
                <label htmlFor="register-company-en">조직명 (영문)</label>
                <div className="auth-entry-control"><Globe aria-hidden="true" /><Input id="register-company-en" type="text" required maxLength={120} value={regOrgEn} onChange={(e) => setRegOrgEn(e.target.value)} placeholder="Aeterno" /></div>
              </div>
              <Button type="submit" disabled={loading} className="wf-btn-primary auth-entry-submit">{loading ? <Loader2 className="auth-entry-spinner" aria-hidden="true" /> : <UserPlus aria-hidden="true" />}{loading ? '등록 중...' : '가입 및 이메일 인증'}</Button>
            </form>
          )}
        </Panel>
        <p className="auth-entry-copyright">© 2026 HR Flow SaaS Platform. All rights reserved.</p>
      </main>
    </div>
  );
};
