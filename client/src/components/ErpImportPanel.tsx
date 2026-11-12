import { useEffect, useRef, useState } from 'react';
import { Download, Upload, FileCheck2, RefreshCw } from 'lucide-react';
import { erpService } from '../services/erpService';
import type { ErpCursor, ErpRecord } from '../services/erpService';
import { downloadErpFile, erpImportService, readErpFile } from '../services/erpImportService';
import type { ErpImport, ErpImportOptions, ErpImportSummary, ErpImportType } from '../services/erpImportService';
import { getErrorMessage } from '../utils/errors';

const initialOptions = (): ErpImportOptions => ({ defaultWarehouseId: '', warehouseByRow: {}, partnerByRow: {}, allowNewItems: false, allowNewPartners: false, acceptExistingItems: false });
const number = (value?: number) => value === undefined ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 4 });
const status = { PENDING: '검토 중', COMMITTED: '확정 완료', CANCELLED: '검토 취소' };
export function ErpImportPanel({ companyId, onInventory }: { companyId: string; onInventory: () => void }) {
  const [type, setType] = useState<ErpImportType>('OPENING'), [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState(initialOptions), [job, setJob] = useState<ErpImport | null>(null);
  const [dirty, setDirty] = useState(false), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [history, setHistory] = useState<ErpImportSummary[]>([]), [warehouses, setWarehouses] = useState<ErpRecord[]>([]);
  const [warehouseCursor, setWarehouseCursor] = useState<ErpCursor | null>(null);
  const live = useRef(true), attempt = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    live.current = true;
    void Promise.all([erpService.list(companyId, 'warehouses', '', 'name'), erpImportService.list(companyId)]).then(([masters, imports]) => {
      if (!live.current) return;
      setWarehouses(masters.records.filter(row => row.active)); setWarehouseCursor(masters.nextCursor); setHistory(imports.imports);
    }).catch(failure => { if (live.current) setError(getErrorMessage(failure)); });
    return () => { live.current = false; };
  }, [companyId]);
  async function run(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (failure) { if (live.current) setError(getErrorMessage(failure)); }
    finally { if (live.current) setBusy(false); }
  }
  async function refresh() { const result = await erpImportService.list(companyId); if (live.current) setHistory(result.imports); }
  function update(patch: Partial<ErpImportOptions>) { setOptions(current => ({ ...current, ...patch })); setDirty(true); setConfirmed(false); }
  async function preview() {
    if (!file) throw new Error('업로드할 파일을 선택해 주세요.');
    const source = await readErpFile(companyId, file); if (!live.current) return;
    const key = JSON.stringify([type, source.base64, options]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    const result = await erpImportService.preview(companyId, attempt.current.id, type, source, options);
    if (!live.current) return;
    attempt.current = null;
    setJob(result.import); setDirty(false); setConfirmed(false); setNotice('검증 완료. 아래 미리보기를 확인해 주세요. 아직 재고는 변경되지 않았습니다.'); await refresh();
  }
  const warehouseOptions = <><option value="">선택하지 않음</option>{warehouses.map(row => <option key={row.id} value={row.id}>{row.code} · {row.name}</option>)}</>;
  return <div className="erp-import">
    <section className="wf-panel erp-import-setup" aria-labelledby="erp-upload-title">
      <div className="wf-panel-head"><h2 className="wf-section-title" id="erp-upload-title">Excel 재고 업로드</h2><span className="wf-status">검증 → 미리보기 → DB 확정</span></div>
      <p className="wf-muted">작성안내 B5에 회사명, B6에 기초재고 기준일을 입력하세요. 실제 저장 회사는 로그인 소속으로 결정됩니다.</p>
      <fieldset disabled={busy} className="erp-form-fields">
        <label className="wf-field"><span>업로드 종류</span><select className="wf-input" value={type} onChange={e => { setType(e.target.value as ErpImportType); setJob(null); setConfirmed(false); setDirty(true); }}><option value="OPENING">기초재고</option><option value="MOVEMENTS">거래별 입출고</option></select></label>
        <div className="erp-template-button"><button className="wf-btn" onClick={() => void run(async () => { const result = await erpImportService.template(companyId, type); if (live.current) downloadErpFile(result); })}><Download size={16} />선택한 Excel 양식 받기</button></div>
        <label className="wf-field erp-form-wide"><span>Excel 파일 (.xlsx, 최대 3MB·200행)</span><input className="wf-input" type="file" accept=".xlsx" onChange={e => { setFile(e.target.files?.[0] || null); setJob(null); setConfirmed(false); setDirty(true); attempt.current = null; }} /></label>
        <label className="wf-field"><span>창고 공란에 적용할 회사 창고</span><select className="wf-input" value={options.defaultWarehouseId} onChange={e => update({ defaultWarehouseId: e.target.value })}>{warehouseOptions}</select></label>
        <div className="erp-template-button">{warehouseCursor && <button className="wf-btn" onClick={() => void run(async () => { const result = await erpService.list(companyId, 'warehouses', '', 'name', warehouseCursor); if (live.current) { setWarehouses(current => [...current, ...result.records.filter(row => row.active)]); setWarehouseCursor(result.nextCursor); } })}>창고 더 불러오기</button>}</div>
        <label className="erp-active-field erp-form-wide"><input type="checkbox" checked={options.allowNewItems} onChange={e => update({ allowNewItems: e.target.checked })} />신규 품목 등록 확인 (기본단가 0, 파일 단가는 원장에 보존)</label>
        {type === 'MOVEMENTS' && <label className="erp-active-field erp-form-wide"><input type="checkbox" checked={options.allowNewPartners} onChange={e => update({ allowNewPartners: e.target.checked })} />신규 거래처 등록 확인 (동명 거래처는 후보를 확인 후 선택)</label>}
        <label className="erp-active-field erp-form-wide"><input type="checkbox" checked={options.acceptExistingItems} onChange={e => update({ acceptExistingItems: e.target.checked })} />이름·규격 차이를 확인했으며 기존 코드의 품목을 사용 (단위 일치 필수)</label>
      </fieldset>
      <p className="erp-form-note">입력 시트의 10~209행만 읽습니다. 참고데이터·작성예시·계산 결과는 반영하지 않습니다. 입출고는 기준일 다음 날부터 날짜·처리순서대로 확정하며, 출고원가는 이동평균으로 계산합니다.</p>
      <div className="erp-actions"><button className="wf-btn wf-btn-primary" disabled={busy || !file} onClick={() => void run(preview)}><Upload size={16} />{busy ? '처리 중…' : '검증 및 미리보기'}</button></div>
    </section>
    {error && <p className="erp-error" role="alert">{error}</p>}{notice && <p className="erp-success" role="status">{notice}</p>}
    {job && <section className="wf-panel erp-import-preview" aria-label="업로드 미리보기">
      <div className="erp-list-head"><div><h2 className="wf-section-title">업로드 미리보기</h2><p className="wf-muted">{job.source.name} · 기준일 {job.basisDate || '미입력'} · {status[job.status]}</p><p className="wf-muted">파일 회사명: {job.companyLabel || '미입력'} · 로그인한 회사에 반영</p></div>
        <button className="wf-btn" disabled={busy} onClick={() => void run(async () => { const result = await erpImportService.source(companyId, job.id); if (live.current) downloadErpFile(result); })}><Download size={16} />원본 받기</button></div>
      <p className="erp-import-summary">정상 파싱 {job.preview.rows.length}행 · 오류 {job.preview.errors.length}건 · 신규 품목 {job.preview.newItems}건 · 신규 거래처 {job.preview.newPartners}건</p>
      {job.preview.errors.length > 0 && <div className="erp-error" role="alert"><strong>오류를 수정하고 다시 검증해 주세요. 오류가 있으면 전체 파일을 확정할 수 없습니다.</strong><ul>{job.preview.errors.map((item, i) => <li key={i}>{item.sheet} {item.row ? `${item.row}행` : ''}: {item.message}</li>)}</ul></div>}
      {job.preview.warnings.length > 0 && <details className="erp-import-notes"><summary>확인 사항 {job.preview.warnings.length}건</summary><ul>{job.preview.warnings.map((item, i) => <li key={i}>{item.row}행: {item.message}</li>)}</ul></details>}
      <div className="erp-table-scroll"><table className="erp-table erp-import-table"><caption className="erp-sr-only">행별 수량·거래금액·재고 변동 미리보기</caption><thead><tr><th>원본행·거래</th><th>품목·창고</th><th>거래처</th><th className="erp-number">수량·거래단가</th><th className="erp-number">공급가액·세액</th><th className="erp-number">출고원가 (원)</th><th className="erp-number">재고수량 전 → 후</th><th className="erp-number">재고금액 전 → 후 (원)</th></tr></thead>
        <tbody>{job.preview.rows.map(row => <tr key={row.sourceRow}><td>{row.sourceRow}행 · {row.direction}<small className="erp-cell-note">{row.date}<br />{row.documentNo}</small></td>
          <td><strong>{row.name}</strong><small className="erp-cell-note">{row.code} {row.newItem ? '· 신규' : ''}<br />{row.warehouseName || '창고 미지정'}</small></td>
          <td>{row.partnerName || '—'}{row.newPartner && <small className="erp-cell-note">신규 등록</small>}</td>
          <td className="erp-number">{number(row.quantity)} {row.unit}<small className="erp-cell-note">{row.price === null ? '장부금액 방식' : `${number(row.price)} ${row.currency}`}</small></td>
          <td className="erp-number">{row.direction === '기초' ? `${number(row.value)} KRW` : `${number(row.supply)} / ${number(row.tax)} ${row.currency}`}<small className="erp-cell-note">원화 {number(row.value)}원</small></td>
          <td className="erp-number">{row.direction === '출고' ? number(row.cost) : '—'}</td><td className="erp-number">{number(row.beforeQuantity)} → {number(row.afterQuantity)}</td><td className="erp-number">{number(row.beforeValue)} → {number(row.afterValue)}</td></tr>)}</tbody></table></div>
      {file && job.status === 'PENDING' && <details className="erp-import-notes"><summary>행별 창고·거래처 매핑</summary><div className="erp-import-mappings">{job.preview.rows.map(row => <div className="erp-import-mapping" key={row.sourceRow}>
        <label className="wf-field"><span>{row.sourceRow}행 {row.code} 창고 재지정</span><select className="wf-input" disabled={busy} value={options.warehouseByRow[row.sourceRow] || ''} onChange={e => { const next = { ...options.warehouseByRow }; if (e.target.value) next[row.sourceRow] = e.target.value; else delete next[row.sourceRow]; update({ warehouseByRow: next }); }}>{warehouseOptions}</select></label>
        {row.partnerCandidates.length > 0 && <label className="wf-field"><span>{row.sourceRow}행 기존 거래처 선택</span><select className="wf-input" disabled={busy} value={options.partnerByRow[row.sourceRow] || ''} onChange={e => { const next = { ...options.partnerByRow }; if (e.target.value) next[row.sourceRow] = e.target.value; else delete next[row.sourceRow]; update({ partnerByRow: next }); }}><option value="">기존 거래처를 선택하거나 신규 등록 확인</option>{row.partnerCandidates.map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></label>}
      </div>)}</div></details>}
      <div className="erp-import-confirm">
        {dirty && <p role="status" className="erp-notice">입력 설정이 변경되었습니다. 검증 및 미리보기를 다시 실행해 주세요.</p>}
        {job.status === 'PENDING' && <><label className="erp-active-field"><input type="checkbox" disabled={busy || dirty || !job.preview.canCommit} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />로그인 회사의 품목·창고·거래처와 위 재고 변동을 확인했습니다.</label>
          <div className="erp-actions"><button className="wf-btn" disabled={busy} onClick={() => void run(async () => { const result = await erpImportService.cancel(companyId, job.id); if (live.current) { setJob(result.import); setNotice('검토를 취소했습니다. 재고 변경은 없습니다.'); } await refresh(); })}>검토 취소</button>
            <button className="wf-btn wf-btn-primary" disabled={busy || dirty || !confirmed || !job.preview.canCommit} onClick={() => void run(async () => {
              const result = await erpImportService.commit(companyId, job); if (!live.current) return;
              setJob(result.import); setConfirmed(false); setNotice(result.idempotent ? '이미 확정한 업로드입니다. 중복 반영하지 않았습니다.' : 'DB 반영 완료. 원장과 회사별 재고가 함께 저장되었습니다.'); await refresh();
            })}><FileCheck2 size={16} />DB 반영 확정</button></div></>}
        {job.status === 'COMMITTED' && <button className="wf-btn wf-btn-primary" onClick={onInventory}>반영된 재고 확인</button>}
      </div>
    </section>}
    <section className="wf-panel" aria-label="업로드 이력"><div className="erp-list-head"><h2 className="wf-section-title">최근 업로드 이력</h2><button className="wf-btn" aria-label="업로드 이력 새로고침" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={16} /></button></div>
      <div className="erp-table-scroll"><table className="erp-table"><thead><tr><th>파일</th><th>유형</th><th>상태</th><th>검토</th></tr></thead><tbody>{history.map(entry => <tr key={entry.id}><td>{entry.name}<small className="erp-cell-note">{new Date(entry.createdAt).toLocaleString('ko-KR')} · {entry.rowCount}행</small></td><td>{entry.type === 'OPENING' ? '기초재고' : '입출고'}</td><td>{status[entry.status]}{entry.errorCount > 0 ? ` · 오류 ${entry.errorCount}` : ''}</td><td><button className="wf-btn" disabled={busy} onClick={() => void run(async () => { const result = await erpImportService.get(companyId, entry.id); if (live.current) { setJob(result.import); setDirty(false); setConfirmed(false); setFile(null); } })}>열기</button></td></tr>)}</tbody></table></div>
      {!history.length && <p className="erp-empty">업로드 이력이 없습니다.</p>}
    </section>
  </div>;
}
