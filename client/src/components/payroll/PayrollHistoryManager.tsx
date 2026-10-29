import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileUp, Loader2, Save, X } from 'lucide-react';
import { Button, Input, Select, Textarea } from '../ui';
import { assertPayrollSession, downloadPayrollPdf, downloadPayrollSourceFile, payrollService, payrollSessionKey, readPayrollSourceFile } from '../../services/payrollService';
import type { PayrollAmounts, PayrollDraft, PayrollDraftSummary, PayrollDraftVersion, PayrollRecordSummary, PayrollRevision, PayrollSnapshotRow, PayrollSourceSelector } from '../../utils/payrollStatements';
import { CSV_TEMPLATE, EDITABLE_AMOUNT_KEYS, completePayrollAmounts, parsePayrollMoney } from '../../../../functions/payroll-import-schema.mjs';
import './PayrollHistoryManager.css';

type AmountKey = (typeof EDITABLE_AMOUNT_KEYS)[number];
type AmountInputs = Record<AmountKey, string>;
type Tab = 'IMPORT' | 'PENDING' | 'HISTORY';
const labels: Record<string, string> = { monthlyGross: '지급합계', nonTaxable: '비과세액', pension: '국민연금', health: '건강보험', longTerm: '장기요양보험', employment: '고용보험', incomeTax: '근로소득세', localTax: '지방소득세', otherDeductions: '기타 공제', basePay: '기본급·과세수당', totalInsurance: '보험료 합계', totalDeductions: '공제합계', netPay: '실지급액' };
const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;
const errorText = (error: unknown) => error instanceof Error ? error.message : '처리하지 못했습니다. 다시 확인해 주세요.';
const stamp = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)} (한국시간)` : '-';
};
const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
const currentYear = kst.getUTCFullYear();
const currentMonth = `${currentYear}-${String(kst.getUTCMonth() + 1).padStart(2, '0')}`;
const toInputs = (row: PayrollSnapshotRow) => Object.fromEntries(EDITABLE_AMOUNT_KEYS.map(key => [key, String(row.amounts[key] ?? 0)])) as AmountInputs;
function toAmounts(inputs: AmountInputs): PayrollAmounts {
  return completePayrollAmounts(Object.fromEntries(EDITABLE_AMOUNT_KEYS.map(key => [key, parsePayrollMoney(inputs[key], labels[key], { signed: key !== 'monthlyGross' && key !== 'nonTaxable', optional: key === 'otherDeductions' })])));
}
function valueText(value: unknown): string { return typeof value === 'number' ? won(value) : value === null || value === undefined ? '-' : String(value); }

function DiffView({ draft }: { draft: PayrollDraft }) {
  const [page, setPage] = useState(0);
  const diff = draft.diff, changed = diff.changed, pages = Math.max(1, Math.ceil(changed.length / 20));
  return <section className="pymi-diff" aria-label="승인본과 변경 비교"><h3>현재 승인본과 비교</h3><p>추가 {diff.added.length}명 · 제외 {diff.removed.length}명 · 변경 {changed.length}명</p>
    {diff.added.length > 0 && <details><summary>추가 직원 {diff.added.length}명</summary><p>{diff.added.map(item => item.name).join(', ')}</p></details>}
    {diff.removed.length > 0 && <details><summary>제외 직원 {diff.removed.length}명</summary><p>{diff.removed.map(item => item.name).join(', ')}</p></details>}
    {changed.length > 0 && <details><summary>변경 금액 상세 {changed.length}명</summary><div className="pymi-changes">{changed.slice(page * 20, page * 20 + 20).map(item => <div key={item.userId}><strong>{item.name}</strong><dl>{item.fields.map(field => <div key={field.field}><dt>{labels[field.field] || field.field}</dt><dd>{valueText(field.before)} → {valueText(field.after)}</dd></div>)}</dl></div>)}</div><div className="pymi-pagination"><Button disabled={page === 0} onClick={() => setPage(value => value - 1)}>이전</Button><span>{page + 1} / {pages}</span><Button disabled={page + 1 >= pages} onClick={() => setPage(value => value + 1)}>다음</Button></div></details>}
    <dl className="pymi-diff-totals">{(['monthlyGross', 'totalDeductions', 'netPay'] as const).map(key => { const before = diff.totals.before?.[key]; return <div key={key}><dt>{labels[key]}</dt><dd>{before === undefined ? '이전 상세자료 없음' : won(before)} → {won(diff.totals.after[key])}</dd></div>; })}</dl></section>;
}

export function PayrollHistoryManager({ scope, onClose, onApproved }: { scope: string; onClose: () => void; onApproved: (year: number, month: number) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true), running = useRef(false), listSequence = useRef(0);
  const [tab, setTab] = useState<Tab>('IMPORT');
  const [year, setYear] = useState(String(currentYear)), [loadedYear, setLoadedYear] = useState(currentYear);
  const [drafts, setDrafts] = useState<PayrollDraftSummary[]>([]), [records, setRecords] = useState<PayrollRecordSummary[]>([]);
  const [draft, setDraft] = useState<PayrollDraft | null>(null), [versions, setVersions] = useState<PayrollDraftVersion[]>([]), [viewedVersion, setViewedVersion] = useState<number | null>(null);
  const [historyRecord, setHistoryRecord] = useState<PayrollRecordSummary | null>(null), [revisions, setRevisions] = useState<PayrollRevision[]>([]);
  const latestRevision = revisions.reduce((latest, item) => item.kind === 'APPROVED' ? Math.max(latest, item.revision) : latest, 0);
  const [correctionRecord, setCorrectionRecord] = useState<PayrollRecordSummary | null>(null);
  const [reason, setReason] = useState(''), [importReason, setImportReason] = useState(''), [correctionReason, setCorrectionReason] = useState('');
  const [period, setPeriod] = useState(currentMonth), [file, setFile] = useState<File | null>(null);
  const [inputs, setInputs] = useState<Record<string, AmountInputs>>({}), [dirty, setDirty] = useState(false);
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [expanded, setExpanded] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const isCurrent = useCallback(() => mounted.current && payrollSessionKey() === scope, [scope]);
  const editable = draft?.status === 'PENDING' && viewedVersion === null;
  const reasonValid = reason.trim().length >= 3;
  const filtered = (draft?.rows ?? []).filter(row => `${row.name} ${row.employeeNumber} ${row.divisionName} ${row.teamName}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 20)), safePage = Math.min(page, pages - 1);
  const preview = useMemo(() => {
    if (!draft) return { valid: false, rows: [], sums: null, refunds: 0 };
    try {
      const rows = draft.rows.map(row => ({ userId: row.userId, amounts: toAmounts(inputs[row.userId] ?? toInputs(row)) }));
      const sums = rows.reduce((total, row) => {
        for (const key of Object.keys(row.amounts) as Array<keyof PayrollAmounts>) { const sum = (total[key] ?? 0) + (row.amounts[key] ?? 0); if (!Number.isSafeInteger(sum)) throw new Error('합계 범위 오류'); total[key] = sum; }
        return total;
      }, {} as PayrollAmounts);
      return { valid: true, rows, sums, refunds: rows.filter(row => EDITABLE_AMOUNT_KEYS.some(key => (row.amounts[key] ?? 0) < 0)).length };
    } catch { return { valid: false, rows: [], sums: null, refunds: 0 }; }
  }, [draft, inputs]);
  useEffect(() => { mounted.current = true; const element = dialog.current; element?.showModal(); return () => { mounted.current = false; element?.close(); }; }, []);
  const refresh = useCallback(async (selectedYear: number) => {
    const sequence = ++listSequence.current;
    const [pending, approved] = await Promise.all([payrollService.listDrafts(selectedYear), payrollService.list(selectedYear)]);
    if (!isCurrent() || sequence !== listSequence.current) return;
    setDrafts(pending.drafts); setRecords(approved.records); setLoadedYear(selectedYear);
    return approved.records;
  }, [isCurrent]);
  useEffect(() => { void refresh(currentYear).catch(failure => { if (isCurrent()) setError(errorText(failure)); }); }, [refresh, isCurrent]);
  function displayDraft(value: PayrollDraft, version: number | null = null) {
    setDraft(value); setReason(value.reason); setInputs(Object.fromEntries(value.rows.map(row => [row.userId, toInputs(row)]))); setViewedVersion(version); setDirty(false); setSearch(''); setPage(0); setExpanded(''); setTab('PENDING');
  }
  async function perform<T>(label: string, action: () => Promise<T>, success: (value: T) => void | Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(label); setError(''); setMessage('');
    try { assertPayrollSession(scope); const value = await action(); if (isCurrent()) await success(value); }
    catch (failure) { if (isCurrent()) setError(errorText(failure)); }
    finally { running.current = false; if (isCurrent()) setBusy(''); }
  }
  function loadYear() {
    const value = Number(year); if (!Number.isInteger(value) || value < 2000 || value > 2200) { setError('조회 연도는 2000~2200년으로 입력해 주세요.'); return; }
    setDraft(null); setHistoryRecord(null); setRevisions([]); setCorrectionRecord(null);
    void perform('승인 및 대기 이력을 불러오는 중입니다.', () => refresh(value), () => {});
  }
  function template() {
    try { assertPayrollSession(scope); const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = '과거급여_표준양식.csv'; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (failure) { setError(errorText(failure)); }
  }
  function importFile() {
    if (!file || importReason.trim().length < 3) { setError('원본 파일과 3자 이상의 등록 사유를 입력해 주세요.'); return; }
    const [selectedYear, selectedMonth] = period.split('-').map(Number);
    if (!/^\d{4}-\d{2}$/.test(period) || period < '2000-01' || period > currentMonth || selectedMonth < 1 || selectedMonth > 12) { setError('원본 귀속월은 2000년 1월부터 현재 월까지 선택해 주세요.'); return; }
    const selectedFile = file;
    void perform('원본을 검증하고 승인 대기로 저장하고 있습니다.', async () => {
      const source = await readPayrollSourceFile(selectedFile, scope); assertPayrollSession(scope);
      return payrollService.importSource(selectedYear, selectedMonth, importReason.trim(), source);
    }, async result => { displayDraft(result.draft); setVersions([]); setFile(null); setMessage('원본 검증이 완료되어 승인 대기로 저장했습니다. 직원과 금액을 확인한 뒤 승인해 주세요.'); setYear(String(result.draft.year)); await refresh(result.draft.year); });
  }
  function openDraft(id: string) {
    void perform('검토 자료를 불러오는 중입니다.', async () => { const [detail, history] = await Promise.all([payrollService.getDraft(id), payrollService.listDraftVersions(id)]); return { detail, history }; }, result => { displayDraft(result.detail.draft); setVersions(result.history.versions); });
  }
  function openVersion(value: number) {
    if (!draft || dirty && !window.confirm('저장하지 않은 변경 내용을 닫고 보관 버전을 열겠습니까?')) return;
    void perform('초안 보관본을 불러오는 중입니다.', () => payrollService.getDraftVersion(draft.id, value), result => displayDraft(result.draft, value));
  }
  function saveDraft() {
    if (!draft || !editable || !preview.valid || !reasonValid) return;
    void perform('검토 내용을 새 초안 버전으로 저장하고 있습니다.', () => payrollService.updateDraft(draft.id, draft.draftVersion, reason.trim(), preview.rows), async result => {
      displayDraft(result.draft); const history = await payrollService.listDraftVersions(result.draft.id); if (!isCurrent()) return; setVersions(history.versions); setMessage('변경 내용과 사유를 저장했습니다. 비교 내역을 확인하고 승인해 주세요.'); await refresh(result.draft.year);
    });
  }
  function approveDraft() {
    if (!draft || !editable || dirty || !preview.valid || draft.stale || !reasonValid) return;
    if (!window.confirm(`${draft.year}년 ${draft.month}월 회사 전체 ${draft.rows.length}명의 자료를 승인·발행합니까?\n\n총 지급액: ${won(draft.sums.monthlyGross)}\n공제합계: ${won(draft.sums.totalDeductions)}\n실지급액: ${won(draft.sums.netPay)}\n추가 ${draft.diff.added.length}명 · 제외 ${draft.diff.removed.length}명 · 변경 ${draft.diff.changed.length}명\n환급 등 음수 공제 포함 ${preview.refunds}명\n\n이 월 전체를 새 개정본으로 발행합니다. 이전 승인본과 원본·수정 이력은 보관하며 연간 명세서에는 새 승인본이 반영됩니다. 승인 전까지 기존 승인본은 유지됩니다.`)) return;
    void perform('검토 자료를 승인하고 새 개정본을 발행하고 있습니다.', () => payrollService.approveDraft(draft.id, draft.draftVersion), async result => {
      setDraft(null); setVersions([]); setTab('HISTORY'); setHistoryRecord(null); setRevisions([]);
      setMessage(result.idempotent ? '이미 처리된 승인 요청입니다. 현재 승인본과 개정 이력을 다시 확인합니다.' : '승인·발행이 완료되었습니다. 이전 버전은 개정 이력에서 확인할 수 있습니다.');
      onApproved(result.record.year, result.record.month); setYear(String(result.record.year));
      const currentRecords = await refresh(result.record.year);
      if (!isCurrent()) return;
      const current = currentRecords?.find(record => record.id === result.record.id && !record.legacy);
      if (!current) throw new Error('현재 승인본을 확인하지 못했습니다. 조회를 다시 실행해 주세요. 승인 결과와 이력은 서버에 보관됩니다.');
      const history = await payrollService.listRevisions(current.id);
      if (isCurrent()) { setHistoryRecord(current); setRevisions(history.revisions); }
    });
  }
  function cancelDraft() {
    if (!draft || !editable || !reasonValid || !window.confirm('승인 대기 자료를 취소합니까? 원본·초안 이력은 보관하며 현재 승인본은 유지됩니다.')) return;
    void perform('승인 대기 자료를 취소하고 있습니다.', () => payrollService.cancelDraft(draft.id, draft.draftVersion, reason.trim()), async result => { displayDraft(result.draft); setMessage('초안을 취소했습니다. 현재 승인본은 변경되지 않았습니다.'); await refresh(result.draft.year); });
  }
  function startCorrection() {
    if (!correctionRecord || correctionReason.trim().length < 3) return;
    void perform('현재 승인본으로 정정 초안을 만들고 있습니다.', () => payrollService.startCorrection(correctionRecord.id, correctionReason.trim()), async result => { displayDraft(result.draft); setVersions([]); setCorrectionRecord(null); setMessage('현재 승인본의 정정 초안을 만들었습니다. 실제 지급·공제액을 검토해 주세요.'); await refresh(result.draft.year); });
  }
  function showRevisions(record: PayrollRecordSummary) { setCorrectionRecord(null); void perform('승인·개정 이력을 불러오는 중입니다.', () => payrollService.listRevisions(record.id), result => { setHistoryRecord(record); setRevisions(result.revisions); }); }
  function downloadRevision(id: string, revision?: number) { void perform('보관 승인본 PDF를 생성하고 있습니다.', () => payrollService.monthlyPdf(id, revision), file => downloadPayrollPdf(file, scope)); }
  function downloadSource(selector: PayrollSourceSelector) { void perform('보관 원본을 내려받고 있습니다.', () => payrollService.sourceDownload(selector), file => downloadPayrollSourceFile(file, scope)); }
  function changeTab(value: Tab) {
    if (busy || value === tab || dirty && !window.confirm('저장하지 않은 변경 내용을 닫고 이동합니까?')) return;
    setTab(value); setDraft(null); setVersions([]); setHistoryRecord(null); setRevisions([]); setCorrectionRecord(null); setDirty(false); setError('');
  }
  function close() { if (!busy && (!dirty || window.confirm('저장하지 않은 변경 내용이 있습니다. 창을 닫겠습니까?'))) onClose(); }

  return <dialog ref={dialog} className="pymi-dialog" aria-label="과거 급여 등록·정정" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="pymi-head"><div><h2>과거 급여 등록·정정</h2><p>회사별 원본과 승인·개정 이력을 보관합니다.</p></div><Button aria-label="과거 급여 등록·정정 닫기" disabled={!!busy} onClick={close}><X size={19} /></Button></header>
    <nav className="pymi-tabs" aria-label="급여 원장 관리 메뉴">{([['IMPORT', '원본 등록'], ['PENDING', '검토 대기'], ['HISTORY', '승인·개정 이력']] as const).map(([key, label]) => <Button key={key} disabled={!!busy} aria-pressed={tab === key} onClick={() => changeTab(key)}>{label}{key === 'PENDING' ? ` (${drafts.filter(item => item.status === 'PENDING').length})` : ''}</Button>)}</nav>
    <div className="pymi-body">{error && <p className="pymi-alert pymi-error" role="alert">{error}</p>}{message && <p className="pymi-alert pymi-success" role="status">{message}</p>}{busy && <p className="pymi-busy" role="status"><Loader2 size={17} className="animate-spin" />{busy}</p>}
      {tab === 'IMPORT' && <section className="pymi-import"><div className="pymi-section-heading"><div><h3>과거 급여 원본 등록</h3><p>실제 지급·공제 금액을 기록합니다. 현재 세액표로 다시 계산하지 않습니다.</p></div><Button disabled={!!busy} onClick={template}><Download size={16} />표준 CSV 양식</Button></div><div className="pymi-instructions"><ol><li>표준 CSV의 열 이름을 유지해 작성하거나 Excel에서 XLSX로 저장합니다. 한 파일에는 한 달의 회사 전체 자료를 입력합니다.</li><li>직원 로그인 ID 또는 과거 직원 코드 중 하나만 입력합니다. 과거 직원 코드는 삭제된 퇴사자의 회사 내부 식별자이며 로그인 계정을 만들지 않습니다. 이름으로 직원을 연결하지 않습니다.</li><li>필수 금액은 0원도 직접 입력합니다. 기타 공제는 생략 시 0원입니다. 합계 열은 생략할 수 있으나 입력하면 항목 합계와 일치해야 합니다.</li><li>수식 대신 계산 결과를 값으로 붙여넣으세요. 공제 환급은 음수로 입력할 수 있습니다.</li></ol><p>같은 월의 승인본이 있으면 이번 파일의 전체 명단과 금액으로 교체하는 초안이 만들어집니다. 직원 추가·제외도 새 월별 원본으로 등록합니다. 기존 승인본은 재승인까지 유지됩니다.</p></div><div className="pymi-import-fields"><label>급여 귀속월<Input type="month" aria-label="과거 급여 원본 귀속월" min="2000-01" max={currentMonth} value={period} disabled={!!busy} onChange={event => setPeriod(event.target.value)} /></label><label>원본 파일 (CSV·XLSX, 3MB 이하)<Input type="file" aria-label="과거 급여 원본 파일" accept=".csv,.xlsx" disabled={!!busy} onChange={event => setFile(event.target.files?.[0] ?? null)} /></label><label className="pymi-full">등록 사유<Textarea aria-label="과거 급여 등록 사유" minLength={3} maxLength={1000} value={importReason} disabled={!!busy} onChange={event => setImportReason(event.target.value)} placeholder="등록 사유를 3자 이상 입력하세요." /></label></div>{file && <p className="pymi-note">선택: {file.name} · {(file.size / 1024).toFixed(1)}KB. 원본은 회사 전용 공간에 보관됩니다.</p>}<Button className="wf-btn-primary" disabled={!!busy || !file || importReason.trim().length < 3} onClick={importFile}><FileUp size={17} />원본 검증·승인 대기 저장</Button></section>}
      {tab !== 'IMPORT' && !draft && <div className="pymi-year-filter"><label>조회 연도<Input type="number" aria-label="급여 원장 조회 연도" min={2000} max={2200} value={year} disabled={!!busy} onChange={event => setYear(event.target.value)} /></label><Button disabled={!!busy} onClick={loadYear}>조회</Button><span>{loadedYear}년 자료</span></div>}
      {tab === 'PENDING' && !draft && <section><h3>검토 대기 및 초안 이력</h3><p className="pymi-note">초안은 승인 전까지 PDF와 연간 명세서에 반영되지 않습니다.</p><div className="pymi-list">{drafts.map(item => <article key={item.id}><div><strong>{item.year}년 {item.month}월 · {item.kind === 'IMPORT' ? '과거 원본' : '승인본 정정'}</strong><p>{item.status === 'PENDING' ? '승인 대기' : item.status === 'APPROVED' ? '승인 완료' : '취소'} · 초안 {item.draftVersion} · {item.updatedByName} · {stamp(item.updatedAtIso)}</p><p>{item.reason}</p>{item.stale && <p className="pymi-warning">기준 승인본이 변경되었습니다.</p>}</div><Button disabled={!!busy} onClick={() => openDraft(item.id)}>검토·이력</Button></article>)}</div>{!drafts.length && <p className="pymi-empty">조회 연도의 검토 자료가 없습니다.</p>}</section>}
      {tab === 'PENDING' && draft && <section className="pymi-review"><div className="pymi-section-heading"><div><h3>{draft.year}년 {draft.month}월 {draft.kind === 'IMPORT' ? '과거 원본 검토' : '승인본 정정'}</h3><p>초안 {draft.draftVersion} · {draft.status === 'PENDING' ? '승인 대기' : draft.status === 'APPROVED' ? '승인 완료' : '취소'} · {draft.updatedByName} · {stamp(draft.updatedAtIso)}</p></div><Button disabled={!!busy} onClick={() => { if (!dirty || window.confirm('저장하지 않은 변경 내용을 닫겠습니까?')) { setDraft(null); setDirty(false); } }}>목록으로</Button></div>
        <div className="pymi-version-filter"><label>초안 보관 버전<Select aria-label="급여 초안 보관 버전" disabled={!!busy} value={viewedVersion ?? ''} onChange={event => { if (!event.target.value) openDraft(draft.id); else openVersion(Number(event.target.value)); }}><option value="">현재 초안</option>{versions.map(item => <option key={item.draftVersion} value={item.draftVersion}>초안 {item.draftVersion} · {item.updatedByName} · {stamp(item.updatedAtIso)}</option>)}</Select></label>{draft.source && <div className="pymi-source"><span>{draft.source.name} · {(draft.source.size / 1024).toFixed(1)}KB</span><Button disabled={!!busy} onClick={() => downloadSource({ draftId: draft.id })}><Download size={16} />등록 원본</Button></div>}</div>
        {viewedVersion !== null && <p className="pymi-alert pymi-warning">초안 {viewedVersion} 보관본을 읽고 있습니다. 현재 초안을 선택하면 검토를 계속할 수 있습니다.</p>}{draft.stale && <p className="pymi-alert pymi-warning">기준 승인본이 변경되어 승인할 수 없습니다. 초안을 취소하고 최신 승인본에서 정정을 시작하거나 원본을 다시 등록해 주세요.</p>}<p className="pymi-note">변경 내용을 저장해야 비교 내역과 승인에 반영됩니다. 직원 추가·제외는 전체 월별 원본으로 등록하세요.</p>
        <label>검토·정정 사유<Textarea aria-label="급여 검토·정정 사유" minLength={3} maxLength={1000} value={reason} disabled={!editable || !!busy} onChange={event => { setReason(event.target.value); setDirty(true); }} /></label><div className="pymi-totals"><div><span>직원 수</span><strong>{draft.rows.length}명</strong></div>{(['monthlyGross', 'totalDeductions', 'netPay'] as const).map(key => <div key={key}><span>{labels[key]}</span><strong>{preview.sums ? won(preview.sums[key]) : '금액 확인 필요'}</strong></div>)}</div>{!preview.valid && <p className="pymi-warning" role="alert">지급합계·비과세액은 0 이상의 정수이며 비과세액은 지급합계 이하여야 합니다. 공제액은 환급을 포함한 원 단위 정수로 입력하세요.</p>}
        <label>직원 검색<Input type="search" aria-label="급여 원장 직원 검색" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} placeholder="이름·사번·부서 검색" /></label><div className="pymi-pagination"><span>{filtered.length}명 · {safePage + 1} / {pages}</span><Button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>이전 20명</Button><Button disabled={safePage + 1 >= pages} onClick={() => setPage(safePage + 1)}>다음 20명</Button></div><div className="pymi-roster">{filtered.slice(safePage * 20, safePage * 20 + 20).map(row => {
          let amount: PayrollAmounts | null = null; try { amount = toAmounts(inputs[row.userId] ?? toInputs(row)); } catch { /* Keep invalid local input visible until corrected. */ }
          return <article key={row.userId}><header><div><strong>{row.name}</strong><p>{[row.employeeNumber, row.divisionName, row.teamName].filter(Boolean).join(' · ') || '부서·사번 미등록'}</p><p>지급 {amount ? won(amount.monthlyGross) : '확인 필요'} · 실지급 {amount ? won(amount.netPay) : '확인 필요'}</p></div><Button aria-expanded={expanded === row.userId} onClick={() => setExpanded(expanded === row.userId ? '' : row.userId)}>{editable ? '금액 수정' : '금액 보기'}</Button></header>{expanded === row.userId && <div className="pymi-row-fields">{EDITABLE_AMOUNT_KEYS.map(key => <label key={key}>{labels[key]}<Input inputMode="decimal" aria-label={`${row.name} ${labels[key]}`} value={(inputs[row.userId] ?? toInputs(row))[key]} disabled={!editable || !!busy} onChange={event => { setInputs(previous => ({ ...previous, [row.userId]: { ...(previous[row.userId] ?? toInputs(row)), [key]: event.target.value } })); setDirty(true); }} /></label>)}{(['basePay', 'totalInsurance', 'totalDeductions', 'netPay'] as const).map(key => <div className="pymi-derived" key={key}><span>{labels[key]}</span><output>{amount ? won(amount[key]) : '확인 필요'}</output></div>)}</div>}</article>;
        })}</div>{!filtered.length && <p className="pymi-empty">검색 조건에 맞는 직원이 없습니다.</p>}<DiffView key={`${draft.id}-${draft.draftVersion}-${viewedVersion}`} draft={draft} />{dirty && <p className="pymi-warning">저장하지 않은 변경사항이 있습니다. 저장 후 서버의 비교 내역을 확인해 주세요.</p>}<div className="pymi-footer-actions">{editable && <><Button disabled={!!busy || !dirty || !preview.valid || !reasonValid} onClick={saveDraft}><Save size={16} />검토 내용 저장</Button><Button className="wf-btn-primary" disabled={!!busy || dirty || !preview.valid || !reasonValid || draft.stale} onClick={approveDraft}>검토 완료·승인 발행</Button><Button disabled={!!busy || !reasonValid} onClick={cancelDraft}>초안 취소</Button></>}</div>
      </section>}
      {tab === 'HISTORY' && <section><h3>승인본 및 개정 이력</h3><p className="pymi-note">현재 승인본이 연간 명세서에 반영됩니다. 이전 승인본 PDF와 원본은 각 개정 버전으로 보관됩니다.</p><div className="pymi-list">{records.map(record => <article key={record.id}><div><strong>{record.year}년 {record.month}월 · {record.legacy ? '이전 집계' : `현재 승인본 · 개정 ${record.revision ?? 1}`}</strong><p>{record.employeeCount}명 · 지급 {won(record.totalGross)} · 실지급 {won(record.totalNet)}</p><p>{record.approvedByName} · {stamp(record.approvedAtIso)}</p></div><div className="pymi-list-actions">{record.legacy ? <Button disabled={!!busy} onClick={() => { setPeriod(`${record.year}-${String(record.month).padStart(2, '0')}`); changeTab('IMPORT'); }}>상세 원본 등록</Button> : <><Button disabled={!!busy} onClick={() => showRevisions(record)}>개정 이력</Button><Button disabled={!!busy} onClick={() => { setCorrectionRecord(record); setCorrectionReason(''); }}>정정 시작</Button></>}</div></article>)}</div>{!records.length && <p className="pymi-empty">조회 연도의 승인본이 없습니다.</p>}
        {correctionRecord && <section className="pymi-correction"><h3>{correctionRecord.year}년 {correctionRecord.month}월 정정 초안 생성</h3><p>현재 승인본 전체를 복사합니다. 재승인 전에는 기존 발행본이 유지됩니다.</p><label>정정 사유<Textarea aria-label="급여 정정 시작 사유" minLength={3} maxLength={1000} value={correctionReason} disabled={!!busy} onChange={event => setCorrectionReason(event.target.value)} /></label><Button disabled={!!busy || correctionReason.trim().length < 3} onClick={startCorrection}>정정 초안 만들기</Button></section>}
        {historyRecord && <section className="pymi-revisions"><h3>{historyRecord.year}년 {historyRecord.month}월 발행 이력</h3><p className="pymi-note">보관 원본은 등록 당시 파일입니다. 이후 정정 금액은 각 개정 PDF와 초안 수정 이력에서 확인하세요.</p><div className="pymi-list">{revisions.map((item, index) => <article key={`${item.kind}-${item.kind === 'APPROVED' ? item.revision : index}`}><div><strong>{item.kind === 'LEGACY' ? '이전 집계 · 상세자료 없음' : `개정 ${item.revision}${item.revision === latestRevision ? ' · 현재 승인본' : ' · 이전 승인본'}`}</strong><p>{item.approvedByName} · {stamp(item.approvedAtIso)}</p><p>사유: {item.reason || '최초 발행'}</p><p>지급 {won(item.totalGross)} · 실지급 {won(item.totalNet)}</p></div><div className="pymi-list-actions">{item.kind === 'APPROVED' && item.pdfAvailable && <Button disabled={!!busy} onClick={() => downloadRevision(historyRecord.id, item.revision)}><Download size={16} />개정 {item.revision} PDF</Button>}{item.kind === 'APPROVED' && item.source && <Button disabled={!!busy} onClick={() => downloadSource({ recordId: historyRecord.id, revision: item.revision })}>보관 원본</Button>}</div></article>)}</div>{!revisions.length && <p className="pymi-empty">발행 이력이 없습니다.</p>}</section>}
      </section>}
    </div>
  </dialog>;
}
