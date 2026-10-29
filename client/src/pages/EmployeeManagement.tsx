import { Button, Input, PageTitle, Panel, Select, Textarea } from '../components/ui';
import React, { useState, useEffect } from 'react';
import { 
  Users, Search, Building, Filter, Trash2, UserX, UserCheck, Key, 
  Loader2, ShieldAlert,
  Calendar, X, MoreVertical, Mail, Copy, Check
} from 'lucide-react';
import { 
  collection, query, where, onSnapshot, doc, updateDoc, 
  getDocs
} from 'firebase/firestore';
import { auth, db, functions } from '../firebase';
import { httpsCallable } from 'firebase/functions';
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { useAuthStore } from '../store/authStore';
import { getRoleDisplayName } from '../utils/roleDisplay';
import { getErrorCode, getErrorMessage } from '../utils/errors';
import { calculateLeaveEntitlement } from '../utils/leaveCalculator';
import './EmployeeManagement.css';

interface Employee {
  uid: string;
  name: string;
  email: string;
  role: string;
  divisionId?: string;
  teamId?: string;
  status?: 'ACTIVE' | 'RESIGNED';
  joinDate?: string;
  rrn?: string;
  phone?: string;
  address?: string;
  personalEmail?: string;
  additionalLeave?: number;
}

interface AttendanceRecord {
  id: string;
  type: 'IN' | 'OUT';
  timestamp: string;
  location?: string;
}

interface Division {
  id: string;
  name: string;
}

interface Team extends Division {
  divisionId: string;
}

interface LeaveSummary {
  status: string;
  type?: string;
  requestDays?: number;
}

