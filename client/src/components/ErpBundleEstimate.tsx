import { useEffect, useState } from 'react';
import { erpService } from '../services/erpService';
import type { BundleEstimate } from '../services/erpService';
import { getErrorMessage } from '../utils/errors';
import {ErpStockStates} from './ErpStockStates';
import {stockLabels} from '../utils/erpStock';

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
      <p><strong>출고 가능 {number(value.availableSets)}세트</strong> · 요청 {quantity}세트 · 예상 원가 <strong>{value.estimatedCost==null?'산정 불가':number(value.estimatedCost)+'원'}</strong></p>
      {!value.canShip && <p className="erp-error">구성품 재고가 부족합니다. 부족한 품목을 입고하거나 출고 수량·창고를 변경해 주세요.</p>}
      <div className="erp-bundle-parts">{value.rows.map(row => <article className="erp-bundle-part" key={row.itemId} aria-label={`${row.name} 구성품`}>
        <h5>{row.name}</h5><small className="wf-muted">{row.code} · {row.unit}</small>
        {row.pendingCost && <p className="erp-notice">원가 미확정 이관분 제외</p>}
        <dl><div><dt>세트당 수량</dt><dd>{number(row.perSet)}</dd></div><div><dt>{stockLabels.owned}</dt><dd>{row.recorded===false?'미등록':number(row.quantity)}</dd></div>
          <div><dt>필요 수량</dt><dd>{number(row.needed)}</dd></div><div><dt>부족 수량</dt><dd className={row.shortage ? 'erp-error' : undefined}>{row.shortage ? number(row.shortage) : '없음'}</dd></div>
          <div><dt>평균 원가</dt><dd>{row.averagePrice==null?'산정 불가':number(row.averagePrice)+'원'}</dd></div><div><dt>예상 출고원가</dt><dd>{row.estimatedCost==null?'산정 불가':number(row.estimatedCost)+'원'}</dd></div></dl>
        <details><summary>보관·차용·원가 대기 상태</summary><ErpStockStates owned={row.recorded===false?null:row.quantity} held={row.customerHeld||0} borrowed={row.borrowedOutstanding||0} pending={row.pendingCost?{quantity:row.pendingQuantity??null,unit:row.pendingUnit||row.unit}:null} unit={row.unit}/></details>
      </article>)}</div>
      <p className="wf-muted">출고 가능 수량은 완전한 1세트 기준입니다. 소수 세트 요청은 구성품 수량의 소수점 4자리 범위에서 별도로 검증합니다. 고객 보관품·차용 미반환·원가 미확정 대기는 가용 수량에 더하지 않습니다. 예상 원가는 요청 수량에 대한 구성품별 이동평균원가 합계이며, 여러 출고 행의 공통 구성품과 최종 확정은 최신 원장으로 다시 검증합니다.</p>
    </>}
  </section>;
}
