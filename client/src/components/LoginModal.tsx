import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { auth } from '../firebase';
import { useAuthStore } from '../store/authStore';
import { accountSecurity } from '../services/accountSecurityService';
import { AlertCircle, X, KeyRound, Loader2, LogOut } from 'lucide-react';
import { Button, Input } from './ui';
import '../styles/WorkflowTheme.css';
import './LoginModal.css';

function PasswordChangeDialog({ manual, required }: { manual: boolean; required: boolean }) {
  const { logout, setLoginModalOpen } = useAuthStore();
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  async function change(event: FormEvent) {
    event.preventDefault(); setError('');
    if (newPassword !== confirmation) { setError('새 비밀번호가 일치하지 않습니다.'); return; }
    if (newPassword.length < 12 || newPassword.length > 128) { setError('새 비밀번호는 12~128자로 입력해 주세요.'); return; }
    setWorking(true);
    try {
      const user = auth.currentUser;
      if (!user?.email) throw new Error('인증 세션이 만료되었습니다. 다시 로그인해 주세요.');
      if (manual) {
        if (!currentPassword) throw new Error('현재 비밀번호를 입력해 주세요.');
        try { await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, currentPassword)); }
        catch { throw new Error('현재 비밀번호를 확인해 주세요.'); }
        await user.getIdToken(true);
      }
      await accountSecurity.changePassword(newPassword);
      setCurrentPassword(''); setNewPassword(''); setConfirmation('');
      await logout();
      window.alert('비밀번호를 변경했습니다. 1초 후 새 비밀번호로 다시 로그인해 주세요.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '비밀번호를 변경하지 못했습니다. 다시 시도해 주세요.');
    } finally { setWorking(false); }
  }
  return <PasswordDialogFrame dismissible={!required || manual} busy={working} onClose={() => setLoginModalOpen(false)}>
    {(!required || manual) && <button type="button" aria-label="비밀번호 변경 닫기" disabled={working} className="wf-icon-button password-change-close" onClick={() => setLoginModalOpen(false)}><X size={20} aria-hidden="true" /></button>}
    <header className="password-change-heading">
      <span className="password-change-icon"><KeyRound aria-hidden="true" /></span>
      <p className="password-change-eyebrow">ACCOUNT SECURITY</p>
      <h2 id="password-change-title">비밀번호 변경</h2>
      <p id="password-change-description">{required ? '초기 비밀번호를 변경해야 업무 기능을 사용할 수 있습니다.' : '현재 비밀번호를 확인한 뒤 새 비밀번호를 설정합니다.'} 변경 후에는 새 비밀번호로 다시 로그인합니다.</p>
    </header>
    <form onSubmit={event => { void change(event); }} className="password-change-form" aria-busy={working}>
      {error && <p role="alert" className="password-change-error"><AlertCircle size={18} aria-hidden="true" /><span>{error}</span></p>}
      <fieldset disabled={working} className="password-change-fields">
        {manual && <label className="wf-field" htmlFor="password-change-current">현재 비밀번호<Input id="password-change-current" type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} data-password-initial-focus /></label>}
        <label className="wf-field" htmlFor="password-change-new">새 비밀번호<Input id="password-change-new" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newPassword} onChange={event => setNewPassword(event.target.value)} data-password-initial-focus={!manual || undefined} aria-describedby="password-change-policy" /></label>
        <label className="wf-field" htmlFor="password-change-confirmation">새 비밀번호 확인<Input id="password-change-confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
        <p id="password-change-policy" className="password-change-policy">12~128자를 입력해 주세요. 공통 초기 비밀번호를 새 비밀번호로 사용할 수 없습니다. 최근 로그인 시간이 오래되었다면 다시 로그인해 주세요.</p>
        <Button type="submit" className="wf-btn-primary password-change-submit">{working && <Loader2 className="password-change-spinner" size={18} aria-hidden="true" />}비밀번호 변경 후 다시 로그인</Button>
      </fieldset>
    </form>
    <footer className="password-change-footer"><Button type="button" disabled={working} className="wf-btn-quiet" onClick={() => { void logout(); }}><LogOut size={16} aria-hidden="true" />로그아웃하고 다시 로그인</Button></footer>
  </PasswordDialogFrame>;
}

export function LoginModal() {
  const { userData, isLoginModalOpen, isManualChangeMode } = useAuthStore();
  if (!userData || !isLoginModalOpen || (!userData.mustChangePassword && !isManualChangeMode)) return null;
  return <PasswordChangeDialog key={`${userData.uid}:${isManualChangeMode}`} manual={isManualChangeMode} required={!!userData.mustChangePassword} />;
}

function PasswordDialogFrame({ children, dismissible, busy, onClose }: {
  children: ReactNode; dismissible: boolean; busy: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    element?.querySelector<HTMLElement>('[data-password-initial-focus]')?.focus({ preventScroll: true });
    return () => {
      if (element?.open) element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="workflow-theme password-change-dialog" aria-labelledby="password-change-title" aria-describedby="password-change-description"
    onCancel={event => { event.preventDefault(); if (dismissible && !busy) onClose(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]'))
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
      const index = elements.indexOf(document.activeElement as HTMLElement);
      if (!elements.length) { event.preventDefault(); event.currentTarget.focus(); }
      else if (event.shiftKey && index <= 0) { event.preventDefault(); elements[elements.length - 1].focus(); }
      else if (!event.shiftKey && (index === -1 || index === elements.length - 1)) { event.preventDefault(); elements[0].focus(); }
    }}>{children}</dialog>;
}
