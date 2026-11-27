import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { FileCheck2, ShieldAlert } from 'lucide-react';
import type { ErpBootstrapJob } from '../services/erpImportService';

type ResetConfirmation = { warningAccepted: boolean; password: string };
const checks = [
  ['inventory', '재고'], ['receivables', '미수잔액'], ['bundles', '세트 구성'],
  ['pendingCosts', '원가 미확정 수량'], ['monthCloses', '월마감 관련 기록'], ['approvals', '승인·감사 기록'],
] as const;

export function ErpBootstrapBackupResult({ backup }: { backup: NonNullable<ErpBootstrapJob['backup']> }) {
  const result = backup.reconciliation;
  return <div className="erp-bootstrap-backup" role="status">
    <strong>{result.verified ? '기존 장부 DB 백업·복원 대사 완료' : '기존 장부 대사 결과를 확인해 주세요.'}</strong>
    <p>백업 번호 <code>{backup.id}</code> · 원본 대조 문서 {result.documentCount.toLocaleString('ko-KR')}건</p>
    {result.verified && <ul>{checks.map(([key, label]) =>
      <li key={key}>{label} · {result.checks[key].count.toLocaleString('ko-KR')}건 일치
        {key === 'monthCloses' && Number.isInteger(backup.counts?.erpMonthCloses) && ` (마감 보관 문서 ${backup.counts.erpMonthCloses.toLocaleString('ko-KR')}건)`}
        {key === 'approvals' && Number.isInteger(backup.counts?.erpApprovals) && ` (승인 요청 문서 ${backup.counts.erpApprovals.toLocaleString('ko-KR')}건)`}
      </li>)}</ul>}
  </div>;
}

