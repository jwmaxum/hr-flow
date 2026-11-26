import { Button, PageTitle, Panel, Select, StatusBadge } from '../components/ui';
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { 
  Clock, LogIn, LogOut, Loader2, Calendar as CalendarIcon, MapPin, History,
  KeyRound, ChevronLeft, ChevronRight, Plus
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { getRoleDisplayName } from '../utils/roleDisplay';
import { collection, query, where, onSnapshot, addDoc, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameDay, isToday, addMonths, subMonths } from 'date-fns';
import { calculateTotalLeave } from '../utils/leaveCalculator';
import { MyIssuedDocuments } from '../components/MyIssuedDocuments';
import { accountSecurity } from '../services/accountSecurityService';
import type { DirectoryUser } from '../services/accountSecurityService';
import './AttendanceDashboard.css';

interface AttendanceRecord {
  id: string;
  userId: string;
  type: 'IN' | 'OUT';
  timestamp: string;
  location?: string;
}
interface LeaveSummary { status: string; type?: string; requestDays?: number }

export const AttendanceDashboard: React.FC = () => {
  const { 
    user, userData, companyData, sessionReady,
    openPasswordChange 
  } = useAuthStore();
  const [kstTime, setKstTime] = useState<string>('');
  const [kstDate, setKstDate] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const isManagement = userData?.role === 'ADMIN' || userData?.role === 'SUB_ADMIN';

  // 캘린더 및 관리자 조회용 상태
  const [currentMonth, setCurrentMonth] = useState<Date>(new Date());
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [monthlyRecords, setMonthlyRecords] = useState<AttendanceRecord[]>([]);
  const [allUsers, setAllUsers] = useState<DirectoryUser[]>([]);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryRetry, setDirectoryRetry] = useState(0);


  // 초기 selectedUserId 설정
  useEffect(() => {
    if (user?.uid && !selectedUserId) {
      setSelectedUserId(user.uid);
    }
  }, [user?.uid, selectedUserId]);



  // 관리자일 경우 전체 사용자 목록 페칭
  useEffect(() => {
    if (!sessionReady || !isManagement || !userData?.companyId) return;
    let active = true;
    accountSecurity.directory().then(result => {
      if (!active) return;
      setAllUsers(result.users); setDirectoryError('');
      setSelectedUserId(previous => previous === user?.uid || result.users.some(employee => employee.uid === previous) ? previous : user?.uid || '');
    }).catch(failure => {
      if (active) { setAllUsers([]); setDirectoryError(failure instanceof Error ? failure.message : '직원 목록을 불러오지 못했습니다.'); }
    });
    return () => { active = false; };
  }, [sessionReady, isManagement, user?.uid, userData?.role, userData?.companyId, userData?.divisionId, directoryRetry]);

  // 선택된 사용자의 월별 근태 기록 구독
  useEffect(() => {
    if (!sessionReady || !selectedUserId) return;


    // KST 기준 월 시작/종료 계산
    const start = startOfMonth(currentMonth).toISOString();
    const end = endOfMonth(currentMonth).toISOString();

    if (!userData?.companyId) return;

    const q = query(
      collection(db, 'attendance'),
      where('companyId', '==', userData.companyId),
      where('userId', '==', selectedUserId),
      ...(userData.role === 'SUB_ADMIN' && selectedUserId !== user?.uid ? [where('divisionId', '==', userData.divisionId || '__unassigned__')] : []),
      where('timestamp', '>=', start),
      where('timestamp', '<=', end)
    );

    const unsubscribe = onSnapshot(q, (snap) => {
      const docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as AttendanceRecord));
      setMonthlyRecords(docs);
    }, (err) => {
      console.error("Monthly Attendance Error:", err);
    });

    return () => unsubscribe();
  }, [sessionReady, selectedUserId, currentMonth, user?.uid, userData?.companyId, userData?.role, userData?.divisionId]);

  // KST 실시간 시계
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setKstTime(now.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setKstDate(now.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 오늘 근태 기록 실시간 구독
  useEffect(() => {
    if (!sessionReady || !user?.uid || !userData?.companyId) {
      setLoading(false);
      return;
    }

    // [버그 수정 및 보강] KST 기준 오늘 날짜 기록 페칭
    const q = query(
      collection(db, 'attendance'),
      where('companyId', '==', userData.companyId),
      where('userId', '==', user.uid)
    );

    const unsubscribe = onSnapshot(q, (snap) => {
      const now = new Date();
      const kstDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
      
      const docs = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as AttendanceRecord));
      
      // KST 기준 오늘 날짜와 일치하는 기록만 필터링
      const todayRecords = docs.filter(record => {
        try {
          const recordKstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(record.timestamp));
          return recordKstDate === kstDateStr;
        } catch {
          return false;
        }
      });

      const sorted = [...todayRecords].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      setRecords(sorted.slice(0, 10));
      setLoading(false);
    }, (err) => {
      console.error("Attendance Subscribe Error:", err);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [sessionReady, user?.uid, userData]);

  const handleAttendance = async (type: 'IN' | 'OUT') => {
    if (!sessionReady || !user || !userData) {
      alert("로그인이 필요합니다.");
      return;
    }

    // 중복 기록 방지 로직 추가
    if (type === 'IN' && hasCheckedInToday) {
      alert('이미 출근했습니다.');
      return;
    }
    if (type === 'OUT' && hasCheckedOutToday) {
      alert('이미 퇴근했습니다.');
      return;
    }
    if (type === 'OUT' && !hasCheckedInToday) {
      alert('출근 기록이 먼저 필요합니다.');
      return;
    }
    
    setIsSubmitting(true);
    try {
      const timestamp = new Date().toISOString();
      const attendanceData = {
        userId: user.uid,
        userName: userData?.name || '근로자',
        type: type,
        timestamp: timestamp,
        location: '본사',
        createdAt: timestamp,
        companyId: userData.companyId,
        divisionId: userData.divisionId || '', teamId: userData.teamId || ''
      };
      
      const docRef = await addDoc(collection(db, 'attendance'), attendanceData);

      const newRecord: AttendanceRecord = {
        id: docRef.id,
        ...attendanceData
      };
      setRecords(prev => {
        if (prev.some(r => r.id === docRef.id)) return prev;
        const updated = [newRecord, ...prev];
        return updated.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 10);
      });

      // 월별 현황(캘린더) 즉시 반영
      if (selectedUserId === user.uid) {
        setMonthlyRecords(prev => {
          if (prev.some(r => r.id === docRef.id)) return prev;
          return [...prev, newRecord];
        });
      }
    } catch (e) {
      const error = e as Error;
      alert('기록 중 오류가 발생했습니다: ' + error.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const lastStatus = records[0];
  const hasCheckedInToday = records.some(r => r.type === 'IN');
  const hasCheckedOutToday = records.some(r => r.type === 'OUT');

  // 연차 요약 로직
  const [leaveRequests, setLeaveRequests] = useState<LeaveSummary[]>([]);
  useEffect(() => {
    if (!sessionReady || !userData?.companyId || !selectedUserId) return;

    const q = query(
      collection(db, 'leaves'), 
      where('companyId', '==', userData.companyId),
      where('userId', '==', selectedUserId),
      ...(userData.role === 'SUB_ADMIN' && selectedUserId !== user?.uid ? [where('divisionId', '==', userData.divisionId || '__unassigned__')] : []),
      orderBy('startDate', 'desc')
    );
    return onSnapshot(q, (snap) => {
      setLeaveRequests(snap.docs.map(doc => doc.data() as LeaveSummary));
    }, (err) => {
      console.error("Leave Snapshot Error:", err);
    });
  }, [sessionReady, user?.uid, selectedUserId, userData?.companyId, userData?.role, userData?.divisionId]);

  const totalLeave = calculateTotalLeave(userData?.joinDate, userData?.additionalLeave || 0);
  const usedLeave = leaveRequests
    .filter(req => req.status === 'APPROVED' && (req.type === 'annual' || req.type === 'half'))
    .reduce((sum, req) => sum + (req.requestDays || 0), 0);
  const remainingLeave = totalLeave - usedLeave;
  const checkInRecord = records.find(record => record.type === 'IN');

  return (
    <div className="attendance-dashboard wf-page">
      <header className="attendance-page-head">
        <div>
          <PageTitle className="wf-title">대시보드</PageTitle>
          <p className="attendance-page-description">{kstDate || '오늘의 업무를 확인하세요.'}{kstTime && <> · <time>{kstTime}</time></>}</p>
          <p className="attendance-user-caption">{userData?.name || '로딩 중...'} · {userData ? getRoleDisplayName(userData, companyData ?? undefined) : 'MEMBER'}</p>
        </div>
        <div className="attendance-page-actions">
          <Button type="button" onClick={openPasswordChange} className="wf-btn"><KeyRound size={16} />보안 설정</Button>
          <Link to="/drafting" className="wf-btn wf-btn-primary"><Plus size={16} />기안·보고 작성</Link>
        </div>
      </header>

      {directoryError && <div role="alert" className="attendance-error">{directoryError}<button type="button" onClick={() => setDirectoryRetry(value => value + 1)}>직원 목록 다시 불러오기</button></div>}

      <div className="attendance-top-grid">
        <Panel as="section" className="wf-panel attendance-summary-card" aria-label="오늘 근태">
          <div className="wf-panel-head"><h2>오늘 근태</h2><StatusBadge className={`wf-status ${lastStatus?.type === 'IN' ? 'wf-status-success' : ''}`}>{lastStatus?.type === 'IN' ? '근무 중' : hasCheckedOutToday ? '퇴근 완료' : '출근 전'}</StatusBadge></div>
          <p className="attendance-label">출근 시각</p>
          <div className="attendance-start-time"><strong>{checkInRecord ? format(new Date(checkInRecord.timestamp), 'HH:mm') : '--:--'}</strong><span>{hasCheckedOutToday ? '오늘 업무를 마쳤습니다.' : hasCheckedInToday ? '오늘도 수고하고 계세요.' : '오늘의 출근을 기록하세요.'}</span></div>
          <div className="attendance-action-buttons">
            <Button type="button" onClick={() => handleAttendance('IN')} disabled={isSubmitting || hasCheckedInToday} className={`wf-btn ${!hasCheckedInToday ? 'wf-btn-primary' : ''}`}>
              {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} />}{hasCheckedInToday ? '출근 완료' : '출근하기'}
            </Button>
            <Button type="button" onClick={() => handleAttendance('OUT')} disabled={isSubmitting || !hasCheckedInToday || hasCheckedOutToday} className={`wf-btn ${hasCheckedInToday && !hasCheckedOutToday ? 'wf-btn-primary' : ''}`}>
              {isSubmitting ? <Loader2 size={16} className="animate-spin" /> : <LogOut size={16} />}{hasCheckedOutToday ? '퇴근 완료' : '퇴근하기'}
            </Button>
          </div>
        </Panel>

        <Panel as="section" className="wf-panel attendance-summary-card attendance-timeline-card" aria-label="최근 근태 기록">
          <div className="wf-panel-head"><h2>최근 기록</h2><History size={17} className="attendance-muted" /></div>
          <div className="attendance-timeline-feed">
            {loading ? <p role="status" className="attendance-empty"><Loader2 size={18} className="animate-spin" />근태 기록을 불러오는 중입니다.</p> : records.length > 0 ? (
              <ul className="attendance-timeline-list">{records.map(record => <li key={record.id}>
                <span className="attendance-log-icon">{record.type === 'IN' ? <LogIn size={16} /> : <LogOut size={16} />}</span>
                <div className="attendance-log-copy"><strong>{record.type === 'IN' ? '출근' : '퇴근'}</strong><small><MapPin size={12} />{record.location || '위치 정보 없음'}</small></div>
                <time dateTime={record.timestamp}>{format(new Date(record.timestamp), 'HH:mm:ss')}</time>
              </li>)}</ul>
            ) : <p className="attendance-empty"><Clock size={18} />오늘의 근태 기록이 없습니다.</p>}
          </div>
        </Panel>

        <Panel as="section" className="wf-panel attendance-summary-card" aria-label="연차휴가 요약">
          <div className="wf-panel-head"><h2>남은 연차</h2><Link to="/leave" className="attendance-text-link">휴가 신청 <ChevronRight size={14} /></Link></div>
          <div className="attendance-leave-total"><strong>{remainingLeave}</strong><span>일</span></div>
          <dl className="attendance-leave-breakdown"><div><dt>총 연차</dt><dd>{totalLeave}일</dd></div><div><dt>사용</dt><dd>{usedLeave}일</dd></div></dl>
        </Panel>
      </div>

      <MyIssuedDocuments />

      <div className="attendance-lower-grid">
        <Panel as="section" className="wf-panel attendance-calendar-card" aria-label="월별 근태 분석">
          <div className="wf-panel-head attendance-calendar-head">
            <h2><CalendarIcon size={18} />월별 근태</h2>
            <div className="attendance-calendar-controls">
              {isManagement && <label className="attendance-employee-filter"><span className="sr-only">근태 조회 직원</span><Select aria-label="근태 조회 직원" value={selectedUserId} onChange={event => setSelectedUserId(event.target.value)} className="wf-input">
                {allUsers.map(employee => <option key={employee.uid} value={employee.uid}>{employee.name}</option>)}
              </Select></label>}
              <div className="attendance-month-controls"><Button type="button" aria-label="이전 달 조회" onClick={() => setCurrentMonth(subMonths(currentMonth, 1))} className="wf-btn"><ChevronLeft size={16} /></Button><strong>{format(currentMonth, 'yyyy. MM')}</strong><Button type="button" aria-label="다음 달 조회" onClick={() => setCurrentMonth(addMonths(currentMonth, 1))} className="wf-btn"><ChevronRight size={16} /></Button></div>
            </div>
          </div>
          <div className="attendance-calendar-weekdays" aria-hidden="true">{['일', '월', '화', '수', '목', '금', '토'].map(day => <span key={day}>{day}</span>)}</div>
          <div className="attendance-calendar-grid">
            {Array.from({ length: startOfMonth(currentMonth).getDay() }).map((_, index) => <div key={`empty-${index}`} aria-hidden="true" />)}
            {eachDayOfInterval({ start: startOfMonth(currentMonth), end: endOfMonth(currentMonth) }).map(day => {
              const dayRecords = monthlyRecords.filter(record => isSameDay(new Date(record.timestamp), day));
              const hasCheckIn = dayRecords.some(record => record.type === 'IN');
              const hasCheckOut = dayRecords.some(record => record.type === 'OUT');
              const isTodayLocal = isToday(day);
              const firstIn = dayRecords.find(record => record.type === 'IN');
              return <div key={day.toString()} className={`attendance-calendar-day ${isTodayLocal ? 'attendance-calendar-day-today' : ''}`} title={firstIn ? `출근 ${format(new Date(firstIn.timestamp), 'HH:mm')}` : undefined}>
                <time dateTime={format(day, 'yyyy-MM-dd')}>{format(day, 'd')}<span className="sr-only">일 · {hasCheckIn ? '출근 기록 있음' : '출근 기록 없음'} · {hasCheckOut ? '퇴근 기록 있음' : '퇴근 기록 없음'}</span></time>
                <span className="attendance-calendar-dots" aria-hidden="true"><span className={hasCheckIn ? 'attendance-dot-in' : ''} /><span className={hasCheckOut ? 'attendance-dot-out' : ''} /></span>
              </div>;
            })}
          </div>
          <p className="attendance-calendar-legend"><span><i className="attendance-dot-in" />출근</span><span><i className="attendance-dot-out" />퇴근</span><span>기록이 있는 날짜에 표시합니다.</span></p>
        </Panel>

        <Panel as="section" className="wf-panel attendance-month-summary" aria-label="월별 근태 요약">
          <div className="wf-panel-head"><h2>근무 요약</h2><span className="attendance-muted">{format(currentMonth, 'yyyy년 M월')}</span></div>
          <dl>
            <div className="attendance-worked-total"><dt>출근한 날</dt><dd><strong>{new Set(monthlyRecords.filter(record => record.type === 'IN').map(record => format(new Date(record.timestamp), 'yyyy-MM-dd'))).size}</strong><span>일</span></dd></div>
            <div><dt>퇴근 기록</dt><dd>{monthlyRecords.filter(record => record.type === 'OUT').length}건</dd></div>
            <div><dt>사용 연차</dt><dd>{usedLeave}일</dd></div>
          </dl>
          <p className="attendance-summary-note">월별 근태와 승인된 휴가 내역을 확인하세요.</p>
        </Panel>
      </div>
    </div>
  );
};
