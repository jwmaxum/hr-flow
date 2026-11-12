import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { Boxes, PackageSearch, Plus, RefreshCw, Warehouse, UsersRound, Pencil, X } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { erpService } from '../services/erpService';
import { erpChoices } from '../services/erpAccountService';
import type { ErpKind, ErpRecord, ErpCursor, ErpValues, InventoryResult } from '../services/erpService';
import { getErrorMessage } from '../utils/errors';
import '../styles/Erp.css';
import { ErpImportPanel } from '../components/ErpImportPanel';
import { ErpReportPanel } from '../components/ErpReportPanel';
const ErpDocumentsPanel = lazy(() => import('../components/ErpDocumentsPanel').then(module => ({ default: module.ErpDocumentsPanel })));
const ErpTransferPanel = lazy(() => import('../components/ErpTransferPanel').then(module => ({ default: module.ErpTransferPanel })));
const ErpMovementPanel = lazy(() => import('../components/ErpMovementPanel').then(module => ({ default: module.ErpMovementPanel })));
const ErpFinancePanel = lazy(() => import('../components/ErpFinancePanel').then(module => ({ default: module.ErpFinancePanel })));
const ErpCustodyPanel = lazy(() => import('../components/ErpCustodyPanel').then(module => ({ default: module.ErpCustodyPanel })));

const names: Record<ErpKind, string> = { items: '품목', warehouses: '창고', partners: '거래처' };
const number = (value: number) => value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
type Field = { key: string; label: string; required?: boolean; max?: number; numeric?: boolean; options?: [string, string][] };
const fields: Record<ErpKind, Field[]> = {
  items: [
    { key: 'code', label: '품목코드', required: true, max: 60 }, { key: 'name', label: '품목명', required: true, max: 120 },
    { key: 'specification', label: '규격', max: 160 }, { key: 'unit', label: '단위', required: true, max: 20 },
    { key: 'purchasePrice', label: '매입단가 (원)', required: true, numeric: true },
    { key: 'salePrice', label: '판매단가 (원)', required: true, numeric: true },
    { key: 'taxType', label: '과세구분', options: [['과세', '과세'], ['영세', '영세'], ['면세', '면세']] },
    { key: 'group', label: '품목그룹', max: 80 },
  ],
  warehouses: [
    { key: 'code', label: '창고코드', required: true, max: 60 }, { key: 'name', label: '창고명', required: true, max: 120 },
    { key: 'address', label: '창고 주소', max: 300 },
  ],
  partners: [
    { key: 'code', label: '거래처코드', required: true, max: 60 }, { key: 'name', label: '거래처명', required: true, max: 120 },
    { key: 'type', label: '거래처 유형', options: [['BOTH', '매입·매출'], ['SUPPLIER', '매입처'], ['CUSTOMER', '매출처']] },
    { key: 'country', label: '국가코드 (KR, US 등)', required: true, max: 2 },
    { key: 'registrationNumber', label: '사업자·해외 등록번호', max: 80 }, { key: 'contactName', label: '담당자', max: 100 },
    { key: 'email', label: '이메일', max: 254 }, { key: 'phone', label: '연락처', max: 50 },
    { key: 'address', label: '주소', max: 300 },
  ],
};