export const EmployeeManagement: React.FC = () => {
  const { userData, companyData } = useAuthStore();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  
  // Filters
  const [selectedDivision, setSelectedDivision] = useState<string>('ALL');
  const [selectedTeam, setSelectedTeam] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  
  // Modals
  const [selectedEmpRecords, setSelectedEmpRecords] = useState<{emp: Employee, records: AttendanceRecord[], leaves: LeaveSummary[]} | null>(null);
  const [deleteConfirmEmp, setDeleteConfirmEmp] = useState<Employee | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Personnel Info
  const [editingInfo, setEditingInfo] = useState({ rrn: '', address: '', phone: '', personalEmail: '', additionalLeave: 0 });
  const [isSaving, setIsSaving] = useState(false);
  const isAdmin = userData?.role === 'ADMIN';
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);

  const handleCopyEmail = (email: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    navigator.clipboard.writeText(email);
    setCopiedEmail(email);
    setTimeout(() => setCopiedEmail(null), 2000);
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleGlobalClick = () => setActiveMenuId(null);
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  useEffect(() => {
    if (!userData?.companyId) return;
    const companyId = userData.companyId;

    // 1. Fetch Organization Data (companyId 기반 격리)
    const unsubDivs = onSnapshot(query(collection(db, 'divisions'), where('companyId', '==', companyId)), (snap) => {
      setDivisions(snap.docs.map(d => ({ id: d.id, ...d.data() } as Division)));
    });
    const unsubTeams = onSnapshot(query(collection(db, 'teams'), where('companyId', '==', companyId)), (snap) => {
      setTeams(snap.docs.map(d => ({ id: d.id, ...d.data() } as Team)));
    });

    // 2. Subscribe to Employees
    const q = query(collection(db, 'UserProfile'), where('companyId', '==', companyId));
    const unsubEmployees = onSnapshot(q, (snap) => {
      const emps = snap.docs.map(d => ({ uid: d.id, ...d.data() } as Employee));
      setEmployees(emps.sort((a, b) => a.name.localeCompare(b.name)));
      setLoading(false);
    });

    return () => { unsubDivs(); unsubTeams(); unsubEmployees(); };
  }, [userData?.companyId]);

  // Filtered List with De-duplication
  const filteredEmployees = (() => {
    // 1. 이메일 기준으로 그룹화하여 중복 제거 (가장 높은 권한 우선)
    const grouped = employees.reduce((acc, emp) => {
      const email = emp.email?.toLowerCase().trim();
      if (!email) return acc;
      
      if (!acc[email]) {
        acc[email] = emp;
      } else {
        const roleOrder: Record<string, number> = { 'ADMIN': 3, 'SUB_ADMIN': 2, 'MEMBER': 1 };
        const currentPrio = roleOrder[acc[email].role] || 0;
        const newPrio = roleOrder[emp.role] || 0;
        if (newPrio > currentPrio) {
          acc[email] = emp;
        }
      }
      return acc;
    }, {} as Record<string, Employee>);

    // 2. 필터링 및 정렬 적용
    return Object.values(grouped)
      .filter(emp => {
        const matchesDiv = selectedDivision === 'ALL' || emp.divisionId === selectedDivision;
        const matchesTeam = selectedTeam === 'ALL' || emp.teamId === selectedTeam;
        const matchesSearch = emp.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
                              emp.email.toLowerCase().includes(searchTerm.toLowerCase());
        return matchesDiv && matchesTeam && matchesSearch;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  })();

  const handleOpenDetail = async (emp: Employee) => {
    setEditingInfo({
      rrn: emp.rrn || '',
      address: emp.address || '',
      phone: emp.phone || '',
      personalEmail: emp.personalEmail || '',
      additionalLeave: emp.additionalLeave || 0
    });
    
    let leaves: LeaveSummary[] = [];
    if (emp.uid) {
      try {
        const q = query(
          collection(db, 'leaves'), 
          where('userId', '==', emp.uid),
          where('companyId', '==', userData?.companyId || '')
        );
        const snap = await getDocs(q);
        leaves = snap.docs.map(doc => doc.data() as LeaveSummary);
      } catch (err) {
        console.error("Failed to fetch leaves for dashboard:", err);
      }
    }

    setSelectedEmpRecords({ emp, records: [], leaves });
  };

  const handleSavePersonalInfo = async () => {
    if (!selectedEmpRecords || !isAdmin) return;
    setIsSaving(true);
    try {
      const userRef = doc(db, 'UserProfile', selectedEmpRecords.emp.uid);
      await updateDoc(userRef, {
        ...editingInfo
      });
      alert('개인정보가 저장되었습니다.');
      // Update local state to reflect changes without reload
      setSelectedEmpRecords(prev => prev ? {
        ...prev,
        emp: { ...prev.emp, ...editingInfo }
      } : null);
    } catch (e) {
      alert('저장 실패: ' + (e as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleStatus = async (emp: Employee, newStatus: 'ACTIVE' | 'RESIGNED') => {
    // 1. 자가 정지 및 소유자 정지 보호
    if (emp.uid === userData?.uid) {
      alert("운영 실수 방지를 위해 본인의 계정 상태는 변경할 수 없습니다.");
      return;
    }
    if (emp.uid === companyData?.adminUid && newStatus === 'RESIGNED') {
      alert("회사 대표 가입자(SUPER_ADMIN)의 계정은 정지할 수 없습니다.");
      return;
    }

    const isActactivating = newStatus === 'ACTIVE';
    const confirmMsg = isActactivating 
      ? `[업무정지 해제] ${emp.name}님의 계정을 다시 활성화하시겠습니까?`
      : `[퇴사(업무정지) 처리] ${emp.name}님의 계정을 정지하시겠습니까? 기록은 유지되지만 로그인이 차단됩니다.`;

    if (!window.confirm(confirmMsg)) return;
    
    try {
      await httpsCallable(functions, 'accountSecurity')({ action: 'setMemberStatus', uid: emp.uid, status: newStatus });
      alert(isActactivating ? '계정이 활성화되었습니다.' : '퇴사(업무정지) 처리가 완료되었습니다.');
    } catch (e) {
      alert('오류 발생: ' + (e as Error).message);
    }
  };

  const handleDeleteAll = async () => {
    if (!deleteConfirmEmp || !adminPassword) return;

    // 2. 자가 삭제 및 소유자 삭제 보호
    if (deleteConfirmEmp.uid === userData?.uid) {
      alert("본인의 계정은 삭제할 수 없습니다.");
      setDeleteConfirmEmp(null);
      return;
    }
    if (deleteConfirmEmp.uid === companyData?.adminUid) {
      alert("회사 대표 가입자(SUPER_ADMIN)의 데이터는 삭제할 수 없습니다.");
      setDeleteConfirmEmp(null);
      return;
    }

    setIsProcessing(true);
    
    try {
      // 0. Verify Admin Password (Re-auth)
      try {
        const administrator = auth.currentUser;
        if (!administrator?.email) throw new Error('관리자 인증 상태를 확인해 주세요.');
        await reauthenticateWithCredential(administrator, EmailAuthProvider.credential(administrator.email, adminPassword));
        await administrator.getIdToken(true);
      } catch {
        throw new Error('비밀번호가 일치하지 않습니다.');
      }

      const emp = deleteConfirmEmp;
      await httpsCallable(functions, 'accountSecurity')({ action: 'deleteMember', uid: emp.uid, deleteRecords: true });
      alert(`[삭제 완료] ${emp.name}님의 모든 정보가 삭제되었습니다.`);
      setDeleteConfirmEmp(null);
      setAdminPassword('');
    } catch (e) {
      alert('삭제 중 오류 발생: ' + (e as Error).message);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleInitializePassword = async (emp: Employee) => {
    if (!window.confirm(`${emp.name}님의 임시 비밀번호를 새로 발급하시겠습니까?\n(실제 로그인 비밀번호가 강제 변경됩니다.)`)) return;
    
    try {
      const confirmationPassword = window.prompt('보안 확인을 위해 관리자 비밀번호를 입력해 주세요.');
      if (!confirmationPassword || !auth.currentUser?.email) return;
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, confirmationPassword));
      await auth.currentUser.getIdToken(true);
      const randomBytes = crypto.getRandomValues(new Uint8Array(18));
      const temporaryPassword = btoa(String.fromCharCode(...randomBytes))
        .replace(/\+/g, '-').replace(/\//g, '_');
      // 1. Firebase Cloud Function을 통해 실제 Auth 비밀번호 변경 시도
      const adminResetPassword = httpsCallable<{ uid: string; password: string }, { success: boolean; message?: string }>(functions, 'adminResetPassword');
      const result = await adminResetPassword({ uid: emp.uid, password: temporaryPassword });

      if (!result.data.success) {
        throw new Error(result.data.message || '비밀번호 초기화 중 오류가 발생했습니다.');
      }

      alert(`임시 비밀번호: ${temporaryPassword}\n직원에게 안전한 수단으로 전달하세요. 최초 로그인 시 변경해야 합니다.`);
    } catch (e) {
      console.error('Password reset failed:', e);
      let errorMsg = getErrorMessage(e);
      const errorCode = getErrorCode(e);
      
      // 사용자에게 친숙한 에러 메시지 처리
      if (errorCode === 'permission-denied') {
        errorMsg = '관리자 권한이 없습니다.';
      } else if (errorCode === 'unauthenticated') {
        errorMsg = '다시 로그인해 주세요.';
      }
      
      alert(`[오류] 비밀번호 초기화 실패\n원인: ${errorMsg}`);
    }
  };

  return (
    <div className="personnel-screen">
      <div className="personnel-content">
        
        {/* Header */}
        <div className="personnel-heading">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="personnel-heading-icon">
                <Users className="w-6 h-6" />
              </div>
              <PageTitle className="wf-title">전체 구성원 관리</PageTitle>
            </div>
            <p className="personnel-description">직원의 근태 조회, 퇴사 처리 및 보안 설정을 통합 관리합니다.</p>
          </div>

          <div className="personnel-heading-tools">
            {loading && (
              <div className="personnel-loading">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-xs font-black uppercase tracking-tighter">불러오는 중</span>
              </div>
            )}
            <div className="personnel-search">
            <Search className="personnel-search-icon" />
            <Input
              type="text" 
              placeholder="이름 또는 로그인 ID(이메일)로 검색..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="wf-input" aria-label="직원 이름 또는 로그인 ID 검색"
            />
          </div>
        </div>
        </div>

        {/* Filters */}
        <Panel className="wf-panel personnel-filters">
          <div className="personnel-filter">
            <div className="personnel-filter-icon"><Building className="w-5 h-5" /></div>
            <Select
              value={selectedDivision}
              onChange={(e) => { setSelectedDivision(e.target.value); setSelectedTeam('ALL'); }}
              className="wf-input" aria-label="본부 필터"
            >
              <option value="ALL">전체 본부</option>
              {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </div>

          <div className="personnel-filter">
            <div className="personnel-filter-icon"><Filter className="w-5 h-5" /></div>
            <Select
              value={selectedTeam}
              onChange={(e) => setSelectedTeam(e.target.value)}
              disabled={selectedDivision === 'ALL'}
              className="wf-input" aria-label="팀 필터"
            >
              <option value="ALL">본부 내 전체 팀</option>
              {teams.filter(t => t.divisionId === selectedDivision).map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </Select>
          </div>

          <div className="personnel-total">
             <span className="text-[10px] font-black uppercase tracking-widest opacity-70">조회된 구성원</span>
             <span className="text-2xl font-black">{filteredEmployees.length} 명</span>
          </div>
        </Panel>

        {/* List Section - Responsive Container */}
        <div className="space-y-4">
          
          {/* Desktop Table: Hidden on small screens */}
          <Panel className="wf-panel personnel-desktop">
            <div className="personnel-table-scroll">
              <table className="personnel-table">
                <thead>
                  <tr className="bg-slate-50/50 border-b border-slate-200/40">
                    <th className="px-8 py-5 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">직원 정보 / 소속</th>
                    <th className="px-8 py-5 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">직책 / 입사일</th>
                    <th className="px-8 py-5 text-center text-[10px] font-black text-slate-400 uppercase tracking-widest">계정 상태</th>
                    <th className="px-8 py-5 text-right text-[10px] font-black text-slate-400 uppercase tracking-widest">관리</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredEmployees.map(emp => {
                    const div = divisions.find(d => d.id === emp.divisionId)?.name || '기타';
                    const team = teams.find(t => t.id === emp.teamId)?.name || '팀 없음';
                    const isResigned = emp.status === 'RESIGNED';

                    return (
                      <tr key={emp.uid} className={`group hover:bg-indigo-50/30 transition-all ${isResigned ? 'opacity-60' : ''}`}>
                        <td className="px-8 py-6">
                          <div className="personnel-person" onClick={() => handleOpenDetail(emp)}>
                            <div className={`personnel-avatar ${isResigned ? 'bg-slate-200 text-slate-400' : 'bg-indigo-600 text-white shadow-indigo-100'}`}>
                              {emp.name[0]}
                            </div>
                            <div className="min-w-0">
                              <div className="text-md font-black tracking-tight text-slate-800">{emp.name}</div>
                              <div 
                                onClick={(e) => handleCopyEmail(emp.email, e)}
                                className="inline-flex items-center gap-1.5 mt-0.5 text-xs text-slate-500 font-bold hover:text-indigo-600 transition-colors group/copy cursor-pointer py-0.5"
                                title="클릭하여 로그인 ID 복사"
                              >
                                <Mail className="w-3.5 h-3.5 text-slate-400 group-hover/copy:text-indigo-500 shrink-0" />
                                <span className="font-mono text-slate-600 group-hover/copy:text-indigo-600">{emp.email}</span>
                                {copiedEmail === emp.email ? (
                                  <span className="text-[10px] text-emerald-600 font-bold flex items-center gap-0.5"><Check className="w-3 h-3" /> 복사됨</span>
                                ) : (
                                  <Copy className="w-3 h-3 text-slate-300 opacity-0 group-hover/copy:opacity-100 transition-opacity" />
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-[9px] font-black text-indigo-500 uppercase tracking-tighter bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100 whitespace-nowrap">{div}</span>
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200 whitespace-nowrap">{team}</span>
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-8 py-6">
                          <div className="text-sm font-black text-slate-700">{getRoleDisplayName({ ...emp, companyId: userData?.companyId || '' }, companyData ?? undefined)}</div>
                          <div className="text-[10px] text-slate-400 font-bold mt-1 flex items-center gap-1">
                            <Calendar className="w-3 h-3" /> {emp.joinDate || '-'} 입사
                          </div>
                        </td>
                        <td className="px-8 py-6">
                          <div className="flex justify-center">
                            <span className={`px-3 py-1 text-[10px] font-black rounded-full border ${
                              isResigned ? 'bg-rose-50 text-rose-500 border-rose-100' : 'bg-emerald-50 text-emerald-500 border-emerald-100'
                            }`}>
                              {isResigned ? '퇴사' : '재직 중'}
                            </span>
                          </div>
                        </td>
                        <td className="px-8 py-6 relative">
                          <div className="flex items-center justify-end gap-3">
                            <Button
                              onClick={() => handleOpenDetail(emp)}
                              className="wf-btn personnel-detail-button"
                            >
                              상세보기
                            </Button>
                            <Button
                              onClick={(e) => { e.stopPropagation(); setActiveMenuId(activeMenuId === emp.uid ? null : emp.uid); }}
                              aria-label={`${emp.name} 관리 메뉴`}
                              className={`wf-btn personnel-menu-toggle ${activeMenuId === emp.uid ? 'bg-indigo-600 text-white' : 'hover:bg-slate-100 text-slate-400'}`}
                            >
                              <MoreVertical className="w-4 h-4" />
                            </Button>
                            
                            {/* Contextual Menu */}
                            {activeMenuId === emp.uid && (
                              <div className="personnel-context-menu">
                                <button onClick={() => handleInitializePassword(emp)} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 text-slate-600 text-[11px] font-bold rounded-xl transition-colors">
                                  <Key className="w-3.5 h-3.5 text-indigo-500" /> 비밀번호 초기화
                                </button>
                                <button onClick={() => handleToggleStatus(emp, isResigned ? 'ACTIVE' : 'RESIGNED')} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 text-slate-600 text-[11px] font-bold rounded-xl transition-colors">
                                  {isResigned ? <UserCheck className="w-3.5 h-3.5 text-emerald-500" /> : <UserX className="w-3.5 h-3.5 text-amber-500" />}
                                  {isResigned ? '정지 해제' : '퇴사(정지) 처리'}
                                </button>
                                <div className="h-px bg-slate-50 my-1"></div>
                                <button onClick={() => setDeleteConfirmEmp(emp)} className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-rose-50 text-rose-600 text-[11px] font-bold rounded-xl transition-colors">
                                  <Trash2 className="w-3.5 h-3.5" /> 데이터 영구 삭제
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          {/* Mobile Card View: Visible on small screens */}
          <div className="personnel-cards">
            {filteredEmployees.map(emp => {
              const div = divisions.find(d => d.id === emp.divisionId)?.name || '기타';
              const team = teams.find(t => t.id === emp.teamId)?.name || '팀 없음';
              const isResigned = emp.status === 'RESIGNED';
              
              return (
                <Panel key={emp.uid} className="wf-panel personnel-card">
                  {isResigned && <div className="absolute top-0 right-0 w-20 h-20 bg-rose-500/10 rounded-bl-full flex items-start justify-end p-2"><UserX className="w-4 h-4 text-rose-400" /></div>}
                  
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-4">
                      <div className={`personnel-avatar ${isResigned ? 'bg-slate-200 text-slate-400' : 'bg-indigo-600 text-white shadow-lg shadow-indigo-100'}`}>
                        {emp.name[0]}
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-lg font-black text-slate-800">{emp.name}</h3>
                        <div 
                          onClick={(e) => handleCopyEmail(emp.email, e)}
                          className="flex items-center gap-1.5 text-xs text-slate-600 font-bold hover:text-indigo-600 transition-colors mt-0.5 cursor-pointer"
                          title="클릭하여 로그인 ID 복사"
                        >
                          <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span className="font-mono truncate">{emp.email}</span>
                          {copiedEmail === emp.email && <Check className="w-3 h-3 text-emerald-500 shrink-0" />}
                        </div>
                        <p className="text-[11px] font-bold text-slate-400 mt-0.5">{getRoleDisplayName({ ...emp, companyId: userData?.companyId || '' }, companyData ?? undefined)}</p>
                      </div>
                    </div>
                    <Button
                      onClick={(event) => { event.stopPropagation(); setActiveMenuId(activeMenuId === emp.uid ? null : emp.uid); }}
                      className="wf-btn personnel-menu-toggle" aria-label={`${emp.name} 관리 메뉴`}
                    >
                      <MoreVertical className="w-5 h-5" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-[10px] font-black uppercase tracking-wider">
                     <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <span className="text-slate-400 block mb-1">본부 / 팀</span>
                        <span className="text-indigo-600">{div} <span className="text-slate-300">/</span> {team}</span>
                     </div>
                     <div className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <span className="text-slate-400 block mb-1">상태</span>
                        <span className={isResigned ? 'text-rose-500' : 'text-emerald-500'}>{isResigned ? '퇴사' : '재직'}</span>
                     </div>
                  </div>

                  <Button
                    onClick={() => handleOpenDetail(emp)}
                    className="wf-btn personnel-card-detail"
                  >
                    상세 정보 및 인사 수정
                  </Button>

                  {/* Mobile Context Menu */}
                  {activeMenuId === emp.uid && (
                    <div className="personnel-card-menu">
                       <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest mb-4 border-b border-slate-100 pb-2">{emp.name} 관리</h4>
                       <button onClick={() => handleInitializePassword(emp)} className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl text-xs font-black text-slate-700 active:bg-indigo-50">
                          <Key className="w-5 h-5 text-indigo-500" /> 임시 비밀번호 발급
                       </button>
                       <button onClick={() => handleToggleStatus(emp, isResigned ? 'ACTIVE' : 'RESIGNED')} className="flex items-center gap-4 p-4 bg-slate-50 rounded-2xl text-xs font-black text-slate-700 active:bg-amber-50">
                          {isResigned ? <UserCheck className="w-5 h-5 text-emerald-500" /> : <UserX className="w-5 h-5 text-amber-500" />} {isResigned ? '정지 해제' : '퇴사(정지) 처리'}
                       </button>
                       <button onClick={() => setDeleteConfirmEmp(emp)} className="flex items-center gap-4 p-4 bg-rose-50 rounded-2xl text-xs font-black text-rose-600 active:bg-rose-100">
                          <Trash2 className="w-5 h-5" /> 데이터 영구 삭제
                       </button>
                       <button onClick={() => setActiveMenuId(null)} className="mt-4 p-4 text-slate-400 font-bold text-xs uppercase tracking-widest">창 닫기</button>
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>
        </div>
      </div>

      {selectedEmpRecords && (
        <div className="personnel-overlay" role="dialog" aria-modal="true" aria-labelledby="personnel-detail-title">
          <div className="personnel-modal">
            <div className="personnel-modal-head">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                   <div className="inline-flex items-center px-4 py-1.5 rounded-full bg-indigo-50 border border-indigo-100 text-[10px] font-black text-indigo-600 uppercase tracking-widest">인사 정보</div>
                   {selectedEmpRecords.emp.status === 'RESIGNED' && <span className="px-3 py-1 bg-rose-50 text-rose-500 text-[10px] font-black rounded-full border border-rose-100 uppercase tracking-widest">퇴사</span>}
                </div>
                <h2 className="personnel-modal-title" id="personnel-detail-title">{selectedEmpRecords.emp.name}님의 상세 정보</h2>
                <div 
                  onClick={() => handleCopyEmail(selectedEmpRecords.emp.email)}
                  className="inline-flex items-center gap-2 px-3 py-1.5 bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 rounded-xl text-xs font-bold text-slate-700 transition-colors cursor-pointer border border-slate-200 w-fit"
                  title="클릭하여 로그인 ID 복사"
                >
                  <Mail className="w-3.5 h-3.5 text-slate-400" />
                  <span className="text-slate-400 font-medium">로그인 ID:</span>
                  <span className="font-mono font-black">{selectedEmpRecords.emp.email}</span>
                  {copiedEmail === selectedEmpRecords.emp.email ? (
                    <span className="text-[10px] text-emerald-600 font-bold flex items-center gap-1 ml-1"><Check className="w-3 h-3" /> 복사됨</span>
                  ) : (
                    <Copy className="w-3 h-3 text-slate-400 ml-1" />
                  )}
                </div>
              </div>
              
              {/* Leave Dashboard Widget */}
              <div className="personnel-leave-summary">
                 {(() => {
                   const baseLeave = selectedEmpRecords.emp.joinDate ? calculateLeaveEntitlement(new Date(selectedEmpRecords.emp.joinDate)) : 0;
                   const totalLeave = baseLeave + (selectedEmpRecords.emp.additionalLeave || 0);
                   const usedLeave = selectedEmpRecords.leaves
                     .filter(req => req.status === 'APPROVED' && (req.type === 'annual' || req.type === 'half'))
                     .reduce((sum, req) => sum + (req.requestDays || 0), 0);
                   const remainingLeave = totalLeave - usedLeave;

                   return (
                     <>
                       <div className="flex flex-col items-center justify-center px-4 py-2 bg-white rounded-xl shadow-sm border border-slate-50 min-w-[70px]">
                         <span className="text-[9px] font-black text-slate-400">총 발생</span>
                         <span className="text-lg font-black text-slate-700">{totalLeave}</span>
                       </div>
                       <div className="flex flex-col items-center justify-center px-4 py-2 bg-white rounded-xl shadow-sm border border-slate-50 min-w-[70px]">
                         <span className="text-[9px] font-black text-slate-400">사용</span>
                         <span className="text-lg font-black text-rose-500">{usedLeave}</span>
                       </div>
                       <div className="flex flex-col items-center justify-center px-4 py-2 bg-indigo-600 rounded-xl shadow-md min-w-[70px]">
                         <span className="text-[9px] font-black text-indigo-200">잔여</span>
                         <span className="text-lg font-black text-white">{remainingLeave}</span>
                       </div>
                     </>
                   );
                 })()}
              </div>

              <Button onClick={() => setSelectedEmpRecords(null)} className="wf-btn personnel-modal-close" aria-label="인사 상세 닫기"><X className="w-6 h-6" /></Button>
            </div>

            <div className="personnel-modal-body">
              <div className="space-y-8 animate-in slide-in-from-bottom-4 duration-300">
                  <div className="personnel-form-grid">
                    <div className="space-y-2">
                        <label htmlFor="personnel-rrn" className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">주민등록번호</label>
                        <Input
                          type="text"
                          id="personnel-rrn"
                          value={editingInfo.rrn}
                          onChange={(e) => setEditingInfo({...editingInfo, rrn: e.target.value})}
                          disabled={!isAdmin}
                          placeholder="예: 660101-1****** (뒤 6자리 마스킹 가능)"
                          className="wf-input"
                        />
                        <p className="text-xs leading-relaxed text-slate-500">국민연금 연령 판단에는 앞 6자리와 뒤 첫 숫자 1자리가 필요합니다. 나머지 6자리는 가려도 됩니다. 정보가 부족하면 만 60세 미만으로 계산합니다.</p>
                    </div>
                    <div className="space-y-2">
                        <label htmlFor="personnel-personalEmail" className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">개인 이메일</label>
                        <Input
                          type="email"
                          id="personnel-personalEmail"
                          value={editingInfo.personalEmail}
                          onChange={(e) => setEditingInfo({...editingInfo, personalEmail: e.target.value})}
                          disabled={!isAdmin}
                          placeholder="personal@email.com"
                          className="wf-input"
                        />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                        <label htmlFor="personnel-phone" className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">비상 연락처 (전화번호)</label>
                        <Input
                          type="text"
                          id="personnel-phone"
                          value={editingInfo.phone}
                          onChange={(e) => setEditingInfo({...editingInfo, phone: e.target.value})}
                          disabled={!isAdmin}
                          placeholder="010-0000-0000"
                          className="wf-input"
                        />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                        <label htmlFor="personnel-address" className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">상세 주소</label>
                        <Textarea
                          rows={2}
                          id="personnel-address"
                          value={editingInfo.address}
                          onChange={(e) => setEditingInfo({...editingInfo, address: e.target.value})}
                          disabled={!isAdmin}
                          placeholder="상세 주소를 입력하세요"
                          className="wf-input"
                        />
                    </div>
                    {isAdmin && (
                      <div className="space-y-2 md:col-span-2">
                        <label htmlFor="personnel-additionalLeave" className="text-[10px] font-black text-indigo-500 uppercase tracking-widest ml-1">추가 연차 부여 (일수)</label>
                        <div className="personnel-leave-addition">
                          <Input
                            type="number"
                            id="personnel-additionalLeave"
                          value={editingInfo.additionalLeave}
                            onChange={(e) => setEditingInfo({...editingInfo, additionalLeave: Number(e.target.value)})}
                            className="wf-input"
                            min="0"
                            step="0.5"
                          />
                          <p className="text-xs font-bold text-slate-500 flex-1">
                            근속연수에 따른 기본 연차 외에, <br/>포상 휴가 등 추가 연차를 부여할 수 있습니다.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  {isAdmin && (
                    <Button
                      onClick={handleSavePersonalInfo}
                      disabled={isSaving}
                      className="wf-btn wf-btn-primary personnel-save"
                    >
                      {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <ShieldAlert className="w-5 h-5" />}
                      인사 정보 저장하기
                    </Button>
                  )}
                  
                  {!isAdmin && (
                    <div className="personnel-readonly">
                      <ShieldAlert className="w-5 h-5 text-amber-500" />
                        <p className="text-xs font-bold text-amber-600">이 정보는 회사 관리자(SUPER_ADMIN 또는 ADMIN)만 수정할 수 있습니다.</p>
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmEmp && (
        <div className="personnel-overlay personnel-delete-overlay" role="dialog" aria-modal="true" aria-labelledby="personnel-delete-title">
          <div className="personnel-delete-modal">
             <div className="personnel-delete-icon">
                <ShieldAlert className="w-10 h-10" />
             </div>
             
             <div className="space-y-2">
                <h3 className="personnel-modal-title" id="personnel-delete-title">데이터 영구 삭제</h3>
                <p className="text-slate-500 font-medium text-sm leading-relaxed">
                  <span className="text-rose-600 font-black">{deleteConfirmEmp.name}</span>님의 모든 데이터(출퇴근, 휴가, 지출결의)가 <span className="underline decoration-rose-200 decoration-w-2">영구적으로 삭제</span>되며 복구할 수 없습니다.
                </p>
             </div>

             <div className="space-y-4">
                <div className="relative">
                  <Key className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <Input
                    type="password"
                    placeholder="관리자 비밀번호를 입력하세요"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    className="wf-input personnel-delete-password" aria-label="삭제 확인 관리자 비밀번호"
                  />
                </div>
                
                <div className="flex gap-3">
                   <Button
                    onClick={() => { setDeleteConfirmEmp(null); setAdminPassword(''); }}
                    className="wf-btn"
                   >
                     취소
                   </Button>
                   <Button
                    onClick={handleDeleteAll}
                    disabled={!adminPassword || isProcessing}
                    className="wf-btn wf-btn-danger"
                   >
                     {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                     데이터 삭제 승인
                   </Button>
                </div>
             </div>
          </div>
        </div>
      )}

    </div>
  );
};
