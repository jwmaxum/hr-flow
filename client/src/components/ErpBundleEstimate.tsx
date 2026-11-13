import { useEffect, useState } from 'react';
import { erpService } from '../services/erpService';
import type { BundleEstimate } from '../services/erpService';
import { getErrorMessage } from '../utils/errors';

const number = (value: number | null) => value === null ? '—' : value.toLocaleString('ko-KR', {maximumFractionDigits: 4});
export function ErpBundleEstimate({companyId, warehouseId, components, quantity}: {
  companyId: string; warehouseId: string; components: {itemId: string; quantity: string}[]; quantity: string;
}) {
  const [result, setResult] = useState<{key: string; value?: BundleEstimate; error?: string} | null>(null);
  const [reload, setReload] = useState(0);
  const serialized = JSON.stringify(components), key = JSON.stringify([companyId, warehouseId, serialized, quantity, reload]);
  const ready = !!warehouseId && !!quantity && components.length > 0 && components.every(row => row.itemId && row.quantity);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void erpService.bundleEstimate(companyId, warehouseId, JSON.parse(serialized), quantity)
        .then(value => {if (live) setResult({key, value});})
        .catch(error => {if (live) setResult({key, error: getErrorMessage(error)});});
    }, 300);
    return () => {live = false; window.clearTimeout(timer);};
  }, [companyId, warehouseId, serialized, quantity, ready, key]);
  const current = result?.key === key ? result : null, value = current?.value;
  return <section className="erp-form-wide erp-bundle-estimate" aria-label="구성품 재고·예상 원가" aria-busy={ready && !current}>
    <div className="erp-list-head"><h4>구성품 재고·예상 원가</h4><button type="button" className="wf-btn" disabled={!ready || !current} onClick={() => setReload(v => v + 1)}>구성품 재고 새로고침</button></div>
    {!ready ? <p className="wf-muted">창고, 구성품, 세트 수량을 입력하면 출고 가능 수량과 예상 원가가 표시됩니다.</p> : !current ? <p role="status">구성품 재고를 조회하고 있습니다.</p> : current.error ? <p role="alert" className="erp-error">{current.error}</p> : value && <>
      <p><strong>출고 가능 {number(value.availableSets)}세트</strong> · 요청 {quantity}세트 · 예상 원가 <strong>{number(value.estimatedCost)}원</strong></p>
      {!value.canShip && <p className="erp-error">구성품 재고가 부족합니다. 부족한 품목을 입고하거나 출고 수량·창고를 변경해 주세요.</p>}
      <div className="erp-table-scroll"><table className="erp-table"><caption className="erp-sr-only">선택 창고의 구성품 재고 및 예상 원가</caption><thead><tr><th>구성품</th><th>세트당 수량</th><th>현재 재고</th><th>필요 수량</th><th>부족 수량</th><th>평균 원가 (원)</th><th>예상 출고원가 (원)</th></tr></thead><tbody>{value.rows.map(row => <tr key={row.itemId}><td>{row.name}<small className="erp-cell-note">{row.code} · {row.unit}{row.pendingCost ? ' · 원가 미확정 이관분 제외' : ''}</small></td><td>{number(row.perSet)}</td><td>{number(row.quantity)}</td><td>{number(row.needed)}</td><td>{row.shortage ? number(row.shortage) : '없음'}</td><td>{number(row.averagePrice)}</td><td>{number(row.estimatedCost)}</td></tr>)}</tbody></table></div>
      <p className="wf-muted">선택 창고의 이동평균원가 기준입니다. 여러 출고 행의 공통 구성품은 검증·미리보기에서 합산 검증합니다. 최종 확정 시 최신 재고·원가를 다시 확인합니다.</p>
    </>}
  </section>;
}
