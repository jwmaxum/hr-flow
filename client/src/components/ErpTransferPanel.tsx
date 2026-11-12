import { useEffect, useRef, useState } from 'react';
import { erpService } from '../services/erpService';
import type { ErpCursor, ErpRecord } from '../services/erpService';
import { erpLedgerService } from '../services/erpLedgerService';
import type { Correction, ReportMeta, TransferInput, TransferStock } from '../services/erpLedgerService';
import { getErrorMessage } from '../utils/errors';

const number = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const nextDay = (value: string) => { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); };
function scaled(value: string): number | null {
  if (!value.trim()) return 0;
  if (!/^\d+(\.\d{1,4})?$/.test(value.trim())) return null;
  const result = Math.round(Number(value) * 10000);
  return Number.isSafeInteger(result) && result <= 1e12 ? result : null;
}

export function ErpTransferPanel({ companyId }: { companyId: string }) {
  const [warehouses, setWarehouses] = useState<ErpRecord[]>([]), [warehouseCursor, setWarehouseCursor] = useState<ErpCursor | null>(null);
  const [meta, setMeta] = useState<ReportMeta | null>(null), [warehouseId, setWarehouseId] = useState(''), [destinations, setDestinations] = useState<string[]>([]);
  const [date, setDate] = useState(today), [reason, setReason] = useState('');
  const [stocks, setStocks] = useState<TransferStock[]>([]), [stockCursor, setStockCursor] = useState<string | null>(null), [loaded, setLoaded] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Correction | null>(null), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const live = useRef(true), lock = useRef(false), attempt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    live.current = true;
    let cancelled = false;
    void Promise.all([erpService.list(companyId, 'warehouses', '', 'name'), erpLedgerService.meta(companyId)]).then(([result, state]) => {
      if (cancelled) return;
      setWarehouses(result.records.filter(row => row.active)); setWarehouseCursor(result.nextCursor); setMeta(state);
      const earliest = state.basisDate ? nextDay(state.basisDate) : today();
      setDate([today(), earliest, state.lastDate || ''].sort().at(-1)!);
    }).catch(failure => { if (!cancelled) setError(getErrorMessage(failure)); });
    return () => { cancelled = true; live.current = false; };
  }, [companyId]);
  function changed() { setPreview(null); setConfirmed(false); setNotice(''); attempt.current = null; }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { if (live.current) setError(getErrorMessage(failure)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function loadStock(more = false) {
    const result = await erpLedgerService.transferStock(companyId, warehouseId, more ? stockCursor || undefined : undefined);
    if (!live.current) return;
    setStocks(current => more ? [...current, ...result.records] : result.records); setStockCursor(result.nextCursor); setLoaded(true);
    if (!more) { setQuantities({}); changed(); }
  }
  const targets = destinations.map(id => warehouses.find(row => row.id === id)!).filter(Boolean);
  const allocations: TransferInput['allocations'] = [];
  const rowStates = new Map<string, { total: number; invalid: boolean; exceeds: boolean }>();
  for (const stock of stocks) {
    let total = 0, invalid = false;
    for (const target of targets) {
      const value = quantities[`${stock.itemId}:${target.id}`] || '', quantity = scaled(value);
      if (quantity === null) invalid = true;
      else if (quantity > 0) { total += quantity; allocations.push({ itemId: stock.itemId, warehouseId: target.id, quantity: value.trim() }); }
    }
    rowStates.set(stock.id, { total, invalid, exceeds: total > Math.round(stock.quantity * 10000) });
  }
  const invalid = [...rowStates.values()].some(row => row.invalid || row.exceeds);
  const committed = preview?.status === 'COMMITTED';
  const minimumDate = meta?.basisDate ? [nextDay(meta.basisDate), meta.lastDate || ''].sort().at(-1)! : '2000-01-01';
  async function validate() {
    const input: TransferInput = { type: 'TRANSFER', date, reason, warehouseId, allocations };
    const key = JSON.stringify(input);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    const result = await erpLedgerService.preview(companyId, attempt.current.id, input);
    if (!live.current) return;
    setPreview(result.correction); setConfirmed(false);
    // A successful preview can be refreshed after a stale-state failure; transport retries retain the ID.
    attempt.current = null; setNotice('출발·도착 창고의 수량과 금액을 확인한 뒤 확정해 주세요.');
  }
  return <section className="wf-panel erp-transfer" aria-label="창고 간 재고 이동">
    <h2 className="wf-section-title">창고 간 재고 이동</h2>
    <p className="wf-muted">출발 창고의 재고를 여러 창고로 나눕니다. 회사 전체 수량·재고금액은 유지되며 매출은 발생하지 않습니다.</p>
    {!meta?.basisDate && <p className="erp-notice">기초재고가 확정되면 창고 이동을 시작할 수 있습니다.</p>}
    <fieldset className="erp-form-fields" disabled={busy || committed}>
      <label className="wf-field"><span>출발 창고</span><select className="wf-input" value={warehouseId} onChange={e => { setWarehouseId(e.target.value); setDestinations([]); setStocks([]); setQuantities({}); setStockCursor(null); setLoaded(false); changed(); }}><option value="">창고 선택</option>{warehouses.map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
      <label className="wf-field"><span>이동일</span><input className="wf-input" type="date" min={minimumDate} max="2099-12-31" value={date} onChange={e => { setDate(e.target.value); changed(); }} /></label>
      <div className="wf-field erp-form-wide"><span id="erp-transfer-destinations">도착 창고 (최대 5곳)</span><div className="erp-transfer-destinations" role="group" aria-labelledby="erp-transfer-destinations">{warehouses.filter(row => row.id !== warehouseId).map(row => <label key={row.id} className="erp-active-field"><input type="checkbox" checked={destinations.includes(row.id)} disabled={!warehouseId || !destinations.includes(row.id) && destinations.length >= 5} onChange={e => { setDestinations(current => e.target.checked ? [...current, row.id] : current.filter(id => id !== row.id)); setQuantities(current => Object.fromEntries(Object.entries(current).filter(([key]) => !key.endsWith(`:${row.id}`)))); changed(); }} />{row.name}</label>)}</div></div>
      <label className="wf-field erp-form-wide"><span>이동 사유</span><input className="wf-input" maxLength={500} value={reason} onChange={e => { setReason(e.target.value); changed(); }} placeholder="예: 기초재고 실물 보관 장소별 배분" /></label>
    </fieldset>
    <div className="erp-actions">{warehouseCursor && <button className="wf-btn" disabled={busy || committed} onClick={() => void run(async () => { const result = await erpService.list(companyId, 'warehouses', '', 'name', warehouseCursor); if (live.current) { setWarehouses(current => [...current, ...result.records.filter(row => row.active)]); setWarehouseCursor(result.nextCursor); } })}>창고 더 불러오기</button>}
      {!committed && <button className="wf-btn" disabled={busy || !warehouseId || !meta?.basisDate} onClick={() => void run(() => loadStock())}>{loaded ? '재고 새로고침 (입력 초기화)' : '출발 재고 불러오기'}</button>}
    </div>
    {error && <p role="alert" className="erp-error">{error}</p>}{notice && <p role="status" className="erp-success">{notice}</p>}
    {loaded && !committed && <>
      <p className="erp-form-note">표시 {stocks.length}개 품목 · 빈칸과 0은 이동하지 않습니다. 소수점 4자리까지, 한 번에 품목·도착 창고 조합 75개까지 가능합니다. 원가 미확정 등으로 재고가 등록되지 않은 품목은 표시되지 않습니다.</p>
      {!stocks.length ? <p className="erp-empty">출발 창고에 등록된 재고가 없습니다.</p> : <div className="erp-table-scroll" tabIndex={0} role="region" aria-label="품목별 창고 배분 입력"><table className="erp-table erp-transfer-table"><thead><tr><th>품목</th><th>출발 현재고</th>{targets.map(target => <th key={target.id}>{target.name} 이동수량</th>)}<th>배분합계</th><th>출발 잔여수량</th></tr></thead><tbody>{stocks.map(stock => {
        const state = rowStates.get(stock.id)!;
        return <tr key={stock.id}><td><strong>{stock.name}</strong><small className="erp-cell-note">{stock.code}{stock.active ? '' : ' · 중지 품목'}</small></td><td className="erp-number">{number(stock.quantity)} {stock.unit}</td>{targets.map(target => <td key={target.id}><input className="wf-input erp-transfer-quantity" aria-label={`${stock.code} ${target.name} 이동수량`} aria-invalid={state.invalid || state.exceeds} inputMode="decimal" value={quantities[`${stock.itemId}:${target.id}`] || ''} disabled={busy || !stock.active || stock.quantity <= 0} onChange={e => { setQuantities(current => ({ ...current, [`${stock.itemId}:${target.id}`]: e.target.value })); changed(); }} /></td>)}<td className="erp-number">{state.invalid ? '수량 형식 확인' : number(state.total / 10000)}</td><td className={state.exceeds || state.invalid ? 'erp-error' : 'erp-number'}>{state.invalid ? '—' : `${number((Math.round(stock.quantity * 10000) - state.total) / 10000)} ${stock.unit}`}{state.exceeds && <small className="erp-cell-note">현재고 초과</small>}</td></tr>;
      })}</tbody></table></div>}
      {stockCursor && <button className="wf-btn" disabled={busy} onClick={() => void run(() => loadStock(true))}>재고 더 불러오기</button>}
      <p className={invalid || allocations.length > 75 ? 'erp-error' : 'wf-muted'} role="status">{invalid ? '수량 형식과 현재고 초과 항목을 확인해 주세요.' : `선택한 배분 ${allocations.length}개 / 75개`}</p>
      <button className="wf-btn wf-btn-primary" disabled={busy || invalid || !allocations.length || allocations.length > 75 || reason.trim().length < 3 || !date} onClick={() => void run(validate)}>{busy ? '처리 중…' : '창고 이동 미리보기'}</button>
    </>}
    {preview && <div className="erp-correction-preview"><h3 className="wf-section-title">이동 전후 재고 · {preview.rows.length / 2}개 배분</h3>
      <div className="erp-table-scroll" tabIndex={0} role="region" aria-label="창고 이동 미리보기"><table className="erp-table"><thead><tr><th>품목·창고</th><th>처리·상대 창고</th><th>수량 전 → 후</th><th>재고금액 전 → 후 (원)</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.rowNo}><td>{row.name}<small className="erp-cell-note">{row.code} · {row.warehouseName}</small></td><td>{row.direction}<small className="erp-cell-note">{row.transferWarehouseName}</small></td><td>{number(row.beforeQuantity)} → {number(row.afterQuantity)} {row.unit}</td><td>{number(row.beforeValue)} → {number(row.afterValue)}</td></tr>)}</tbody></table></div>
      {committed ? <><p role="status" className="erp-success">창고 이동 완료. 입출고 총괄·원장에서 이동 내역을 조회하거나 문서 전체를 취소할 수 있습니다. 후속 거래가 있으면 취소가 제한됩니다.</p><button className="wf-btn" disabled={busy} onClick={() => void run(() => loadStock())}>새 창고 이동</button></> : <><label className="erp-active-field"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />출발·도착 창고와 전체 이동 수량·금액을 확인했습니다.</label><button className="wf-btn wf-btn-primary" disabled={busy || !confirmed} onClick={() => void run(async () => { const result = await erpLedgerService.commit(companyId, preview); if (live.current) { setPreview(result.correction); setConfirmed(false); setNotice('모든 배분이 함께 반영되었습니다.'); } })}>창고 이동 확정</button></>}
    </div>}
  </section>;
}
