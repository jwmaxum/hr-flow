import {ErpNavigation} from '../components/ErpNavigation';
import {erpAccessOf,erpCanOperate,erpAccessNames} from '../utils/erpAccess';
import type {ErpAccess} from '../utils/erpAccess';
import {erpRoute,erpPath,erpMenuFor,erpTasks,erpMenus,erpInbound,erpOutbound} from '../utils/erpNavigation';
import type {ErpView,ErpMenu} from '../utils/erpNavigation';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Boxes, PackageSearch, Plus, RefreshCw, Pencil, X, ChartColumn } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { erpService } from '../services/erpService';
import { ErpBundleEstimate } from '../components/ErpBundleEstimate';
import { erpChoices } from '../services/erpAccountService';
import type { ErpKind, ErpRecord, ErpCursor, ErpValues, InventoryResult } from '../services/erpService';
import { getErrorMessage } from '../utils/errors';
import '../styles/Erp.css';
import { ErpImportPanel } from '../components/ErpImportPanel';
import { ErpReportPanel } from '../components/ErpReportPanel';
const ErpShipmentsPanel=lazy(()=>import('../components/ErpShipmentsPanel').then(m=>({default:m.ErpShipmentsPanel})));
const ErpClosingPlanPanel=lazy(()=>import('../components/ErpClosingPlanPanel').then(m=>({default:m.ErpClosingPlanPanel})));
const ErpControlPanel=lazy(()=>import('../components/ErpControlPanel').then(m=>({default:m.ErpControlPanel})));
const ErpDocumentsPanel = lazy(() => import('../components/ErpDocumentsPanel').then(module => ({ default: module.ErpDocumentsPanel })));
const ErpTransferPanel = lazy(() => import('../components/ErpTransferPanel').then(module => ({ default: module.ErpTransferPanel })));
const ErpMovementPanel = lazy(() => import('../components/ErpMovementPanel').then(module => ({ default: module.ErpMovementPanel })));
const ErpFinancePanel = lazy(() => import('../components/ErpFinancePanel').then(module => ({ default: module.ErpFinancePanel })));
const ErpDashboardPanel=lazy(()=>import('../components/ErpDashboardPanel').then(module=>({default:module.ErpDashboardPanel})));
const ErpOpeningPanel = lazy(() => import('../components/ErpOpeningPanel').then(module => ({ default: module.ErpOpeningPanel })));
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
  companyId: string; kind: ErpKind; record: ErpRecord | null; onClose: () => void; onSaved: (record: ErpRecord, queued?: boolean) => void;
}) {
  const [id] = useState(() => record?.id || crypto.randomUUID());
  const [requestId]=useState(()=>crypto.randomUUID());
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields[kind].map(field => {
    const existing = record?.[field.key as keyof ErpRecord];
    return [field.key, existing === undefined ? (field.options?.[0][0] || (field.key === 'country' ? 'KR' : '')) : String(existing)];
  })));
  const [notes, setNotes] = useState(record?.notes || '');
  const [itemType, setItemType] = useState(record?.itemType || 'STOCK');
  const [components, setComponents] = useState(() => record?.components?.map(c => ({itemId: c.itemId, quantity: String(c.quantityScaled / 10000)})) || [{itemId: '', quantity: '1'}, {itemId: '', quantity: '1'}]);
  const [choices, setChoices] = useState<ErpRecord[]>([]), [warehouses, setWarehouses] = useState<ErpRecord[]>([]);
  const [warehouseId, setWarehouseId] = useState(''), [componentSearch, setComponentSearch] = useState('');
  const [active, setActive] = useState(record?.active ?? true);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; first.current?.focus(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {let live = true; if (kind === 'items') void Promise.all([erpChoices(companyId, 'items'), erpChoices(companyId, 'warehouses')]).then(([items, stores]) => {if (live) {setChoices(items); setWarehouses(stores);}}).catch(e => {if (live) setError(getErrorMessage(e));}); return () => {live = false;};}, [companyId, kind]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(''); setBusy(true);
    const payload: ErpValues = { code: values.code.trim(), name: values.name.trim(), active, notes: notes.trim() };
    for (const field of fields[kind]) payload[field.key] = field.numeric ? Number(values[field.key]) : values[field.key].trim();
    if (kind === 'items') {payload.itemType = itemType; payload.components = itemType === 'BUNDLE' ? components : []; if (itemType === 'BUNDLE') payload.purchasePrice = 0;}
    try {
      const unchangedLegacy = record?.components?.length === 1 && components.length === 1 && record.components[0].itemId === components[0].itemId && record.components[0].quantityScaled === Number(components[0].quantity) * 10000;
      if (kind === 'items' && itemType === 'BUNDLE' && ((components.length < 2 && !unchangedLegacy) || new Set(components.map(c => c.itemId)).size !== components.length)) throw new Error('합성상품은 서로 다른 일반 품목 2~20종으로 구성해 주세요.');
      const result = await erpService.save(companyId, kind, id, record?.revision || 0, payload, requestId);
      if (mounted.current) onSaved(result.approvalRequested ? record! : result.record, result.approvalRequested);
    } catch (failure) { if (mounted.current) setError(getErrorMessage(failure, '저장하지 못했습니다. 다시 시도해 주세요.')); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <section className="wf-panel erp-editor" aria-labelledby="erp-editor-title">
    <div className="wf-panel-head"><h2 id="erp-editor-title" className="wf-section-title">{names[kind]} {record ? '수정' : '등록'}</h2>
      <button type="button" className="wf-btn" onClick={onClose} disabled={busy} aria-label="편집 닫기"><X size={16} aria-hidden="true" /></button></div>
    <p className="wf-muted">이 회사의 기준정보로 저장합니다. 필수 항목은 * 표시입니다.</p>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={busy} className="erp-form-fields">
        {kind === 'items' && <label className="wf-field erp-form-wide"><span>상품 유형</span><select aria-label="상품 유형" className="wf-input" value={itemType} disabled={!!record} onChange={e => setItemType(e.target.value as 'STOCK' | 'BUNDLE')}><option value="STOCK">일반상품</option><option value="BUNDLE">합성상품 (Combo·세트)</option></select></label>}
        {fields[kind].filter(field => !(kind === 'items' && itemType === 'BUNDLE' && field.key === 'purchasePrice')).map((field, index) => <label className="wf-field" key={field.key}>
          <span>{field.label}{field.required ? ' *' : ''}</span>
          {field.options ? <select className="wf-input" value={values[field.key]} onChange={e => setValues(current => ({ ...current, [field.key]: e.target.value }))}>
            {field.options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select> : <input ref={index === 0 ? first : undefined} className="wf-input" value={values[field.key]} required={field.required}
            type={field.numeric ? 'number' : field.key === 'email' ? 'email' : 'text'} min={field.numeric ? 0 : undefined}
            max={field.numeric ? 1e9 : undefined} step={field.numeric ? '0.0001' : undefined} maxLength={field.max}
            onChange={e => setValues(current => ({ ...current, [field.key]: e.target.value }))} />}
        </label>)}
        {kind === 'items' && itemType === 'BUNDLE' && <div className="erp-form-wide">
          <h3>합성상품 1세트 구성</h3><p className="wf-muted">서로 다른 일반상품 2~20종을 선택하세요. 출고 시 구성품을 같은 창고에서 차감하며 당시 구성과 원가는 보존합니다. 세트 자체의 매입단가는 입력하지 않습니다.</p>
          {record?.components?.length === 1 && <p className="erp-notice">기존 1종 구성은 유지할 수 있습니다. 구성을 변경하려면 2종 이상을 선택하세요.</p>}
          <label className="wf-field"><span>구성품 검색</span><input className="wf-input" placeholder="품목명 또는 코드 검색" value={componentSearch} onChange={e => setComponentSearch(e.target.value)} /></label>
          {components.map((component, index) => <div className="erp-form-fields erp-bundle-component" key={index}>
            <label className="wf-field"><span>{index + 1}번 구성품 *</span><select aria-label={`${index + 1}번 구성품`} className="wf-input" required value={component.itemId} onChange={e => setComponents(rows => rows.map((r, i) => i === index ? {...r, itemId: e.target.value} : r))}><option value="">구성품 선택</option>{choices.filter(r => r.id === component.itemId || r.active && r.itemType !== 'BUNDLE' && r.id !== id && `${r.code} ${r.name}`.toLocaleLowerCase().includes(componentSearch.trim().toLocaleLowerCase())).map(r => <option key={r.id} value={r.id} disabled={components.some((c, i) => i !== index && c.itemId === r.id)}>{r.code} · {r.name}</option>)}</select></label>
            <label className="wf-field"><span>{index + 1}번 구성수량 *</span><input className="wf-input" required type="number" min="0.0001" step="0.0001" value={component.quantity} onChange={e => setComponents(rows => rows.map((r, i) => i === index ? {...r, quantity: e.target.value} : r))} /></label>
            <button className="wf-btn" type="button" disabled={components.length <= 2} aria-label={`${index + 1}번 구성 삭제`} onClick={() => setComponents(rows => rows.filter((_, i) => i !== index))}>구성 삭제</button>
          </div>)}
          <button className="wf-btn" type="button" disabled={components.length >= 20} onClick={() => setComponents(rows => [...rows, {itemId: '', quantity: '1'}])}>구성품 추가</button>
          <label className="wf-field"><span>원가 확인 창고</span><select aria-label="원가 확인 창고" className="wf-input" value={warehouseId} onChange={e => setWarehouseId(e.target.value)}><option value="">창고 선택 (선택사항)</option>{warehouses.filter(w => w.active).map(w => <option key={w.id} value={w.id}>{w.code} · {w.name}</option>)}</select></label>
          <ErpBundleEstimate companyId={companyId} warehouseId={warehouseId} components={components} quantity="1" />
        </div>}
        <label className="wf-field erp-form-wide"><span>비고</span><input className="wf-input" maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} /></label>
        <label className="erp-active-field erp-form-wide"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> 사용 중</label>
      </fieldset>
      {record && <p className="erp-form-note">사용을 중지해도 기존 재고와 거래 이력은 보존됩니다. 담당자의 변경은 ADMIN 승인 후 반영합니다. ERP관리자가 품목 매입·판매 단가만 변경하면 승인 없이 반영하며, 그 외 기준정보 변경은 ADMIN 승인을 요청합니다.</p>}
      {kind === 'partners' && <p className="erp-form-note">등록번호가 없는 거래처는 이름과 연락처를 확인해 주세요. 같은 이름을 자동 병합하지 않습니다.</p>}
      {error && <p role="alert" className="erp-error">{error}</p>}
      <div className="erp-actions"><button className="wf-btn" type="button" onClick={onClose} disabled={busy}>취소</button>
        <button className="wf-btn wf-btn-primary" type="submit" disabled={busy}>{busy ? '저장 중…' : '저장'}</button></div>
    </form>
  </section>;
}

function InventoryPanel({ value, loading, error, onRetry, onEdit, onOpening, canManage, canOpenOpening }: {
  value: InventoryResult | null; loading: boolean; error: string; onRetry: () => void; onEdit: () => void; onOpening: () => void; canManage: boolean; canOpenOpening:boolean;
}) {
  return <section className="wf-panel erp-inventory" aria-label="품목 재고현황" aria-busy={loading}>
    <div className="wf-panel-head"><h2 className="wf-section-title">재고현황</h2><button className="wf-btn" onClick={onRetry} disabled={loading} aria-label="재고 새로고침"><RefreshCw size={16} aria-hidden="true" /></button></div>
    {loading ? <p role="status" className="erp-empty">재고를 확인하고 있습니다.</p> : error ? <p role="alert" className="erp-error">{error}</p> : value ? <>
      <div className="erp-item-heading"><span className="erp-code">{value.item.code}</span><h3>{value.item.name}</h3><p className="wf-muted">{value.item.specification || '규격 미입력'} · {value.item.unit}</p>
        {!value.item.active && <span className="wf-status wf-status-warning">사용 중지</span>}</div>
      <dl className="erp-stock-totals"><div><dt>{value.virtual ? '구성품으로 출고 가능한 조합수량' : value.status === 'PENDING_COST' ? '이관 대기 수량 (원본 기준)' : '현재 재고수량'}</dt><dd>{value.status === 'PENDING_COST' ? (value.pendingOpening?.quantity == null ? '수량 미입력' : number(value.pendingOpening.quantity)) : value.quantity === null ? '—' : number(value.quantity)}<small>{value.status === 'PENDING_COST' ? value.pendingOpening?.unit : value.item.unit}</small></dd></div>
        {canManage && <><div><dt>전체 재고금액</dt><dd>{value.status === 'PENDING_COST' ? <small>원가 미확정</small> : <>{value.value == null ? '—' : number(value.value)}<small>원</small></>}</dd></div><div><dt>평균 재고단가</dt><dd>{value.status === 'PENDING_COST' ? <small>원가 미확정</small> : <>{value.averagePrice == null ? '—' : number(value.averagePrice)}<small>원</small></>}</dd></div></>}</dl>
      {value.virtual && <p className="erp-notice">조합상품의 별도 재고자산은 없습니다. 출고 가능 수량은 창고별 구성품 보유량으로 계산하며 구성품 원가에서 차감합니다.</p>}{canManage && !value.virtual && <p className="wf-muted">평균 재고단가 = 전체 창고의 재고금액 ÷ 현재 재고수량</p>}
      {value.status === 'UNINITIALIZED' && <p className="erp-notice"><strong>재고 미등록</strong><br />기초재고 또는 입출고가 반영되면 창고별 수량을 확인할 수 있습니다.</p>}
      {value.pendingOpening && <div className="erp-notice" aria-label="원가 미확정 이관 대기"><strong>원가 확인 후 재고 확정 필요</strong><p>{value.pendingOpening.basisDate} 기준 · 원본 수량 {value.pendingOpening.quantity == null ? '공란' : `${number(value.pendingOpening.quantity)} ${value.pendingOpening.unit}`}</p><p>{value.pendingOpening.source}</p><p>원본의 이관 대기 수량입니다. 출고 가능한 확정 재고와 재고자산에는 포함되지 않습니다. 실제 원가 확인 후 기초재고 원가 확정에서 수량·금액을 확정해 주세요. 기본 매입단가만 수정해도 재고가 확정되지는 않습니다.</p>{canOpenOpening&&<button className="wf-btn wf-btn-primary" disabled={!value.item.active} onClick={onOpening}>원가 입력·기초재고 확정</button>}</div>}
      {canManage && <dl className="erp-prices">{!value.virtual && <div><dt>기본 매입단가</dt><dd>{number(value.item.purchasePrice ?? 0)}원</dd></div>}<div><dt>기본 판매단가</dt><dd>{number(value.item.salePrice ?? 0)}원</dd></div></dl>}
      {value.warehouses.length > 0 && <div className="erp-table-scroll"><table className="erp-table"><caption className="erp-sr-only">창고별 재고</caption><thead><tr><th>창고</th><th className="erp-number">수량</th>{canManage && <th className="erp-number">금액 (원)</th>}</tr></thead>
        <tbody>{value.warehouses.map(row => <tr key={row.warehouseId}><td>{row.warehouseName}<small className="erp-cell-note">{row.warehouseCode}{row.warehouseActive ? '' : ' · 사용 중지'}</small></td><td className="erp-number">{number(row.quantity)}</td>{canManage && <td className="erp-number">{number(row.value ?? 0)}</td>}</tr>)}</tbody></table></div>}
      <div className="erp-inventory-footer"><small className="wf-muted">조회 {new Date(value.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</small>
        {canManage && <button className="wf-btn" onClick={onEdit}><Pencil size={14} aria-hidden="true" />품목 수정</button>}</div>
    </> : <div className="erp-empty"><PackageSearch size={32} aria-hidden="true" /><p>품목명을 입력하거나 목록에서 품목을 선택해 주세요.</p></div>}
  </section>;
}

export function ErpPage() {
  const {userData,companyData}=useAuthStore(),location=useLocation(),access=erpAccessOf(userData);
  if(!userData||userData.role==='SUPER_ADMIN'||!userData.companyId||userData.companyId==='PLATFORM')return <Navigate to="/" replace/>;
  if(access==='NONE')return <main className="wf-page"><h1>ERP 접근 권한이 없습니다.</h1><p>회사 ADMIN에게 ERP 접근 권한 지정을 요청해 주세요.</p></main>;
  const route=erpRoute(location.search,access),item=location.state?.erpItem;
  return <ErpWorkspace key={`${userData.uid}:${userData.companyId}:${userData.role}:${access}:${location.key}`} companyId={userData.companyId}
    companyName={companyData?.id===userData.companyId?companyData.nameKo:'소속 회사'} canManage={access==='ADMIN'} access={access} route={route}
    initialItem={item&&typeof item.id==='string'&&typeof item.name==='string'&&typeof item.code==='string'?item:null}/>;
}

function ErpWorkspace({companyId,companyName,canManage,access,route,initialItem}:{companyId:string;companyName:string;canManage:boolean;access:ErpAccess;route:ReturnType<typeof erpRoute>;initialItem:ErpRecord|null}){
  const navigate=useNavigate(),canOperate=erpCanOperate(access),manager=access==='MANAGER';
  const inbound=erpInbound(access),outbound=erpOutbound(access),view=route.view;
  const kind:ErpKind=view==='warehouses'||view==='partners'?view:'items';
  const showMaster=!route.denied&&['items','warehouses','partners'].includes(view||'');
  const movement:{direction:'입고'|'출고';item:ErpRecord|null;key:string}|null=view==='inbound'||view==='outbound'?{direction:view==='inbound'?'입고':'출고',item:initialItem,key:view}:null;
  function openView(next:ErpView,menu?:ErpMenu,source='',item:ErpRecord|null=null){
    const group=menu||(erpTasks[route.menu].some(t=>t.view===next)?route.menu:erpMenuFor(next));
    navigate(erpPath(next,group,source),{state:item?{erpItem:item}:null});
  }
  function openOpening(itemId=''){openView('opening','inbound',itemId);}
  const [search, setSearch] = useState(''), [searchBy, setSearchBy] = useState<'name' | 'code'>('name');
  const [records, setRecords] = useState<ErpRecord[]>([]), [cursor, setCursor] = useState<ErpCursor | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<ErpRecord | null>(null), [stock, setStock] = useState<InventoryResult | null>(null);
  const [stockLoading, setStockLoading] = useState(false), [stockError, setStockError] = useState('');
  const [editor, setEditor] = useState<{ record: ErpRecord | null } | null>(null), [notice, setNotice] = useState('');
  const generation = useRef(0), stockGeneration = useRef(0), preferred = useRef('');
  const addButton = useRef<HTMLButtonElement>(null);
  function openMovement(direction:'입고'|'출고',item:ErpRecord|null=null){openView(direction==='입고'?'inbound':'outbound',direction==='입고'?'inbound':'sales','',item);}
  function showInventory(){openView('items','stock');}

  function choose(record: ErpRecord) { stockGeneration.current++; setSelected({ ...record }); setEditor(null); setStock(null); setStockError(''); }
  function reset() {
    generation.current++; stockGeneration.current++; preferred.current = '';
    setRecords([]); setCursor(null); setSelected(null); setStock(null); setStockError(''); setStockLoading(false); setEditor(null); setError(''); setLoading(true); setNotice('');
  }
  useEffect(() => {
    if(!showMaster)return;
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
  }, [companyId, kind, search, searchBy, reload, showMaster]);

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
  function saved(record: ErpRecord, queued=false) {
    reset(); preferred.current = record.id; setSearchBy('name'); setSearch(record.name); setReload(value => value + 1);
    setNotice(queued?'ADMIN 승인 요청을 등록했습니다. 승인 전에는 기존 정보가 유지됩니다.':`${record.name} ${record.active ? '저장' : '사용 중지'} 완료`);
    requestAnimationFrame(() => addButton.current?.focus());
  }
  return <main className="wf-page erp-page">
    <header className="erp-page-head"><div><p className="erp-eyebrow">{companyName}</p><div className="erp-title-row"><h1 className="wf-title">재고관리 ERP</h1>{canManage&&<button className="wf-btn erp-dashboard-toggle" aria-label="ERP 월별 대시보드" title="월별 재고·매출·미수금 대시보드" onClick={()=>openView('dashboard','dashboard')}><ChartColumn size={21} aria-hidden="true"/></button>}</div>
      <p className="wf-muted">{erpMenus.find(m=>m.id===route.menu)?.description}</p></div><span className="wf-status"><Boxes size={15} aria-hidden="true"/>{erpAccessNames[access]}</span></header>
    <ErpNavigation menu={route.menu} view={view} access={access} onOpen={openView}/>
    {manager&&<p className="erp-notice">ERP관리자: 입출고 정정·재고 수량/금액 조정·품목 단가만 변경하는 수정은 승인 없이 반영하고 이력을 남깁니다. 다른 기준정보 변경과 기존 승인 대기 요청은 ADMIN 승인을 따릅니다.</p>}
    {notice && <p role="status" className="erp-success">{notice}</p>}
    {route.denied?<section className="wf-panel" role="alert"><h2>이 업무에 접근할 권한이 없습니다.</h2><p>현재 ERP 담당 업무 범위에서 메뉴를 선택해 주세요. 권한 변경은 회사 ADMIN에게 요청하세요.</p></section>:
      view==='closing'?<Suspense fallback={<p role="status">마감 일정을 불러오고 있습니다.</p>}><ErpClosingPlanPanel companyId={companyId}/></Suspense>:
      view==='access'||view==='approvals'||view==='close'||view==='history'?<Suspense fallback={<p role="status">관리 화면을 불러오고 있습니다.</p>}><ErpControlPanel companyId={companyId} initialTab={view} embedded/></Suspense>:
      view==='dashboard'?<Suspense fallback={<p role="status">대시보드를 불러오고 있습니다.</p>}><ErpDashboardPanel companyId={companyId} onFinance={()=>openView('finance','receivables')} onLedger={()=>openView('report','stock')}/></Suspense>:
      view==='finance'?<Suspense fallback={<p role="status">미수금을 불러오고 있습니다.</p>}><ErpFinancePanel companyId={companyId}/></Suspense>:
      view==='shipments'?<Suspense fallback={<p role="status">출고 문서를 불러오고 있습니다.</p>}><ErpShipmentsPanel companyId={companyId} initialDocumentNo={route.source} onFinance={()=>openView('finance','receivables')}/></Suspense>:
      view==='custody'?<Suspense fallback={<p role="status">보관·차용을 불러오고 있습니다.</p>}><ErpCustodyPanel companyId={companyId}/></Suspense>:
      view==='opening'?<Suspense fallback={<p role="status">기초재고를 불러오고 있습니다.</p>}><ErpOpeningPanel companyId={companyId} initialItemId={route.source} onInventory={showInventory}/></Suspense>:
      movement?<Suspense fallback={<p role="status">입출고 등록을 불러오고 있습니다.</p>}><ErpMovementPanel key={movement.key} companyId={companyId} direction={movement.direction} initialItem={movement.item} onInventory={showInventory} onShipment={source=>openView('shipments','sales',source)} onStatement={source=>openView('documents','sales',source)}/></Suspense>:
      view==='transfer'?<Suspense fallback={<p role="status">창고 이동을 불러오고 있습니다.</p>}><ErpTransferPanel companyId={companyId}/></Suspense>:
      view==='documents'?<Suspense fallback={<p role="status">거래서류를 불러오고 있습니다.</p>}><ErpDocumentsPanel companyId={companyId} initialSourceDocumentNo={route.source} returnWorkflow/></Suspense>:
      view==='report'?<ErpReportPanel companyId={companyId} canManage={canOperate} onStatement={canManage?source=>openView('documents','sales',source):undefined}/>:
      view==='import'?<ErpImportPanel companyId={companyId} onInventory={showInventory}/>:
      <div className={`erp-layout ${kind!=='items'&&!editor?'erp-layout-single':''}`}>
      <section className="wf-panel erp-list" aria-label={`${names[kind]} 목록`}>
        <div className="erp-list-head"><h2 className="wf-section-title">{names[kind]} 목록</h2>{(kind==='items'?inbound:canOperate) && <button ref={addButton} className="wf-btn wf-btn-primary" onClick={() => { if (kind === 'items') openMovement('입고'); else { setEditor({ record: null }); setNotice(''); } }}><Plus size={16} aria-hidden="true" />{kind === 'items' ? '입고등록' : `${names[kind]} 등록`}</button>}</div>
        {kind === 'items' && canOperate && <div className="erp-actions"><small className="wf-muted">코드 선택 → 일반상품 입고 / 합성상품 출고 · 품목명 선택 → 재고현황</small><button className="wf-btn" onClick={() => { setEditor({ record: null }); setNotice(''); }}>품목 등록</button></div>}
        <div className="erp-search"><label className="wf-field"><span>검색 기준</span><select className="wf-input" value={searchBy} onChange={e => { reset(); setSearchBy(e.target.value as 'name' | 'code'); }}><option value="name">{names[kind]}명</option><option value="code">코드</option></select></label>
          <label className="wf-field erp-search-term"><span>{searchBy === 'name' ? `${names[kind]}명` : '코드'} 검색</span><input className="wf-input" type="search" value={search} maxLength={120} placeholder="이름 또는 코드의 앞부분 입력" onChange={e => { reset(); setSearch(e.target.value); }} /></label>
          <button className="wf-btn erp-refresh" aria-label="목록 새로고침" onClick={() => { reset(); setReload(value => value + 1); }}><RefreshCw size={17} aria-hidden="true" /></button></div>
        {error && <p role="alert" className="erp-error">{error}</p>}
        <div className="erp-table-scroll" aria-busy={loading}><table className="erp-table"><caption className="erp-sr-only">회사별 {names[kind]} 목록</caption><thead><tr><th>코드</th><th>{names[kind]}명</th><th>상태</th><th>관리</th></tr></thead>
          <tbody>{records.map(record => <tr key={record.id} className={selected?.id === record.id ? 'erp-selected' : ''}>
            <td className="erp-code">{kind === 'items' && (record.itemType==='BUNDLE'?outbound:inbound) ? <button className="erp-name-button" disabled={!record.active} onClick={() => openMovement(record.itemType === 'BUNDLE' ? '출고' : '입고', record)} aria-label={`${record.code} ${record.itemType === 'BUNDLE' ? '출고등록' : '입고등록'}`}>{record.code}</button> : record.code}</td><td>{kind === 'items' ? <button className="erp-name-button" aria-pressed={selected?.id === record.id} onClick={() => choose(record)} aria-label={`${record.name} 재고 보기`}>{record.name}<small className="erp-cell-note">{record.specification || record.unit}</small></button> : <><strong>{record.name}</strong><small className="erp-cell-note">{record.address || (record.type === 'CUSTOMER' ? '매출처' : record.type === 'SUPPLIER' ? '매입처' : record.type === 'BOTH' ? '매입·매출처' : '')}</small></>}</td>
            <td><span className={`wf-status ${record.active ? '' : 'wf-status-warning'}`}>{record.active ? '사용 중' : '중지'}</span></td>
            {<td>{canOperate&&<button className="wf-btn" onClick={() => setEditor({ record })} aria-label={`${record.name} 수정`}><Pencil size={14} aria-hidden="true" /><span>{canManage||manager&&kind==='items'?'수정':'수정 요청'}</span></button>}</td>}</tr>)}</tbody></table></div>
        {loading ? <p role="status" className="erp-empty">불러오는 중…</p> : !records.length && !error ? <div className="erp-empty"><PackageSearch size={30} aria-hidden="true" /><p>{search ? '검색 결과가 없습니다. 이름의 앞부분이나 코드를 확인해 주세요.' : `등록된 ${names[kind]}이 없습니다.`}</p>{canManage && !search && <p>회사의 {names[kind]}을 등록해 시작하세요.</p>}</div> : null}
        {cursor && <div className="erp-more"><button className="wf-btn" onClick={() => void more()} disabled={loading}>더 보기</button></div>}
      </section>
      {editor && canOperate ? <MasterEditor key={`${kind}:${editor.record?.id || 'new'}:${editor.record?.revision || 0}`} companyId={companyId} kind={kind} record={editor.record}
        onClose={() => { setEditor(null); requestAnimationFrame(() => addButton.current?.focus()); }} onSaved={saved} /> : kind === 'items' ? <InventoryPanel value={stock} loading={stockLoading} error={stockError} canManage={canManage||manager} canOpenOpening={canManage}
          onOpening={()=>openOpening(stock?.item.id||'')} onRetry={() => { if (selected) { stockGeneration.current++; setStock(null); setSelected({ ...selected }); } }} onEdit={() => { if (stock) setEditor({ record: stock.item }); }} /> : null}
    </div>}
  </main>;
}
