import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Download, FilePlus2, RefreshCw } from 'lucide-react';
import { erpDocumentService as api } from '../services/erpDocumentService';
import type { DocumentCursor, DocumentInput, DocumentKind, DocumentMeta, DocumentPdf, DocumentResult, PrintProfile, SourceDocument, TradeDocument } from '../services/erpDocumentService';
import { erpService } from '../services/erpService';
import type { ErpCursor, ErpRecord } from '../services/erpService';
import { erpScope } from '../services/erpLedgerService';
import { getErrorMessage } from '../utils/errors';

const labels: Record<DocumentKind, string> = { PROFORMA: '영문 Proforma Invoice', INVOICE: '한글 Invoice', STATEMENT: '거래명세표' };
const statusLabel = { DRAFT: '초안', ISSUED: '발행', CANCELLED: '취소' };
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
const money = (minor: number | null, currency: string) => minor === null ? '—' : `${(minor / (['KRW', 'JPY'].includes(currency) ? 1 : 100)).toLocaleString('ko-KR', { maximumFractionDigits: 2 })} ${currency}`;
function blank(companyId: string, kind: DocumentKind): TradeDocument {
  const date = today(), until = new Date(`${date}T00:00:00Z`); until.setUTCDate(until.getUTCDate() + 30);
  return { id: crypto.randomUUID(), companyId, kind, status: 'DRAFT', revision: 0, edition: 1, number: '', issueDate: date, buyerName: '', currency: 'KRW',
    totalMinor: null, pdfReady: false, updatedAt: '', createdAt: '', replacesId: '', replacesNumber: '', replacementId: '', cancelledAt: '', cancelReason: '',
    input: { kind, issueDate: date, validUntil: kind === 'PROFORMA' ? until.toISOString().slice(0, 10) : '', partnerId: '', buyerNameEn: '', buyerAddressEn: '',
      currency: 'KRW', sourceDocumentNo: '', lines: [], paymentTerms: '', deliveryTerms: '', tradeTerms: '', notes: '' } };
}
const profileFields = [
  ['companyNameEn', '영문 회사명', 120], ['addressEn', '영문 회사 주소', 300], ['representativeEn', '영문 대표자', 120],
  ['registrationNumber', '공급자 사업자등록번호', 120], ['businessType', '업태', 120], ['businessItem', '종목', 120], ['bankDetails', '은행·계좌 정보', 500],
] as const;
function ProfileEditor({ meta, busy, save }: { meta: DocumentMeta; busy: boolean; save: (value: PrintProfile) => void }) {
  const [profile, setProfile] = useState(() => ({ ...meta.profile, companyNameEn: meta.profile.companyNameEn || meta.companyNameEn }));
  return <details className="wf-panel erp-print-profile"><summary>공급자 출력 설정 · 영문 정보·사업자번호·계좌</summary>
    <p className="wf-muted">회사명·주소·대표자·인감은 기존 <Link to="/documents">서류 발급 → 회사 서류 템플릿</Link>에서 관리합니다. 아래 영문 정보는 Proforma에 사용합니다.</p>
    <form onSubmit={event => { event.preventDefault(); save(profile); }}><fieldset className="erp-form-fields" disabled={busy}>
      {profileFields.map(([key, label, max]) => <label className={`wf-field ${key === 'bankDetails' ? 'erp-form-wide' : ''}`} key={key}><span>{label}</span>
        {key === 'bankDetails' ? <textarea className="wf-input" rows={3} maxLength={max} value={profile[key]} onChange={event => setProfile({ ...profile, [key]: event.target.value })} /> :
          <input className="wf-input" maxLength={max} value={profile[key]} onChange={event => setProfile({ ...profile, [key]: event.target.value })} />}</label>)}
    </fieldset><div className="erp-actions"><button className="wf-btn" disabled={busy}>출력 설정 저장</button></div></form>
  </details>;
}

