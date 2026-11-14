import {erpAccessOf} from '../utils/erpAccess';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, BookOpen, Check, Loader2, RefreshCw, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import {
  acknowledgeOfficialNotification, officialNotificationError, subscribeOfficialNotifications,
} from '../services/officialNotificationService';
import type { OfficialNotification } from '../services/officialNotificationService';
import {ErpApprovalAlert} from './ErpApprovalAlert';
import {ErpClosingAlert} from './ErpClosingAlert';

interface NotificationBellProps {
  currentUserId: string;
  onNavigate?: () => void;
  appearance?: 'default' | 'workflow';
}

interface InboxState {
  items: OfficialNotification[];
  loaded: boolean;
  fromCache: boolean;
  error: string;
}

interface UnreadState {
  count: number | null;
  fromCache: boolean;
  error: string;
}

function notificationLabel(notification: OfficialNotification): string {
  if (notification.draftingKind && notification.draftingKind !== 'DRAFT') {
    if (notification.requiresAction) return '내 확인 차례';
    if (notification.status === 'ISSUED') return '확인 완료';
    if (notification.status === 'REJECTED') return '반려';
    return notification.status === 'DRAFT' ? '업무보고 수정' : '확인 진행';
  }
  if (notification.requiresAction) return '내 결재 차례';
  if (notification.status === 'ISSUED') return '발행 완료';
  if (notification.status === 'REJECTED') return '반려';
  if (notification.status === 'DRAFT') return '수정·결재라인 변경';
  return '결재 진행';
}

function notificationDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function NotificationInbox({ currentUserId, companyId, recipientRole, onNavigate, appearance = 'default' }: NotificationBellProps & {
  companyId: string; recipientRole: OfficialNotification['recipientRole'];
}) {
  const navigate = useNavigate();
  const panelId = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [inbox, setInbox] = useState<InboxState>({ items: [], loaded: false, fromCache: true, error: '' });
  const [unread, setUnread] = useState<UnreadState>({ count: null, fromCache: true, error: '' });
  const [opening, setOpening] = useState('');
  const [actionError, setActionError] = useState('');
  const [position, setPosition] = useState({ top: 72, left: 12, width: 360, maxHeight: 500 });
  const enabled = Boolean(currentUserId && companyId);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const stop = subscribeOfficialNotifications(
      currentUserId,
      companyId,
      recipientRole,
      result => {
        if (active) setInbox({ items: result.value, loaded: true, fromCache: result.fromCache, error: '' });
      },
      result => {
        if (active) setUnread({ count: result.value, fromCache: result.fromCache, error: '' });
      },
      (source, error) => {
        if (!active) return;
        const message = officialNotificationError(error);
        if (source === 'items') setInbox({ items: [], loaded: true, fromCache: true, error: message });
        else setUnread({ count: null, fromCache: true, error: message });
      },
    );
    return () => { active = false; stop(); };
  }, [currentUserId, companyId, recipientRole, enabled, attempt]);

  const updatePosition = useCallback(() => {
    if (!anchor.current) return;
    const bounds = anchor.current.getBoundingClientRect();
    const width = Math.min(384, window.innerWidth - 24);
    const top = Math.min(bounds.bottom + 8, Math.max(12, window.innerHeight - 240));
    setPosition({
      top,
      left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)),
      width,
      maxHeight: Math.max(160, window.innerHeight - top - 12),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const handlePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); anchor.current?.focus(); }
    };
    document.addEventListener('pointerdown', handlePointer);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointer);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const retry = () => {
    setInbox({ items: [], loaded: false, fromCache: true, error: '' });
    setUnread({ count: null, fromCache: true, error: '' });
    setActionError('');
    setAttempt(value => value + 1);
  };

  const goTo = (path: string) => {
    const beforeNavigation = new CustomEvent('hr-flow:before-navigation', { cancelable: true, detail: { path } });
    if (!window.dispatchEvent(beforeNavigation)) return;
    setOpen(false);
    navigate(path);
    onNavigate?.();
  };

  const openLetter = async (notification: OfficialNotification) => {
    setOpening(notification.letterId);
    setActionError('');
    try {
      // This also checks current membership before opening a possibly stale alert.
      await acknowledgeOfficialNotification(notification);
      if (alive.current) goTo(`${notification.documentType === 'DRAFTING' ? '/drafting' : '/documents'}?letter=${encodeURIComponent(notification.letterId)}&notification=${encodeURIComponent(`${notification.revision}:${notification.updatedAt}`)}`);
    } catch (error) {
      if (alive.current) setActionError(officialNotificationError(error));
    } finally {
      if (alive.current) setOpening('');
    }
  };

  const loadError = inbox.error || unread.error;
  const uncertain = enabled && (Boolean(loadError) || inbox.fromCache || unread.fromCache || unread.count === null);
  const knownUnread = !uncertain && unread.count !== null ? unread.count : null;
  const badgeLabel = knownUnread !== null && knownUnread > 99 ? '99+' : knownUnread;
  const accessibleLabel = !enabled ? '알림 및 공지사항' : uncertain
    ? '서류 알림 연결 상태 확인 필요'
    : `서류 알림 ${knownUnread}개 미확인`;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => { updatePosition(); setOpen(value => !value); }}
        className={`relative shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white ${appearance === 'workflow' ? 'workflow-bell' : ''}`}
        aria-label={accessibleLabel}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
      >
        <Bell className="h-6 w-6" />
        {knownUnread !== null && knownUnread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-slate-900 bg-rose-500 px-1 text-[10px] font-bold text-white">
            {badgeLabel}
          </span>
        )}
        {uncertain && (
          <span aria-hidden="true" className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-full border-2 border-slate-900 bg-slate-500 text-[9px] font-bold text-white">?</span>
        )}
      </button>
      {open && createPortal(
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label="서류 결재 알림"
          tabIndex={-1}
          className={`fixed z-[200] flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-800 shadow-2xl outline-none ${appearance === 'workflow' ? 'workflow-theme workflow-notifications' : ''}`}
          style={position}
        >
          <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-bold">서류 결재 알림</h2>
              <p className="mt-0.5 text-xs text-slate-500">최근 알림 20개 · 서류별 최신 상태</p>
            </div>
            <button type="button" onClick={() => { setOpen(false); anchor.current?.focus(); }} aria-label="알림 닫기" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button>
          </div>
          <div className="min-h-0 overflow-y-auto" aria-live="polite">
            {!enabled ? <p className="p-4 text-sm text-slate-500">로그인 후 회사의 서류 알림을 확인할 수 있습니다.</p> : (
              <>
                {(loadError || actionError) && (
                  <div role="alert" className="m-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                    <p>{actionError || loadError}</p>
                    <button type="button" onClick={retry} className="mt-2 inline-flex items-center gap-1 font-semibold text-indigo-700"><RefreshCw className="h-3 w-3" />다시 불러오기</button>
                  </div>
                )}
                {!loadError && uncertain && (
                  <div role="status" className="m-3 rounded-xl bg-slate-100 p-3 text-xs text-slate-500">
                    최신 알림 연결을 확인 중입니다. 네트워크 연결을 확인해 주세요.
                    <button type="button" onClick={retry} className="mt-2 block font-semibold text-slate-600">다시 연결</button>
                  </div>
                )}
                {!inbox.loaded && !loadError && <div className="flex items-center justify-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />알림을 불러오는 중입니다.</div>}
                {inbox.loaded && !inbox.error && inbox.items.length === 0 && !inbox.fromCache && <p className="p-6 text-center text-sm text-slate-500">새로운 서류 알림이 없습니다.</p>}
                {!loadError && inbox.items.map(notification => (
                  <button
                    type="button"
                    key={notification.letterId}
                    onClick={() => void openLetter(notification)}
                    disabled={Boolean(opening)}
                    className={`flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left transition-colors hover:bg-indigo-50 disabled:opacity-60 ${notification.readAt ? 'bg-white' : 'bg-indigo-50/50'}`}
                  >
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${notification.readAt ? 'bg-slate-200' : 'bg-indigo-500'}`} aria-label={notification.readAt ? '확인한 알림' : '미확인 알림'} />
                    <span className="min-w-0 flex-1">
                      <span className={`text-[11px] font-semibold ${notification.requiresAction ? 'text-indigo-700' : 'text-slate-500'}`}>{notificationLabel(notification)}</span>
                      <span className="mt-1 block break-words text-sm font-semibold">{notification.title}</span>
                      <span className="mt-1 block text-[11px] text-slate-400">{notificationDate(notification.updatedAt)} · 수정본 {notification.revision}</span>
                    </span>
                    {opening === notification.letterId ? <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-indigo-600" /> : notification.readAt ? <Check className="mt-1 h-4 w-4 shrink-0 text-slate-400" /> : null}
                  </button>
                ))}
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-4 py-3 text-xs font-semibold">
            <button type="button" onClick={() => goTo('/documents')} className="text-indigo-700 hover:underline">서류발급 열기</button>
            <button type="button" onClick={() => goTo('/board')} className="flex items-center gap-1 text-slate-600 hover:underline"><BookOpen className="h-3.5 w-3.5" />공지사항 보기</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export function NotificationBell(props: NotificationBellProps) {
  const userData = useAuthStore(state => state.userData);
  const sessionReady=useAuthStore(state=>state.sessionReady);
  const recipientRole = userData?.role === 'ADMIN' || userData?.role === 'SUB_ADMIN' || userData?.role === 'MEMBER' ? userData.role : null;
  const companyId = userData?.uid === props.currentUserId && recipientRole && userData.status !== 'RESIGNED'
    ? userData.companyId : '';
  // A different company/account/role gets a new state tree before effects run.
  return <>{sessionReady&&companyId&&erpAccessOf(userData)!=='NONE'&&<ErpClosingAlert key={`closing:${props.currentUserId}:${companyId}:${userData?.erpAccess}`} companyId={companyId} onNavigate={props.onNavigate}/>} {sessionReady&&recipientRole==='ADMIN'&&companyId&&<ErpApprovalAlert key={`${props.currentUserId}:${companyId}`} companyId={companyId} onNavigate={props.onNavigate}/>}<NotificationInbox key={`${props.currentUserId}:${companyId}:${recipientRole}`} {...props} companyId={companyId} recipientRole={recipientRole || 'MEMBER'} /></>;
}
