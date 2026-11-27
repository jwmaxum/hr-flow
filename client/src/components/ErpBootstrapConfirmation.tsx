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
  const unavailable = !protection || typeof protection.hasExistingData !== 'boolean';
  const disabled = unavailable || busy || dirty || !acknowledged;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (!reset) { onCommit(); return; }
    const input = password.current;
    if (!input?.value) return;
    const credential = input.value;
    input.value = '';
    onCommit({ warningAccepted: acknowledged, password: credential });
  }
  return <form onSubmit={submit}>
    {unavailable ? <p className="erp-error" role="alert">장부 보호 상태를 확인할 수 없어 확정할 수 없습니다. 잠시 후 새로고침하고 다시 미리보기해 주세요.</p> :
      <fieldset className={reset ? 'erp-bootstrap-warning' : 'erp-bootstrap-initial'} disabled={busy || dirty}>
        <legend>{reset ? '전체 초기화 경고' : '최초 이관 확인'}</legend>
        {reset && <div role="alert">
          <p><ShieldAlert size={20} aria-hidden="true" /> <strong>{companyName}의 기존 ERP 문서 {protection.existingDocumentCount.toLocaleString('ko-KR')}건이 있어 일반 재이관이 차단되었습니다.</strong></p>
          <p>전체 초기화는 기존 재고·거래·미수금과 마감·승인 내역을 활성 장부에서 제거하고 업로드한 자료로 교체합니다. 시스템은 기존 장부를 DB에 자동 백업하고 복제 장부의 복원·대사가 완료된 후 교체합니다.</p>
        </div>}
        <label className="erp-active-field">
          <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} />
          {reset ? '빨간 경고를 확인했으며 기존 ERP 전체 초기화와 재이관에 동의합니다.' : `${companyName}의 최초 기초자료로 반영할 내역을 확인했습니다.`}
        </label>
        {reset && acknowledged && <div className="erp-bootstrap-credentials">
          <label className="wf-field">
            <span>현재 회사 ADMIN 비밀번호</span>
            <input ref={password} type="password" className="wf-input" required autoComplete="current-password" />
          </label>
        </div>}
      </fieldset>}
    <div className="erp-actions">
      <button type="button" className="wf-btn" disabled={busy} onClick={onCancel}>검토 취소</button>
      <button type="submit" className={`wf-btn wf-btn-primary${reset ? ' erp-bootstrap-reset' : ''}`} disabled={disabled}>
        <FileCheck2 size={16} aria-hidden="true" /> {reset ? 'ADMIN 인증 후 백업·전체 재이관' : '기초자료 이관 확정'}
      </button>
    </div>
  </form>;
}