function DraftEditor({ companyId, document, items, partners, busy, onSave, onIssue, onPdf, onDirty, moreItems, morePartners, initialSource, lockedSource }: {
  lockedSource?: boolean; companyId: string; document: TradeDocument; items: ErpRecord[]; partners: ErpRecord[]; busy: boolean;
  onSave: (value: DocumentInput) => void; onIssue: () => void; onPdf: () => void; onDirty: (value: boolean) => void;
  moreItems?: () => void; morePartners?: () => void; initialSource?: SourceDocument | null;
}) {
  const [form, setForm] = useState<DocumentInput>(document.input!), [dirty, setDirty] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [source, setSource] = useState<SourceDocument | null>(initialSource && initialSource.documentNo === document.input?.sourceDocumentNo ? initialSource : null), [sourceBusy, setSourceBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), errorRef = useRef<HTMLParagraphElement>(null), proforma = form.kind === 'PROFORMA';
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(()=>{let active=true;if(lockedSource&&document.replacesId&&document.input?.sourceDocumentNo){setSourceBusy(true);void api.sources(companyId,document.input.sourceDocumentNo,document.kind).then(value=>{if(active)setSource(value);}).catch(e=>{if(active)setError(getErrorMessage(e));}).finally(()=>{if(active)setSourceBusy(false);});}return()=>{active=false;};},[companyId,lockedSource,document.id,document.replacesId,document.input?.sourceDocumentNo,document.kind]);
  function change(patch: Partial<DocumentInput>) { setForm(current => ({ ...current, ...patch })); setDirty(true); setConfirmed(false); onDirty(true); }
  async function loadSource() {
    if (sourceBusy || busy) return; setSourceBusy(true); setError('');
    try {
      const loaded = await api.sources(companyId, form.sourceDocumentNo, form.kind);
      if (!alive.current) return;
      setSource(loaded); change({ sourceDocumentNo: loaded.documentNo, currency: loaded.currency, partnerId: loaded.partnerId,
        lines: loaded.rows.filter(row => row.available > 0).map(row => ({ sourceId: row.id, quantity: String(row.available), notes: '' })) });
    } catch (failure) { if (alive.current) { setError(getErrorMessage(failure)); setTimeout(() => errorRef.current?.focus(), 0); } }
    finally { if (alive.current) setSourceBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); setError(''); onSave(form); }
  const disabled = busy || sourceBusy, preview = document.preview;
  return <form onSubmit={submit} aria-label={`${labels[form.kind]} 초안`}>
    {error && <p role="alert" tabIndex={-1} ref={errorRef} className="erp-error">{error}</p>}
    <fieldset className="erp-form-fields" disabled={disabled}>
      <label className="wf-field"><span>발행일 *</span><input className="wf-input" type="date" required value={form.issueDate} onChange={event => change({ issueDate: event.target.value })} /></label>
      {proforma ? <><label className="wf-field"><span>견적 유효기간 *</span><input className="wf-input" type="date" required min={form.issueDate} value={form.validUntil} onChange={event => change({ validUntil: event.target.value })} /></label>
        <label className="wf-field"><span>거래처 *</span><select className="wf-input" required value={form.partnerId} onChange={event => change({ partnerId: event.target.value })}><option value="">거래처 선택</option>
          {partners.filter(row => row.active && row.type !== 'SUPPLIER').map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}
          {form.partnerId && !partners.some(row => row.id === form.partnerId) && <option value={form.partnerId}>{preview?.buyer.name || '저장된 거래처'}</option>}</select>{morePartners && <button type="button" className="wf-btn" onClick={morePartners}>거래처 더 불러오기</button>}</label>
        <label className="wf-field"><span>통화 *</span><select className="wf-input" value={form.currency} onChange={event => change({ currency: event.target.value })}>{['KRW', 'USD', 'EUR', 'JPY', 'CNY'].map(currency => <option key={currency}>{currency}</option>)}</select></label>
        <label className="wf-field"><span>Buyer name (영문) *</span><input className="wf-input" required maxLength={200} value={form.buyerNameEn} onChange={event => change({ buyerNameEn: event.target.value })} /></label>
        <label className="wf-field"><span>Buyer address (영문) *</span><input className="wf-input" required maxLength={300} value={form.buyerAddressEn} onChange={event => change({ buyerAddressEn: event.target.value })} /></label></> :
        <div className="wf-field"><label htmlFor="erp-document-source-number">확정 출고 문서번호 *</label><div className="erp-document-source"><input id="erp-document-source-number" readOnly={lockedSource} className="wf-input" required maxLength={80} value={form.sourceDocumentNo} onChange={event => { setSource(null); change({ sourceDocumentNo: event.target.value, lines: [], partnerId: '' }); }} />
          <button type="button" className="wf-btn" onClick={() => void loadSource()} disabled={!form.sourceDocumentNo || disabled}>{sourceBusy ? '불러오는 중…' : '출고 불러오기'}</button></div></div>}
    </fieldset>
    {!proforma && <p className="erp-form-note">입출고 총괄·원장의 출고 문서번호를 입력하세요. 취소·반품·같은 종류의 기발행 수량을 제외한 범위에서 일부 또는 전체를 선택합니다. {source && `${source.partnerName} · ${source.currency}`}</p>}
    {proforma ? <fieldset disabled={disabled} className="erp-document-lines"><legend>견적 품목</legend>
      {form.lines.map((line, index) => <div className="erp-document-line" key={index}><div className="erp-document-line-heading"><strong>품목 {index + 1}</strong><button className="wf-btn" type="button" onClick={() => change({ lines: form.lines.filter((_, i) => i !== index) })}>품목 {index + 1} 삭제</button></div>
        <div className="erp-form-fields"><label className="wf-field"><span>품목 선택 *</span><select className="wf-input" required value={line.itemId} onChange={event => {
          const item = items.find(row => row.id === event.target.value); change({ lines: form.lines.map((row, i) => i === index ? { ...row, itemId: event.target.value, price: String(item?.salePrice || 0), taxType: item?.taxType || '과세', taxRate: item?.taxType === '과세' ? '0.1' : '0' } : row) });
        }}><option value="">품목 선택</option>{items.filter(row => row.active).map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}
          {line.itemId && !items.some(row => row.id === line.itemId) && <option value={line.itemId}>{preview?.rows[index]?.description || '저장된 품목'}</option>}</select></label>
          {([['description', '영문 품목명 *', 'text'], ['quantity', '수량 *', 'number'], ['price', '단가 *', 'number'], ['taxRate', '세율 (10% = 0.1) *', 'number']] as const).map(([key, label, type]) =>
            <label className="wf-field" key={key}><span>{label}</span><input className="wf-input" type={type} required maxLength={200} min={key === 'quantity' ? '0.0001' : '0'} max={key === 'taxRate' ? '1' : undefined} step={key === 'taxRate' ? '0.000001' : '0.0001'} value={line[key] || ''}
              onChange={event => change({ lines: form.lines.map((row, i) => i === index ? { ...row, [key]: event.target.value } : row) })} /></label>)}
          <label className="wf-field"><span>과세구분</span><select className="wf-input" value={line.taxType} onChange={event => change({ lines: form.lines.map((row, i) => i === index ? { ...row, taxType: event.target.value, taxRate: event.target.value === '과세' ? '0.1' : '0' } : row) })}>{['과세', '영세', '면세'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="wf-field"><span>단가 기준</span><select className="wf-input" value={line.priceBasis} onChange={event => change({ lines: form.lines.map((row, i) => i === index ? { ...row, priceBasis: event.target.value } : row) })}><option>세금별도</option><option>세금포함</option></select></label>
          <label className="wf-field"><span>행 비고 (영문)</span><input className="wf-input" maxLength={200} value={line.notes} onChange={event => change({ lines: form.lines.map((row, i) => i === index ? { ...row, notes: event.target.value } : row) })} /></label>
        </div></div>)}
      <div className="erp-actions">{moreItems && <button type="button" className="wf-btn" onClick={moreItems}>품목 더 불러오기</button>}<button type="button" className="wf-btn" disabled={form.lines.length >= 100} onClick={() => change({ lines: [...form.lines, { itemId: '', description: '', quantity: '1', price: '0', taxType: '과세', taxRate: '0.1', priceBasis: '세금별도', notes: '' }] })}>견적 품목 추가</button></div>
    </fieldset> : <fieldset className="erp-document-lines" disabled={disabled}><legend>발행할 출고 품목</legend>
      {source ? source.rows.map(row => {
        const selected = form.lines.find(line => line.sourceId === row.id);
        return <div className="erp-document-source-row" key={row.id}><label className="erp-active-field"><input type="checkbox" checked={Boolean(selected)} disabled={!row.available} onChange={event => change({ lines: event.target.checked ? [...form.lines, { sourceId: row.id, quantity: String(row.available), notes: '' }] : form.lines.filter(line => line.sourceId !== row.id) })} />{row.code} · {row.name} (발행 가능 {row.available} {row.unit})</label>
          {selected && <label className="wf-field"><span>{row.name} 발행 수량</span><input className="wf-input" type="number" min="0.0001" max={row.available} step="0.0001" required value={selected.quantity} onChange={event => change({ lines: form.lines.map(line => line.sourceId === row.id ? { ...line, quantity: event.target.value } : line) })} /></label>}</div>;
      }) : form.lines.map((line, index) => <label className="wf-field" key={line.sourceId}><span>{preview?.rows[index]?.description || `출고 ${index + 1}행`} 발행 수량</span><input className="wf-input" type="number" required min="0.0001" step="0.0001" value={line.quantity} onChange={event => change({ lines: form.lines.map((row, i) => i === index ? { ...row, quantity: event.target.value } : row) })} /></label>)}
      {!form.lines.length && <p className="wf-muted">출고를 불러온 뒤 발행할 품목을 선택하세요.</p>}
    </fieldset>}
    <fieldset className="erp-form-fields" disabled={disabled}>
      {([['paymentTerms', '결제 조건'], ['deliveryTerms', '납기·배송 조건'], ['tradeTerms', '무역 조건'], ['notes', '문서 비고']] as const).map(([key, label]) => <label className="wf-field" key={key}><span>{label}{proforma ? ' (영문)' : ''}</span>
        <textarea className="wf-input" rows={2} maxLength={key === 'notes' ? 1000 : 500} value={form[key]} onChange={event => change({ [key]: event.target.value })} /></label>)}
    </fieldset>
    <p className="erp-form-note">초안 저장과 PDF 발행은 재고를 변경하지 않습니다. Proforma는 출고 전 견적이며, Invoice·거래명세표 금액은 선택한 확정 출고 수량에 따라 계산됩니다.</p>
    <div className="erp-actions"><button className="wf-btn wf-btn-primary" disabled={disabled || !form.lines.length}>초안 저장·금액 확인</button></div>
    {preview && !dirty && <div className="erp-document-preview" aria-label="발행 내용 확인"><h3>발행 내용 확인</h3>
      <p>{preview.branding.companyName} → {preview.buyer.name} · {preview.issueDate}</p>
      <div className="erp-table-scroll" tabIndex={0} role="region" aria-label="발행 품목 가로 스크롤"><table className="erp-table"><thead><tr><th>품목</th><th>수량</th><th>공급가액</th><th>세액</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.rowNo}><td>{row.description}<small className="erp-cell-note">{row.code} · {row.specification}</small></td><td>{row.quantityScaled / 10000} {row.unit}</td><td>{money(row.supplyMinor, preview.currency)}</td><td>{money(row.taxMinor, preview.currency)}</td></tr>)}</tbody></table></div>
      <p className="erp-document-total">합계 {money(preview.totals.totalMinor, preview.currency)}</p>
      <p className="erp-form-note">{preview.branding.sealRegistered ? `등록 인감 ${preview.branding.sealWidthMm} × ${preview.branding.sealHeightMm}mm를 발행본에 사용합니다.` : '회사 서류 템플릿에 법인 인감을 등록한 뒤 초안을 다시 저장해 주세요.'}</p>
      <label className="erp-active-field"><input type="checkbox" checked={confirmed} disabled={disabled} onChange={event => setConfirmed(event.target.checked)} />거래처·금액·등록 인감을 확인했습니다.</label>
      <div className="erp-actions"><button type="button" className="wf-btn" disabled={disabled} onClick={onPdf}>초안 PDF 미리보기</button><button type="button" className="wf-btn wf-btn-primary" disabled={disabled || !confirmed || !preview.branding.sealRegistered} onClick={onIssue}>발행 확정</button></div>
    </div>}
  </form>;
}

