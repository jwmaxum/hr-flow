import { useEffect, useRef, useState } from 'react';
import { erpService } from '../services/erpService';
import type { ErpCursor, ErpRecord, InventoryResult, PurchaseHistory } from '../services/erpService';
import { erpImportService as api } from '../services/erpImportService';
import type { ErpImport, ManualLine, ManualMovement } from '../services/erpImportService';
import { erpScope } from '../services/erpLedgerService';
import { getErrorMessage } from '../utils/errors';
import { erpCustody } from '../services/erpAccountService';
import type { CustodyLot } from '../services/erpAccountService';

const number = (value: number | null | undefined) => value == null ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
type Line = ManualLine & { key: string; itemId: string };
function lineFor(item?: ErpRecord | null): Line {
  return { key: crypto.randomUUID(), itemId: item?.id || '', code: item?.code || '', name: item?.name || '', specification: item?.specification || '',
    unit: item?.unit || 'EA', taxType: item?.taxType || '과세', quantity: '', price: '', notes: '' };
}
function PriceHistory({ companyId, itemId, price, currency, priceBasis }: { companyId: string; itemId: string; price: string; currency: string; priceBasis: string }) {
  const [stock, setStock] = useState<InventoryResult | null>(null), [history, setHistory] = useState<PurchaseHistory | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(true), [reload, setReload] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const current = ++epoch.current;
    void Promise.all([erpService.inventory(companyId, itemId), erpService.purchaseHistory(companyId, itemId)]).then(([s, h]) => {
      if (epoch.current === current) { setStock(s); setHistory(h); setError(''); }
    }).catch(failure => { if (epoch.current === current) setError(getErrorMessage(failure)); }).finally(() => { if (epoch.current === current) setBusy(false); });
    return () => { epoch.current = current + 1; };
  }, [companyId, itemId, reload]);
  async function more() {
    if (!history?.nextCursor || busy) return; const current = epoch.current; setBusy(true);
    try { const result = await erpService.purchaseHistory(companyId, itemId, history.nextCursor); if (epoch.current === current) { setHistory({ rows: [...history.rows, ...result.rows], nextCursor: result.nextCursor }); setError(''); } }
    catch (failure) { if (epoch.current === current) setError(getErrorMessage(failure)); }
    finally { if (epoch.current === current) setBusy(false); }
  }
  return <section className="wf-panel" aria-label="기존 입고단가 비교" aria-busy={busy}>
    <h3 className="wf-section-title">기존 입고단가 · 신규단가 비교</h3>
    <p><strong>{stock?.item.code} {stock?.item.name}</strong></p>
    <dl className="erp-stock-totals"><div><dt>전체 창고 재고수량</dt><dd>{number(stock?.quantity)}</dd></div><div><dt>전체 재고금액</dt><dd>{number(stock?.value)}<small>원</small></dd></div>
      <div><dt>평균 재고단가</dt><dd>{number(stock?.averagePrice)}<small>원</small></dd></div><div><dt>이번 신규단가</dt><dd>{price || '미입력'}<small>{currency} · {priceBasis}</small></dd></div></dl>
    <p className="wf-muted">평균 재고단가는 현재 남아 있는 모든 창고의 장부금액 ÷ 수량입니다. 기존 입고단가는 거래 당시 값을 보존하며 취소·반품을 표시합니다.</p>
    {error && <p role="alert" className="erp-error">{error} <button type="button" className="wf-btn" disabled={busy} onClick={() => setReload(value => value + 1)}>다시 조회</button></p>}
    <div className="erp-table-scroll"><table className="erp-table"><caption className="erp-sr-only">이전 입고 단가 이력</caption><thead><tr><th>입고일·창고</th><th>수량</th><th>기존 입고단가</th><th>원화 원가단가</th><th>상태</th></tr></thead><tbody>
      {history?.rows.map(row => <tr key={row.id}><td>{row.date}<small className="erp-cell-note">{row.warehouseName} · {row.documentNo}</small></td><td>{number(row.quantity)}</td>
        <td>{number(row.price)} {row.currency}<small className="erp-cell-note">{row.priceBasis}{row.price === null ? ' · 금액으로 이관' : ''}</small></td><td>{number(row.costPerUnit)} 원</td><td>{row.cancelled ? '취소' : row.returnedQuantity ? `반품 ${number(row.returnedQuantity)}` : '확정'}</td></tr>)}
    </tbody></table></div>
    {!busy && !history?.rows.length && !error && <p className="wf-muted">조회한 구간에 입고 이력이 없습니다.</p>}
    {history?.nextCursor && <button className="wf-btn" type="button" disabled={busy} onClick={() => void more()}>이전 입고 이력 더 보기</button>}
    {busy && <p role="status">기존 재고와 입고 이력을 조회하고 있습니다.</p>}
  </section>;
}