function MasterEditor({ companyId, kind, record, onClose, onSaved }: {
  companyId: string; kind: ErpKind; record: ErpRecord | null; onClose: () => void; onSaved: (record: ErpRecord) => void;
}) {
  const [id] = useState(() => record?.id || crypto.randomUUID());
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields[kind].map(field => {
    const existing = record?.[field.key as keyof ErpRecord];
    return [field.key, existing === undefined ? (field.options?.[0][0] || (field.key === 'country' ? 'KR' : '')) : String(existing)];
  })));
  const [notes, setNotes] = useState(record?.notes || '');
  const [itemType, setItemType] = useState(record?.itemType || 'STOCK');
  const [components, setComponents] = useState(() => record?.components?.map(c => ({itemId: c.itemId, quantity: String(c.quantityScaled / 10000)})) || [{itemId: '', quantity: '1'}]);
  const [choices, setChoices] = useState<ErpRecord[]>([]);
  const [active, setActive] = useState(record?.active ?? true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; first.current?.focus(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {let live = true; if (kind === 'items') void erpChoices(companyId, 'items').then(items => {if (live) setChoices(items);}).catch(e => {if (live) setError(getErrorMessage(e));}); return () => {live = false;};}, [companyId, kind]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(''); setBusy(true);
    const payload: ErpValues = { code: values.code.trim(), name: values.name.trim(), active, notes: notes.trim() };
    for (const field of fields[kind]) payload[field.key] = field.numeric ? Number(values[field.key]) : values[field.key].trim();
    if (kind === 'items') {payload.itemType = itemType; payload.components = itemType === 'BUNDLE' ? components : [];}
    try {
      const result = await erpService.save(companyId, kind, id, record?.revision || 0, payload);
      if (mounted.current) onSaved(result.record);
    } catch (failure) { if (mounted.current) setError(getErrorMessage(failure, '저장하지 못했습니다. 다시 시도해 주세요.')); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="wf-panel erp-editor" aria-labelledby="erp-editor-title">
    <div className="wf-panel-head"><h2 id="erp-editor-title" className="wf-section-title">{names[kind]} {record ? '수정' : '등록'}</h2>
      <button type="button" className="wf-btn" onClick={onClose} disabled={busy} aria-label="편집 닫기"><X size={16} aria-hidden="true" /></button></div>
    <p className="wf-muted">이 회사의 기준정보로 저장합니다. 필수 항목은 * 표시입니다.</p>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={busy} className="erp-form-fields">
        {kind === 'items' && <label className="wf-field erp-form-wide"><span>상품 유형</span><select className="wf-input" value={itemType} disabled={!!record} onChange={e => setItemType(e.target.value as 'STOCK' | 'BUNDLE')}><option value="STOCK">일반 품목</option><option value="BUNDLE">조합상품 (구성품 자동 차감)</option></select></label>}
        {fields[kind].map((field, index) => <label className="wf-field" key={field.key}>
          <span>{field.label}{field.required ? ' *' : ''}</span>
          {field.options ? <select className="wf-input" value={values[field.key]} onChange={e => setValues(current => ({ ...current, [field.key]: e.target.value }))}>
            {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select> : <input ref={index === 0 ? first : undefined} className="wf-input" value={values[field.key]} required={field.required}
            type={field.numeric ? 'number' : field.key === 'email' ? 'email' : 'text'} min={field.numeric ? 0 : undefined}
            max={field.numeric ? 1e9 : undefined} step={field.numeric ? '0.0001' : undefined} maxLength={field.max}
            onChange={e => setValues(current => ({ ...current, [field.key]: e.target.value }))} />}
        </label>)}
        {kind === 'items' && itemType === 'BUNDLE' && <div className="erp-form-wide"><h3>조합 1개당 구성</h3><p className="wf-muted">1~20개 일반 품목으로 구성합니다. 조합상품 판매 시 구성품을 같은 출고 창고에서 차감하며, 판매 당시 구성은 반품·원장에 보존합니다.</p>{components.map((component, index) => <div className="erp-form-fields" key={index}><label className="wf-field"><span>{index + 1}번 구성품 *</span><select className="wf-input" required value={component.itemId} onChange={e => setComponents(rows => rows.map((r, i) => i === index ? {...r, itemId: e.target.value} : r))}><option value="">구성품 선택</option>{choices.filter(r => r.active && r.itemType !== 'BUNDLE' && r.id !== id).map(r => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}</select></label><label className="wf-field"><span>{index + 1}번 구성수량 *</span><input className="wf-input" required inputMode="decimal" value={component.quantity} onChange={e => setComponents(rows => rows.map((r, i) => i === index ? {...r, quantity: e.target.value} : r))} /></label><button className="wf-btn" type="button" disabled={components.length === 1} onClick={() => setComponents(rows => rows.filter((_, i) => i !== index))}>구성 삭제</button></div>)}<button className="wf-btn" type="button" disabled={components.length >= 20} onClick={() => setComponents(rows => [...rows, {itemId: '', quantity: '1'}])}>구성품 추가</button></div>}
        <label className="wf-field erp-form-wide"><span>비고</span><input className="wf-input" maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} /></label>
        <label className="erp-active-field erp-form-wide"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> 사용 중</label>
      </fieldset>
      {record && <p className="erp-form-note">사용을 중지해도 기존 재고와 거래 이력은 보존됩니다.</p>}
      {kind === 'partners' && <p className="erp-form-note">등록번호가 없는 거래처는 이름과 연락처를 확인해 주세요. 같은 이름을 자동 병합하지 않습니다.</p>}
      {error && <p role="alert" className="erp-error">{error}</p>}
      <div className="erp-actions"><button className="wf-btn" type="button" onClick={onClose} disabled={busy}>취소</button>
        <button className="wf-btn wf-btn-primary" type="submit" disabled={busy}>{busy ? '저장 중…' : '저장'}</button></div>
    </form>
  </section>;
}

function InventoryPanel({ value, loading, error, onRetry, onEdit, canManage }: {
  value: InventoryResult | null; loading: boolean; error: string; onRetry: () => void; onEdit: () => void; canManage: boolean;
}) {
  return <section className="wf-panel erp-inventory" aria-label="품목 재고현황" aria-busy={loading}>
    <div className="wf-panel-head"><h2 className="wf-section-title">재고현황</h2><button className="wf-btn" onClick={onRetry} disabled={loading} aria-label="재고 새로고침"><RefreshCw size={16} aria-hidden="true" /></button></div>
    {loading ? <p role="status" className="erp-empty">재고를 확인하고 있습니다.</p> : error ? <p role="alert" className="erp-error">{error}</p> : value ? <>
      <div className="erp-item-heading"><span className="erp-code">{value.item.code}</span><h3>{value.item.name}</h3><p className="wf-muted">{value.item.specification || '규격 미입력'} · {value.item.unit}</p>
        {!value.item.active && <span className="wf-status wf-status-warning">사용 중지</span>}</div>
      <dl className="erp-stock-totals"><div><dt>{value.virtual ? '구성품으로 출고 가능한 조합수량' : '현재 재고수량'}</dt><dd>{value.quantity === null ? '—' : number(value.quantity)}<small>{value.item.unit}</small></dd></div>
        {canManage && <><div><dt>전체 재고금액</dt><dd>{value.value == null ? '—' : number(value.value)}<small>원</small></dd></div><div><dt>평균 재고단가</dt><dd>{value.averagePrice == null ? '—' : number(value.averagePrice)}<small>원</small></dd></div></>}</dl>
      {value.virtual && <p className="erp-notice">조합상품의 별도 재고자산은 없습니다. 출고 가능 수량은 창고별 구성품 보유량으로 계산하며 구성품 원가에서 차감합니다.</p>}{canManage && !value.virtual && <p className="wf-muted">평균 재고단가 = 전체 창고의 재고금액 ÷ 현재 재고수량</p>}
      {value.status === 'UNINITIALIZED' && <p className="erp-notice"><strong>재고 미등록</strong><br />기초재고 또는 입출고가 반영되면 창고별 수량을 확인할 수 있습니다.</p>}
      {canManage && <dl className="erp-prices"><div><dt>기본 매입단가</dt><dd>{number(value.item.purchasePrice ?? 0)}원</dd></div><div><dt>기본 판매단가</dt><dd>{number(value.item.salePrice ?? 0)}원</dd></div></dl>}
      {value.warehouses.length > 0 && <div className="erp-table-scroll"><table className="erp-table"><caption className="erp-sr-only">창고별 재고</caption><thead><tr><th>창고</th><th className="erp-number">수량</th>{canManage && <th className="erp-number">금액 (원)</th>}</tr></thead>
        <tbody>{value.warehouses.map(row => <tr key={row.warehouseId}><td>{row.warehouseName}<small className="erp-cell-note">{row.warehouseCode}{row.warehouseActive ? '' : ' · 사용 중지'}</small></td><td className="erp-number">{number(row.quantity)}</td>{canManage && <td className="erp-number">{number(row.value ?? 0)}</td>}</tr>)}</tbody></table></div>}
      <div className="erp-inventory-footer"><small className="wf-muted">조회 {new Date(value.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</small>
        {canManage && <button className="wf-btn" onClick={onEdit}><Pencil size={14} aria-hidden="true" />품목 수정</button>}</div>
    </> : <div className="erp-empty"><PackageSearch size={32} aria-hidden="true" /><p>품목명을 입력하거나 목록에서 품목을 선택해 주세요.</p></div>}
  </section>;
}

export function ErpPage() {
  const { userData, companyData } = useAuthStore();
  if (!userData || userData.role === 'SUPER_ADMIN' || !userData.companyId || userData.companyId === 'PLATFORM') return <Navigate to="/" replace />;
  return <ErpWorkspace key={`${userData.uid}:${userData.companyId}:${userData.role}`} companyId={userData.companyId}
    companyName={companyData?.id === userData.companyId ? companyData.nameKo : '소속 회사'} canManage={userData.role === 'ADMIN'} />;
}

function ErpWorkspace({ companyId, companyName, canManage }: { companyId: string; companyName: string; canManage: boolean }) {
  const [importOpen, setImportOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [documentsOpen, setDocumentsOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [accountPanel, setAccountPanel] = useState<'finance' | 'custody' | null>(null);
  const [movement, setMovement] = useState<{ direction: '입고' | '출고'; item: ErpRecord | null; key: string } | null>(null);
  const [documentSource, setDocumentSource] = useState('');
  const [kind, setKind] = useState<ErpKind>('items');
  const [search, setSearch] = useState(''), [searchBy, setSearchBy] = useState<'name' | 'code'>('name');
  const [records, setRecords] = useState<ErpRecord[]>([]), [cursor, setCursor] = useState<ErpCursor | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<ErpRecord | null>(null), [stock, setStock] = useState<InventoryResult | null>(null);
  const [stockLoading, setStockLoading] = useState(false), [stockError, setStockError] = useState('');
  const [editor, setEditor] = useState<{ record: ErpRecord | null } | null>(null), [notice, setNotice] = useState('');
  const generation = useRef(0), stockGeneration = useRef(0), preferred = useRef('');
  const addButton = useRef<HTMLButtonElement>(null);
  function openMovement(direction: '입고' | '출고', item: ErpRecord | null = null) {
    setAccountPanel(null);
    setImportOpen(false); setReportOpen(false); setDocumentsOpen(false); setTransferOpen(false); setNotice('');
    setMovement({ direction, item, key: crypto.randomUUID() });
  }
  function showInventory() { setMovement(null); setImportOpen(false); reset(); setKind('items'); setSearch(''); setSearchBy('name'); setReload(value => value + 1); }

  function choose(record: ErpRecord) { stockGeneration.current++; setSelected({ ...record }); setEditor(null); setStock(null); setStockError(''); }
  function reset() {
    generation.current++; stockGeneration.current++; preferred.current = '';
    setRecords([]); setCursor(null); setSelected(null); setStock(null); setStockError(''); setStockLoading(false); setEditor(null); setError(''); setLoading(true); setNotice('');
  }
  useEffect(() => {
    const epoch = ++generation.current;
    const timer = setTimeout(() => {
      void erpService.list(companyId, kind, search, searchBy).then(result => {
        if (generation.current !== epoch) return;
        setRecords(result.records); setCursor(result.nextCursor); setError('');
        if (kind === 'items') setSelected(result.records.find(row => row.id === preferred.current) || result.records[0] || null);
      }).catch(failure => { if (generation.current === epoch) { setRecords([]); setSelected(null); setStock(null); setError(getErrorMessage(failure, '목록을 불러오지 못했습니다.')); } })
        .finally(() => { if (generation.current === epoch) setLoading(false); });
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); generation.current = epoch + 1; };
  }, [companyId, kind, search, searchBy, reload]);

  useEffect(() => {
    if (!selected || kind !== 'items') return;
    const epoch = ++stockGeneration.current;
    // A separate task preserves loading feedback without retaining a previous item's balance.
    const timer = setTimeout(() => {
      setStockLoading(true); setStock(null); setStockError('');
      void erpService.inventory(companyId, selected.id).then(result => {
        if (stockGeneration.current === epoch) setStock(result);
      }).catch(failure => { if (stockGeneration.current === epoch) setStockError(getErrorMessage(failure, '재고를 불러오지 못했습니다.')); })
        .finally(() => { if (stockGeneration.current === epoch) setStockLoading(false); });
    }, 0);
    return () => { clearTimeout(timer); stockGeneration.current = epoch + 1; };
  }, [companyId, kind, selected]);

  async function more() {
    if (!cursor || loading) return;
    const epoch = generation.current; setLoading(true);
    try {
      const result = await erpService.list(companyId, kind, search, searchBy, cursor);
      if (epoch !== generation.current) return;
      setRecords(current => [...current, ...result.records.filter(row => !current.some(item => item.id === row.id))]); setCursor(result.nextCursor); setError('');
    } catch (failure) { if (epoch === generation.current) setError(getErrorMessage(failure)); }
    finally { if (epoch === generation.current) setLoading(false); }
  }
  function saved(record: ErpRecord) {
    reset(); preferred.current = record.id; setSearchBy('name'); setSearch(record.name); setReload(value => value + 1);
    setNotice(`${record.name} ${record.active ? '저장' : '사용 중지'} 완료`);
    requestAnimationFrame(() => addButton.current?.focus());
  }
  return <main className="wf-page erp-page">
    <header className="erp-page-head"><div><p className="erp-eyebrow">{companyName}</p><h1 className="wf-title">재고관리 ERP</h1>
      <p className="wf-muted">품목을 찾고 창고별 재고를 확인하세요.</p></div><span className="wf-status"><Boxes size={15} aria-hidden="true" />{canManage ? '회사 관리자' : '재고 조회'}</span></header>
    <nav className="erp-tabs" aria-label="ERP 업무">
      {([['items', PackageSearch], ['warehouses', Warehouse], ['partners', UsersRound]] as const).filter(([key]) => canManage || key !== 'partners').map(([key, Icon]) =>
        <button key={key} type="button" aria-pressed={!accountPanel && !movement && !importOpen && !reportOpen && !documentsOpen && !transferOpen && kind === key} onClick={() => { setAccountPanel(null); setMovement(null); setImportOpen(false); setReportOpen(false); setDocumentsOpen(false); setTransferOpen(false); if (kind !== key || movement || importOpen || reportOpen || documentsOpen || transferOpen) { reset(); setKind(key); setSearch(''); setSearchBy('name'); setReload(value => value + 1); } }}><Icon size={18} aria-hidden="true" />{names[key]}{key === 'items' ? '·재고현황' : ' 관리'}</button>)}
      {canManage && <button type="button" aria-pressed={movement?.direction === '출고'} onClick={() => openMovement('출고')}>출고등록</button>}
      {canManage && <button type="button" aria-pressed={importOpen} onClick={() => { setAccountPanel(null); setMovement(null); setImportOpen(true); setReportOpen(false); setDocumentsOpen(false); setTransferOpen(false); }}>Excel 업로드</button>}
      {canManage && <button type="button" aria-pressed={transferOpen} onClick={() => { setAccountPanel(null); setMovement(null); setTransferOpen(true); setImportOpen(false); setReportOpen(false); setDocumentsOpen(false); }}>창고 이동</button>}
      <button type="button" aria-pressed={reportOpen} onClick={() => { setAccountPanel(null); setMovement(null); setReportOpen(true); setImportOpen(false); setDocumentsOpen(false); setTransferOpen(false); }}>입출고 총괄·원장</button>
      {canManage && <button type="button" aria-pressed={documentsOpen} onClick={() => { setAccountPanel(null); setMovement(null); setDocumentSource(''); setDocumentsOpen(true); setImportOpen(false); setReportOpen(false); setTransferOpen(false); }}>거래서류 발행</button>}
      {canManage && <><button type="button" aria-pressed={accountPanel === 'finance'} onClick={() => {setAccountPanel('finance'); setMovement(null); setImportOpen(false); setReportOpen(false); setDocumentsOpen(false); setTransferOpen(false);}}>미수금·수금</button><button type="button" aria-pressed={accountPanel === 'custody'} onClick={() => {setAccountPanel('custody'); setMovement(null); setImportOpen(false); setReportOpen(false); setDocumentsOpen(false); setTransferOpen(false);}}>보관·차용</button></>}
    </nav>
    {notice && <p role="status" className="erp-success">{notice}</p>}
    {accountPanel && canManage ? <Suspense fallback={<p role="status">원장을 불러오고 있습니다.</p>}>{accountPanel === 'finance' ? <ErpFinancePanel companyId={companyId} /> : <ErpCustodyPanel companyId={companyId} />}</Suspense> : movement && canManage ? <Suspense fallback={<p role="status">입출고 등록을 불러오고 있습니다.</p>}><ErpMovementPanel key={movement.key} companyId={companyId} direction={movement.direction} initialItem={movement.item} onInventory={showInventory} onStatement={documentNo => { setMovement(null); setDocumentSource(documentNo); setDocumentsOpen(true); }} /></Suspense> : transferOpen && canManage ? <Suspense fallback={<p role="status">창고 이동을 불러오고 있습니다.</p>}><ErpTransferPanel key={companyId} companyId={companyId} /></Suspense> : documentsOpen && canManage ? <Suspense fallback={<p role="status">거래서류를 불러오고 있습니다.</p>}><ErpDocumentsPanel companyId={companyId} initialSourceDocumentNo={documentSource} /></Suspense> : reportOpen ? <ErpReportPanel companyId={companyId} canManage={canManage} /> : importOpen && canManage ? <ErpImportPanel companyId={companyId} onInventory={showInventory} /> : <div className={`erp-layout ${kind !== 'items' && !editor ? 'erp-layout-single' : ''}`}>
      <section className="wf-panel erp-list" aria-label={`${names[kind]} 목록`}>
        <div className="erp-list-head"><h2 className="wf-section-title">{names[kind]} 목록</h2>{canManage && <button ref={addButton} className="wf-btn wf-btn-primary" onClick={() => { if (kind === 'items') openMovement('입고'); else { setEditor({ record: null }); setNotice(''); } }}><Plus size={16} aria-hidden="true" />{kind === 'items' ? '입고등록' : `${names[kind]} 등록`}</button>}</div>
        {kind === 'items' && canManage && <div className="erp-actions"><small className="wf-muted">코드 선택 → 입고등록 · 품목명 선택 → 재고현황</small><button className="wf-btn" onClick={() => { setEditor({ record: null }); setNotice(''); }}>품목 정보만 등록</button></div>}
        <div className="erp-search"><label className="wf-field"><span>검색 기준</span><select className="wf-input" value={searchBy} onChange={e => { reset(); setSearchBy(e.target.value as 'name' | 'code'); }}><option value="name">{names[kind]}명</option><option value="code">코드</option></select></label>
          <label className="wf-field erp-search-term"><span>{searchBy === 'name' ? `${names[kind]}명` : '코드'} 검색</span><input className="wf-input" type="search" value={search} maxLength={120} placeholder="이름 또는 코드의 앞부분 입력" onChange={e => { reset(); setSearch(e.target.value); }} /></label>
          <button className="wf-btn erp-refresh" aria-label="목록 새로고침" onClick={() => { reset(); setReload(value => value + 1); }}><RefreshCw size={17} aria-hidden="true" /></button></div>
        {error && <p role="alert" className="erp-error">{error}</p>}
        <div className="erp-table-scroll" aria-busy={loading}><table className="erp-table"><caption className="erp-sr-only">회사별 {names[kind]} 목록</caption><thead><tr><th>코드</th><th>{names[kind]}명</th><th>상태</th>{canManage && <th>관리</th>}</tr></thead>
          <tbody>{records.map(record => <tr key={record.id} className={selected?.id === record.id ? 'erp-selected' : ''}>
            <td className="erp-code">{kind === 'items' && canManage ? <button className="erp-name-button" disabled={!record.active} onClick={() => openMovement(record.itemType === 'BUNDLE' ? '출고' : '입고', record)} aria-label={`${record.code} ${record.itemType === 'BUNDLE' ? '출고등록' : '입고등록'}`}>{record.code}</button> : record.code}</td><td>{kind === 'items' ? <button className="erp-name-button" aria-pressed={selected?.id === record.id} onClick={() => choose(record)} aria-label={`${record.name} 재고 보기`}>{record.name}<small className="erp-cell-note">{record.specification || record.unit}</small></button> : <><strong>{record.name}</strong><small className="erp-cell-note">{record.address || (record.type === 'CUSTOMER' ? '매출처' : record.type === 'SUPPLIER' ? '매입처' : record.type === 'BOTH' ? '매입·매출처' : '')}</small></>}</td>
            <td><span className={`wf-status ${record.active ? '' : 'wf-status-warning'}`}>{record.active ? '사용 중' : '중지'}</span></td>
            {canManage && <td><button className="wf-btn" onClick={() => setEditor({ record })} aria-label={`${record.name} 수정`}><Pencil size={14} aria-hidden="true" /><span>수정</span></button></td>}</tr>)}</tbody></table></div>
        {loading ? <p role="status" className="erp-empty">불러오는 중…</p> : !records.length && !error ? <div className="erp-empty"><PackageSearch size={30} aria-hidden="true" /><p>{search ? '검색 결과가 없습니다. 이름의 앞부분이나 코드를 확인해 주세요.' : `등록된 ${names[kind]}이 없습니다.`}</p>{canManage && !search && <p>회사의 {names[kind]}을 등록해 시작하세요.</p>}</div> : null}
        {cursor && <div className="erp-more"><button className="wf-btn" onClick={() => void more()} disabled={loading}>더 보기</button></div>}
      </section>
      {editor && canManage ? <MasterEditor key={`${kind}:${editor.record?.id || 'new'}:${editor.record?.revision || 0}`} companyId={companyId} kind={kind} record={editor.record}
        onClose={() => { setEditor(null); requestAnimationFrame(() => addButton.current?.focus()); }} onSaved={saved} /> : kind === 'items' ? <InventoryPanel value={stock} loading={stockLoading} error={stockError} canManage={canManage}
          onRetry={() => { if (selected) { stockGeneration.current++; setStock(null); setSelected({ ...selected }); } }} onEdit={() => { if (stock) setEditor({ record: stock.item }); }} /> : null}
    </div>}
  </main>;
}
