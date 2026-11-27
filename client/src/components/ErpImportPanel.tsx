import { useEffect, useRef, useState } from 'react';
import { Download, Upload, FileCheck2, RefreshCw, Pencil, Check, AlertCircle, Sparkles } from 'lucide-react';
import { ErpBootstrapConfirmation, ErpBootstrapBackupResult, ErpLedgerComparisonTable } from './ErpBootstrapConfirmation';
import { erpService } from '../services/erpService';
import type { ErpCursor, ErpRecord } from '../services/erpService';
import { downloadErpFile, erpBootstrapService, erpImportService, readErpFile } from '../services/erpImportService';
import type { ErpBootstrapJob, ErpImport, ErpImportOptions, ErpImportSummary, ErpImportType } from '../services/erpImportService';
import { erpMoney } from '../services/erpAccountService';
import { getErrorMessage } from '../utils/errors';
import { useAuthStore } from '../store/authStore';
import {
  createSimpleOpeningTemplate,
  convertToStandardOpeningWorkbook,
  type SimpleOpeningRow
} from '../utils/erpWorkbook';

type UploadMode = ErpImportType | 'BOOTSTRAP';

const initialOptions = (): ErpImportOptions => ({
  defaultWarehouseId: '',
  warehouseByRow: {},
  partnerByRow: {},
  allowNewItems: false,
  allowNewPartners: false,
  acceptExistingItems: false
});

const number = (value?: number) => (value === undefined ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 4 }));
const statusLabels: Record<string, string> = { PREPARING: '버전 준비 중', PENDING: '검토 중', COMMITTED: '확정 완료', CANCELLED: '검토 취소' };

