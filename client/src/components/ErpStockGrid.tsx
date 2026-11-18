import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Download, Plus, Search, Eye, ArrowDownToLine, ArrowUpFromLine, Layers, Package } from 'lucide-react';
import { erpService } from '../services/erpService';
import type { ErpRecord } from '../services/erpService';
import { erpLedgerService } from '../services/erpLedgerService';
import { createStockSnapshotWorkbook, type StockSnapshotItem } from '../utils/erpWorkbook';
import { getErrorMessage } from '../utils/errors';

const number = (value?: number | null) => (value == null ? '—' : value.toLocaleString('ko-KR', { maximumFractionDigits: 4 }));
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());

export interface ErpStockGridProps {
  companyId: string;
  canManage: boolean;
  canOperate: boolean;
  inboundAllowed: boolean;
  outboundAllowed: boolean;
  onSelectDetail: (item: ErpRecord) => void;
  onOpenMovement: (direction: '입고' | '출고', item: ErpRecord) => void;
  onOpenCreateItem: () => void;
}

export function ErpStockGrid({
  companyId,
  canManage,
  canOperate,
  inboundAllowed,
  outboundAllowed,
  onSelectDetail,
  onOpenMovement,
  onOpenCreateItem
}: ErpStockGridProps) {
  const [items, setItems] = useState<ErpRecord[]>([]);
  const [warehouses, setWarehouses] = useState<ErpRecord[]>([]);
  const [stockMap, setStockMap] = useState<Map<string, { totalQuantity: number; totalValue: number; byWarehouse: Map<string, number> }>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<'ALL' | 'IN_STOCK' | 'OUT_OF_STOCK' | 'NORMAL' | 'BUNDLE'>('ALL');
  const [exporting, setExporting] = useState(false);

  const live = useRef(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      // 1. 전체 품목 목록 및 창고 목록 조회
      const [itemResult, warehouseResult, ledgerMeta] = await Promise.all([
        erpService.list(companyId, 'items', '', 'name'),
        erpService.list(companyId, 'warehouses', '', 'name'),
        erpLedgerService.meta(companyId).catch(() => null)
      ]);

      if (!live.current) return;
      const allItems = itemResult.records;
      const activeWarehouses = warehouseResult.records.filter(w => w.active);
      setItems(allItems);
      setWarehouses(activeWarehouses);

      // 2. 전체 수불부 요약(Summary) 원장 조회하여 품목/창고별 기말재고 가져오기
      const newStockMap = new Map<string, { totalQuantity: number; totalValue: number; byWarehouse: Map<string, number> }>();
      // 초기화
      for (const item of allItems) {
        newStockMap.set(item.id, { totalQuantity: 0, totalValue: 0, byWarehouse: new Map() });
      }

      if (ledgerMeta?.basisDate) {
        try {
          const reportResult = await erpLedgerService.report(
            companyId,
            {
              from: ledgerMeta.basisDate,
              to: today(),
              search: '',
              itemId: '',
              warehouseId: ''
            },
            'summary'
          );

          if (live.current && reportResult?.rows) {
            for (const row of reportResult.rows) {
              const entry = newStockMap.get(row.itemId) || { totalQuantity: 0, totalValue: 0, byWarehouse: new Map() };
              const closingQty = row.closingQuantity || 0;
              const closingVal = row.closingValue || 0;
              entry.byWarehouse.set(row.warehouseId, closingQty);
              entry.totalQuantity += closingQty;
              entry.totalValue += closingVal;
              newStockMap.set(row.itemId, entry);
            }
          }
        } catch {
          // 리포트 조회 실패 시 기본 수치 유지
        }
      }

      if (live.current) {
        setStockMap(newStockMap);
      }
    } catch (failure) {
      if (live.current) setError(getErrorMessage(failure, '재고 목록을 불러오지 못했습니다.'));
    } finally {
      if (live.current) setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    live.current = true;
    void loadData();
    return () => {
      live.current = false;
    };
  }, [loadData]);

  // 엑셀 다운로드
  async function exportToExcel() {
    if (!items.length) return;
    setExporting(true);
    try {
      const warehouseNames = warehouses.map(w => w.name);
      const snapshotItems: StockSnapshotItem[] = items.map(item => {
        const stockEntry = stockMap.get(item.id);
        const whObj: Record<string, number> = {};
        for (const w of warehouses) {
          whObj[w.name] = stockEntry?.byWarehouse.get(w.id) ?? 0;
        }
        return {
          code: item.code,
          name: item.name,
          specification: item.specification,
          unit: item.unit || 'EA',
          itemType: item.itemType,
          quantity: stockEntry?.totalQuantity ?? 0,
          warehouses: whObj,
          purchasePrice: item.purchasePrice,
          salePrice: item.salePrice,
          active: item.active
        };
      });

      const blob = await createStockSnapshotWorkbook(snapshotItems, warehouseNames, canManage);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `현재고현황_${today()}.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setNotice(`현재고 현황 ${items.length}개 품목을 엑셀로 내려받았습니다.`);
    } catch (e) {
      setError(getErrorMessage(e, '엑셀 파일 생성에 실패했습니다.'));
    } finally {
      setExporting(false);
    }
  }

  // 필터링 및 검색된 품목들
  const filteredItems = items.filter(item => {
    const stock = stockMap.get(item.id);
    const qty = stock?.totalQuantity ?? 0;

    // 검색어 필터
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const codeMatch = item.code.toLowerCase().includes(q);
      const nameMatch = item.name.toLowerCase().includes(q);
      const specMatch = item.specification ? item.specification.toLowerCase().includes(q) : false;
      if (!codeMatch && !nameMatch && !specMatch) return false;
    }

    // 탭 필터
    if (filterType === 'IN_STOCK' && qty <= 0) return false;
    if (filterType === 'OUT_OF_STOCK' && qty > 0) return false;
    if (filterType === 'NORMAL' && item.itemType === 'BUNDLE') return false;
    if (filterType === 'BUNDLE' && item.itemType !== 'BUNDLE') return false;

    return true;
  });

  // 요약 카운트
  const totalItemCount = items.length;
  const inStockCount = items.filter(item => (stockMap.get(item.id)?.totalQuantity ?? 0) > 0).length;
  const outOfStockCount = items.filter(item => (stockMap.get(item.id)?.totalQuantity ?? 0) <= 0).length;

  return (
    <section className="wf-panel erp-stock-grid-panel" aria-label="종합 재고현황판">
      {/* 상단 헤더 및 통계 요약 */}
      <div className="erp-list-head" style={{ marginBottom: '12px' }}>
        <div>
          <h2 className="wf-section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Layers size={20} style={{ color: 'var(--color-primary, #2563eb)' }} /> 전체 품목 재고 현황
          </h2>
          <p className="wf-muted" style={{ margin: 0 }}>
            모든 품목의 실시간 현재고와 창고별 보유 현황을 한눈에 확인하고 즉시 입·출고를 연결합니다.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button type="button" className="wf-btn" disabled={loading} onClick={() => void loadData()} title="재고 새로고침">
            <RefreshCw size={16} /> 새로고침
          </button>
          <button type="button" className="wf-btn wf-btn-primary" disabled={loading || exporting || !items.length} onClick={() => void exportToExcel()}>
            <Download size={16} /> {exporting ? '생성 중…' : '현재고 엑셀 다운로드'}
          </button>
          {canOperate && (
            <button type="button" className="wf-btn" onClick={onOpenCreateItem}>
              <Plus size={16} /> 품목 신규 등록
            </button>
          )}
        </div>
      </div>

      {/* 상단 통계 뱃지 바 */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <div style={{ background: 'var(--color-bg-secondary, #f8fafc)', padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--color-border, #e2e8f0)' }}>
          <small className="wf-muted">전체 등록 품목</small>
          <div style={{ fontSize: '18px', fontWeight: 600 }}>{totalItemCount} <span style={{ fontSize: '12px', fontWeight: 400 }}>개</span></div>
        </div>
        <div style={{ background: 'var(--color-bg-secondary, #f8fafc)', padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--color-border, #e2e8f0)' }}>
          <small className="wf-muted">재고 보유 품목</small>
          <div style={{ fontSize: '18px', fontWeight: 600, color: '#16a34a' }}>{inStockCount} <span style={{ fontSize: '12px', fontWeight: 400 }}>개</span></div>
        </div>
        <div style={{ background: 'var(--color-bg-secondary, #f8fafc)', padding: '8px 16px', borderRadius: '8px', border: '1px solid var(--color-border, #e2e8f0)' }}>
          <small className="wf-muted">재고 0 (품절) 품목</small>
          <div style={{ fontSize: '18px', fontWeight: 600, color: '#dc2626' }}>{outOfStockCount} <span style={{ fontSize: '12px', fontWeight: 400 }}>개</span></div>
        </div>
      </div>

      {/* 검색 및 필터 탭 바 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`wf-btn ${filterType === 'ALL' ? 'wf-btn-primary' : ''}`}
            onClick={() => setFilterType('ALL')}
          >
            전체 ({totalItemCount})
          </button>
          <button
            type="button"
            className={`wf-btn ${filterType === 'IN_STOCK' ? 'wf-btn-primary' : ''}`}
            onClick={() => setFilterType('IN_STOCK')}
          >
            재고 보유 ({inStockCount})
          </button>
          <button
            type="button"
            className={`wf-btn ${filterType === 'OUT_OF_STOCK' ? 'wf-btn-primary' : ''}`}
            onClick={() => setFilterType('OUT_OF_STOCK')}
          >
            재고 0/품절 ({outOfStockCount})
          </button>
          <button
            type="button"
            className={`wf-btn ${filterType === 'NORMAL' ? 'wf-btn-primary' : ''}`}
            onClick={() => setFilterType('NORMAL')}
          >
            일반상품
          </button>
          <button
            type="button"
            className={`wf-btn ${filterType === 'BUNDLE' ? 'wf-btn-primary' : ''}`}
            onClick={() => setFilterType('BUNDLE')}
          >
            합성세트
          </button>
        </div>

        <div style={{ position: 'relative', minWidth: '240px', flex: '1', maxWidth: '360px' }}>
          <Search size={16} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--color-text-muted, #64748b)' }} />
          <input
            className="wf-input"
            style={{ paddingLeft: '32px' }}
            placeholder="품목코드, 품목명, 규격 검색"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {error && <p className="erp-error" role="alert">{error}</p>}
      {notice && <p className="erp-success" role="status">{notice}</p>}

      {/* 종합 재고현황 데이터 테이블 */}
      <div className="erp-table-scroll" aria-busy={loading} style={{ minHeight: '300px' }}>
        <table className="erp-table">
          <caption className="erp-sr-only">회사 전체 품목 재고 현황 목록</caption>
          <thead>
            <tr>
              <th style={{ width: '120px' }}>품목코드</th>
              <th>품목명 / 규격</th>
              <th style={{ width: '70px' }}>단위</th>
              <th style={{ width: '90px' }}>유형</th>
              <th className="erp-number" style={{ width: '120px' }}>전체 현재고</th>
              <th>창고별 재고 현황</th>
              {canManage && <th className="erp-number" style={{ width: '110px' }}>기본 매입단가</th>}
              <th className="erp-number" style={{ width: '110px' }}>기본 판매단가</th>
              <th style={{ width: '80px', textAlign: 'center' }}>상태</th>
              <th style={{ width: '160px', textAlign: 'center' }}>빠른 작업</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map(item => {
              const stock = stockMap.get(item.id);
              const qty = stock?.totalQuantity ?? 0;
              const isBundle = item.itemType === 'BUNDLE';

              return (
                <tr key={item.id} className={!item.active ? 'erp-row-disabled' : ''}>
                  <td className="erp-code">
                    <button
                      type="button"
                      className="erp-name-button"
                      onClick={() => onSelectDetail(item)}
                      title="품목 상세현황 보기"
                      style={{ fontWeight: 600 }}
                    >
                      {item.code}
                    </button>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="erp-name-button"
                      onClick={() => onSelectDetail(item)}
                      title="품목 상세현황 보기"
                      style={{ textAlign: 'left' }}
                    >
                      <strong>{item.name}</strong>
                      {item.specification && <small className="erp-cell-note">{item.specification}</small>}
                    </button>
                  </td>
                  <td>{item.unit || 'EA'}</td>
                  <td>
                    {isBundle ? (
                      <span className="wf-status" style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                        합성세트
                      </span>
                    ) : (
                      <span className="wf-muted">일반</span>
                    )}
                  </td>
                  <td className="erp-number" style={{ fontWeight: 700, fontSize: '15px' }}>
                    <span style={{ color: qty > 0 ? '#16a34a' : '#94a3b8' }}>
                      {number(qty)}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {warehouses.map(wh => {
                        const whQty = stock?.byWarehouse.get(wh.id) || 0;
                        if (whQty === 0 && warehouses.length > 2) return null; // 창고가 많으면 0개 창고는 축소
                        return (
                          <span
                            key={wh.id}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '4px',
                              background: whQty > 0 ? '#f0fdf4' : '#f8fafc',
                              color: whQty > 0 ? '#166534' : '#64748b',
                              border: `1px solid ${whQty > 0 ? '#bbf7d0' : '#e2e8f0'}`,
                              padding: '2px 8px',
                              borderRadius: '4px',
                              fontSize: '12px'
                            }}
                          >
                            <span>{wh.name}:</span>
                            <strong>{number(whQty)}</strong>
                          </span>
                        );
                      })}
                      {isBundle && <span className="wf-muted" style={{ fontSize: '12px' }}>세트 가용 수량</span>}
                    </div>
                  </td>
                  {canManage && (
                    <td className="erp-number">
                      {isBundle ? '—' : `${number(item.purchasePrice || 0)}원`}
                    </td>
                  )}
                  <td className="erp-number">{number(item.salePrice || 0)}원</td>
                  <td style={{ textAlign: 'center' }}>
                    <span className={`wf-status ${item.active ? '' : 'wf-status-warning'}`}>
                      {item.active ? '정상' : '중지'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                      {inboundAllowed && !isBundle && (
                        <button
                          type="button"
                          className="wf-btn"
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          disabled={!item.active}
                          title="이 품목 입고등록"
                          onClick={() => onOpenMovement('입고', item)}
                        >
                          <ArrowDownToLine size={13} /> 입고
                        </button>
                      )}
                      {outboundAllowed && (
                        <button
                          type="button"
                          className="wf-btn"
                          style={{ padding: '4px 8px', fontSize: '12px' }}
                          disabled={!item.active}
                          title="이 품목 출고등록"
                          onClick={() => onOpenMovement('출고', item)}
                        >
                          <ArrowUpFromLine size={13} /> 출고
                        </button>
                      )}
                      <button
                        type="button"
                        className="wf-btn"
                        style={{ padding: '4px 8px', fontSize: '12px' }}
                        title="상세 재고현황"
                        onClick={() => onSelectDetail(item)}
                      >
                        <Eye size={13} /> 상세
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {loading && <p role="status" className="erp-empty">전체 품목 및 재고를 불러오는 중입니다…</p>}
      {!loading && !filteredItems.length && (
        <div className="erp-empty" style={{ padding: '36px 0' }}>
          <Package size={36} aria-hidden="true" style={{ color: '#94a3b8' }} />
          <p style={{ marginTop: '8px' }}>
            {search ? '검색 조건과 일치하는 품목이 없습니다.' : '등록된 품목이 없습니다.'}
          </p>
          {canOperate && !search && (
            <button type="button" className="wf-btn wf-btn-primary" onClick={onOpenCreateItem}>
              첫 품목 등록하기
            </button>
          )}
        </div>
      )}
    </section>
  );
}