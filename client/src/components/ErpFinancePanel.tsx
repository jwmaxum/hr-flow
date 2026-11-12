import { ErpSettlementPanel } from './ErpSettlementPanel';
import { useEffect, useRef, useState } from 'react';
import { erpChoices, erpFinance as api, erpMoney as money, erpToday } from '../services/erpAccountService';
import type { ReceiptInput, ReceiptJob, ReceivableReport } from '../services/erpAccountService';
import type { ErpRecord } from '../services/erpService';
import { getErrorMessage } from '../utils/errors';
const labels: Record<string, string> = { SALE: '출고 매출', SALES_RETURN: '판매 반품', CANCEL: '취소', RECEIPT: '수금', REFUND: '환불', BANK: '계좌이체', CASH: '현금', CARD: '카드', OTHER: '기타' };
export function ErpFinancePanel({companyId}: {companyId: string}) {
  const [settlementVersion,setSettlementVersion] = useState(0);
  const [from, setFrom] = useState('2000-01-01'), [to, setTo] = useState(erpToday), [filter, setFilter] = useState('');
  const [partners, setPartners] = useState<ErpRecord[]>([]), [report, setReport] = useState<ReceivableReport | null>(null);
  const [input, setInput] = useState<ReceiptInput>({type: 'RECEIPT', date: erpToday(), partnerId: '', currency: 'KRW', amount: '', method: 'BANK', reference: '', notes: ''});
  const [job, setJob] = useState<ReceiptJob | null>(null), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const live = useRef(true), lock = useRef(false), attempt = useRef(crypto.randomUUID());
  useEffect(() => { live.current = true; void Promise.all([erpChoices(companyId, 'partners'), api.report(companyId, '2000-01-01', erpToday())]).then(([p, r]) => {if (live.current) {setPartners(p); setReport(r);}}).catch(e => {if (live.current) setError(getErrorMessage(e));}).finally(() => {if (live.current) setBusy(false);}); return () => {live.current = false;}; }, [companyId]);
  function change(patch: Partial<ReceiptInput>) {setInput(v => ({...v, ...patch})); setJob(null); setConfirm(false); setError(''); attempt.current = crypto.randomUUID();}
  async function run(work: () => Promise<void>) {if (busy || lock.current) return; lock.current = true; setBusy(true); setError(''); try {await work();} catch (e) {if (live.current) setError(getErrorMessage(e));} finally {lock.current = false; if (live.current) setBusy(false);}}
  async function query() {const result = await api.report(companyId, from, to, filter); if (live.current) setReport(result);}
  const done = job?.status === 'COMMITTED';
  return <div className="erp-movement" aria-busy={busy}>
    <section className="wf-panel" aria-label="거래처별 미수금"><h2 className="wf-section-title">거래처별 미수금·수금</h2>
      <p className="wf-muted">출고·반품·취소를 반영한 부가세 포함 잔액입니다. 통화별로 구분하며, PDF 발행은 매출을 중복 생성하지 않습니다. 이전에 받은 돈은 수금 원장에 등록해야 반영됩니다.</p>
      <form onSubmit={e => {e.preventDefault(); void run(query);}}><fieldset disabled={busy} className="erp-form-fields">
        <label className="wf-field"><span>미수금 조회 시작일</span><input className="wf-input" type="date" required value={from} onChange={e => {setFrom(e.target.value); setReport(null);}} /></label>
        <label className="wf-field"><span>미수금 조회 종료일</span><input className="wf-input" type="date" required value={to} onChange={e => {setTo(e.target.value); setReport(null);}} /></label>
        <label className="wf-field"><span>조회 거래처</span><select className="wf-input" value={filter} onChange={e => {setFilter(e.target.value); setReport(null);}}><option value="">전체 거래처</option>{partners.map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label>
        <div className="erp-actions"><button className="wf-btn wf-btn-primary">미수금 조회</button></div>
      </fieldset></form>
      <div className="erp-table-scroll"><table className="erp-table"><caption>거래처·통화별 잔액</caption><thead><tr><th>거래처</th><th>통화</th><th>이월잔액</th><th>순매출액</th><th>부가세</th><th>청구합계</th><th>순수금액</th><th>미수잔액</th><th>처리</th></tr></thead><tbody>{report?.rows.map(r => <tr key={`${r.partnerId}:${r.currency}`}><td>{r.partnerName}</td><td>{r.currency}</td>{(['opening', 'sales', 'tax', 'billed', 'receipts', 'balance'] as const).map(k => <td key={k} className="erp-number">{money(r[k], r.currency)}</td>)}<td><button className="wf-btn" disabled={busy || r.balance === 0} onClick={() => change({type: r.balance < 0 ? 'REFUND' : 'RECEIPT', partnerId: r.partnerId, currency: r.currency, amount: '', sourceId: undefined})}>{r.balance < 0 ? '환불 등록' : '수금 등록'}</button></td></tr>)}</tbody></table></div>
      {report && !report.rows.length && <p>조회 기간까지의 출고·수금 내역이 없습니다.</p>}
      <p className="wf-muted">순수금액 = 수금 − 환불 ± 수금 취소. 음수 잔액은 판매 반품 등으로 고객에게 돌려줄 잔액입니다. 서로 다른 통화는 합산하지 않습니다.</p>
    </section>
    <section className="wf-panel" aria-label="수금 등록"><h2 className="wf-section-title">수금·환불 등록</h2>
      <form onSubmit={e => {e.preventDefault(); void run(async () => {const r = await api.preview(companyId, attempt.current, input.type === 'CANCEL' ? {type: input.type, date: input.date, notes: input.notes, sourceId: input.sourceId} : {type: input.type, date: input.date, notes: input.notes, partnerId: input.partnerId, currency: input.currency, amount: input.amount, method: input.method, reference: input.reference}); if (live.current) {setJob(r.job); setConfirm(false);}});}}>
        <fieldset disabled={busy || done} className="erp-form-fields">
          <label className="wf-field"><span>수금 처리유형</span><select className="wf-input" value={input.type} onChange={e => change({type: e.target.value as ReceiptInput['type']})}><option value="RECEIPT">수금</option><option value="REFUND">환불</option>{input.sourceId && <option value="CANCEL">원수금·환불 취소</option>}</select></label>
          <label className="wf-field"><span>수금 처리일 *</span><input className="wf-input" type="date" required value={input.date} onChange={e => change({date: e.target.value})} /></label>
          {input.type !== 'CANCEL' && <><label className="wf-field"><span>수금 거래처 *</span><select className="wf-input" required value={input.partnerId} onChange={e => change({partnerId: e.target.value})}><option value="">선택</option>{partners.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label>
            <label className="wf-field"><span>수금 통화</span><select className="wf-input" value={input.currency} onChange={e => change({currency: e.target.value})}>{['KRW', 'USD', 'EUR', 'JPY', 'CNY'].map(c => <option key={c}>{c}</option>)}</select></label>
            <label className="wf-field"><span>수금·환불 금액 *</span><input className="wf-input" required inputMode="decimal" value={input.amount} onChange={e => change({amount: e.target.value})} /></label>
            <label className="wf-field"><span>수금 방법</span><select className="wf-input" value={input.method} onChange={e => change({method: e.target.value})}>{['BANK', 'CASH', 'CARD', 'OTHER'].map(m => <option key={m} value={m}>{labels[m]}</option>)}</select></label>
            <label className="wf-field"><span>거래 참조번호</span><input className="wf-input" maxLength={100} value={input.reference} onChange={e => change({reference: e.target.value})} /></label></>}
          <label className="wf-field"><span>수금 처리 사유 *</span><input className="wf-input" required maxLength={500} value={input.notes} onChange={e => change({notes: e.target.value})} /></label>
          <div className="erp-actions"><button className="wf-btn wf-btn-primary">수금 검증·미리보기</button></div>
        </fieldset></form>
      {job && <div aria-label="수금 미리보기"><p>{job.entry.partnerName} · {labels[job.entry.type]} {money(job.entry.amountMinor, job.entry.currency)} {job.entry.currency} · {job.entry.date}</p><p>미수잔액: {money(job.before, job.entry.currency)} → {money(job.after, job.entry.currency)} {job.entry.currency}</p>
        {done ? <p role="status" className="erp-success">수금 원장 반영 완료</p> : <><label className="erp-active-field"><input type="checkbox" disabled={busy} checked={confirm} onChange={e => setConfirm(e.target.checked)} />거래처·통화·금액과 잔액을 확인했습니다.</label><button className="wf-btn wf-btn-primary" disabled={busy || !confirm} onClick={() => void run(async () => {const r = await api.commit(companyId, job); if (live.current) {setJob(r.job);setSettlementVersion(v=>v+1);} await query();})}>수금 처리 확정</button></>}
        <button className="wf-btn" disabled={busy} onClick={() => change({type: 'RECEIPT', sourceId: undefined, amount: '', notes: ''})}>{done ? '새 수금 등록' : '입력 재검토'}</button></div>}
    </section>
    <ErpSettlementPanel companyId={companyId} refreshKey={settlementVersion} />
    <section className="wf-panel"><h2 className="wf-section-title">매출·수금 상세 내역</h2><div className="erp-table-scroll"><table className="erp-table"><thead><tr><th>일자</th><th>거래처</th><th>유형·참조</th><th>청구금액</th><th>수금액</th><th>비고</th><th>처리</th></tr></thead><tbody>{report?.events.map(r => <tr key={r.id}><td>{r.date}</td><td>{r.partnerName}</td><td>{labels[r.kind] || r.kind}<small className="erp-cell-note">{r.documentNo}</small></td><td>{money(r.gross, r.currency)} {r.currency}</td><td>{money(r.receipt, r.currency)} {r.currency}</td><td>{labels[r.method || '']} {r.notes}</td><td>{['RECEIPT', 'REFUND'].includes(r.kind) && <button className="wf-btn" disabled={busy} onClick={() => change({type: 'CANCEL', sourceId: r.id, notes: '', date: erpToday()})}>수금·환불 취소</button>}</td></tr>)}</tbody></table></div>
      {report?.nextOffset != null && <button className="wf-btn" disabled={busy} onClick={() => void run(async () => {const r = await api.report(companyId, from, to, filter, report.nextOffset!, report.snapshot); if (live.current) setReport({...r, events: [...report.events, ...r.events]});})}>상세 내역 더 보기</button>}</section>
    {error && <p role="alert" className="erp-error">{error}</p>}{busy && <p role="status">미수금·수금 원장을 확인하고 있습니다.</p>}
  </div>;
}
