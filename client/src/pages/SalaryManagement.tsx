import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { collection, doc, onSnapshot, query, runTransaction, where } from 'firebase/firestore';
import { Banknote, Calculator, Download, History, Loader2, Minus, Plus, Save, Search, Trash2, X } from 'lucide-react';
import { Button, Input, PageTitle, Panel, Select } from '../components/ui';
import { db } from '../firebase';
import { useAuthStore } from '../store/authStore';
import type { UserData } from '../store/authStore';
import { getRoleDisplayName } from '../utils/roleDisplay';
import { calculateNetPay, getDeductionCounts, MEAL_ALLOWANCE_DEFAULT } from '../utils/payroll';
import type { PayrollResult, TaxTable } from '../utils/payroll';
import { getTaxTableStatus } from '../utils/payrollTaxTable';
import { assertPayrollSession, downloadPayrollPdf, payrollService, payrollSessionKey } from '../services/payrollService';
import type { PayrollIdentity, PayrollRecordSummary } from '../utils/payrollStatements';
import './SalaryManagement.css';
import './PayrollReports.css';

interface Division { id: string; name: string }
interface Team extends Division { divisionId: string }
type PayrollSettings = Required<Pick<UserData, 'annualSalary' | 'salaryType' | 'isSeveranceIncluded' | 'dependents' | 'childrenUnder20' | 'nonTaxable'>>;
interface Draft { values: PayrollSettings; baseline: string }
const financialFields = ['annualSalary', 'salaryType', 'isSeveranceIncluded', 'dependents', 'childrenUnder20', 'nonTaxable'] as const;
const baselineOf = (value: Partial<UserData>) => JSON.stringify(financialFields.map(field => value[field] ?? null));
const settingsOf = (employee: UserData): PayrollSettings => ({ annualSalary: employee.annualSalary ?? 0,
  salaryType: employee.salaryType ?? 'ANNUAL', isSeveranceIncluded: false,
  dependents: getDeductionCounts(employee).dependents, childrenUnder20: getDeductionCounts(employee).children,
  nonTaxable: employee.nonTaxable ?? MEAL_ALLOWANCE_DEFAULT });
const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const now = new Date();
const years = Array.from({ length: 7 }, (_, index) => now.getFullYear() - 4 + index);
const monthIndex = (year: number, month: number) => year * 12 + month;
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : '처리하지 못했습니다. 다시 시도해 주세요.';