export function ErpImportPanel({ companyId, onInventory }: { companyId: string; onInventory: () => void }) {
  const companyData = useAuthStore(s => s.companyData);
  const userData = useAuthStore(s => s.userData);
  const isCompanyAdmin = userData?.role === 'ADMIN';
  const companyName = companyData?.nameKo || '소속 회사';
  const resumeKey = 'erp-bootstrap:' + companyId + ':' + (userData?.uid || '');

  const [type, setType] = useState<UploadMode>('OPENING');
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState(initialOptions);
  const [job, setJob] = useState<ErpImport | null>(null);
  const [bootstrapJob, setBootstrapJob] = useState<ErpBootstrapJob | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [history, setHistory] = useState<ErpImportSummary[]>([]);
  const [warehouses, setWarehouses] = useState<ErpRecord[]>([]);
  const [warehouseCursor, setWarehouseCursor] = useState<ErpCursor | null>(null);

  // 스마트 간편 업로드 및 인라인 수정 상태
  const [simpleMode, setSimpleMode] = useState(false);
  const [simpleRows, setSimpleRows] = useState<SimpleOpeningRow[]>([]);
  const [basisDate, setBasisDate] = useState(() => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date()));
  const [editingRowIndex, setEditingRowIndex] = useState<number | null>(null);
  const [rowEditValues, setRowEditValues] = useState<{ quantity?: string; price?: string; name?: string }>({});

  const live = useRef(true);
  const selection = useRef(0);
  const attempt = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    live.current = true;
    void Promise.all([erpService.list(companyId, 'warehouses', '', 'name'), erpImportService.list(companyId)])
      .then(([masters, imports]) => {
        if (!live.current) return;
        const activeWarehouses = masters.records.filter(row => row.active);
        setWarehouses(activeWarehouses);
        setWarehouseCursor(masters.nextCursor);
        setHistory(imports.imports);
        setOptions(cur => cur.defaultWarehouseId ? cur : { ...cur, defaultWarehouseId: activeWarehouses[0]?.id || '' });
      })
      .catch(failure => {
        if (live.current) setError(getErrorMessage(failure));
      });
    return () => {
      live.current = false;
    };
  }, [companyId]);

  useEffect(() => {
    let active = true;
    const beforeSelection = selection.current;
    let id: string | null = null;
    try { id = sessionStorage.getItem(resumeKey); } catch { /* restricted browser storage */ }
    if (isCompanyAdmin && id) {
      void erpBootstrapService.get(companyId, id).then(({ bootstrap }) => {
        if (!active || beforeSelection !== selection.current || bootstrap.status === 'CANCELLED') return;
        if (bootstrap.status === 'COMMITTED') {
          try { sessionStorage.removeItem(resumeKey); } catch { /* restricted browser storage */ }
        }
        if (bootstrap.status === 'PREPARING') attempt.current = {key: bootstrap.source.sha256, id: bootstrap.id};
        setType('BOOTSTRAP');
        setBootstrapJob(bootstrap);
        setDirty(false);
        setNotice(bootstrap.status === 'PREPARING' ? '이전 이관 준비를 이어가려면 같은 Excel 파일을 선택해 검증해 주세요.' : bootstrap.status === 'COMMITTED' ? '통합 이관이 완료되었습니다. 확정 결과를 확인해 주세요.' : '진행 중이던 통합 이관을 불러왔습니다.');
      }).catch(() => { /* a new preview can still be created */ });
    }
    return () => { active = false; };
  }, [companyId, resumeKey, isCompanyAdmin]);

  function rememberBootstrap(id: string | null) {
    try {
      if (id) sessionStorage.setItem(resumeKey, id);
      else sessionStorage.removeItem(resumeKey);
    } catch { /* continue in this tab if storage is unavailable */ }
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (failure) {
      if (live.current) setError(getErrorMessage(failure));
    } finally {
      if (live.current) setBusy(false);
    }
  }

  async function refresh() {
    const result = await erpImportService.list(companyId);
    if (live.current) setHistory(result.imports);
  }

  function update(patch: Partial<ErpImportOptions>) {
    setOptions(current => ({ ...current, ...patch }));
    setDirty(true);
    setConfirmed(false);
  }

  // 파일 선택 및 스마트 감지
  async function handleFileSelect(selectedFile: File | null) {
    selection.current++;
    if (bootstrapJob?.status !== 'PREPARING') rememberBootstrap(null);
    setFile(selectedFile);
    setJob(null);
    setBootstrapJob(null);
    setConfirmed(false);
    setDirty(true);
    setError('');
    setNotice('');
    setSimpleMode(false);
    setSimpleRows([]);
    setEditingRowIndex(null);
    if (bootstrapJob?.status !== 'PREPARING') attempt.current = null;

    if (!selectedFile) return;
    if (selectedFile.size > 12 * 1024 * 1024) { setError('12MB 이하의 .xlsx 파일을 선택해 주세요.'); return; }
    if (type === 'BOOTSTRAP') return;
    if (selectedFile.size > 3 * 1024 * 1024) { setNotice('대용량 통합 양식은 기초 통합 이관을 선택해 검증해 주세요.'); return; }

    try {
      // 엑셀 시트 구조 검사
      const { default: readExcelFile } = await import('read-excel-file/browser');
      const sheets = await readExcelFile(selectedFile);
      const sheetNames = sheets.map(s => s.sheet);
      const hasBootstrapSheets = sheetNames.includes('작성안내') && sheetNames.includes('이관입력') &&
        (sheetNames.includes('차용이관') || sheetNames.includes('거래처이관') || sheetNames.includes('기초미수이관'));

      if (hasBootstrapSheets && isCompanyAdmin) {
        setType('BOOTSTRAP');
        setNotice('통합 이관 양식이 감지되었습니다. 검증 및 미리보기에서 기존 장부와 이관 대상을 확인해 주세요.');
        return;
      }

      const hasStandardSheets = sheetNames.includes('작성안내') && (sheetNames.includes('이관입력') || sheetNames.includes('거래입력'));

      if (!hasStandardSheets && type === 'OPENING') {
        // 단일 시트 또는 간편 엑셀 감지!
        const parsedRows = (sheets[0]?.data || []) as (string | number | boolean | Date | null)[][];
        if (parsedRows.length >= 2) {
          // 헤더 행 찾기 (1~3행 내에서 '코드', '품목', '상품' 등 탐색)
          let headerIdx = -1;
          for (let r = 0; r < Math.min(parsedRows.length, 5); r++) {
            const rowStr = parsedRows[r].map((c: unknown) => String(c ?? '')).join(' ');
            if (rowStr.includes('코드') || rowStr.includes('품목') || rowStr.includes('상품') || rowStr.includes('수량')) {
              headerIdx = r;
              break;
            }
          }

          if (headerIdx !== -1) {
            const headerRow = parsedRows[headerIdx].map((c: unknown) => String(c ?? '').trim());
            const colMap = {
              code: headerRow.findIndex((h: string) => /코드|code/i.test(h)),
              name: headerRow.findIndex((h: string) => /품목명|상품명|이름|name/i.test(h)),
              spec: headerRow.findIndex((h: string) => /규격|사양|spec/i.test(h)),
              unit: headerRow.findIndex((h: string) => /단위|unit/i.test(h)),
              qty: headerRow.findIndex((h: string) => /수량|재고|기초수량|qty/i.test(h)),
              price: headerRow.findIndex((h: string) => /단가|금액|매입단가|price|cost/i.test(h)),
              wh: headerRow.findIndex((h: string) => /창고|창고코드|warehouse/i.test(h)),
              notes: headerRow.findIndex((h: string) => /비고|메모|notes/i.test(h))
            };

            if (colMap.code !== -1 && (colMap.name !== -1 || colMap.qty !== -1)) {
              const rows: SimpleOpeningRow[] = [];
              for (let i = headerIdx + 1; i < parsedRows.length; i++) {
                const r = parsedRows[i];
                if (!r || r.every((cell: unknown) => cell == null || cell === '')) continue;
                const code = String(r[colMap.code] ?? '').trim();
                const name = colMap.name !== -1 ? String(r[colMap.name] ?? '').trim() : code;
                const qtyVal = colMap.qty !== -1 ? r[colMap.qty] : 0;
                const priceVal = colMap.price !== -1 ? r[colMap.price] : 0;
                if (!code && !name) continue;

                rows.push({
                  code: code || `ITEM-${i}`,
                  name: name || code,
                  specification: colMap.spec !== -1 ? String(r[colMap.spec] ?? '').trim() : '',
                  unit: colMap.unit !== -1 ? String(r[colMap.unit] ?? 'EA').trim() || 'EA' : 'EA',
                  quantity: typeof qtyVal === 'number' ? qtyVal : Number(String(qtyVal ?? 0).replace(/,/g, '')) || 0,
                  price: typeof priceVal === 'number' ? priceVal : Number(String(priceVal ?? 0).replace(/,/g, '')) || 0,
                  warehouseCode: colMap.wh !== -1 ? String(r[colMap.wh] ?? '').trim() : '',
                  notes: colMap.notes !== -1 ? String(r[colMap.notes] ?? '').trim() : ''
                });
              }

              if (rows.length > 0) {
                setSimpleMode(true);
                setSimpleRows(rows);
                setNotice(`스마트 감지: 간편 엑셀 양식(${rows.length}개 품목)으로 자동 인식되었습니다. '검증 및 미리보기'를 눌러주세요.`);
              }
            }
          }
        }
      }
    } catch {
      // 엑셀 파싱 실패 시 기본 모드로 진행
      setSimpleMode(false);
      setSimpleRows([]);
    }
  }

  async function preview(customRows?: SimpleOpeningRow[]) {
    if (!file && !customRows?.length) throw new Error('업로드할 파일을 선택해 주세요.');

    if (type === 'BOOTSTRAP') {
      const source = await readErpFile(companyId, file!, true);
      if (!live.current) return;
      const hash = await crypto.subtle.digest('SHA-256', await file!.arrayBuffer());
      const key = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
      rememberBootstrap(attempt.current.id);
      const result = await erpBootstrapService.preview(companyId, attempt.current.id, source);
      if (!live.current) return;
      attempt.current = null;
      setJob(null);
      setBootstrapJob(result.bootstrap);
      rememberBootstrap(result.bootstrap.id);
      setDirty(false);
      setConfirmed(false);
      setNotice('통합 이관 패키지 검증 완료. 아직 기존 ERP 데이터는 삭제·변경되지 않았습니다. 아래 내역을 확인해 주세요.');
      return;
    }

    let uploadFile: File = file!;

    // 간편 모드 또는 인라인 수정된 행이 있는 경우 표준 엑셀로 자동 변환
    const targetRows = customRows || (simpleMode ? simpleRows : null);
    if (targetRows && targetRows.length > 0 && type === 'OPENING') {
      const selectedWh = warehouses.find(w => w.id === options.defaultWarehouseId);
      const blob = await convertToStandardOpeningWorkbook(
        companyName,
        basisDate,
        targetRows,
        selectedWh?.code || 'DEFAULT'
      );
      uploadFile = new File([blob], file?.name || 'simple_converted.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
    }

    const source = await readErpFile(companyId, uploadFile);
    if (!live.current) return;

    const key = JSON.stringify([type, source.base64, options]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };

    const result = await erpImportService.preview(companyId, attempt.current.id, type, source, options);
    if (!live.current) return;

    attempt.current = null;
    setJob(result.import);
    setDirty(false);
    setConfirmed(false);
    setEditingRowIndex(null);
    setNotice('검증 완료. 아래 미리보기를 확인해 주세요. 아직 재고는 변경되지 않았습니다.');
    await refresh();
  }

  // 초간편 엑셀 양식 다운로드
  async function downloadSimpleTemplate() {
    const blob = await createSimpleOpeningTemplate();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '초간편_기초재고_등록양식.xlsx';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setNotice('초간편 기초재고 양식을 내려받았습니다. 품목코드, 품목명, 수량만 적어 바로 올릴 수 있습니다.');
  }

  // 화면 내 인라인 행 수정 시작
  function startEditing(index: number, row: { quantity: number; price: number | null; name: string }) {
    setEditingRowIndex(index);
    setRowEditValues({
      quantity: String(row.quantity),
      price: row.price == null ? '' : String(row.price),
      name: row.name
    });
  }

  // 화면 내 인라인 행 수정 저장 및 재검증
  async function applyInlineEdit(rowIndex: number) {
    if (!job) return;
    const currentRows = job.preview.rows;
    const target = currentRows[rowIndex];
    if (!target) return;

    const updatedRows: SimpleOpeningRow[] = currentRows.map((r, i) => {
      const isTarget = i === rowIndex;
      return {
        code: r.code,
        name: isTarget && rowEditValues.name !== undefined ? rowEditValues.name.trim() : r.name,
        specification: '',
        unit: r.unit,
        quantity: isTarget && rowEditValues.quantity !== undefined ? Number(rowEditValues.quantity) || 0 : r.quantity,
        price: isTarget && rowEditValues.price !== undefined ? Number(rowEditValues.price) || 0 : r.price || 0,
        warehouseCode: r.warehouseName || '',
        notes: ''
      };
    });

    setSimpleRows(updatedRows);
    setSimpleMode(true);
    await preview(updatedRows);
  }

  // 오류 행 제외하고 정상 행만 반영
  async function excludeErrorsAndRepreview() {
    if (!job || !job.preview.errors.length) return;
    const errorRows = new Set(job.preview.errors.map(e => e.row));
    const validRows: SimpleOpeningRow[] = job.preview.rows
      .filter(r => !errorRows.has(r.sourceRow))
      .map(r => ({
        code: r.code,
        name: r.name,
        specification: '',
        unit: r.unit,
        quantity: r.quantity,
        price: r.price || 0,
        warehouseCode: r.warehouseName || '',
        notes: ''
      }));

    if (!validRows.length) {
      setError('오류 행을 제외하면 남은 정상 행이 없습니다.');
      return;
    }

    setSimpleRows(validRows);
    setSimpleMode(true);
    await preview(validRows);
    setNotice(`오류 행이 제외되고 정상 행 ${validRows.length}건으로 재검증되었습니다.`);
  }

  const warehouseOptions = (
    <>
      <option value="">선택하지 않음</option>
      {warehouses.map(row => (
        <option key={row.id} value={row.id}>
          {row.code} · {row.name}
        </option>
      ))}
    </>
  );

  return (
    <div className="erp-import">
      <section className="wf-panel erp-import-setup" aria-labelledby="erp-upload-title">
        <div className="wf-panel-head">
          <h2 className="wf-section-title" id="erp-upload-title">Excel 재고 업로드</h2>
          <span className="wf-status">검증 → 미리보기 → DB 확정</span>
        </div>
        <p className="wf-muted">
          중소규모 회사를 위한 <strong>스마트 간편 업로드</strong>를 지원합니다. 필수 5개 항목(코드, 품목명, 수량 등)만 있는 단일 시트 엑셀도 자동 인식됩니다.
        </p>

        <fieldset disabled={busy} className="erp-form-fields">
          <label className="wf-field">
            <span>업로드 종류</span>
            <select
              className="wf-input"
              value={type}
              onChange={e => {
                setType(e.target.value as UploadMode);
                setJob(null);
                setBootstrapJob(null);
                setConfirmed(false);
                setDirty(true);
                setSimpleMode(false);
              }}
            >
              <option value="OPENING">기초재고 (간편 / 표준)</option>
              <option value="MOVEMENTS">거래별 입출고</option>
              {isCompanyAdmin && <option value="BOOTSTRAP">기초 통합 이관 · 회사 ADMIN</option>}
            </select>
          </label>

          {/* 템플릿 다운로드 버튼 영역 */}
          {type !== 'BOOTSTRAP' && (
            <div className="erp-template-button" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {type === 'OPENING' && (
                <button type="button" className="wf-btn wf-btn-primary" onClick={() => void run(downloadSimpleTemplate)}>
                  <Sparkles size={16} /> 초간편 기초재고 양식 받기 (Simple)
                </button>
              )}
              <button
                type="button"
                className="wf-btn"
                onClick={() =>
                  void run(async () => {
                    const result = await erpImportService.template(companyId, type);
                    if (live.current) downloadErpFile(result);
                  })
                }
              >
                <Download size={16} /> 표준 양식 받기 (기존 16·27열)
              </button>
            </div>
          )}

          {type === 'BOOTSTRAP' && <p className="erp-form-wide wf-muted">
            최초 이관은 빈 ERP 장부에 적용합니다. 기존 장부를 전체 교체하려면 미리보기에서 회사 ADMIN이 별도로 초기화를 확인해야 합니다.
          </p>}

          <label className="wf-field erp-form-wide">
            <span>Excel 파일 (.xlsx, {type === 'BOOTSTRAP' ? '통합 이관 최대 12MB' : '최대 3MB'})</span>
            <input
              className="wf-input"
              type="file"
              accept=".xlsx"
              onChange={e => {
                void handleFileSelect(e.target.files?.[0] || null);
              }}
            />
          </label>

          {simpleMode && (
            <div className="erp-notice erp-form-wide" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Sparkles size={18} style={{ color: 'var(--color-primary, #2563eb)', flexShrink: 0 }} />
              <div>
                <strong>스마트 간편 양식이 감지되었습니다!</strong>
                <p style={{ margin: 0 }}>
                  시트명이나 복잡한 열 순서 상관없이 감지된 {simpleRows.length}개 품목 데이터를 서버 표준 규격으로 자동 변환하여 반영합니다.
                </p>
              </div>
            </div>
          )}

          {type === 'OPENING' && (
            <label className="wf-field">
              <span>기초재고 기준일</span>
              <input
                className="wf-input"
                type="date"
                value={basisDate}
                onChange={e => {
                  setBasisDate(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
          )}

          {type !== 'BOOTSTRAP' && (
            <>
              <label className="wf-field">
                <span>창고 공란에 적용할 기본 창고</span>
                <select className="wf-input" value={options.defaultWarehouseId} onChange={e => update({ defaultWarehouseId: e.target.value })}>
                  {warehouseOptions}
                </select>
              </label>

              <div className="erp-template-button">
                {warehouseCursor && (
                  <button
                    type="button"
                    className="wf-btn"
                    onClick={() =>
                      void run(async () => {
                        const result = await erpService.list(companyId, 'warehouses', '', 'name', warehouseCursor);
                        if (live.current) {
                          setWarehouses(current => [...current, ...result.records.filter(row => row.active)]);
                          setWarehouseCursor(result.nextCursor);
                        }
                      })
                    }
                  >
                    창고 더 불러오기
                  </button>
                )}
              </div>

              <label className="erp-active-field erp-form-wide">
                <input type="checkbox" checked={options.allowNewItems} onChange={e => update({ allowNewItems: e.target.checked })} />
                신규 품목 자동 등록 동의 (기본단가 0원 등록, 파일 단가는 재고원장에 보존)
              </label>

              {type === 'MOVEMENTS' && (
                <label className="erp-active-field erp-form-wide">
                  <input type="checkbox" checked={options.allowNewPartners} onChange={e => update({ allowNewPartners: e.target.checked })} />
                  신규 거래처 등록 확인 (동명 거래처는 후보를 확인 후 선택)
                </label>
              )}

              <label className="erp-active-field erp-form-wide">
                <input type="checkbox" checked={options.acceptExistingItems} onChange={e => update({ acceptExistingItems: e.target.checked })} />
                이름·규격 차이를 확인했으며 기존 코드의 품목을 사용 (단위 일치 필수)
              </label>
            </>
          )}
        </fieldset>

        <p className="erp-form-note">
          초간편 엑셀은 필수 5개 열만으로 즉시 변환되며, 표준 양식은 10~209행을 읽습니다. 출고원가는 이동평균으로 자동 계산됩니다.
        </p>

        <div className="erp-actions">
          <button type="button" className="wf-btn wf-btn-primary" disabled={busy || !file} onClick={() => void run(() => preview())}>
            <Upload size={16} /> {busy ? '처리 중…' : '검증 및 미리보기'}
          </button>
        </div>
      </section>

      {error && <p className="erp-error" role="alert">{error}</p>}
      {notice && <p className="erp-success" role="status">{notice}</p>}

      {bootstrapJob && (
        <section className="wf-panel erp-import-preview" aria-label="통합 이관 미리보기">
          <div className="erp-list-head">
            <div>
              <h2 className="wf-section-title">기초 통합 이관 미리보기</h2>
              <p className="wf-muted">
                {bootstrapJob.source.name} · 파일 회사 {bootstrapJob.companyLabel} · 반영 회사 {companyName} · 재고 기준일 {bootstrapJob.basisDate} · 기본 창고 {bootstrapJob.summary.warehouseName} ({bootstrapJob.summary.warehouseCode}) · {statusLabels[bootstrapJob.status]}
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '10px', marginBottom: '16px' }}>
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px 12px' }}>
              <small className="wf-muted">기초재고 품목 (실물보유)</small>
              <div style={{ fontSize: '16px', fontWeight: 700 }}>{bootstrapJob.summary.totalItems}개 (보유 {bootstrapJob.summary.positiveItems}개)</div>
              <small className="wf-muted">{number(bootstrapJob.summary.ownedQuantity)} EA · {number(bootstrapJob.summary.ownedValue)}원</small>
            </div>
            <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '10px 12px' }}>
              <small style={{ color: '#991b1b' }}>차용 미반환 (마이너스 재고)</small>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#b91c1c' }}>{bootstrapJob.summary.borrowingCount}품목 (-{number(bootstrapJob.summary.borrowedQuantity)} EA)</div>
              <small style={{ color: '#991b1b' }}>평가액 -{number(bootstrapJob.summary.borrowedValue)}원 · 순장부 {number(bootstrapJob.summary.netBookValue)}원</small>
            </div>
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px 12px' }}>
              <small className="wf-muted">거래처 마스터</small>
              <div style={{ fontSize: '16px', fontWeight: 700 }}>{bootstrapJob.summary.partnerCount}개처</div>
              <small className="wf-muted">매입·매출·채권·보관 상대처</small>
            </div>
            <div style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: '8px', padding: '10px 12px' }}>
              <small style={{ color: '#5b21b6' }}>기초 미수채권 (부가세 포함)</small>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#5b21b6' }}>{bootstrapJob.summary.receivableCount}건</div>
              <small style={{ color: '#5b21b6' }}>
                {bootstrapJob.summary.receivableTotals.map(t => `${erpMoney(t.amountMinor, t.currency)} ${t.currency}`).join(' / ') || '0 KRW'}
              </small>
            </div>
          </div>

          {bootstrapJob.comparison && <ErpLedgerComparisonTable comparison={bootstrapJob.comparison} />}
          {bootstrapJob.borrowings.length > 0 && (
            <div className="erp-table-scroll" style={{ marginBottom: '16px' }}>
              <table className="erp-table">
                <caption>차용 미반환 이관 내역 ({bootstrapJob.borrowings.length} / {bootstrapJob.summary.borrowingCount}건)</caption>
                <thead>
                  <tr><th>품목코드</th><th>품목명</th><th>창고</th><th className="erp-number">차용 수량</th><th className="erp-number">평가금액 (원)</th><th>원소유 → 판매처</th><th>기준일</th></tr>
                </thead>
                <tbody>
                  {bootstrapJob.borrowings.map(b => (
                    <tr key={`${b.code}-${b.date}`}>
                      <td className="erp-code">{b.code}</td>
                      <td>{b.name}</td>
                      <td>{b.warehouseName}</td>
                      <td className="erp-number" style={{ color: '#b91c1c', fontWeight: 600 }}>-{number(b.quantity)}</td>
                      <td className="erp-number">-{number(b.evaluationValue)}</td>
                      <td>{b.ownerName} → {b.buyerName}</td>
                      <td>{b.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {bootstrapJob.receivables.length > 0 && (
            <div className="erp-table-scroll" style={{ marginBottom: '16px' }}>
              <table className="erp-table">
                <caption>기초 미수채권 이관 내역 ({bootstrapJob.receivables.length} / {bootstrapJob.summary.receivableCount}건)</caption>
                <thead>
                  <tr><th>기준일</th><th>거래처코드</th><th>거래처명</th><th>문서번호</th><th>통화</th><th className="erp-number">미수잔액</th></tr>
                </thead>
                <tbody>
                  {bootstrapJob.receivables.map(r => (
                    <tr key={r.documentNo}>
                      <td>{r.date}</td>
                      <td className="erp-code">{r.partnerCode}</td>
                      <td>{r.partnerName}</td>
                      <td>{r.documentNo}</td>
                      <td>{r.currency}</td>
                      <td className="erp-number" style={{ fontWeight: 600 }}>{erpMoney(r.amountMinor, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="erp-import-confirm">
            {bootstrapJob.status === 'PENDING' && <ErpBootstrapConfirmation
              key={bootstrapJob.id + (bootstrapJob.stageConflict?.challenge || '')} job={bootstrapJob} companyName={companyName} busy={busy} dirty={dirty}
              onCancel={() => void run(async () => {
                const result = await erpBootstrapService.cancel(companyId, bootstrapJob.id);
                if (live.current) {
                  setBootstrapJob(result.bootstrap);
                  rememberBootstrap(null);
                  setNotice('통합 이관 검토를 취소했습니다.');
                }
              })}
              onCommit={reset => void run(async () => {
                const current = () => live.current && useAuthStore.getState().userData?.companyId === companyId;
                const onPending = (updated: ErpBootstrapJob) => {
                  if (!current()) return;
                  setBootstrapJob(updated);
                  setNotice('기존 장부를 백업하고 새 버전을 대사하고 있습니다.');
                };
                let result;
                try {
                  result = reset
                    ? await erpBootstrapService.reset(companyId, bootstrapJob, reset.warningAccepted, reset.password, current, onPending)
                    : await erpBootstrapService.commit(companyId, bootstrapJob, current, onPending);
                } catch (failure) {
                  if (!current()) return;
                  const latest = await erpBootstrapService.get(companyId, bootstrapJob.id).catch(() => null);
                  if (!current()) return;
                  if (latest) setBootstrapJob(latest.bootstrap);
                  if (latest?.bootstrap.status !== 'COMMITTED') throw failure;
                  result = latest;
                }
                if (!current()) return;
                setBootstrapJob(result.bootstrap);
                if (result.bootstrap.status !== 'COMMITTED') {
                  setNotice(result.bootstrap.stageConflict ? '새 장부 재작성에 대한 ADMIN 확인이 필요합니다.' : '새 장부를 준비 중입니다. 현재 상태를 확인해 주세요.');
                  return;
                }
                rememberBootstrap(null);
                if (result.idempotent) setNotice('이미 확정된 이관입니다. 기존 확정 결과를 표시합니다.');
                else setNotice(result.bootstrap.backup ? '기존 장부 백업 후 재이관을 확정했습니다.' : '최초 기초자료 이관을 확정했습니다.');
                const [masters, imports] = await Promise.all([erpService.list(companyId, 'warehouses', '', 'name'), erpImportService.list(companyId)]);
                if (live.current) {
                  setWarehouses(masters.records.filter(r => r.active));
                  setHistory(imports.imports);
                }
              })}
            />}
            {bootstrapJob.status === 'COMMITTED' && bootstrapJob.backup && <ErpBootstrapBackupResult backup={bootstrapJob.backup} />}
            {bootstrapJob.status === 'COMMITTED' && (
              <button type="button" className="wf-btn wf-btn-primary" onClick={onInventory}>
                반영된 재고·차용·미수금 확인
              </button>
            )}
          </div>
        </section>
      )}

      {job && (
        <section className="wf-panel erp-import-preview" aria-label="업로드 미리보기">
          <div className="erp-list-head">
            <div>
              <h2 className="wf-section-title">업로드 미리보기</h2>
              <p className="wf-muted">{job.source.name} · 기준일 {job.basisDate || '미입력'} · {statusLabels[job.status]}</p>
              <p className="wf-muted">파일 회사명: {job.companyLabel || '미입력'} · 로그인한 회사에 반영</p>
            </div>
            {!['MANUAL', 'PENDING_OPENING'].includes(job.source.kind || 'XLSX') && (
              <button
                type="button"
                className="wf-btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await erpImportService.source(companyId, job.id);
                    if (live.current) downloadErpFile(result);
                  })
                }
              >
                <Download size={16} /> 원본 받기
              </button>
            )}
          </div>

          <p className="erp-import-summary">
            정상 파싱 {job.preview.rows.length}행 · 오류 {job.preview.errors.length}건 · 신규 품목 {job.preview.newItems}건 · 신규 거래처 {job.preview.newPartners}건
          </p>

          {job.preview.errors.length > 0 && (
            <div className="erp-error" role="alert" style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <strong>
                  <AlertCircle size={16} style={{ display: 'inline', verticalAlign: 'text-bottom' }} /> 오류 {job.preview.errors.length}건이 있습니다. 표에서 직접 수정하거나 오류 행을 제외할 수 있습니다.
                </strong>
                <button type="button" className="wf-btn wf-btn-warning" disabled={busy} onClick={() => void run(excludeErrorsAndRepreview)}>
                  오류 행 제외하고 정상 행만 반영
                </button>
              </div>
              <ul style={{ marginTop: '8px', marginBottom: 0 }}>
                {job.preview.errors.map((item, i) => (
                  <li key={i}>{item.sheet} {item.row ? `${item.row}행` : ''}: {item.message}</li>
                ))}
              </ul>
            </div>
          )}

          {job.preview.warnings.length > 0 && (
            <details className="erp-import-notes">
              <summary>확인 사항 {job.preview.warnings.length}건</summary>
              <ul>
                {job.preview.warnings.map((item, i) => (
                  <li key={i}>{item.row}행: {item.message}</li>
                ))}
              </ul>
            </details>
          )}

          <div className="erp-table-scroll">
            <table className="erp-table erp-import-table">
              <caption className="erp-sr-only">행별 수량·거래금액·재고 변동 미리보기</caption>
              <thead>
                <tr>
                  <th>원본행·거래</th>
                  <th>품목·창고</th>
                  <th>거래처</th>
                  <th className="erp-number">수량·거래단가</th>
                  <th className="erp-number">공급가액·세액</th>
                  <th className="erp-number">출고원가 (원)</th>
                  <th className="erp-number">재고수량 전 → 후</th>
                  <th className="erp-number">재고금액 전 → 후 (원)</th>
                  {job.status === 'PENDING' && <th>인라인 수정</th>}
                </tr>
              </thead>
              <tbody>
                {job.preview.rows.map((row, index) => {
                  const isEditing = editingRowIndex === index;
                  return (
                    <tr key={row.sourceRow}>
                      <td>
                        {row.sourceRow}행 · {row.direction}
                        <small className="erp-cell-note">{row.date}<br />{row.documentNo}</small>
                      </td>
                      <td>
                        {isEditing ? (
                          <input
                            className="wf-input"
                            value={rowEditValues.name || ''}
                            onChange={e => setRowEditValues(v => ({ ...v, name: e.target.value }))}
                          />
                        ) : (
                          <strong>{row.name}</strong>
                        )}
                        <small className="erp-cell-note">
                          {row.code} {row.newItem ? '· 신규' : ''}<br />
                          {row.warehouseName || '창고 미지정'}
                        </small>
                      </td>
                      <td>
                        {row.partnerName || '—'}
                        {row.newPartner && <small className="erp-cell-note">신규 등록</small>}
                      </td>
                      <td className="erp-number">
                        {isEditing ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <input
                              className="wf-input"
                              placeholder="수량"
                              type="number"
                              value={rowEditValues.quantity || ''}
                              onChange={e => setRowEditValues(v => ({ ...v, quantity: e.target.value }))}
                            />
                            <input
                              className="wf-input"
                              placeholder="단가"
                              type="number"
                              value={rowEditValues.price || ''}
                              onChange={e => setRowEditValues(v => ({ ...v, price: e.target.value }))}
                            />
                          </div>
                        ) : (
                          <>
                            {number(row.quantity)} {row.unit}
                            <small className="erp-cell-note">
                              {row.price === null ? '장부금액 방식' : `${number(row.price)} ${row.currency}`}
                            </small>
                          </>
                        )}
                      </td>
                      <td className="erp-number">
                        {row.direction === '기초' ? `${number(row.value)} KRW` : `${number(row.supply)} / ${number(row.tax)} ${row.currency}`}
                        <small className="erp-cell-note">원화 {number(row.value)}원</small>
                      </td>
                      <td className="erp-number">{row.direction === '출고' ? number(row.cost) : '—'}</td>
                      <td className="erp-number">{number(row.beforeQuantity)} → {number(row.afterQuantity)}</td>
                      <td className="erp-number">{number(row.beforeValue)} → {number(row.afterValue)}</td>
                      {job.status === 'PENDING' && (
                        <td>
                          {isEditing ? (
                            <div style={{ display: 'flex', gap: '4px' }}>
                              <button
                                type="button"
                                className="wf-btn wf-btn-primary"
                                title="수정 반영"
                                onClick={() => void run(() => applyInlineEdit(index))}
                              >
                                <Check size={14} /> 적용
                              </button>
                              <button
                                type="button"
                                className="wf-btn"
                                onClick={() => setEditingRowIndex(null)}
                              >
                                취소
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="wf-btn"
                              title="수량/단가 직접 수정"
                              onClick={() => startEditing(index, row)}
                            >
                              <Pencil size={14} /> 수정
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {file && job.status === 'PENDING' && (
            <details className="erp-import-notes">
              <summary>행별 창고·거래처 매핑</summary>
              <div className="erp-import-mappings">
                {job.preview.rows.map(row => (
                  <div className="erp-import-mapping" key={row.sourceRow}>
                    <label className="wf-field">
                      <span>{row.sourceRow}행 {row.code} 창고 재지정</span>
                      <select
                        className="wf-input"
                        disabled={busy}
                        value={options.warehouseByRow[row.sourceRow] || ''}
                        onChange={e => {
                          const next = { ...options.warehouseByRow };
                          if (e.target.value) next[row.sourceRow] = e.target.value;
                          else delete next[row.sourceRow];
                          update({ warehouseByRow: next });
                        }}
                      >
                        {warehouseOptions}
                      </select>
                    </label>
                    {row.partnerCandidates.length > 0 && (
                      <label className="wf-field">
                        <span>{row.sourceRow}행 기존 거래처 선택</span>
                        <select
                          className="wf-input"
                          disabled={busy}
                          value={options.partnerByRow[row.sourceRow] || ''}
                          onChange={e => {
                            const next = { ...options.partnerByRow };
                            if (e.target.value) next[row.sourceRow] = e.target.value;
                            else delete next[row.sourceRow];
                            update({ partnerByRow: next });
                          }}
                        >
                          <option value="">기존 거래처를 선택하거나 신규 등록 확인</option>
                          {row.partnerCandidates.map(p => (
                            <option key={p.id} value={p.id}>{p.code} · {p.name}</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          <div className="erp-import-confirm">
            {dirty && <p role="status" className="erp-notice">입력 설정이 변경되었습니다. 검증 및 미리보기를 다시 실행해 주세요.</p>}
            {job.status === 'PENDING' && (
              <>
                <label className="erp-active-field">
                  <input
                    type="checkbox"
                    disabled={busy || dirty || !job.preview.canCommit}
                    checked={confirmed}
                    onChange={e => setConfirmed(e.target.checked)}
                  />
                  로그인 회사의 품목·창고·거래처와 위 재고 변동을 확인했습니다.
                </label>
                <div className="erp-actions">
                  <button
                    type="button"
                    className="wf-btn"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await erpImportService.cancel(companyId, job.id);
                        if (live.current) {
                          setJob(result.import);
                          setNotice('검토를 취소했습니다. 재고 변경은 없습니다.');
                        }
                        await refresh();
                      })
                    }
                  >
                    검토 취소
                  </button>
                  <button
                    type="button"
                    className="wf-btn wf-btn-primary"
                    disabled={busy || dirty || !confirmed || !job.preview.canCommit}
                    onClick={() =>
                      void run(async () => {
                        const result = await erpImportService.commit(companyId, job);
                        if (!live.current) return;
                        setJob(result.import);
                        setConfirmed(false);
                        setNotice(result.idempotent ? '이미 확정한 업로드입니다. 중복 반영하지 않았습니다.' : 'DB 반영 완료. 원장과 회사별 재고가 함께 저장되었습니다.');
                        await refresh();
                      })
                    }
                  >
                    <FileCheck2 size={16} /> DB 반영 확정
                  </button>
                </div>
              </>
            )}
            {job.status === 'COMMITTED' && (
              <button type="button" className="wf-btn wf-btn-primary" onClick={onInventory}>
                반영된 재고 확인
              </button>
            )}
          </div>
        </section>
      )}

      <section className="wf-panel" aria-label="업로드 이력">
        <div className="erp-list-head">
          <h2 className="wf-section-title">최근 업로드 이력</h2>
          <button type="button" className="wf-btn" aria-label="업로드 이력 새로고침" disabled={busy} onClick={() => void run(refresh)}>
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="erp-table-scroll">
          <table className="erp-table">
            <thead>
              <tr>
                <th>파일</th>
                <th>유형</th>
                <th>상태</th>
                <th>검토</th>
              </tr>
            </thead>
            <tbody>
              {history.map(entry => (
                <tr key={entry.id}>
                  <td>
                    {entry.name}
                    <small className="erp-cell-note">{new Date(entry.createdAt).toLocaleString('ko-KR')} · {entry.rowCount}행</small>
                  </td>
                  <td>{entry.type === 'OPENING' ? '기초재고' : '입출고'}</td>
                  <td>{statusLabels[entry.status]}{entry.errorCount > 0 ? ` · 오류 ${entry.errorCount}` : ''}</td>
                  <td>
                    <button
                      type="button"
                      className="wf-btn"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const result = await erpImportService.get(companyId, entry.id);
                          if (live.current) {
                            setJob(result.import);
                            setDirty(false);
                            setConfirmed(false);
                            setFile(null);
                          }
                        })
                      }
                    >
                      열기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!history.length && <p className="erp-empty">업로드 이력이 없습니다.</p>}
      </section>
    </div>
  );
}
