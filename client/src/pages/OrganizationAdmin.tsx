import React, { useState, useEffect } from 'react';
import { PASSWORD_LENGTH_LABEL } from '../../../functions/password-policy.mjs';
import { 
  PlusCircle, Users, UserPlus, Loader2,
  Trash2, Building, X, Search, ChevronRight, Briefcase, ShieldCheck, History, Filter
} from 'lucide-react';
import { 
  collection, onSnapshot, addDoc, doc, setDoc, deleteDoc, updateDoc,
  query, where, getDocs, writeBatch
} from 'firebase/firestore';
import { useNavigate } from 'react-router-dom';
import { auth, db, functions } from '../firebase';
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { useAuthStore } from '../store/authStore';
import { getEmployeeLoginDomain, getEmployeeLoginEmail } from '../utils/employeeLogin';
import { getRoleDisplayName } from '../utils/roleDisplay';
import { getErrorMessage } from '../utils/errors';
import './OrganizationAdmin.css';
import {ErpEmployeeAccess} from '../components/ErpEmployeeAccess';

interface Division {
  id: string;
  name: string;
  headId: string;
}

interface Team {
  id: string;
  divisionId: string;
  name: string;
  leaderId: string;
}

interface Employee {
  erpAccess?: string;
  status?: string;
  uid: string;
  name: string;
  email: string;
  teamId?: string;
  role: string;
  teamHistory: { teamId: string; teamName: string; joinedAt: string; leftAt?: string; role?: string }[];
  joinDate?: string;
}

interface AuditLog {
  id: string;
  timestamp: string;
  actionType: string;
  performedBy: string;
  targetId: string;
  targetName: string;
  details: string;
}