function PayrollDialog({ title, children, onClose, error }: { title: string; children: ReactNode; onClose: () => void; error?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="pyre-dialog" aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="pyre-dialog-head"><h2>{title}</h2><Button aria-label={`${title} 닫기`} onClick={onClose}><X size={18} /></Button></header>
    <div className="pyre-dialog-body">{error && <p className="pyre-alert pyre-error" role="alert">{error}</p>}{children}</div>
  </dialog>;
}

function PayrollWorkspace({ companyId, scope }: { companyId: string; scope: string }) {
  const { companyData } = useAuthStore();
  const mounted = useRef(true);
  const historyRequest = useRef(0);
  const isCurrent = useCallback(() => mounted.current && payrollSessionKey() === scope, [scope]);
  const [employees, setEmployees] = useState<UserData[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [taxTable, setTaxTable] = useState<TaxTable>(null);
  const [taxLoading, setTaxLoading] = useState(true);
  const [taxReadError, setTaxReadError] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [selectedDivision, setSelectedDivision] = useState('ALL');
  const [selectedTeam, setSelectedTeam] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [yearRecords, setYearRecords] = useState<PayrollRecordSummary[]>([]);
  const [annualEmployees, setAnnualEmployees] = useState<PayrollIdentity[]>([]);
  const [annualEmployeeId, setAnnualEmployeeId] = useState('');
  const [listLoading, setListLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [historyRecords, setHistoryRecords] = useState<PayrollRecordSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyStart, setHistoryStart] = useState(`${now.getFullYear()}-01`);
  const [historyEnd, setHistoryEnd] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!isCurrent()) return;
    try { assertPayrollSession(scope); }
    catch (failure) { setError(failureMessage(failure)); setLoading(false); return; }
    const fail = (failure: unknown) => { if (isCurrent()) { setError(failureMessage(failure)); setLoading(false); } };
    const unsubEmployees = onSnapshot(query(collection(db, 'UserProfile'), where('companyId', '==', companyId)), snapshot => {
      if (!isCurrent()) return;
      setEmployees(snapshot.docs.map(item => ({ ...item.data(), uid: item.id } as UserData))
        .filter(employee => employee.companyId === companyId && ['ADMIN', 'SUB_ADMIN', 'MEMBER'].includes(employee.role))
        .sort((left, right) => (left.name || '').localeCompare(right.name || '', 'ko')));
      setLoading(false);
    }, fail);
    const unsubDivisions = onSnapshot(query(collection(db, 'divisions'), where('companyId', '==', companyId)), snapshot => {
      if (isCurrent()) setDivisions(snapshot.docs.filter(item => item.data().companyId === companyId).map(item => ({ ...item.data(), id: item.id } as Division)));
    }, fail);
    const unsubTeams = onSnapshot(query(collection(db, 'teams'), where('companyId', '==', companyId)), snapshot => {
      if (isCurrent()) setTeams(snapshot.docs.filter(item => item.data().companyId === companyId).map(item => ({ ...item.data(), id: item.id } as Team)));
    }, fail);
    const unsubTax = onSnapshot(doc(db, 'system_config', 'tax_table'), snapshot => {
      if (!isCurrent()) return;
      setTaxTable(snapshot.exists() ? snapshot.data() as TaxTable : null); setTaxReadError(''); setTaxLoading(false);
    }, () => {
      if (!isCurrent()) return;
      setTaxTable(null); setTaxReadError('등록 세액표를 불러오지 못했습니다. 공식 기본표로 예상 계산하며 확정 전 서버에서 다시 확인합니다.'); setTaxLoading(false);
    });
    return () => { unsubEmployees(); unsubDivisions(); unsubTeams(); unsubTax(); };
  }, [companyId, scope, isCurrent]);

  useEffect(() => {
    let active = true;
    void payrollService.list(selectedYear).then(result => {
      if (!active || !isCurrent()) return;
      setYearRecords(result.records); setAnnualEmployees(result.employees); setListLoading(false);
    }).catch(failure => { if (active && isCurrent()) { setError(failureMessage(failure)); setListLoading(false); } });
    return () => { active = false; };
  }, [selectedYear, isCurrent]);

  const period = { year: selectedYear, month: selectedMonth };
  const taxStatus = getTaxTableStatus(taxTable);
  const policySupported = calculateNetPay({ annualSalary: 12, nonTaxable: 0 }, taxTable, period)?.metadata.policyPeriodSupported === true;
  const monthEnd = new Date(Date.UTC(selectedYear, selectedMonth, 0)).toISOString().slice(0, 10);
  const activeEmployees = employees.filter(employee => employee.status !== 'RESIGNED' && (!employee.joinDate || employee.joinDate <= monthEnd));
  const filteredEmployees = activeEmployees.filter(employee => (selectedDivision === 'ALL' || employee.divisionId === selectedDivision) &&
    (selectedTeam === 'ALL' || employee.teamId === selectedTeam) && (employee.name || '').toLocaleLowerCase().includes(searchTerm.toLocaleLowerCase()));
  const edited = activeEmployees.filter(employee => drafts[employee.uid] || employee.isSeveranceIncluded === true);
  const legacyCount = activeEmployees.filter(employee => employee.isSeveranceIncluded === true).length;
  const calculate = (employee: UserData) => calculateNetPay({ ...employee, ...(drafts[employee.uid]?.values ?? settingsOf(employee)) }, taxTable, period);
  const totals = filteredEmployees.reduce((sum, employee) => {
    const result = calculate(employee);
    return { gross: sum.gross + (result?.monthlyGross ?? 0), net: sum.net + (result?.netPay ?? 0), deductions: sum.deductions + (result?.totalDeductions ?? 0) };
  }, { gross: 0, net: 0, deductions: 0 });
  const approved = yearRecords.find(record => record.year === selectedYear && record.month === selectedMonth && !record.legacy && record.schemaVersion === 2);
  const detailsEmployee = employees.find(employee => employee.uid === detailsId);
  const details = detailsEmployee ? calculate(detailsEmployee) : null;
  const busy = approving || saving !== null;

  function updateField<Key extends keyof PayrollSettings>(employee: UserData, field: Key, value: PayrollSettings[Key]) {
    if (busy) return;
    setDrafts(previous => {
      const current = previous[employee.uid] ?? { values: settingsOf(employee), baseline: baselineOf(employee) };
      const values = { ...current.values, [field]: value, isSeveranceIncluded: false };
      if (field === 'dependents' || field === 'childrenUnder20') values.dependents = Math.max(1, values.dependents, values.childrenUnder20 + 1);
      return { ...previous, [employee.uid]: { ...current, values } };
    });
  }
  function setSalary(employee: UserData, displayed: number) {
    const settings = drafts[employee.uid]?.values ?? settingsOf(employee);
    updateField(employee, 'annualSalary', displayed * (settings.salaryType === 'MONTHLY' ? 12 : 1));
  }
  async function saveSettings(employee: UserData) {
    const scopeAtStart = scope;
    const draft = drafts[employee.uid] ?? { values: settingsOf(employee), baseline: baselineOf(employee) };
    const values = draft.values;
    if (![values.annualSalary, values.nonTaxable, values.dependents, values.childrenUnder20].every(Number.isSafeInteger) ||
      values.annualSalary < 0 || values.nonTaxable < 0 || values.dependents < 1 || values.dependents > 100 || values.childrenUnder20 < 0 || values.childrenUnder20 > 99) {
      setError('급여·비과세액은 0 이상의 정수, 부양가족은 1~100명, 자녀는 0~99명으로 입력해 주세요.'); return;
    }
    if (employee.isSeveranceIncluded && !window.confirm(`${employee.name}님의 기존 급여 금액을 확인하셨습니까? 저장된 연봉 ${won(values.annualSalary)}을 12개월로 나눠 계산합니다. 금액을 검토한 뒤 저장해 주세요.`)) return;
    setSaving(employee.uid); setError(''); setMessage('');
    try {
      assertPayrollSession(scopeAtStart);
      await runTransaction(db, async transaction => {
        const reference = doc(db, 'UserProfile', employee.uid);
        const snapshot = await transaction.get(reference);
        assertPayrollSession(scopeAtStart);
        if (!snapshot.exists() || snapshot.data().companyId !== companyId) throw new Error('해당 회사의 직원 정보를 확인할 수 없습니다.');
        if (baselineOf(snapshot.data()) !== draft.baseline) throw new Error('급여 설정이 다른 곳에서 변경되었습니다. 새로고침 후 최신 금액을 확인해 주세요. 입력 내용은 현재 화면에 유지됩니다.');
        transaction.update(reference, { ...values, isSeveranceIncluded: false });
      });
      if (!isCurrent()) return;
      setDrafts(previous => { const next = { ...previous }; delete next[employee.uid]; return next; });
      setMessage(`${employee.name}님의 급여 설정을 저장했습니다.`);
    } catch (failure) { if (isCurrent()) setError(failureMessage(failure)); }
    finally { if (isCurrent()) setSaving(null); }
  }
  async function approvePayroll() {
    if (edited.length || busy || !policySupported || approved || listLoading) return;
    setApproving(true); setError(''); setMessage('');
    try {
      assertPayrollSession(scope);
      const preview = await payrollService.preview(selectedYear, selectedMonth);
      if (!isCurrent()) return;
      const taxName = preview.taxTable.source === 'uploaded' ? '관리자 등록 세액표' : '2026.03 공식 기본 세액표';
      if (!window.confirm(`${selectedYear}년 ${selectedMonth}월 회사 전체 ${preview.employeeCount}명의 급여를 확정합니다.\n\n총 지급액: ${won(preview.totalGross)}\n총 공제액: ${won(preview.totalDeductions)}\n실지급액: ${won(preview.totalNet)}\n급여 0원: ${preview.zeroCount}명\n계산 기준: ${taxName}\n\n검색·본부·팀 필터와 관계없이 저장된 전체 직원 설정으로 확정되며 승인 후 수정·삭제할 수 없습니다. 계속하시겠습니까?`)) return;
      const result = await payrollService.approve(selectedYear, selectedMonth, preview.fingerprint);
      if (!isCurrent()) return;
      setYearRecords(previous => [result.record, ...previous.filter(record => record.id !== result.record.id)]);
      setMessage('회사 전체 급여를 확정했습니다. 월별 급여대장과 직원별 연간 급여명세서 PDF를 다운로드할 수 있습니다.');
      const refreshed = await payrollService.list(selectedYear);
      if (isCurrent()) { setYearRecords(refreshed.records); setAnnualEmployees(refreshed.employees); }
    } catch (failure) { if (isCurrent()) setError(failureMessage(failure)); }
    finally { if (isCurrent()) setApproving(false); }
  }
  async function download(kind: 'monthly' | 'annual', identifier: string) {
    if (downloading) return;
    setDownloading(`${kind}:${identifier}`); setError('');
    try {
      assertPayrollSession(scope);
      const file = kind === 'monthly' ? await payrollService.monthlyPdf(identifier) : await payrollService.annualPdf(selectedYear, identifier);
      if (isCurrent()) downloadPayrollPdf(file, scope);
    } catch (failure) { if (isCurrent()) setError(failureMessage(failure)); }
    finally { if (isCurrent()) setDownloading(null); }
  }
  async function fetchHistory() {
    const requestId = ++historyRequest.current;
    if (!/^\d{4}-\d{2}$/.test(historyStart) || !/^\d{4}-\d{2}$/.test(historyEnd) || historyStart > historyEnd) { setError('조회 시작월과 종료월을 확인해 주세요.'); return; }
    const [startYear, startMonth] = historyStart.split('-').map(Number), [endYear, endMonth] = historyEnd.split('-').map(Number);
    if (endYear - startYear > 5) { setError('승인 이력은 한 번에 최대 6개 연도를 조회할 수 있습니다.'); return; }
    setHistoryLoading(true); setError('');
    try {
      const results = await Promise.all(Array.from({ length: endYear - startYear + 1 }, (_, index) => payrollService.list(startYear + index)));
      if (!isCurrent() || requestId !== historyRequest.current) return;
      setHistoryRecords(results.flatMap(result => result.records).filter(record => monthIndex(record.year, record.month) >= monthIndex(startYear, startMonth) &&
        monthIndex(record.year, record.month) <= monthIndex(endYear, endMonth)).sort((a, b) => monthIndex(b.year, b.month) - monthIndex(a.year, a.month) || b.approvedAtIso.localeCompare(a.approvedAtIso)));
    } catch (failure) { if (isCurrent() && requestId === historyRequest.current) setError(failureMessage(failure)); }
    finally { if (isCurrent() && requestId === historyRequest.current) setHistoryLoading(false); }
  }
  async function deleteLegacy(record: PayrollRecordSummary) {
    if (!record.legacy || !window.confirm('이전 집계 승인 이력을 삭제하시겠습니까? 직원별 상세자료가 없는 이전 기록만 삭제할 수 있습니다.')) return;
    setError('');
    try {
      assertPayrollSession(scope);
      await runTransaction(db, async transaction => {
        const reference = doc(db, 'payroll_records', record.id), snapshot = await transaction.get(reference);
        assertPayrollSession(scope);
        const value = snapshot.data();
        if (!snapshot.exists() || value?.companyId !== companyId || (value.schemaVersion ?? 1) !== 1 ||
          ['rows', 'sums', 'scope', 'taxTable', 'approvedAtIso', 'revision'].some(key => key in value)) throw new Error('삭제 가능한 이전 회사 집계 기록이 아닙니다.');
        transaction.delete(reference);
      });
      if (isCurrent()) {
        setHistoryRecords(previous => previous.filter(item => item.id !== record.id));
        setYearRecords(previous => previous.filter(item => item.id !== record.id)); setMessage('이전 집계 이력을 삭제했습니다.');
      }
    } catch (failure) { if (isCurrent()) setError(failureMessage(failure)); }
  }

  function employeeEditor(employee: UserData) {
    const settings = drafts[employee.uid]?.values ?? settingsOf(employee), result = calculate(employee);
    const changed = !!drafts[employee.uid] || employee.isSeveranceIncluded === true;
    const displayed = settings.salaryType === 'MONTHLY' ? Math.floor(settings.annualSalary / 12) : settings.annualSalary;
    return <article className="pyre-employee wf-panel" key={employee.uid}>
      <div className="pyre-person"><div className="pyre-avatar" aria-hidden="true">{employee.name?.slice(0, 1)}</div><div><h3>{employee.name}</h3><p>{getRoleDisplayName(employee, companyData)}</p><p>{divisions.find(item => item.id === employee.divisionId)?.name || '본부 미배정'} · {teams.find(item => item.id === employee.teamId)?.name || '팀 미배정'}</p></div></div>
      <div className="pyre-salary-fields"><div className="pyre-basis" role="group" aria-label={`${employee.name} 급여 입력 기준`}>
        <Button disabled={busy} aria-pressed={settings.salaryType === 'ANNUAL'} onClick={() => updateField(employee, 'salaryType', 'ANNUAL')}>연봉</Button>
        <Button disabled={busy} aria-pressed={settings.salaryType === 'MONTHLY'} onClick={() => updateField(employee, 'salaryType', 'MONTHLY')}>월급</Button>
      </div><label>{settings.salaryType === 'MONTHLY' ? '월 급여' : '연봉'} (원)<Input inputMode="numeric" aria-label={`${employee.name} ${settings.salaryType === 'MONTHLY' ? '월 급여' : '연봉'}`} disabled={busy} value={displayed.toLocaleString('ko-KR')} onChange={event => setSalary(employee, Number(event.target.value.replace(/[^0-9]/g, '')))} /></label>
        <div className="pyre-salary-hint"><span>{settings.salaryType === 'MONTHLY' ? `연 환산 ${won(settings.annualSalary)}` : `월 환산 ${won(Math.floor(settings.annualSalary / 12))}`}</span><span><Button disabled={busy} onClick={() => setSalary(employee, displayed + (settings.salaryType === 'MONTHLY' ? 500_000 : 5_000_000))}>{settings.salaryType === 'MONTHLY' ? '+50만' : '+500만'}</Button><Button disabled={busy} onClick={() => setSalary(employee, displayed + (settings.salaryType === 'MONTHLY' ? 100_000 : 1_000_000))}>{settings.salaryType === 'MONTHLY' ? '+10만' : '+100만'}</Button></span></div>
        {employee.isSeveranceIncluded && <p className="pyre-warning">기존 급여 금액을 확인하고 설정을 저장해 주세요.</p>}
      </div>
      <div className="pyre-deductions"><div className="pyre-count-grid">{(['dependents', 'childrenUnder20'] as const).map(field => <div className="pyre-count" key={field}><span>{field === 'dependents' ? '공제대상 가족 (본인 포함)' : '8~20세 공제대상 자녀'}</span><div><Button disabled={busy || settings[field] <= (field === 'dependents' ? settings.childrenUnder20 + 1 : 0)} aria-label={`${employee.name} ${field === 'dependents' ? '가족' : '자녀'} 감소`} onClick={() => updateField(employee, field, settings[field] - 1)}><Minus size={14} /></Button><output aria-label={`${employee.name} ${field === 'dependents' ? '가족' : '자녀'} 수`}>{settings[field]}</output><Button disabled={busy || settings[field] >= (field === 'dependents' ? 100 : 99)} aria-label={`${employee.name} ${field === 'dependents' ? '가족' : '자녀'} 증가`} onClick={() => updateField(employee, field, settings[field] + 1)}><Plus size={14} /></Button></div></div>)}</div>
        <label>비과세액 (월, 원)<Input disabled={busy} inputMode="numeric" aria-label={`${employee.name} 월 비과세액`} value={settings.nonTaxable.toLocaleString('ko-KR')} onChange={event => updateField(employee, 'nonTaxable', Number(event.target.value.replace(/[^0-9]/g, '')))} /></label>
      </div>
      <div className="pyre-result"><span>예상 월 실수령액</span><strong>{won(result?.netPay ?? 0)}</strong><p>지급액 {won(result?.monthlyGross ?? 0)}</p><p>공제액 {won(result?.totalDeductions ?? 0)}</p><div className="pyre-row-actions"><Button disabled={busy || !changed} onClick={() => void saveSettings(employee)}>{saving === employee.uid ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}설정 저장</Button><Button onClick={() => setDetailsId(employee.uid)}><Calculator size={16} />산출 상세</Button><Button disabled={!!downloading || listLoading} onClick={() => void download('annual', employee.uid)}><Download size={16} />연간 PDF</Button></div></div>
    </article>;
  }

  if (loading) return <div className="pyre-screen pyre-loading" role="status"><Loader2 size={22} className="animate-spin" />급여 정보를 불러오는 중입니다.</div>;
  return <div className="salary-screen pyre-screen"><div className="pyre-workspace">
    <header className="pyre-heading"><div><PageTitle>급여관리</PageTitle><p>월별 급여대장과 직원별 연간 급여명세서를 PDF로 보관합니다.</p></div><Button onClick={() => { setShowHistory(true); void fetchHistory(); }}><History size={17} />과거 승인 내역</Button></header>
    {error && <p className="pyre-alert pyre-error" role="alert">{error}</p>}{message && <p className="pyre-alert pyre-success" role="status">{message}</p>}
    <Panel className="pyre-tax"><div><strong>적용 세액표</strong><span>{taxLoading ? '확인 중' : taxStatus.source === 'uploaded' ? '관리자 등록 세액표' : '2026.03 공식 기본 세액표'}</span></div>
      {taxStatus.fileName && <p>등록 파일: {taxStatus.fileName}{taxStatus.updateDate ? ` · 등록일 ${taxStatus.updateDate.slice(0, 10)}` : ''}</p>}
      <p>적용일 {taxStatus.effectiveFrom || '2026-03-01'} · {taxStatus.bracketCount}개 급여 구간 · 자녀 공제는 8~20세 대상 자녀만 입력하세요.</p>
      {(taxStatus.reason || taxReadError) && <p className="pyre-warning" role="alert">{taxReadError || `등록 세액표 검증 오류: ${taxStatus.reason} 전체 공식 기본표로 계산합니다.`}</p>}
      {taxStatus.source === 'uploaded' && taxStatus.highIncomeSource !== 'uploaded' && <p className="pyre-warning">1,000만원 이상 급여는 등록표의 기준 세액이 없어 공식 기본표 산식을 사용합니다.</p>}
    </Panel>
    <div className="pyre-summary-layout"><Panel className="pyre-period"><h2>급여 대상 기간</h2><div><Select aria-label="급여 대상 연도" disabled={busy} value={selectedYear} onChange={event => { setListLoading(true); setYearRecords([]); setAnnualEmployees([]); setAnnualEmployeeId(''); setSelectedYear(Number(event.target.value)); }}>{years.map(year => <option key={year} value={year}>{year}년</option>)}</Select><Select aria-label="급여 대상 월" disabled={busy} value={selectedMonth} onChange={event => setSelectedMonth(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}월</option>)}</Select></div><p>설정은 현재 저장된 급여 기준입니다. 과거 확정액은 승인 이력에서 확인하세요.</p></Panel>
      <Panel className="pyre-summary"><h2>조회 목록 예상 합계 <span>{filteredEmployees.length}명</span></h2><dl><div><dt>총 지급액</dt><dd>{won(totals.gross)}</dd></div><div><dt>총 공제액</dt><dd>{won(totals.deductions)}</dd></div><div><dt>예상 실지급액</dt><dd>{won(totals.net)}</dd></div></dl><p>본부·팀·이름으로 조회한 목록의 예상 금액입니다. 월 급여 확정은 회사 전체 저장 설정으로 진행합니다.</p></Panel></div>
    <Panel className="pyre-report-actions"><div><h2>{selectedYear}년 {selectedMonth}월 회사 전체 급여대장</h2>{approved ? <p>확정 {approved.employeeCount}명 · 총 지급 {won(approved.totalGross)} · 실지급 {won(approved.totalNet)} · 승인일 {approved.approvedAtIso.slice(0, 10)}</p> : <p>저장된 회사 전체 직원 {activeEmployees.length}명의 급여를 서버에서 확인한 뒤 확정합니다.</p>}
      {edited.length > 0 && <p className="pyre-warning">설정 확인·저장 필요 {edited.length}명{legacyCount ? ` (이전 급여 설정 ${legacyCount}명)` : ''}. 모두 저장한 뒤 확정할 수 있습니다.</p>}
      {!policySupported && <p className="pyre-warning">선택 기간은 현재 세액·보험 기준으로 확정할 수 없습니다. 이미 승인된 문서는 다운로드할 수 있습니다.</p>}</div><div className="pyre-action-buttons"><Button className="wf-btn-primary" disabled={busy || !!approved || edited.length > 0 || !policySupported || taxLoading || listLoading || !activeEmployees.length} onClick={() => void approvePayroll()}>{approving ? <Loader2 size={17} className="animate-spin" /> : <Banknote size={17} />}{approved ? '확정 완료' : '회사 전체 급여 확정'}</Button><Button disabled={!approved || !!downloading || listLoading} onClick={() => approved && void download('monthly', approved.id)}><Download size={17} />월별 급여대장 PDF</Button></div></Panel>
    <Panel className="pyre-annual"><div><h2>직원별 {selectedYear}년 급여명세서</h2><p>월별 확정 이력을 모아 생성합니다. 이력이 없는 월은 미확정으로 표시하며 퇴사자도 선택할 수 있습니다.</p></div><label>직원 선택<Select aria-label="연간 급여명세서 직원 선택" value={annualEmployeeId} disabled={listLoading || !!downloading} onChange={event => setAnnualEmployeeId(event.target.value)}><option value="">직원을 선택하세요</option>{annualEmployees.map(employee => <option key={employee.userId} value={employee.userId}>{employee.name}{employee.resignDate ? ` · 퇴사 ${employee.resignDate}` : ''}{employee.teamName ? ` · ${employee.teamName}` : ''}</option>)}</Select></label><Button disabled={!annualEmployeeId || !!downloading || listLoading} onClick={() => void download('annual', annualEmployeeId)}><Download size={17} />연간 급여명세서 PDF</Button></Panel>
    {downloading && <p className="pyre-inline-status" role="status"><Loader2 size={17} className="animate-spin" />승인 자료로 PDF를 생성하고 있습니다.</p>}
    <Panel className="pyre-filters"><label>본부<Select aria-label="급여 조회 본부" value={selectedDivision} onChange={event => { setSelectedDivision(event.target.value); setSelectedTeam('ALL'); }}><option value="ALL">전체 본부</option>{divisions.map(division => <option key={division.id} value={division.id}>{division.name}</option>)}</Select></label><label>팀<Select aria-label="급여 조회 팀" value={selectedTeam} onChange={event => setSelectedTeam(event.target.value)}><option value="ALL">전체 팀</option>{teams.filter(team => selectedDivision === 'ALL' || team.divisionId === selectedDivision).map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</Select></label><label className="pyre-search">직원 이름<div><Search size={17} aria-hidden="true" /><Input type="search" aria-label="급여 대상 직원 검색" placeholder="직원 이름 검색" value={searchTerm} onChange={event => setSearchTerm(event.target.value)} /></div></label></Panel>
    <div className="pyre-list-heading"><h2>급여 설정 <span>{filteredEmployees.length}명</span></h2><p>저장된 연봉을 12개월로 나누어 계산합니다. 설정 변경은 확정된 문서에 영향을 주지 않습니다.</p></div>
    <div className="pyre-employees">{filteredEmployees.map(employeeEditor)}</div>{!filteredEmployees.length && <Panel className="pyre-empty">선택한 조건의 직원이 없습니다. 검색어와 본부·팀 필터를 확인하세요.</Panel>}
    {detailsEmployee && details && <PayrollDialog title={`${detailsEmployee.name}님 예상 급여 산출 내역`} error={error} onClose={() => setDetailsId(null)}><p className="pyre-dialog-note">{selectedYear}년 {selectedMonth}월 현재 입력한 설정의 예상 계산입니다. 확정 급여명세서는 승인 이력으로 생성한 PDF를 사용하세요.</p><div className="pyre-detail-summary"><div><span>월 지급액</span><strong>{won(details.monthlyGross)}</strong></div><div><span>예상 실수령액</span><strong>{won(details.netPay)}</strong></div></div><dl className="pyre-detail-rows">{detailItems(details).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{won(value)}</dd></div>)}</dl><p className="pyre-dialog-note">공제대상 가족 {details.dependents}명 · 8~20세 자녀 {details.children}명 · {details.metadata.tableSource === 'uploaded' ? '관리자 등록 세액표' : '2026.03 공식 기본 세액표'}<br />{pensionAgeNote(details)} · 건강보험 3.595% · 장기요양 건강보험료의 13.14% · 고용보험 0.9%. 실제 지급액은 회사의 수당·보험 가입 조건에 따라 달라질 수 있습니다.</p><Button disabled={!!downloading} onClick={() => void download('annual', detailsEmployee.uid)}><Download size={17} />{selectedYear}년 확정 급여명세서 PDF</Button></PayrollDialog>}
    {showHistory && <PayrollDialog title="급여 지출 승인 이력" error={error} onClose={() => { historyRequest.current += 1; setShowHistory(false); setHistoryLoading(false); }}><div className="pyre-history-filters"><label>시작월<Input type="month" aria-label="급여 이력 시작월" value={historyStart} onChange={event => setHistoryStart(event.target.value)} /></label><label>종료월<Input type="month" aria-label="급여 이력 종료월" value={historyEnd} onChange={event => setHistoryEnd(event.target.value)} /></label><Button disabled={historyLoading} onClick={() => void fetchHistory()}>조회</Button></div><p className="pyre-dialog-note">새로 확정한 상세 급여대장은 수정·삭제할 수 없습니다. 이전 집계 기록은 직원별 상세자료가 없어 PDF를 생성할 수 없습니다.</p>{historyLoading ? <p role="status">승인 이력을 불러오는 중입니다.</p> : <div className="pyre-history-scroll"><table><thead><tr><th>승인 기간</th><th>인원</th><th>총 지급액</th><th>실지급액</th><th>승인 정보</th><th>문서·관리</th></tr></thead><tbody>{historyRecords.map(record => <tr key={record.id}><td>{record.year}년 {record.month}월<br /><small>{record.legacy ? '이전 집계' : '회사 전체 확정'}</small></td><td>{record.employeeCount}명</td><td>{won(record.totalGross)}</td><td>{won(record.totalNet)}</td><td>{record.approvedAtIso.slice(0, 10)}<br /><small>{record.approvedByName}</small></td><td>{record.legacy ? <div className="pyre-history-actions"><span>상세내역 없음</span><Button aria-label={`${record.year}년 ${record.month}월 이전 집계 삭제`} onClick={() => void deleteLegacy(record)}><Trash2 size={16} /></Button></div> : <Button disabled={!!downloading} onClick={() => void download('monthly', record.id)}><Download size={16} />PDF</Button>}</td></tr>)}</tbody></table>{!historyRecords.length && <p className="pyre-empty">조회 기간의 승인 내역이 없습니다.</p>}</div>}</PayrollDialog>}
  </div></div>;
}