export function ErpDocumentsPanel({ companyId, initialSourceDocumentNo = '', initialDraftId = '', embedded = false,returnWorkflow=false }: { companyId: string; initialSourceDocumentNo?: string; initialDraftId?:string; embedded?: boolean;returnWorkflow?:boolean }) {
  const [initialSource, setInitialSource] = useState<SourceDocument | null>(null);
  const [meta, setMeta] = useState<DocumentMeta | null>(null), [documents, setDocuments] = useState<TradeDocument[]>([]), [cursor, setCursor] = useState<DocumentCursor | null>(null);
  const [items, setItems] = useState<ErpRecord[]>([]), [partners, setPartners] = useState<ErpRecord[]>([]), [itemCursor, setItemCursor] = useState<ErpCursor | null>(null), [partnerCursor, setPartnerCursor] = useState<ErpCursor | null>(null);
  const [selected, setSelected] = useState<TradeDocument | null>(null), [busy, setBusy] = useState(true), [dirty, setDirty] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [reason, setReason] = useState(''), [cancelChecked, setCancelChecked] = useState(false);
  const [returnDate,setReturnDate]=useState(today()),[returnReason,setReturnReason]=useState(''),[returnChecked,setReturnChecked]=useState(false);
  const live = useRef(true), pending = useRef(false), errorRef = useRef<HTMLParagraphElement>(null), revisionIds = useRef(new Map<string, string>());
  useEffect(() => {
    let active=true;live.current = true;
    const pickedRequest=initialDraftId?api.get(companyId,initialDraftId):Promise.resolve(null);
    const sourceRequest=initialSourceDocumentNo?api.sources(companyId,initialSourceDocumentNo,'STATEMENT').catch(failure=>{if(!embedded)throw failure;if(active)setError(getErrorMessage(failure));return null;}):Promise.resolve(null);
    void Promise.all([api.meta(companyId), api.list(companyId, undefined, embedded ? initialSourceDocumentNo : undefined), erpService.list(companyId, 'items', '', 'name'), erpService.list(companyId, 'partners', '', 'name'), sourceRequest,pickedRequest]).then(async ([m, list, i, p, source,picked]) => {
      if (!active) return; setMeta(m); setDocuments(list.documents); setCursor(list.cursor); setItems(i.records); setItemCursor(i.nextCursor); setPartners(p.records); setPartnerCursor(p.nextCursor);
      if(picked){setSelected(picked.document);}
      else if(returnWorkflow&&list.documents.some(doc=>doc.kind==='STATEMENT')){
        const target=list.documents.find(doc=>doc.kind==='STATEMENT'&&doc.status==='ISSUED')||list.documents.find(doc=>doc.kind==='STATEMENT');
        if(target){const loaded=await api.get(companyId,target.id);if(active)setSelected(loaded.document);}
      }else if (source && (!embedded || source.rows.some(row => row.available > 0))) {
        const draft = blank(companyId, 'STATEMENT');
        draft.input = { ...draft.input!, sourceDocumentNo: source.documentNo, currency: source.currency, partnerId: source.partnerId,
          lines: source.rows.filter(row => row.available > 0).map(row => ({ sourceId: row.id, quantity: String(row.available), notes: '' })) };
        setInitialSource(source); setSelected(draft); setNotice('확정 출고를 불러왔습니다. 초안을 저장하고 금액을 확인한 뒤 발행해 주세요.');
      }
    }).catch(failure => { if (active) setError(getErrorMessage(failure)); }).finally(() => { if (active) setBusy(false); });
    return () => { active=false;live.current = false; };
  }, [companyId, initialSourceDocumentNo, initialDraftId, embedded,returnWorkflow]);
  async function run(action: () => Promise<void>) {
    if (pending.current || busy) return; pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (failure) { if (live.current) { setError(getErrorMessage(failure)); setTimeout(() => errorRef.current?.focus(), 0); } }
    finally { pending.current = false; if (live.current) setBusy(false); }
  }
  async function refresh() { const list = await api.list(companyId, undefined, embedded ? initialSourceDocumentNo : undefined); if (live.current) { setDocuments(list.documents); setCursor(list.cursor); } }
  function select(doc: TradeDocument) { setSelected(doc); setInitialSource(null);setDirty(false); setReason(''); setCancelChecked(false);setReturnChecked(false);setReturnReason(''); }
  async function result(action: Promise<DocumentResult>, message: string) {
    const response = await action; if (!live.current) return; select(response.document); setNotice(response.warning || message); await refresh();
  }
  async function download(doc: TradeDocument, preview = false) {
    const scope = erpScope(companyId, true), data: DocumentPdf = await api.pdf(companyId, doc, preview);
    if (!live.current || scope !== erpScope(companyId, true)) return;
    const bytes = Uint8Array.from(atob(data.base64), value => value.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = window.document.createElement('a'); link.href = url; link.download = data.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    if (data.document) select(data.document); setNotice(preview ? '인감이 없는 초안 PDF를 내려받았습니다.' : '발행 당시의 원본 PDF를 내려받았습니다.'); await refresh();
  }
  return <div className="erp-documents" aria-busy={busy}>
    <section className="wf-panel erp-document-intro"><div className="erp-list-head"><div><h2 className="wf-section-title">거래서류 발행</h2><p className="wf-muted">회사 인감과 발행 당시의 거래 내용을 PDF로 보관합니다.</p></div><button className="wf-btn" disabled={busy} aria-label="거래서류 새로고침" onClick={() => void run(async () => { const m = await api.meta(companyId); if (live.current) setMeta(m); await refresh(); })}><RefreshCw size={16} /></button></div>
      <div className="erp-actions">{(embedded ? ['STATEMENT'] as DocumentKind[] : Object.keys(labels) as DocumentKind[]).map(kind => <button className="wf-btn" disabled={busy} key={kind} onClick={() => { const next=blank(companyId, kind); if(embedded)next.input!.sourceDocumentNo=initialSourceDocumentNo; select(next); setNotice(''); }}><FilePlus2 size={16} />{labels[kind]} 작성</button>)}</div>
      {meta && !meta.canIssue && <p className="erp-notice">발행하려면 <Link to="/documents">회사 서류 템플릿</Link>에 회사명·주소·대표자·법인 인감을 등록해 주세요.</p>}
    </section>
    {error && <p role="alert" tabIndex={-1} ref={errorRef} className="erp-error">{error}</p>}{notice && <p role="status" className="erp-success">{notice}</p>}
    {meta && <ProfileEditor key={meta.profile.version} meta={meta} busy={busy} save={value => void run(async () => { await api.saveProfile(companyId, value); const next = await api.meta(companyId); if (live.current) { setMeta(next); setNotice('공급자 출력 설정을 저장했습니다. 기존 초안은 다시 저장해 주세요.'); } })} />}
    {selected && <section className="wf-panel erp-document-editor" aria-label="거래서류 편집"><div className="erp-list-head"><div><h2 className="wf-section-title">{labels[selected.kind]} · {statusLabel[selected.status]}</h2><p className="wf-muted">{selected.number || '발행 시 번호 자동 부여'}{selected.replacesNumber && ` · 정정 ${selected.edition}차 / 원본 ${selected.replacesNumber}`}</p></div><button className="wf-btn" disabled={busy} onClick={() => setSelected(null)}>닫기</button></div>
      {selected.status === 'DRAFT' ? <DraftEditor key={`${selected.id}:${selected.revision}`} companyId={companyId} lockedSource={embedded} document={selected} items={items} partners={partners} busy={busy} initialSource={initialSource}
        onDirty={setDirty} onSave={input => void run(() => result(api.save(companyId, selected.id, selected.revision, input), '초안을 저장했습니다. 금액을 확인한 뒤 발행해 주세요.'))}
        onIssue={() => void run(() => result(api.issue(companyId, selected), '발행이 완료되었습니다. PDF를 내려받을 수 있습니다.'))} onPdf={() => void run(() => download(selected, true))}
        moreItems={itemCursor ? () => void run(async () => { const next = await erpService.list(companyId, 'items', '', 'name', itemCursor); if (live.current) { setItems(current => [...current, ...next.records]); setItemCursor(next.nextCursor); } }) : undefined}
        morePartners={partnerCursor ? () => void run(async () => { const next = await erpService.list(companyId, 'partners', '', 'name', partnerCursor); if (live.current) { setPartners(current => [...current, ...next.records]); setPartnerCursor(next.nextCursor); } }) : undefined} /> : <div className="erp-document-issued">
        <p><strong>{selected.buyerName}</strong> · {selected.issueDate} · 합계 {money(selected.totalMinor, selected.currency)}</p>
        <p className="erp-form-note">발행본과 재고 처리는 별개입니다. 문서 취소·정정·재다운로드로 입출고 원장이 바뀌지 않습니다.</p>
        {selected.status === 'CANCELLED' && <p className="erp-notice">취소된 문서입니다. {selected.cancelReason} · {selected.cancelledAt.slice(0, 10)}<br />PDF는 취소 전 발행 원본이며, 유효한 문서로 사용하지 마세요.</p>}
        <button className="wf-btn wf-btn-primary" disabled={busy} onClick={() => void run(() => download(selected))}><Download size={16} />{selected.status === 'CANCELLED' ? '취소된 원본 PDF 내려받기' : selected.pdfReady ? '발행 PDF 내려받기' : 'PDF 생성·내려받기'}</button>
        {returnWorkflow&&selected.kind==='STATEMENT'&&selected.status==='ISSUED'&&<section className="erp-document-cancel" aria-label="반품 반영 거래명세표 정정"><h3>반품 반영 거래명세표 정정</h3><p>현재 발행본을 취소하고, 이 명세표의 품목 중 반품 후 남은 발행 가능 수량으로 정정 초안을 만듭니다. 전량 반품이면 취소만 기록합니다. 원본 PDF는 보관되며, 마감된 발행본은 ADMIN이 월마감을 재개방해야 합니다.</p>
          <label className="wf-field"><span>정정 발행일</span><input className="wf-input" disabled={busy} type="date" value={returnDate} onChange={e=>setReturnDate(e.target.value)}/></label><label className="wf-field"><span>반품 정정 사유</span><input className="wf-input" disabled={busy} maxLength={500} value={returnReason} onChange={e=>setReturnReason(e.target.value)}/></label>
          <label className="erp-active-field"><input type="checkbox" disabled={busy} checked={returnChecked} onChange={e=>setReturnChecked(e.target.checked)}/>원본을 보관하고 반품 수량에 맞춰 취소·정정함을 확인했습니다.</label>
          <button className="wf-btn wf-btn-primary" disabled={busy||!returnChecked||returnReason.trim().length<3||!returnDate} onClick={()=>void run(async()=>{
            const key=`return:${selected.id}:${selected.revision}:${returnDate}:${returnReason}`;if(!revisionIds.current.has(key))revisionIds.current.set(key,crypto.randomUUID());
            const response=await api.returnRevision(companyId,revisionIds.current.get(key)!,selected,returnDate,returnReason);
            await result(Promise.resolve(response),response.cancelledOnly?'남은 발행 수량이 없어 거래명세표를 취소했습니다. 원본 PDF는 보관됩니다.':'반품 수량을 반영한 정정 초안을 만들었습니다. 저장·금액 확인 후 발행해 주세요.');
          })}>반품 반영 취소·정정 초안 만들기</button>
        </section>}
        {selected.status === 'ISSUED' ? <div className="erp-document-cancel"><label className="wf-field"><span>문서 취소 사유</span><input className="wf-input" disabled={busy} minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <label className="erp-active-field"><input type="checkbox" checked={cancelChecked} disabled={busy} onChange={event => setCancelChecked(event.target.checked)} />문서만 취소하고 재고는 유지함을 확인했습니다.</label>
          <button className="wf-btn" disabled={busy || !cancelChecked || reason.trim().length < 3} onClick={() => void run(() => result(api.cancel(companyId, selected, reason), '문서를 취소했습니다. 원본 PDF는 보존됩니다.'))}>발행 문서 취소</button></div> :
          selected.returnCancelledOnly?<p className="erp-notice">전량 반품 또는 남은 발행 수량이 없어 정정본 발행을 생략했습니다. 원본 PDF와 취소 이력은 보관됩니다.</p>:<div className="erp-actions"><button className="wf-btn" disabled={busy} onClick={() => void run(async () => {
            if (selected.replacementId) return result(api.get(companyId, selected.replacementId), '연결된 정정본을 열었습니다.');
            if (!revisionIds.current.has(selected.id)) revisionIds.current.set(selected.id, crypto.randomUUID());
            await result(api.revise(companyId, revisionIds.current.get(selected.id)!, selected.id), '정정 초안을 만들었습니다. 수정·저장 후 새 번호로 발행해 주세요.');
          })}>{selected.replacementId ? '연결된 정정본 열기' : '정정 초안 만들기'}</button></div>}
      </div>}
      {dirty && <p className="erp-form-note">저장하지 않은 변경사항이 있습니다.</p>}
    </section>}
    <section className="wf-panel" aria-label="거래서류 목록"><div className="erp-list-head"><h2 className="wf-section-title">초안·발행 내역</h2></div><div className="erp-table-scroll" tabIndex={0} role="region" aria-label="거래서류 목록 가로 스크롤"><table className="erp-table erp-document-list"><thead><tr><th>문서번호·종류</th><th>거래처</th><th>발행일</th><th>합계</th><th>상태</th><th>열기</th></tr></thead><tbody>{documents.map(doc => <tr key={doc.id}><td>{doc.number || '번호 미부여'}<small className="erp-cell-note">{labels[doc.kind]}{doc.edition > 1 ? ` · 정정 ${doc.edition}차` : ''}</small></td><td>{doc.buyerName || '초안 작성 중'}</td><td>{doc.issueDate}</td><td className="erp-number">{money(doc.totalMinor, doc.currency)}</td><td>{statusLabel[doc.status]}</td><td><button className="wf-btn" disabled={busy} aria-label={`${doc.number || labels[doc.kind]} 열기`} onClick={() => void run(async () => { const loaded = await api.get(companyId, doc.id); if (live.current) select(loaded.document); })}>열기</button></td></tr>)}</tbody></table></div>
      {!documents.length && <p className="erp-empty">저장된 거래서류가 없습니다.</p>}{cursor && <div className="erp-more"><button className="wf-btn" disabled={busy} onClick={() => void run(async () => { const next = await api.list(companyId, cursor, embedded ? initialSourceDocumentNo : undefined); if (live.current) { setDocuments(current => [...current, ...next.documents]); setCursor(next.cursor); } })}>발행 내역 더 보기</button></div>}
    </section>
  </div>;
}
