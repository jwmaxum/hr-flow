import { useEffect, useRef, useState } from 'react';
import { erpChoices, erpCustody as api, erpToday } from '../services/erpAccountService';
import type { CustodyInput, CustodyJob, CustodyList } from '../services/erpAccountService';
import type { ErpRecord } from '../services/erpService';
import { getErrorMessage } from '../utils/errors';
const number = (v: number) => v.toLocaleString('ko-KR', {maximumFractionDigits: 4});
const labels: Record<string, string> = {REGISTER: '기존 판매분 보관 등록', DELIVER: '소유 거래처에 인도', REPAY: '차용품 현물 반환', CANCEL: '보관 처리 취소'};
export function ErpCustodyPanel({companyId}: {companyId: string}) {
  const [data, setData] = useState<CustodyList | null>(null), [items, setItems] = useState<ErpRecord[]>([]), [warehouses, setWarehouses] = useState<ErpRecord[]>([]), [partners, setPartners] = useState<ErpRecord[]>([]);
  const [input, setInput] = useState<CustodyInput>({type: 'REGISTER', date: erpToday(), notes: '', quantity: '', itemId: '', warehouseId: '', ownerPartnerId: '', reference: ''});
  const [job, setJob] = useState<CustodyJob | null>(null), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const live = useRef(true), lock = useRef(false), attempt = useRef(crypto.randomUUID());
  useEffect(() => {live.current = true; void Promise.all([api.list(companyId), erpChoices(companyId, 'items'), erpChoices(companyId, 'warehouses'), erpChoices(companyId, 'partners')]).then(([d, i, w, p]) => {if (live.current) {setData(d); setItems(i); setWarehouses(w); setPartners(p);}}).catch(e => {if (live.current) setError(getErrorMessage(e));}).finally(() => {if (live.current) setBusy(false);}); return () => {live.current = false;};}, [companyId]);
  function change(patch: Partial<CustodyInput>) {setInput(v => ({...v, ...patch})); setJob(null); setConfirmed(false); setError(''); attempt.current = crypto.randomUUID();}
  async function run(work: () => Promise<void>) {if (busy || lock.current) return; lock.current = true; setBusy(true); setError(''); try {await work();} catch (e) {if (live.current) setError(getErrorMessage(e));} finally {lock.current = false; if (live.current) setBusy(false);}}
  async function refresh() {const result = await api.list(companyId); if (live.current) setData(result);}
  async function preview() {
    const v: CustodyInput = {type: input.type, date: input.date, notes: input.notes};
    if (input.type === 'CANCEL') v.sourceId = input.sourceId;
    else {v.quantity = input.quantity; if (input.type === 'REGISTER') Object.assign(v, {itemId: input.itemId, warehouseId: input.warehouseId, ownerPartnerId: input.ownerPartnerId, reference: input.reference}); if (input.type === 'DELIVER') v.lotId = input.lotId; if (input.type === 'REPAY') v.borrowingId = input.borrowingId;}
    const result = await api.preview(companyId, attempt.current, v); if (live.current) {setJob(result.job); setConfirmed(false);}
  }
  const done = job?.status === 'COMMITTED';
  return <div className="erp-movement" aria-busy={busy}>
    <section className="wf-panel" aria-label="보관·차용 현황"><div className="erp-list-head"><h2 className="wf-section-title">타사 소유 보관품 · 차용 현황</h2><button className="wf-btn" disabled={busy} onClick={() => void run(refresh)}>보관 현황 새로고침</button></div>
      <p className="wf-muted">판매했지만 아직 인도하지 않은 상품은 거래처 소유 보관품입니다. 회사 재고자산에 포함하지 않으며, 다른 업체에 먼저 판매한 수량은 소유자에게 반환할 의무로 음수 표시합니다.</p>
      <p className="erp-notice">새 출고는 출고등록에서 ‘판매 후 보관’ 또는 ‘보관품 차용 판매’를 선택하세요. 아래 기존 판매분 등록은 과거 매출을 다시 만들지 않습니다.</p>
      <div className="erp-table-scroll"><table className="erp-table"><caption>소유 거래처별 보관품</caption><thead><tr><th>소유 거래처</th><th>품목·창고</th><th>실제 보관수량</th><th>차용 미반환수량</th><th>인도완료</th><th>원판매 증빙</th><th>처리</th></tr></thead><tbody>{data?.lots.filter(l => !l.cancelled).map(l => <tr key={l.id}><td>{l.ownerName}</td><td>{l.code} · {l.name}<small className="erp-cell-note">{l.warehouseName}</small></td><td>{number(l.availableQuantityScaled / 10000)}</td><td className={l.borrowedQuantityScaled ? 'erp-error' : ''}>{number(-l.borrowedQuantityScaled / 10000)}</td><td>{number(l.deliveredQuantityScaled / 10000)}</td><td>{l.reference}</td><td><button className="wf-btn" disabled={busy || !l.availableQuantityScaled} onClick={() => change({type: 'DELIVER', lotId: l.id, quantity: '', notes: ''})}>인도 등록</button></td></tr>)}</tbody></table></div>
      {data && !data.lots.length && <p>등록된 타사 소유 보관품이 없습니다.</p>}
      <div className="erp-table-scroll"><table className="erp-table"><caption>차용 판매별 반환 의무</caption><thead><tr><th>원소유자 → 판매처</th><th>품목·창고</th><th>미반환수량</th><th>미반환 평가금액 (원)</th><th>처리</th></tr></thead><tbody>{data?.borrowings.filter(l => l.outstandingQuantityScaled > 0).map(l => <tr key={l.id}><td>{l.ownerName} → {l.buyerName}</td><td>{l.code} · {l.name}<small className="erp-cell-note">{l.warehouseName}</small></td><td className="erp-error">{number(-l.outstandingQuantityScaled / 10000)}</td><td>{number(l.outstandingValue)}</td><td><button className="wf-btn" disabled={busy} onClick={() => change({type: 'REPAY', borrowingId: l.id, quantity: '', notes: ''})}>현물 반환</button></td></tr>)}</tbody></table></div>
    </section>
    <section className="wf-panel" aria-label="보관 처리 등록"><h2 className="wf-section-title">{labels[input.type]}</h2><form onSubmit={e => {e.preventDefault(); void run(preview);}}><fieldset disabled={busy || done} className="erp-form-fields">
      <label className="wf-field"><span>보관 처리유형</span><select className="wf-input" value={input.type} onChange={e => change({type: e.target.value as CustodyInput['type']})}>{['REGISTER', 'DELIVER', 'REPAY', ...(input.sourceId ? ['CANCEL'] : [])].map(v => <option key={v} value={v}>{labels[v]}</option>)}</select></label>
      <label className="wf-field"><span>보관 처리일 *</span><input className="wf-input" type="date" required value={input.date} onChange={e => change({date: e.target.value})} /></label>
      {input.type === 'REGISTER' && <><label className="wf-field"><span>보관 품목 *</span><select className="wf-input" required value={input.itemId} onChange={e => change({itemId: e.target.value})}><option value="">품목 선택</option>{items.filter(i => i.active && i.itemType !== 'BUNDLE').map(i => <option key={i.id} value={i.id}>{i.code} · {i.name}</option>)}</select></label>
        <label className="wf-field"><span>보관 창고 *</span><select className="wf-input" required value={input.warehouseId} onChange={e => change({warehouseId: e.target.value})}><option value="">창고 선택</option>{warehouses.filter(w => w.active).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
        <label className="wf-field"><span>소유 거래처 *</span><select className="wf-input" required value={input.ownerPartnerId} onChange={e => change({ownerPartnerId: e.target.value})}><option value="">소유자 선택</option>{partners.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label>
        <label className="wf-field"><span>기존 판매 증빙번호 *</span><input className="wf-input" required maxLength={100} value={input.reference} onChange={e => change({reference: e.target.value})} /></label></>}
      {input.type === 'DELIVER' && <label className="wf-field"><span>인도할 보관품 *</span><select className="wf-input" required value={input.lotId || ''} onChange={e => change({lotId: e.target.value})}><option value="">선택</option>{data?.lots.filter(l => l.availableQuantityScaled > 0).map(l => <option key={l.id} value={l.id}>{l.ownerName} · {l.name} · {l.warehouseName} · {number(l.availableQuantityScaled / 10000)}</option>)}</select></label>}
      {input.type === 'REPAY' && <label className="wf-field"><span>반환할 차용 건 *</span><select className="wf-input" required value={input.borrowingId || ''} onChange={e => change({borrowingId: e.target.value})}><option value="">선택</option>{data?.borrowings.filter(l => l.outstandingQuantityScaled > 0).map(l => <option key={l.id} value={l.id}>{l.ownerName} → {l.buyerName} · {l.name} · {number(l.outstandingQuantityScaled / 10000)}</option>)}</select></label>}
      {input.type !== 'CANCEL' && <label className="wf-field"><span>보관 처리수량 *</span><input className="wf-input" required inputMode="decimal" value={input.quantity} onChange={e => change({quantity: e.target.value})} /></label>}
      <label className="wf-field"><span>보관 처리 사유 *</span><input className="wf-input" required maxLength={500} value={input.notes} onChange={e => change({notes: e.target.value})} /></label>
      <div className="erp-actions"><button className="wf-btn wf-btn-primary">보관 검증·미리보기</button></div>
    </fieldset></form>
      {input.type === 'REPAY' && <p className="wf-muted">차용한 품목·창고의 회사 소유 재고로 반환합니다. 반환 원가는 이동평균으로 계산하며 최초 평가금액과의 차이를 매출원가에 반영합니다.</p>}
      {job && <div aria-label="보관 처리 미리보기"><p>{labels[job.summary.type]} · {job.summary.ownerName} · {job.summary.name} · {job.summary.warehouseName} · {number(job.summary.quantity)}</p>
        {job.summary.notice && <p>{job.summary.notice}</p>}{job.summary.remaining != null && <p>처리 후 잔량 {number(job.summary.remaining)}</p>}
        {job.summary.actualCost != null && <p>실제 반환원가 {number(job.summary.actualCost)}원 · 평가금액 {number(job.summary.evaluationCost || 0)}원 · 원가 조정 {number(job.summary.costDifference || 0)}원</p>}
        {done ? <p role="status" className="erp-success">보관 원장 반영 완료</p> : <><label className="erp-active-field"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />소유 거래처·수량·재고 변동을 확인했습니다.</label><button className="wf-btn wf-btn-primary" disabled={busy || !confirmed} onClick={() => void run(async () => {const r = await api.commit(companyId, job); if (live.current) setJob(r.job); await refresh();})}>보관 처리 확정</button></>}
        <button className="wf-btn" disabled={busy} onClick={() => change({type: 'REGISTER', quantity: '', notes: '', sourceId: undefined})}>{done ? '새 보관 처리' : '입력 재검토'}</button></div>}
    </section>
    <section className="wf-panel"><h2 className="wf-section-title">보관 처리 이력</h2><div className="erp-table-scroll"><table className="erp-table"><thead><tr><th>일자</th><th>처리</th><th>품목·소유자</th><th>수량</th><th>사유</th><th>취소</th></tr></thead><tbody>{data?.operations.toSorted((a, b) => b.input.date.localeCompare(a.input.date)).map(o => <tr key={o.id}><td>{o.input.date}</td><td>{labels[o.input.type]}{o.cancelledBy ? ' · 취소됨' : ''}</td><td>{o.summary.name} · {o.summary.ownerName}</td><td>{number(o.summary.quantity)}</td><td>{o.input.notes}</td><td>{o.input.type !== 'CANCEL' && !o.cancelledBy && <button className="wf-btn" disabled={busy} onClick={() => change({type: 'CANCEL', sourceId: o.id, notes: '', date: erpToday()})}>보관 처리 취소</button>}</td></tr>)}</tbody></table></div><p className="wf-muted">후속 거래가 연결된 처리는 먼저 후속 거래를 취소해야 합니다. 출고 매출의 취소·반품은 입출고 원장에서 처리합니다.</p></section>
    {error && <p role="alert" className="erp-error">{error}</p>}{busy && <p role="status">보관·차용 원장을 확인하고 있습니다.</p>}
  </div>;
}