export const OrganizationAdmin: React.FC = () => {
  const { userData, companyData } = useAuthStore();
  const navigate = useNavigate();

  const [divisions, setDivisions] = useState<Division[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedDivision, setSelectedDivision] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  
  // 모달 제어용
  const [showEmployeeModal, setShowEmployeeModal] = useState(false);
  const [showDivisionModal, setShowDivisionModal] = useState(false);
  const [showTeamModal, setShowTeamModal] = useState(false);

  // 입력 필드용
  const [newDivName, setNewDivName] = useState('');
  const [newTeamDivId, setNewTeamDivId] = useState('');
  const [newTeamName, setNewTeamName] = useState('');
  const [newEmp, setNewEmp] = useState({ name: '', email: '', teamId: '', joinDate: new Date().toISOString().split('T')[0] });
  const employeeLoginPreview = (() => {
    try {
      return newEmp.email.trim() ? getEmployeeLoginEmail(newEmp.email, companyData) : `직원ID@${getEmployeeLoginDomain(companyData)}`;
    } catch { return ''; }
  })();
  const [isSubmittingEmployee, setIsSubmittingEmployee] = useState(false);

  // 정보 수정용 (임명/이동)
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);

  // 이력 조회 및 삭제용
  const [selectedEmpForLogs, setSelectedEmpForLogs] = useState<Employee | null>(null);
  const [showLogDeleteConfirm, setShowLogDeleteConfirm] = useState(false);
  const [deleteLogsPassword, setDeleteLogsPassword] = useState('');
  const [isProcessingLogs, setIsProcessingLogs] = useState(false);
  const [logSearchResults, setLogSearchResults] = useState<AuditLog[] | null>(null);

  // 부관리자(SUB_ADMIN) 접근 차단 리다이렉트
  useEffect(() => {
    if (userData && userData.role === 'SUB_ADMIN') {
      alert('조직 관리 메뉴에 대한 접근 권한이 없습니다.');
      navigate('/attendance');
    }
  }, [userData, navigate]);

  // Firestore 데이터 실시간 구독 (companyId 기반 격리)
  useEffect(() => {
    if (!userData?.companyId) return;
    const companyId = userData.companyId;
    setLoading(true);

    const handleError = (error: unknown) => {
      console.error("Firestore Subscription Error:", error);
      setLoading(false);
    };

    const unsubDivs = onSnapshot(query(collection(db, 'divisions'), where('companyId', '==', companyId)), (snap) => {
      setDivisions(snap.docs.map(d => ({ id: d.id, ...d.data() } as Division)));
      setLoading(false);
    }, handleError);

    const unsubTeams = onSnapshot(query(collection(db, 'teams'), where('companyId', '==', companyId)), (snap) => {
      setTeams(snap.docs.map(d => ({ id: d.id, ...d.data() } as Team)));
    }, handleError);

    const unsubUsers = onSnapshot(query(collection(db, 'UserProfile'), where('companyId', '==', companyId)), (snap) => {
      setEmployees(snap.docs.map(d => ({ uid: d.id, ...d.data() } as Employee)));
      setLoading(false);
    }, handleError);

    const unsubLogs = onSnapshot(query(collection(db, 'AuditLogs'), where('companyId', '==', companyId)), (snap) => {
      const logs = snap.docs.map(d => ({ id: d.id, ...d.data() } as AuditLog));
      setAuditLogs(logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
    }, handleError);

    const timeoutId = setTimeout(() => {
      setLoading(false);
    }, 3000);

    return () => {
      unsubDivs(); unsubTeams(); unsubUsers(); unsubLogs();
      clearTimeout(timeoutId);
    };
  }, [userData?.companyId]);

  const logAction = async (type: string, targetId: string, targetName: string, details: string) => {
    try {
      await addDoc(collection(db, 'AuditLogs'), {
        timestamp: new Date().toISOString(),
        actionType: type,
        performedBy: userData?.name || '시스템',
        targetId, targetName, details,
        companyId: userData?.companyId || ''
      });
    } catch (err) {
      console.error("Log failed:", err);
    }
  };

  // 중복 제거된 직원 목록 (이메일 기준, 가장 높은 권한 우선)
  const dedupedEmployees = React.useMemo(() => {
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
    return Object.values(grouped).sort((a, b) => a.name.localeCompare(b.name));
  }, [employees]);

  const unassignedEmployees = dedupedEmployees.filter(emp => !emp.teamId || emp.teamId === '');

  const filteredTeams = selectedDivision
    ? teams.filter((team) => team.divisionId === selectedDivision)
    : teams;

  const handleCreateDivision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDivName.trim()) return;
    try {
      const docRef = await addDoc(collection(db, 'divisions'), { name: newDivName, headId: '', companyId: userData?.companyId || '' });
      await logAction('CREATE_DIVISION', docRef.id, newDivName, '새 본부 생성');
      setNewDivName(''); setShowDivisionModal(false);
    } catch (err) {
      alert("본부 생성 실패: " + (err as Error).message);
    }
  };

  const handleCreateTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTeamName.trim() || !newTeamDivId) return;
    try {
      const docRef = await addDoc(collection(db, 'teams'), { divisionId: newTeamDivId, name: newTeamName, leaderId: '', companyId: userData?.companyId || '' });
      const divName = divisions.find(d => d.id === newTeamDivId)?.name || '알 수 없음';
      await logAction('CREATE_TEAM', docRef.id, newTeamName, `${divName} 소속 팀 생성`);
      setNewTeamName(''); setNewTeamDivId(''); setShowTeamModal(false);
    } catch (err) {
      alert("팀 생성 실패: " + (err as Error).message);
    }
  };

  const handleCreateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmittingEmployee(true);
      const finalEmail = getEmployeeLoginEmail(newEmp.email, companyData);

      // 1. 중복 아이디 체크 (UX 차원)
      const q = query(collection(db, 'UserProfile'), where('email', '==', finalEmail), where('companyId', '==', userData?.companyId || ''));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        alert(`[중복 오류] '${finalEmail}' 아이디는 이미 등록되어 있습니다.\n다른 아이디를 사용해 주세요.`);
        return;
      }

      // 2. Cloud Function 호출 (계정 + 프로필 동시 생성)
      const createMemberFn = httpsCallable(functions, 'adminCreateMember');
      const result = await createMemberFn({
        name: newEmp.name,
        email: finalEmail,
        teamId: newEmp.teamId,
        joinDate: newEmp.joinDate
      });

      const data = result.data as { success: boolean, uid: string, message: string };
      const newUid = data.uid;
      
      // 3. 로그 기록 및 알림
      await logAction('CREATE_MEMBER', newUid, newEmp.name, `직원 등록 (${finalEmail}) / 최초 로그인 시 비밀번호 변경 필요`);
      alert(`[안내] 신규 직원 계정이 생성되었습니다.\n아이디: ${finalEmail}\n임시 비밀번호: !123456\n\n* 해당 직원은 첫 로그인 시 ${PASSWORD_LENGTH_LABEL}의 새 비밀번호로 변경해야 합니다.`);
      
      setShowEmployeeModal(false);
      setNewEmp({ name: '', email: '', teamId: '', joinDate: new Date().toISOString().split('T')[0] });
    } catch (err) {
      console.error("Employee Registration Error:", err);
      alert("직원 등록 실패: " + getErrorMessage(err, String(err)));
    } finally {
      setIsSubmittingEmployee(false);
    }
  };

  const handleDeleteEmployee = async (uid: string, name: string) => {
    if (!window.confirm(`'${name}' 직원을 삭제하시겠습니까?`)) return;
    try {
      const confirmationPassword = window.prompt('보안 확인을 위해 관리자 비밀번호를 입력해 주세요.');
      if (!confirmationPassword || !auth.currentUser?.email) return;
      await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, confirmationPassword));
      await auth.currentUser.getIdToken(true);
      await httpsCallable(functions, 'accountSecurity')({ action: 'deleteMember', uid });
      await logAction('DELETE_MEMBER', uid, name, '직원 삭제(영구)');
    } catch (err) {
      alert("삭제 실패: " + (err as Error).message);
    }
  };

  const handleUpdateRole = async (emp: Employee, newTeamId: string, newRole: string) => {
    try {
      const originalEmp = employees.find(e => e.uid === emp.uid);
      
      // 회사 대표 가입자(SUPER_ADMIN) 권한 강등 보호
      if (emp.uid === companyData?.adminUid && newRole !== 'ADMIN') {
        alert("회사 대표 가입자(SUPER_ADMIN)의 권한은 변경할 수 없습니다.");
        return;
      }

      // 본인 권한 변경 시도 차단
      if (emp.uid === userData?.uid && originalEmp && originalEmp.role !== newRole) {
        alert("운영 실수 방지를 위해 본인의 권한은 직접 변경할 수 없습니다.");
        return;
      }

      const userRef = doc(db, 'UserProfile', emp.uid);
      const selectedTeam = teams.find(t => t.id === newTeamId);
      const divisionId = selectedTeam?.divisionId || '';
      const teamName = selectedTeam?.name || '미배정';
      
      const newHistory = [...(emp.teamHistory || []), {
        teamId: newTeamId, teamName, joinedAt: new Date().toISOString(), role: newRole
      }];

      await updateDoc(userRef, {
        teamId: newTeamId,
        divisionId,
        role: newRole,
        teamHistory: newHistory
      });
      
      const displayedRole = getRoleDisplayName({ ...emp, role: newRole, companyId: userData?.companyId || '' }, companyData);
      await logAction('UPDATE_MEMBER', emp.uid, emp.name, `${teamName} 로 이동 / 역할: ${displayedRole}`);
      alert(`${emp.name}님의 소속/역할이 ${displayedRole} 등급으로 변경되었습니다.`);
      setShowEditModal(false);
      setEditingEmployee(null);
    } catch (err) {
      alert("변경 실패: " + (err as Error).message);
    }
  };

  const handleAppointHead = async (divisionId: string, userId: string) => {
    try {
      await setDoc(doc(db, 'divisions', divisionId), { headId: userId }, { merge: true });
      const empName = employees.find(e => e.uid === userId)?.name || '미임명';
      const divName = divisions.find(d => d.id === divisionId)?.name || '';
      await logAction('APPOINT_HEAD', divisionId, divName, `본부장 임명: ${empName}`);
      alert("본부장이 임명되었습니다.");
    } catch (err) {
      alert("임명 실패: " + (err as Error).message);
    }
  };

  const handleAppointLeader = async (teamId: string, userId: string) => {
    try {
      await setDoc(doc(db, 'teams', teamId), { leaderId: userId }, { merge: true });
      const empName = employees.find(e => e.uid === userId)?.name || '미임명';
      const teamName = teams.find(t => t.id === teamId)?.name || '';
      await logAction('APPOINT_LEADER', teamId, teamName, `팀장 임명: ${empName}`);
      alert("팀장이 임명되었습니다.");
    } catch (err) {
      alert("임명 실패: " + (err as Error).message);
    }
  };

  const handleDeleteDivision = async (id: string, name: string) => {
    const hasTeams = teams.some(t => t.divisionId === id);
    if (hasTeams) {
      alert("소속된 팀이 있는 본부는 삭제할 수 없습니다.");
      return;
    }
    if (!window.confirm(`'${name}' 본부를 삭제하시겠습니까?`)) return;
    try {
      await deleteDoc(doc(db, 'divisions', id));
      await logAction('DELETE_DIVISION', id, name, '본부 삭제');
    } catch (err) {
      alert("삭제 실패: " + (err as Error).message);
    }
  };

  const handleDeleteTeam = async (id: string, name: string) => {
    const hasEmployees = employees.some(e => e.teamId === id);
    if (hasEmployees) {
      alert("이 팀에 소속된 직원이 있습니다.");
      return;
    }
    if (!window.confirm(`'${name}' 팀을 삭제하시겠습니까?`)) return;
    try {
      await deleteDoc(doc(db, 'teams', id));
      await logAction('DELETE_TEAM', id, name, '팀 삭제');
    } catch (err) {
      alert("삭제 실패: " + (err as Error).message);
    }
  };

  const handleDeleteAllLogs = async () => {
    if (!deleteLogsPassword) return;
    setIsProcessingLogs(true);
    try {
      try {
        const administrator = auth.currentUser;
        if (!administrator?.email) throw new Error('관리자 인증 상태를 확인해 주세요.');
        await reauthenticateWithCredential(administrator, EmailAuthProvider.credential(administrator.email, deleteLogsPassword));
        await administrator.getIdToken(true);
      } catch {
        throw new Error('비밀번호가 일치하지 않습니다.');
      }

      const batch = writeBatch(db);
      const snap = await getDocs(query(collection(db, 'AuditLogs'), where('companyId', '==', userData?.companyId || '')));
      snap.forEach(d => batch.delete(d.ref));
      
      await batch.commit();
      alert('모든 조직 변경 이력이 삭제되었습니다.');
      setShowLogDeleteConfirm(false);
      setDeleteLogsPassword('');
    } catch (err) {
      alert('삭제 중 오류: ' + (err as Error).message);
    } finally {
      setIsProcessingLogs(false);
    }
  };

  const handleSearchLogs = () => {
    if (!searchQuery.trim()) {
      setLogSearchResults(null);
      return;
    }
    const filtered = auditLogs.filter(log => 
      log.targetName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.performedBy.toLowerCase().includes(searchQuery.toLowerCase())
    );
    setLogSearchResults(filtered);
  };

  const getEmployeesInTeam = (teamId: string) => {
    return dedupedEmployees.filter(emp => emp.teamId === teamId);
  }

  if (loading) {
    return (
      <div role="status" className="organization-screen organization-loading flex-1 flex items-center justify-center bg-slate-50 min-h-screen">
        <div className="flex flex-col items-center gap-6">
          <div className="w-16 h-16 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin"></div>
          <p className="text-slate-500 font-black tracking-tight text-lg">조직 정보를 불러오는 중입니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="organization-screen flex-1 p-4 md:p-10 bg-slate-50 min-h-screen">
      <div className="organization-content max-w-7xl mx-auto space-y-10">
        
        {/* Page Header */}
        <div className="organization-page-head flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="organization-title-icon p-2.5 bg-indigo-600 rounded-2xl text-white shadow-xl shadow-indigo-100">
                <Users className="w-6 h-6" />
              </div>
              <h1 className="text-3xl font-black text-slate-900 tracking-tight">조직관리</h1>
            </div>
            <p className="text-slate-500 font-medium">본부 및 팀의 구조를 설계, 구성원 권한 / 보안설정을 변경합니다.</p>
          </div>

          <div className="organization-header-actions flex items-center gap-3">
            <div className="organization-history-search flex items-center gap-2 relative group hidden xl:flex">
              <input 
                type="text" 
                placeholder="구성원 이름 검색..." 
                aria-label="구성원 변경 이력 검색"
                value={searchQuery}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSearchLogs(); }}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-64 pl-11 pr-5 py-3.5 bg-white border border-slate-200 rounded-2xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50/50 outline-none transition-all font-bold text-slate-700 premium-shadow"
              />
              <Search className="w-5 h-5 text-slate-300 absolute left-4 top-1/2 -translate-y-1/2 group-focus-within:text-indigo-500 transition-colors" />
              <button 
                onClick={handleSearchLogs}
                className="p-3.5 bg-white border-2 border-slate-100 text-indigo-600 rounded-2xl hover:border-indigo-500 hover:bg-indigo-50 transition-all shadow-sm flex items-center justify-center group/btn"
                title="해당 인원 이력 검색"
              >
                <History className="w-6 h-6 group-hover/btn:rotate-12 transition-transform" />
              </button>
            </div>
            <button 
              onClick={() => setShowEmployeeModal(true)}
              className="organization-primary flex items-center gap-2.5 px-6 py-4 bg-indigo-600 text-white font-black rounded-2xl shadow-xl shadow-indigo-100 hover:bg-indigo-700 transition-all active:scale-95 shrink-0"
            >
              <UserPlus className="w-5 h-5" />
              <span>직원 등록</span>
            </button>
          </div>
        </div>


        {/* 이력 검색 결과 섹션 */}
        {logSearchResults && (
          <div className="organization-history-panel bg-white rounded-[2.5rem] shadow-2xl border-2 border-indigo-100 overflow-hidden animate-in slide-in-from-top-4 duration-500">
            <div className="p-8 border-b border-slate-50 flex items-center justify-between bg-indigo-50/30">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-600 text-white rounded-xl">
                  <History className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-800 tracking-tight">"{searchQuery}" 이력 검색 결과</h2>
                  <p className="text-xs font-bold text-indigo-500 mt-0.5">총 {logSearchResults.length}건의 기록이 발견되었습니다.</p>
                </div>
              </div>
              <button 
                onClick={() => setLogSearchResults(null)}
                aria-label="이력 검색 결과 닫기"
                className="p-3 hover:bg-white rounded-2xl text-slate-400 hover:text-slate-900 transition-all"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-slate-50/50">
                    <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">일시</th>
                    <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">수행자</th>
                    <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">변경 분류</th>
                    <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest">대상 객체</th>
                    <th className="px-8 py-5 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">상세 변경 내용</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {logSearchResults.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50/80 transition-all">
                      <td className="px-8 py-6 text-[11px] font-bold text-slate-400">
                        {new Date(log.timestamp).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="px-8 py-6 text-sm font-black text-slate-700">{log.performedBy}</td>
                      <td className="px-8 py-6">
                        <span className={`px-3 py-1 rounded-full text-[10px] font-black tracking-widest uppercase border ${
                          log.actionType.includes('CREATE') ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                          log.actionType.includes('DELETE') ? 'bg-rose-50 text-rose-600 border-rose-100' :
                          'bg-indigo-50 text-indigo-600 border-indigo-100'
                        }`}>
                          {log.actionType}
                        </span>
                      </td>
                      <td className="px-8 py-6 text-sm font-bold text-slate-600">{log.targetName}</td>
                      <td className="px-8 py-6 text-right text-xs text-slate-500 font-medium">{log.details}</td>
                    </tr>
                  ))}
                  {logSearchResults.length === 0 && (
                    <tr><td colSpan={5} className="text-center py-24 text-slate-400 font-bold">검색 결과가 없습니다.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 조직 엔진 (Main Grid) */}
        <div className="organization-layout grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          <div className="organization-divisions lg:col-span-4 space-y-6">
            <div className="organization-panel bg-white rounded-[2.5rem] shadow-2xl border border-slate-100 overflow-hidden group">
              <div className="organization-panel-head p-8 border-b border-slate-50 flex items-center justify-between bg-slate-50/30">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 bg-white rounded-2xl shadow-sm text-indigo-600 border border-slate-100">
                    <Building className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-slate-800 tracking-tight">본부 구성</h2>
                    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest mt-0.5">{divisions.length}개 본부</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowDivisionModal(true)}
                  aria-label="본부 추가"
                  className="p-2.5 text-indigo-400 hover:text-indigo-600 hover:bg-white rounded-2xl transition-all shadow-sm border border-transparent hover:border-slate-100"
                >
                  <PlusCircle className="w-6 h-6" />
                </button>
              </div>
              
              <div className="organization-division-list p-4 space-y-3">
                <button type="button" className="organization-all-divisions" aria-pressed={!selectedDivision} onClick={() => setSelectedDivision(null)}>전체 본부 · {teams.length}개 팀</button>
                {divisions.map((div) => (
                  <div 
                    key={div.id}
                    onClick={() => setSelectedDivision(div.id)}
                    className={`organization-division ${selectedDivision === div.id ? 'is-selected' : ''} group/item p-4 rounded-[2rem] transition-all duration-500 cursor-pointer border-2 shadow-sm ${
                      selectedDivision === div.id 
                        ? 'bg-slate-900 border-slate-800 shadow-2xl shadow-indigo-100 -translate-y-1' 
                        : 'bg-white border-slate-50 hover:border-indigo-100 hover:bg-slate-50/50 hover:shadow-indigo-50/50'
                    }`}
                  >
                    <div className="flex flex-col gap-3">
                       <div className="flex justify-between items-center">
                         <div className="flex items-center gap-3">
                            <div className={`w-9 h-9 rounded-2xl flex items-center justify-center transition-colors shadow-sm ${
                              selectedDivision === div.id ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400 group-hover/item:bg-white'
                            }`}>
                              <Briefcase className="w-4.5 h-4.5" />
                            </div>
                            <button type="button" onClick={(event) => { event.stopPropagation(); setSelectedDivision(div.id); }} className={`organization-division-name text-base font-black tracking-tight ${selectedDivision === div.id ? 'text-white' : 'text-slate-700'}`}>
                               {div.name}
                            </button>
                         </div>
                         <button 
                            onClick={(e) => { e.stopPropagation(); handleDeleteDivision(div.id, div.name); }}
                            aria-label={`${div.name} 본부 삭제`}
                            className={`p-2 rounded-xl transition-all ${selectedDivision === div.id ? 'text-slate-500 hover:text-rose-400' : 'text-slate-200 hover:text-rose-500'}`}
                         >
                            <Trash2 className="w-4 h-4" />
                         </button>
                       </div>
                       
                       <div className={`flex items-center gap-2 p-2 rounded-2xl transition-colors border ${
                        selectedDivision === div.id ? 'bg-white/5 border-white/10' : 'bg-slate-50/50 border-slate-100'
                       }`}>
                          <ShieldCheck className={`w-3.5 h-3.5 ${selectedDivision === div.id ? 'text-indigo-400' : 'text-slate-300'}`} />
                          <span className={`text-[10px] font-black uppercase tracking-widest ${selectedDivision === div.id ? 'text-slate-500' : 'text-slate-400'}`}>본부장:</span>
                          <select 
                            aria-label={`${div.name} 본부장`}
                            className={`flex-1 text-xs font-black bg-transparent border-none focus:ring-0 p-0 appearance-none ${selectedDivision === div.id ? 'text-white' : 'text-indigo-600'}`}
                            value={div.headId || ''}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => handleAppointHead(div.id, e.target.value)}
                          >
                            <option value="">미임명</option>
                            {dedupedEmployees.map(emp => <option key={emp.uid} value={emp.uid}>{emp.name}</option>)}
                          </select>
                          <ChevronRight className={`w-3.5 h-3.5 transition-transform group-hover/item:translate-x-0.5 ${selectedDivision === div.id ? 'text-white' : 'text-slate-300'}`} />
                       </div>
                    </div>
                  </div>
                ))}
                {divisions.length === 0 && (
                   <div className="py-20 text-center border-2 border-dashed border-slate-100 rounded-[2.5rem] bg-slate-50/20">
                      <Building className="w-10 h-10 text-slate-100 mx-auto mb-3" />
                      <p className="text-xs font-black text-slate-300 uppercase tracking-widest">등록된 본부가 없습니다.</p>
                   </div>
                )}
              </div>
            </div>
          </div>


          {/* 팀 및 구성원 */}
          <div className="organization-teams lg:col-span-8 space-y-8">
            <div className="organization-panel organization-team-panel bg-white rounded-[2.5rem] shadow-2xl border border-slate-100 overflow-hidden min-h-[600px] relative">
              <div className="organization-panel-head p-8 border-b border-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-6 bg-slate-50/10">
                <div>
                   <h2 className="text-2xl font-black text-slate-800 tracking-tight">팀 관리 및 구성원</h2>
                   <p className="text-[10px] font-black text-indigo-500 uppercase tracking-[0.2em] mt-1">{filteredTeams.length}개 팀 · 팀장 임명과 구성원 권한 관리</p>
                </div>
                <button 
                  onClick={() => { if (selectedDivision) setNewTeamDivId(selectedDivision); setShowTeamModal(true); }}
                  className="organization-primary flex items-center justify-center gap-2.5 px-7 py-4 bg-slate-900 text-white font-black rounded-[1.5rem] shadow-xl hover:bg-indigo-600 transition-all active:scale-95 group/btn"
                >
                  <PlusCircle className="w-5 h-5 group-hover/btn:rotate-90 transition-transform" />
                  <span className="text-sm tracking-tight uppercase">팀 추가</span>
                </button>
              </div>

              <div className="organization-team-grid p-8 grid grid-cols-1 xl:grid-cols-2 gap-8 items-start">
                {unassignedEmployees.length > 0 && !selectedDivision && (
                  <div className="organization-unassigned xl:col-span-2 p-6 rounded-[2rem] border-2 border-amber-100 bg-amber-50/20 relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
                       <Users className="w-20 h-20 text-amber-900" />
                    </div>
                    <div className="flex items-center gap-3 mb-5">
                       <div className="w-10 h-10 rounded-2xl bg-amber-100 text-amber-600 flex items-center justify-center shadow-sm">
                          <Users className="w-5 h-5" />
                       </div>
                       <h4 className="text-xl font-black text-amber-900 italic">미배정 구성원</h4>
                    </div>
                    <div className="flex flex-wrap gap-3">
                       {unassignedEmployees.map(emp => (
                         <button type="button"
                           key={emp.uid} 
                           className="group/tag flex items-center gap-3 bg-white border border-amber-100 px-5 py-3 rounded-2xl shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all cursor-pointer" 
                           onClick={() => { setEditingEmployee(emp); setShowEditModal(true); }}
                         >
                           <span className="text-xs font-black text-slate-700">{emp.name}</span>
                           <ChevronRight className="w-3.5 h-3.5 text-amber-300 group-hover/tag:translate-x-0.5 transition-transform" />
                         </button>
                       ))}
                    </div>
                  </div>
                )}
                
                {filteredTeams.map((team) => (
                  <div key={team.id} className="organization-team-card p-1 rounded-[2.5rem] bg-slate-50/50 border border-slate-100 hover:shadow-2xl hover:shadow-indigo-50 transition-all group/team-card">
                    <div className="p-6">
                       <div className="flex justify-between items-start mb-6">
                         <div className="space-y-1.5">
                           <span className="inline-block text-[9px] font-black text-indigo-500 uppercase bg-white px-2 py-0.5 rounded-lg border border-slate-100 shadow-sm">
                              {divisions.find(d => d.id === team.divisionId)?.name || 'N/A'}
                           </span>
                           <h4 className="text-2xl font-black text-slate-900 tracking-tight">{team.name}</h4>
                         </div>
                         <button 
                           onClick={() => handleDeleteTeam(team.id, team.name)} 
                           aria-label={`${team.name} 팀 삭제`}
                           className="p-3 text-slate-300 hover:text-rose-500 hover:bg-white rounded-2xl transition-all shadow-sm border border-transparent hover:border-rose-50 border-dashed"
                         >
                            <Trash2 className="w-5 h-5" />
                         </button>
                       </div>
                       
                       <div className="space-y-5">
                          {/* 팀장 관리 */}
                          <div className="flex items-center justify-between p-4 bg-white rounded-2xl border border-slate-100 shadow-sm group/leader">
                             <div className="flex items-center gap-3">
                                <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shadow-inner">
                                   <ShieldCheck className="w-5 h-5" />
                                </div>
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">팀장</span>
                             </div>
                             <select 
                               aria-label={`${team.name} 팀장`}
                               className="text-xs font-black text-emerald-600 bg-transparent border-none focus:ring-0 p-0 text-right cursor-pointer" 
                               value={team.leaderId || ''} 
                               onChange={(e) => handleAppointLeader(team.id, e.target.value)}
                             >
                               <option value="">미지정</option>
                               {getEmployeesInTeam(team.id).map(emp => <option key={emp.uid} value={emp.uid}>{emp.name}</option>)}
                             </select>
                          </div>

                          {/* 구성원 리스트 */}
                          <div className="space-y-3">
                             <div className="flex items-center gap-2 px-1">
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">구성원</span>
                                <div className="h-px flex-1 bg-slate-100"></div>
                                <span className="text-[10px] font-black text-indigo-500 bg-white px-2 rounded-full border">{getEmployeesInTeam(team.id).length}</span>
                             </div>
                             
                             <div className="organization-members grid grid-cols-2 gap-2">
                               {getEmployeesInTeam(team.id).map(emp => (
                                 <div 
                                   key={emp.uid} 
                                   className="organization-member group/mem flex items-center justify-between bg-white border border-slate-100 px-4 py-3 rounded-2xl hover:border-indigo-200 transition-all cursor-pointer relative overflow-hidden"
                                   onClick={() => { setEditingEmployee(emp); setShowEditModal(true); }}
                                 >
                                   <div className="flex items-center gap-2 relative z-10">
                                      <div className={`w-1.5 h-1.5 rounded-full ${emp.role === 'ADMIN' ? 'bg-indigo-500' : emp.role === 'SUB_ADMIN' ? 'bg-emerald-500' : 'bg-slate-300'}`}></div>
                                      <div className="min-w-0"><button type="button" aria-label={`${emp.name} 정보 수정`} onClick={(event) => { event.stopPropagation(); setEditingEmployee(emp); setShowEditModal(true); }} className="text-[11px] font-black text-slate-700">{emp.name}</button><p className="text-[9px] font-bold text-slate-400">{getRoleDisplayName({ ...emp, companyId: userData?.companyId || '' }, companyData ?? undefined)}</p></div>
                                   </div>
                                   <div className="organization-member-actions flex items-center gap-1 opacity-0 group-hover/mem:opacity-100 transition-opacity relative z-10">
                                      <button type="button" aria-label={`${emp.name} 변경 이력`} onClick={(e) => { e.stopPropagation(); setSelectedEmpForLogs(emp); }}><History className="w-3.5 h-3.5 text-slate-300 hover:text-indigo-600 transition-colors" /></button>
                                      <button type="button" aria-label={`${emp.name} 직원 삭제`} onClick={(e) => { e.stopPropagation(); handleDeleteEmployee(emp.uid, emp.name); }}><X className="w-3.5 h-3.5 text-slate-300 hover:text-rose-500 transition-colors" /></button>
                                   </div>
                                   <div className="absolute inset-y-0 left-0 w-0 group-hover/mem:w-1 bg-indigo-500 transition-all"></div>
                                 </div>
                               ))}
                             </div>
                             
                             {getEmployeesInTeam(team.id).length === 0 && (
                                <div className="py-8 text-center border-2 border-dashed border-slate-100 rounded-3xl bg-slate-50/30">
                                   <p className="text-[10px] font-black text-slate-300 uppercase tracking-widest">배정된 구성원이 없습니다.</p>
                                </div>
                             )}
                          </div>
                       </div>
                    </div>
                  </div>
                ))}
                
                {filteredTeams.length === 0 && selectedDivision && (
                   <div className="xl:col-span-2 py-32 text-center">
                      <div className="w-20 h-20 bg-slate-50 rounded-[2rem] flex items-center justify-center border border-slate-100 mx-auto mb-6">
                         <Filter className="w-8 h-8 text-slate-200" />
                      </div>
                      <p className="text-slate-400 font-black tracking-tight text-xl">이 본부에는 아직 생성된 팀이 없습니다.</p>
                      <button 
                        onClick={() => { setNewTeamDivId(selectedDivision!); setShowTeamModal(true); }}
                        className="mt-6 text-sm font-black text-indigo-600 hover:underline"
                      >
                         + 첫 번째 팀 생성하기
                      </button>
                   </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 모달 필터 */}
      {(showDivisionModal || showTeamModal || showEmployeeModal || showEditModal || selectedEmpForLogs || showLogDeleteConfirm) && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-[100]" />
      )}

      {/* 본부 생성 모달 */}
      {showDivisionModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6">
          <div role="dialog" aria-modal="true" aria-label="신규 본부 설립" className="bg-white rounded-[3rem] p-12 w-full max-w-lg shadow-2xl animate-modal-pop">
            <div className="flex justify-between items-center mb-10">
              <h2 className="text-3xl font-black text-slate-900">신규 본부 설립</h2>
              <button aria-label="본부 생성 취소" onClick={() => setShowDivisionModal(false)}><X className="w-6 h-6" /></button>
            </div>
            <form onSubmit={handleCreateDivision} className="space-y-8">
              <input type="text" autoFocus required value={newDivName} onChange={(e) => setNewDivName(e.target.value)} placeholder="본부 명칭" className="w-full p-5 bg-slate-50 rounded-[2rem] outline-none font-black text-lg" />
              <button type="submit" className="w-full p-5 text-white bg-indigo-600 rounded-[1.5rem] font-black">본부 생성</button>
            </form>
          </div>
        </div>
      )}

      {/* 팀 생성 모달 */}
      {showTeamModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6">
          <div role="dialog" aria-modal="true" aria-label="신규 팀 구축" className="bg-white rounded-[3rem] p-12 w-full max-w-lg shadow-2xl animate-modal-pop">
            <h2 className="text-3xl font-black text-slate-900 mb-10">신규 팀 구축</h2>
            <form onSubmit={handleCreateTeam} className="space-y-6">
              <select aria-label="신규 팀의 소속 본부" className="w-full p-5 bg-slate-50 rounded-[2rem] outline-none font-black" value={newTeamDivId} onChange={(e) => setNewTeamDivId(e.target.value)}>
                <option value="">본부 선택</option>
                {divisions.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
              <input type="text" required value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} placeholder="팀 명칭" className="w-full p-5 bg-slate-50 rounded-[2rem] outline-none font-black" />
              <button type="submit" className="w-full p-5 text-white bg-indigo-600 rounded-[1.5rem] font-black">팀 생성</button>
              <button type="button" onClick={() => setShowTeamModal(false)} className="w-full p-4 text-slate-400 font-bold">취소</button>
            </form>
          </div>
        </div>
      )}

      {/* 직원 등록 모달 */}
      {showEmployeeModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6">
          <div role="dialog" aria-modal="true" aria-label="신규 직원 등록" className="bg-white rounded-[3rem] p-12 w-full max-w-xl shadow-2xl animate-modal-pop">
            <h2 className="text-3xl font-black text-slate-900 mb-10">신규 직원 등록</h2>
            <form onSubmit={handleCreateEmployee} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <input type="text" required aria-label="직원 이름" placeholder="이름" value={newEmp.name} onChange={(e) => setNewEmp({...newEmp, name: e.target.value})} className="p-5 bg-slate-50 rounded-[2rem] outline-none font-black" />
                <input type="text" required aria-label="직원 로그인 ID" aria-describedby="employee-login-preview" placeholder="직원 ID 또는 전체 이메일" value={newEmp.email} onChange={(e) => setNewEmp({...newEmp, email: e.target.value})} className="p-5 bg-slate-50 rounded-[2rem] outline-none font-black" />
              </div>
              <p id="employee-login-preview" role="status" className="break-all text-sm leading-6 text-indigo-700">
                {employeeLoginPreview ? `생성할 로그인 ID: ${employeeLoginPreview}` : '회사 영문명과 직원 ID를 확인하거나 전체 로그인 주소를 입력해 주세요.'}
                <span className="mt-1 block text-xs text-slate-500">아이디만 입력하면 @영문회사명.com으로 완성됩니다. 전체 이메일을 입력하면 해당 주소를 사용합니다. 기존 직원의 주소는 변경되지 않습니다.</span>
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-[2rem] bg-indigo-50 p-5 text-sm text-indigo-700"><span className="block font-bold">초기 임시 비밀번호: !123456</span><span className="mt-1 block text-xs">자동 발급되며 최초 로그인 시 반드시 변경합니다.</span></div>
                <select aria-label="직원 소속 팀" className="w-full p-5 bg-slate-50 rounded-[2rem] outline-none font-black" value={newEmp.teamId} onChange={(e) => setNewEmp({...newEmp, teamId: e.target.value})}>
                  <option value="">팀 선택(선택사항)</option>
                  {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <button 
                type="submit" 
                disabled={isSubmittingEmployee}
                className="w-full h-[60px] flex items-center justify-center gap-2 text-white bg-indigo-600 rounded-[1.5rem] font-black hover:bg-indigo-700 transition-all active:scale-[0.98] disabled:opacity-70 shadow-lg shadow-indigo-600/30"
              >
                {isSubmittingEmployee ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    등록 처리 중...
                  </>
                ) : '등록 완료'}
              </button>
              <button type="button" onClick={() => setShowEmployeeModal(false)} className="w-full p-4 text-slate-400 font-bold">취소</button>
            </form>
          </div>
        </div>
      )}

      {/* 역할/팀 수정 모달 */}
      {showEditModal && editingEmployee && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6">
          <div role="dialog" aria-modal="true" aria-label={`${editingEmployee.name} 정보 수정`} className="bg-white rounded-[3rem] p-5 sm:p-8 w-full max-w-lg max-h-[85vh] overflow-y-auto shadow-2xl animate-modal-pop">
            <h2 className="text-2xl font-black text-slate-900 mb-6">{editingEmployee.name} 정보 수정</h2>
            <div className="space-y-6">
               <div className="space-y-2">
                 <label className="text-xs font-black text-slate-400 ml-1">소속 팀 변경</label>
                 <select aria-label="소속 팀 변경" value={editingEmployee.teamId || ''} onChange={(e) => setEditingEmployee({...editingEmployee, teamId: e.target.value})} className="w-full p-5 bg-slate-50 rounded-2xl outline-none font-black">
                   <option value="">미배정</option>
                   {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                 </select>
               </div>
                <div className="space-y-2">
                  <label className="text-xs font-black text-slate-400 ml-1">
                    권한 등급 
                    {editingEmployee.uid === companyData?.adminUid ? " (회사 대표 가입자 SUPER_ADMIN - 변경 불가)" :
                     editingEmployee.uid === userData?.uid ? " (본인 변경 불가)" : ""}
                  </label>
                  <select 
                    aria-label="권한 등급"
                    value={editingEmployee.role} 
                    onChange={(e) => setEditingEmployee({...editingEmployee, role: e.target.value})} 
                    className="w-full p-5 bg-slate-50 rounded-2xl outline-none font-black disabled:bg-slate-100 disabled:text-slate-400"
                    disabled={editingEmployee.uid === userData?.uid || editingEmployee.uid === companyData?.adminUid}
                  >
                    <option value="MEMBER">일반 직원 (MEMBER)</option>
                    <option value="SUB_ADMIN">부관리자 (SUB_ADMIN)</option>
                    <option value="ADMIN" disabled={editingEmployee.uid === companyData?.adminUid}>{editingEmployee.uid === companyData?.adminUid ? '회사 대표 가입자 (SUPER_ADMIN)' : '회사 관리자 (ADMIN)'}</option>
                  </select>
                </div>
               {(()=>{const employee=employees.find(e=>e.uid===editingEmployee.uid);return employee&&userData?.companyId?<><p className="text-sm text-slate-500">HR 역할 변경 시 먼저 상태를 저장한 뒤 ERP 옵션을 지정해 주세요.</p><ErpEmployeeAccess key={`${userData.companyId}:${employee.uid}:${employee.erpAccess}:${employee.role}:${employee.status}`} companyId={userData.companyId} uid={employee.uid} role={employee.role} currentAccess={employee.erpAccess} active={(employee.status||'ACTIVE')==='ACTIVE'} canManage={userData.role==='ADMIN'&&employee.role===editingEmployee.role}/></>:null;})()}
               <button onClick={() => handleUpdateRole(editingEmployee, editingEmployee.teamId || '', editingEmployee.role)} className="w-full p-5 text-white bg-indigo-600 rounded-2xl font-black shadow-lg">상태 저장하기</button>
               <button onClick={() => setShowEditModal(false)} className="w-full p-4 text-slate-400 font-bold">닫기</button>
            </div>
          </div>
        </div>
      )}

      {/* 직원 이력 상세 모달 */}
      {selectedEmpForLogs && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6">
          <div role="dialog" aria-modal="true" aria-label={`${selectedEmpForLogs.name} 변경 이력`} className="bg-white rounded-[3rem] p-10 w-full max-w-2xl shadow-2xl animate-modal-pop max-h-[80vh] flex flex-col">
            <div className="flex justify-between items-center mb-8 shrink-0">
               <h2 className="text-2xl font-black text-slate-900">{selectedEmpForLogs.name} 변경 이력</h2>
               <button aria-label="직원 이력 닫기" onClick={() => setSelectedEmpForLogs(null)} className="p-3 bg-slate-50 rounded-2xl"><X className="w-6 h-6" /></button>
            </div>
            <div className="flex-1 overflow-y-auto pr-2 space-y-4">
               {auditLogs.filter(l => l.targetId === selectedEmpForLogs.uid).map(log => (
                 <div key={log.id} className="p-5 bg-slate-50 rounded-2xl border border-slate-100">
                    <div className="flex justify-between items-start mb-2">
                       <span className="text-[10px] font-black text-indigo-500 uppercase tracking-widest">{log.actionType}</span>
                       <span className="text-[11px] font-bold text-slate-400">{new Date(log.timestamp).toLocaleString()}</span>
                    </div>
                    <p className="text-sm font-bold text-slate-700">{log.details}</p>
                    <p className="text-[10px] text-slate-400 mt-2">처리자: {log.performedBy}</p>
                 </div>
               ))}
               {auditLogs.filter(l => l.targetId === selectedEmpForLogs.uid).length === 0 && (
                 <div className="py-20 text-center text-slate-400 font-bold">이력이 존재하지 않습니다.</div>
               )}
            </div>
          </div>
        </div>
      )}

      {/* 이력 삭제 확인 모달 */}
      {showLogDeleteConfirm && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6">
          <div role="dialog" aria-modal="true" aria-label="전체 이력 영구 삭제" className="bg-white rounded-[3rem] p-12 w-full max-w-lg shadow-2xl animate-modal-pop">
            <h2 className="text-2xl font-black text-rose-600 mb-4 tracking-tight">전체 이력 영구 삭제</h2>
            <p className="text-slate-500 font-medium mb-8">보안을 위해 비밀번호를 입력해주세요.</p>
            <input 
              type="password" 
              placeholder="관리자 비밀번호"
              value={deleteLogsPassword}
              onChange={(e) => setDeleteLogsPassword(e.target.value)}
              className="w-full p-5 bg-slate-50 rounded-[2rem] outline-none font-black mb-6"
            />
            <div className="flex gap-4">
               <button onClick={() => { setShowLogDeleteConfirm(false); setDeleteLogsPassword(''); }} className="flex-1 p-5 text-slate-400 font-black bg-slate-100 rounded-2xl">취소</button>
               <button 
                  onClick={handleDeleteAllLogs}
                  disabled={!deleteLogsPassword || isProcessingLogs}
                  className="flex-[2] p-5 text-white bg-rose-600 rounded-2xl font-black disabled:opacity-50"
                >
                  {isProcessingLogs ? '삭제 중...' : '데이터 말소'}
               </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