export function ErpMovementPanel({ companyId, direction, initialItem, onInventory, onStatement }: {
  companyId: string; direction: '입고' | '출고'; initialItem?: ErpRecord | null; onInventory: () => void; onStatement: (documentNo: string) => void;
}) {
  const [date, setDate] = useState(today), [warehouseId, setWarehouseId] = useState(''), [partnerId, setPartnerId] = useState('');
  const [newPartner, setNewPartner] = useState({ code: '', name: '', country: 'KR', registrationNumber: '' });
  const [currency, setCurrency] = useState('KRW'), [exchangeRate, setExchangeRate] = useState('1'), [priceBasis, setPriceBasis] = useState('세금별도');
  const [lines, setLines] = useState<Line[]>(() => [lineFor(initialItem)]), [active, setActive] = useState(0);
  const [items, setItems] = useState<ErpRecord[]>(initialItem ? [initialItem] : []), [warehouses, setWarehouses] = useState<ErpRecord[]>([]), [partners, setPartners] = useState<ErpRecord[]>([]);
  const [cursors, setCursors] = useState<Partial<Record<'items' | 'warehouses' | 'partners', ErpCursor | null>>>({});
  const [allowNewItems, setAllowNewItems] = useState(false), [allowNewPartners, setAllowNewPartners] = useState(false);
  const [lots, setLots] = useState<CustodyLot[]>([]);
  const [job, setJob] = useState<ErpImport | null>(null), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const live = useRef(true), lock = useRef(false), attempt = useRef(crypto.randomUUID()), title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    live.current = true; title.current?.focus();
    void Promise.all([Promise.all(['items','warehouses','partners'].map(kind => erpService.list(companyId, kind as 'items' | 'warehouses' | 'partners', '', 'name'))), direction === '출고' ? erpCustody.list(companyId) : Promise.resolve(null)]).then(([[i, w, p], c]) => {
      if (!live.current) return;
      setItems(initialItem && !i.records.some(row => row.id === initialItem.id) ? [initialItem, ...i.records] : i.records); setWarehouses(w.records); setPartners(p.records);
      setCursors({ items: i.nextCursor, warehouses: w.nextCursor, partners: p.nextCursor });
      setLots(c?.lots || []);
    }).catch(failure => { if (live.current) setError(getErrorMessage(failure)); }).finally(() => { if (live.current) setBusy(false); });
    return () => { live.current = false; };
  }, [companyId, initialItem, direction]);
  function changed() { setJob(null); setConfirmed(false); setError(''); attempt.current = crypto.randomUUID(); }
  function edit(index: number, patch: Partial<Line>) { changed(); setLines(current => current.map((line, i) => i === index ? { ...line, ...patch } : line)); setActive(index); }
  async function run(action: () => Promise<void>) {
    if (busy || lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await action(); } catch (failure) { if (live.current) setError(getErrorMessage(failure)); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function more(kind: 'items' | 'warehouses' | 'partners') {
    const cursor = cursors[kind]; if (!cursor) return;
    const result = await erpService.list(companyId, kind, '', 'name', cursor); if (!live.current) return;
    const setter = kind === 'items' ? setItems : kind === 'warehouses' ? setWarehouses : setPartners;
    setter(current => [...current, ...result.records.filter(row => !current.some(old => old.id === row.id))]); setCursors(current => ({ ...current, [kind]: result.nextCursor }));
  }
  async function preview() {
    const movement: ManualMovement = { direction, date, warehouseId, ...(partnerId === 'NEW' ? { partner: newPartner } : { partnerId }), currency, exchangeRate, priceBasis,
      lines: lines.map(({ code, name, specification, unit, taxType, quantity, price, notes, fulfillment, custodyLotId, borrowValue }) => ({ code, name, specification, unit, taxType, quantity, price, notes, fulfillment: fulfillment || 'DIRECT', ...(fulfillment === 'BORROW' ? {custodyLotId, borrowValue} : {}) })), allowNewItems, allowNewPartners };
    const result = await api.manualPreview(companyId, attempt.current, movement); if (live.current) { setJob(result.import); setConfirmed(false); }
  }
  const done = job?.status === 'COMMITTED', selected = lines[active], total = (field: 'supply' | 'tax' | 'total' | 'cost' | 'value') => job?.preview.rows.reduce((sum, row) => sum + (row[field] || 0), 0) || 0;
  return <div className="erp-movement" aria-busy={busy}>
    <section className="wf-panel"><div className="erp-list-head"><div><h2 ref={title} tabIndex={-1} className="wf-section-title">{direction}등록</h2><p className="wf-muted">품목과 거래처를 입력하고 미리보기 확인 후 확정하세요. 거래번호와 처리순서는 자동으로 부여됩니다.</p></div><button className="wf-btn" disabled={busy} onClick={onInventory}>재고현황으로</button></div>
      <form onSubmit={event => { event.preventDefault(); void run(preview); }}>
        <fieldset className="erp-form-fields" disabled={busy || done}>
          <label className="wf-field"><span>거래일 *</span><input className="wf-input" type="date" required value={date} onChange={e => { changed(); setDate(e.target.value); }} /></label>
          <label className="wf-field"><span>{direction} 창고 *</span><select className="wf-input" required value={warehouseId} onChange={e => { changed(); setWarehouseId(e.target.value); }}><option value="">창고 선택</option>{warehouses.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
          <label className="wf-field"><span>거래처 *</span><select className="wf-input" required value={partnerId} onChange={e => { changed(); setPartnerId(e.target.value); }}><option value="">거래처 선택</option><option value="NEW">새 거래처 입력</option>{partners.filter(row => row.active && (direction !== '출고' || row.type !== 'SUPPLIER')).map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
          <label className="wf-field"><span>단가기준 *</span><select className="wf-input" value={priceBasis} onChange={e => { changed(); setPriceBasis(e.target.value); }}><option>세금별도</option><option>세금포함</option></select></label>
          {partnerId === 'NEW' && <>{(['code','name','country','registrationNumber'] as const).map((key, i) => <label className="wf-field" key={key}><span>{['거래처 코드','거래처명 *','국가코드 *','사업자 등록번호'][i]}</span><input className="wf-input" required={key === 'name' || key === 'country'} maxLength={[60,120,2,80][i]} value={newPartner[key]} onChange={e => { changed(); setNewPartner(current => ({ ...current, [key]: e.target.value })); }} /></label>)}</>}
          <label className="wf-field"><span>통화</span><select className="wf-input" value={currency} onChange={e => { changed(); setCurrency(e.target.value); setExchangeRate(e.target.value === 'KRW' ? '1' : ''); }}>{['KRW','USD','EUR','JPY','CNY'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="wf-field"><span>적용환율 (원/통화단위) *</span><input className="wf-input" required readOnly={currency === 'KRW'} inputMode="decimal" value={exchangeRate} onChange={e => { changed(); setExchangeRate(e.target.value); }} /></label>
        </fieldset>
        <div className="erp-actions">{(['items','warehouses','partners'] as const).filter(kind => cursors[kind]).map((kind, i) => <button key={kind} type="button" className="wf-btn" disabled={busy || done} onClick={() => void run(() => more(kind))}>{({ items: '품목', warehouses: '창고', partners: '거래처' })[kind]} 선택목록 더 보기<span className="erp-sr-only"> {i}</span></button>)}</div>
        {lines.map((line, index) => <fieldset className="erp-movement-line erp-form-fields" key={line.key} disabled={busy || done}><legend>{index + 1}. {line.name || '품목 선택'}</legend>
          <label className="wf-field erp-form-wide"><span>등록 품목 선택 *</span><select className="wf-input" required value={line.itemId} onChange={e => {
            const item = items.find(row => row.id === e.target.value), next = lineFor(item); edit(index, { ...next, key: line.key, itemId: e.target.value });
          }}><option value="">품목 선택</option>{direction === '입고' && <option value="NEW">신규 품목 입력</option>}{items.filter(row => row.active && (direction === '출고' || row.itemType !== 'BUNDLE')).map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</select></label>
          {(['code','name','specification','unit'] as const).map((key, i) => <label className="wf-field" key={key}><span>{['품목코드 *','품목명 *','규격','단위 *'][i]}</span><input className="wf-input" value={line[key]} required={key !== 'specification'} readOnly={line.itemId !== 'NEW'} maxLength={[60,120,160,20][i]} onChange={e => edit(index, { [key]: e.target.value })} /></label>)}
          <label className="wf-field"><span>{direction}수량 *</span><input className="wf-input" required inputMode="decimal" value={line.quantity} onChange={e => edit(index, { quantity: e.target.value })} /></label>
          <label className="wf-field"><span>{direction === '입고' ? '신규 입고단가' : '판매단가'} ({currency}) *</span><input className="wf-input" required inputMode="decimal" value={line.price} onChange={e => edit(index, { price: e.target.value })} /></label>
          <label className="wf-field"><span>부가세 구분</span><select className="wf-input" value={line.taxType} onChange={e => edit(index, { taxType: e.target.value })}><option>과세</option><option>영세</option><option>면세</option></select></label>
          {direction === '출고' && <><label className="wf-field"><span>출고 방식</span><select className="wf-input" value={line.fulfillment || 'DIRECT'} onChange={e => edit(index, {fulfillment: e.target.value as ManualLine['fulfillment'], custodyLotId: '', borrowValue: ''})}><option value="DIRECT">회사 재고 직접 출고</option>{items.find(i => i.id === line.itemId)?.itemType !== 'BUNDLE' && <><option value="HOLD">판매 후 보관 (거래처 소유)</option><option value="BORROW">보관품 차용 판매</option></>}</select></label>{line.fulfillment === 'BORROW' && <><label className="wf-field"><span>차용할 보관품 *</span><select className="wf-input" required value={line.custodyLotId || ''} onChange={e => edit(index, {custodyLotId: e.target.value})}><option value="">소유자·보관품 선택</option>{lots.filter(l => l.itemId === line.itemId && l.warehouseId === warehouseId && l.ownerPartnerId !== partnerId && l.availableQuantityScaled > 0).map(l => <option key={l.id} value={l.id}>{l.ownerName} · {number(l.availableQuantityScaled / 10000)} · {l.reference}</option>)}</select></label><label className="wf-field"><span>이번 차용 전체 평가금액 (원) *</span><input className="wf-input" required inputMode="numeric" value={line.borrowValue || ''} onChange={e => edit(index, {borrowValue: e.target.value})} /></label><p className="wf-muted erp-form-wide">차용 평가금액을 매출원가로 기록하고 미반환 의무를 남깁니다. 현물 반환 시 실제 원가와의 차이를 정산합니다. 회사 재고자산은 차감하지 않습니다.</p></>}</>}
          <label className="wf-field"><span>비고 (무상 거래는 사유 필수)</span><input className="wf-input" maxLength={500} value={line.notes} onChange={e => edit(index, { notes: e.target.value })} /></label>
          <div className="erp-actions erp-form-wide">{line.itemId && line.itemId !== 'NEW' && <button type="button" className="wf-btn" aria-pressed={active === index} onClick={() => setActive(index)}>이 품목 재고·단가 비교</button>}{lines.length > 1 && <button type="button" className="wf-btn" onClick={() => { changed(); setLines(current => current.filter((_, i) => i !== index)); setActive(0); }}>행 삭제</button>}</div>
        </fieldset>)}
        <fieldset disabled={busy || done} className="erp-movement-confirm">
          <button type="button" className="wf-btn" disabled={lines.length >= 50} onClick={() => { changed(); setLines(current => [...current, lineFor()]); }}>품목 행 추가</button>
          {direction === '입고' && <label className="erp-active-field"><input type="checkbox" checked={allowNewItems} onChange={e => { changed(); setAllowNewItems(e.target.checked); }} />신규 품목을 이 회사에 등록하는 데 동의합니다.</label>}
          {partnerId === 'NEW' && <label className="erp-active-field"><input type="checkbox" checked={allowNewPartners} onChange={e => { changed(); setAllowNewPartners(e.target.checked); }} />입력한 거래처를 이 회사에 저장하고 재사용합니다.</label>}
          <p className="wf-muted">재고가 없는 신규 회사의 첫 입고는 거래일 전날의 재고 0에서 시작합니다. 기존 재고가 있으면 먼저 Excel로 기초재고를 이관하세요.</p>
          <div className="erp-actions"><button type="submit" className="wf-btn wf-btn-primary">검증·미리보기</button></div>
        </fieldset>
      </form>
    </section>
    {error && <p role="alert" className="erp-error">{error}</p>}
    {!done && selected?.itemId && selected.itemId !== 'NEW' && <PriceHistory key={selected.itemId} companyId={companyId} itemId={selected.itemId} price={selected.price} currency={currency} priceBasis={priceBasis} />}
    {job && <section className="wf-panel" aria-label="입출고 미리보기"><h3 className="wf-section-title">{done ? `${direction} 확정 완료` : `${direction} 미리보기`}</h3>
      <p className="erp-code">거래번호: {job.preview.rows[0]?.documentNo || '검증 필요'}</p>
      {job.preview.errors.map((issue, i) => <p role="alert" className="erp-error" key={i}>{issue.row >= 10 ? `${issue.row - 9}번 품목: ` : ''}{issue.message}</p>)}
      {job.preview.warnings.map((issue, i) => <p className="erp-notice" key={i}>{issue.message}</p>)}
      <dl className="erp-stock-totals"><div><dt>{direction === '출고' ? '매출액 (공급가액)' : '매입 공급가액'}</dt><dd>{number(total('supply'))}<small>{currency}</small></dd></div><div><dt>부가세</dt><dd>{number(total('tax'))}<small>{currency}</small></dd></div><div><dt>거래 합계</dt><dd>{number(total('total'))}<small>{currency}</small></dd></div>
        <div><dt>재고자산 {direction === '출고' ? '감소 (출고원가)' : '증가'}</dt><dd>{number(direction === '출고' ? job.preview.rows.reduce((sum, row) => sum + (row.stockMode === 'BORROW' ? 0 : row.cost || 0), 0) : total('value'))}<small>원</small></dd></div></dl>
      {direction === '출고' && <><p>원화 매출액 {number(total('value'))}원 · 매출총이익 {number(total('value') - total('cost'))}원</p><p className="wf-muted">일반·조합 출고원가는 구성품 출고 창고의 이동평균원가로 계산합니다. 차용 판매는 입력한 평가금액을 사용하고 반환 시 실제 원가로 정산합니다. 아래 평균단가는 모든 창고를 합친 현재 재고 기준입니다.</p></>}
      <div className="erp-table-scroll"><table className="erp-table"><caption>품목별 전체 창고 재고 변동</caption><thead><tr><th>품목</th><th>전체 수량 전 → 후</th><th>전체 금액 전 → 후 (원)</th><th>평균단가 전 → 후 (원)</th></tr></thead><tbody>{job.preview.itemTotals?.map(row => <tr key={row.itemId}><td>{row.name || job.preview.rows.find(line => line.itemId === row.itemId)?.name}</td><td>{number(row.beforeQuantity)} → {number(row.quantity)}</td><td>{number(row.beforeValue)} → {number(row.value)}</td><td>{number(row.beforeQuantity ? row.beforeValue / row.beforeQuantity : null)} → {number(row.quantity ? row.value / row.quantity : null)}</td></tr>)}</tbody></table></div>
      {job.preview.rows.filter(row => row.bundle?.length).map(row => <div key={row.sourceRow}><h4>{row.name} 판매 당시 조합 구성</h4><ul>{row.bundle!.map(part => <li key={part.itemId}>{part.code} · {part.name}: {number(part.quantityScaled / 10000)} 차감 · 원가 {number(part.cost)}원</li>)}</ul></div>)}
      {!done && <><label className="erp-active-field"><input type="checkbox" disabled={busy || !job.preview.canCommit} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />수량·단가·거래처와 재고 변동을 확인했습니다.</label><div className="erp-actions"><button className="wf-btn" disabled={busy} onClick={() => { changed(); }}>입력 재검토</button><button className="wf-btn wf-btn-primary" disabled={busy || !job.preview.canCommit || !confirmed} onClick={() => void run(async () => {
        const expected = erpScope(companyId, true), result = await api.commit(companyId, job); if (live.current && erpScope(companyId, true) === expected) setJob(result.import);
      })}>{direction} 확정</button></div></>}
      {done && <><p role="status" className="erp-success">{direction}를 확정하고 회사 재고와 원장에 반영했습니다.</p><div className="erp-actions"><button className="wf-btn" onClick={onInventory}>갱신된 재고 확인</button>{direction === '출고' && <button className="wf-btn wf-btn-primary" onClick={() => onStatement(job.preview.rows[0].documentNo)}>이 출고로 거래명세표 작성</button>}</div><p className="wf-muted">확정 거래의 취소·반품은 입출고 총괄·원장에서 처리합니다. 같은 거래를 다시 입력하지 마세요.</p></>}
    </section>}
    {busy && <p role="status">처리 중입니다. 잠시 기다려 주세요.</p>}
  </div>;
}