function pensionAgeNote(result: PayrollResult): string {
  if (result.metadata.pensionAgeStatus === 'AGE_EXEMPT') return '국민연금 0원 (급여월 기준 만 60세 의무가입 제외)';
  if (result.metadata.pensionAgeStatus === 'BIRTH_DATE_UNAVAILABLE') return '국민연금 4.75% (생년월일 확인 불가: 만 60세 미만으로 계산)';
  return '국민연금 4.75% (해당 급여월 납부 대상)';
}

function detailItems(result: PayrollResult): Array<[string, number]> {
  return [['기본급', result.monthlyGross - result.nonTaxable], ['비과세액', result.nonTaxable], ['국민연금', result.pension], ['건강보험', result.health], ['장기요양보험', result.longTerm], ['고용보험', result.employment], ['근로소득세', result.incomeTax], ['지방소득세', result.localTax], ['공제 합계', result.totalDeductions]];
}

export function SalaryManagement() {
  const { userData, companyData, sessionReady } = useAuthStore();
  if (!sessionReady || !userData || userData.role !== 'ADMIN' || userData.status === 'RESIGNED' || userData.mustChangePassword ||
    !companyData || companyData.id !== userData.companyId || companyData.status !== 'ACTIVE') return <Panel className="pyre-empty" role="status">소속 회사 관리자만 급여 정보를 이용할 수 있습니다.</Panel>;
  const scope = payrollSessionKey();
  try { assertPayrollSession(scope); }
  catch { return <Panel className="pyre-empty" role="status">로그인과 소속 정보를 다시 확인해 주세요.</Panel>; }
  return <PayrollWorkspace key={scope} companyId={userData.companyId} scope={scope} />;
}