export function ErpLedgerComparisonTable({ comparison }: {comparison: NonNullable<ErpBootstrapJob['comparison']>}) {
  const {previous, incoming} = comparison;
  const rows: [string, number, number, string][] = [
    ['재고수량', previous.inventoryQuantity, incoming.inventoryQuantity, ''],
    ['재고금액', previous.inventoryValue, incoming.inventoryValue, '원'],
    ['세트 품목', previous.bundleCount, incoming.bundleCount, '종'],
    ['원가 미확정 수량', previous.pendingQuantity, incoming.pendingQuantity, ''],
    ['월마감 문서', previous.monthCloseCount, incoming.monthCloseCount, '건'],
    ['승인 문서', previous.approvalCount, incoming.approvalCount, '건']
  ];
  if (previous.pendingUnknownCount || incoming.pendingUnknownCount) {
    rows.push(['대기 수량 미입력 품목', previous.pendingUnknownCount ?? 0, incoming.pendingUnknownCount ?? 0, '종']);
  }
  const oldBalances = new Map(previous.receivableTotals.map(row => [row.currency, row.amountMinor]));
  const newBalances = new Map(incoming.receivableTotals.map(row => [row.currency, row.amountMinor]));
  for (const currency of new Set([...oldBalances.keys(), ...newBalances.keys()])) {
    const scale = ['KRW', 'JPY'].includes(currency) ? 1 : 100;
    rows.push(['미수잔액', (oldBalances.get(currency) ?? 0) / scale, (newBalances.get(currency) ?? 0) / scale, currency]);
  }
  const display = (value: number, unit: string) => value.toLocaleString('ko-KR', {maximumFractionDigits: 4}) + (unit ? ' ' + unit : '');
  return <div className="erp-table-scroll">
    <table className="erp-table"><caption>기존 장부와 업로드 자료 비교</caption>
      <thead><tr><th>항목</th><th className="erp-number">기존 장부</th><th className="erp-number">업로드 자료</th><th className="erp-number">증감</th></tr></thead>
      <tbody>{rows.map(([name, oldValue, newValue, unit]) => <tr key={name + unit}>
        <th scope="row">{name}</th><td className="erp-number">{display(oldValue, unit)}</td><td className="erp-number">{display(newValue, unit)}</td>
        <td className="erp-number">{newValue > oldValue ? '+' : ''}{display(newValue - oldValue, unit)}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export function ErpBootstrapConfirmation({ job, companyName, busy, dirty, onCancel, onCommit }: {
  job: ErpBootstrapJob;
  companyName: string;
  busy: boolean;
  dirty: boolean;
  onCancel: () => void;
  onCommit: (reset?: ResetConfirmation) => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const protection = job.protection;
  const reset = protection?.hasExistingData === true;
  const repair = Boolean(job.stageConflict?.challenge);
  const repaired = !repair && Boolean(protection?.repairChallengeIssuedAt);
  const needsPassword = reset || repair || repaired;
  const unavailable = !protection || typeof protection.hasExistingData !== 'boolean' || (job.stage?.status === 'MISMATCH' && !repair);
  const disabled = unavailable || busy || dirty || !acknowledged;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (!needsPassword) { onCommit(); return; }
    const input = password.current;
    if (!input?.value) return;
    const credential = input.value;
    input.value = '';
    onCommit({ warningAccepted: acknowledged, password: credential });
  }
  return <form onSubmit={submit}>
    {unavailable ? <p className="erp-error" role="alert">장부 보호 상태를 확인할 수 없어 확정할 수 없습니다. 잠시 후 새로고침하고 다시 미리보기해 주세요.</p> :
      <fieldset className={needsPassword ? 'erp-bootstrap-warning' : 'erp-bootstrap-initial'} disabled={busy || dirty}>
        <legend>{repair ? '업로드 자료로 새 장부 재작성 경고' : repaired ? '재작성한 장부 전환 확인' : reset ? '전체 초기화 경고' : '최초 이관 확인'}</legend>
        {repair ? <div role="alert">
          <p><ShieldAlert size={20} aria-hidden="true" /> <strong>준비한 새 장부와 업로드 자료가 일치하지 않아 전환을 멈췄습니다.</strong></p>
          <p>아래 경고를 확인하고 ADMIN 비밀번호를 다시 입력하면 업로드 자료로 별도 버전을 재작성합니다. 재대사가 통과하면 그 버전으로 전환합니다.</p>
        </div> : repaired ? <p role="alert">업로드 자료로 재작성한 장부를 전환하려면 ADMIN 비밀번호를 다시 입력해 주세요.</p> : reset && <div role="alert">
          <p><ShieldAlert size={20} aria-hidden="true" /> <strong>{companyName}의 기존 ERP 문서 {protection.existingDocumentCount.toLocaleString('ko-KR')}건이 있어 일반 재이관이 차단되었습니다.</strong></p>
          <p>기존 장부를 DB에 자동 백업합니다. 기존 장부와 업로드 자료 사이에 차이가 있으면 업로드 자료를 적용합니다. 새 버전이 업로드 자료와 일치하고 백업 복원 대사가 끝난 뒤 전환합니다.</p>
        </div>}
        <label className="erp-active-field">
          <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
          {repair ? '업로드 자료로 새 장부를 재작성하고 검증 후 전환하는 데 동의합니다.' : repaired ? '재작성한 장부의 검증 결과를 확인하고 전환에 동의합니다.' : reset ? '빨간 경고를 확인했으며 기존 ERP 전체 초기화와 재이관에 동의합니다.' : `${companyName}의 최초 기초자료로 반영할 내역을 확인했습니다.`}
        </label>
        {needsPassword && acknowledged && <div className="erp-bootstrap-credentials">
          <label className="wf-field">
            <span>현재 회사 ADMIN 비밀번호</span>
            <input ref={password} type="password" className="wf-input" required autoComplete="current-password" />
          </label>
        </div>}
      </fieldset>}
    <div className="erp-actions">
      <button type="button" className="wf-btn" disabled={busy} onClick={onCancel}>검토 취소</button>
      <button type="submit" className={`wf-btn wf-btn-primary${needsPassword ? ' erp-bootstrap-reset' : ''}`} disabled={disabled}>
        <FileCheck2 size={16} aria-hidden="true" /> {repair ? 'ADMIN 재인증 후 새 장부 재작성' : repaired ? 'ADMIN 인증 후 검증된 장부 전환' : reset ? 'ADMIN 인증 후 백업·전체 재이관' : '기초자료 이관 확정'}
      </button>
    </div>
  </form>;
}
