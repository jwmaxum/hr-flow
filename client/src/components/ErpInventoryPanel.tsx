import {RefreshCw,Pencil,PackageSearch} from 'lucide-react';
import type {InventoryResult} from '../services/erpService';
import {ErpStockStates} from './ErpStockStates';
import {stockLabels} from '../utils/erpStock';
const number=(value:number)=>value.toLocaleString('ko-KR',{maximumFractionDigits:4});
export function ErpInventoryPanel({value,loading,error,onRetry,onEdit,onOpening,canManage,canOpenOpening}:{value:InventoryResult|null;loading:boolean;error:string;onRetry:()=>void;onEdit:()=>void;onOpening:()=>void;canManage:boolean;canOpenOpening:boolean}){
  return <section className="wf-panel erp-inventory" aria-label="품목 재고현황" aria-busy={loading}>
    <div className="wf-panel-head"><h2 className="wf-section-title">재고현황</h2><button className="wf-btn" onClick={onRetry} disabled={loading} aria-label="재고 새로고침"><RefreshCw size={16} aria-hidden="true"/></button></div>
    {loading?<p role="status" className="erp-empty">재고를 확인하고 있습니다.</p>:error?<p role="alert" className="erp-error">{error}</p>:value?<>
      <div className="erp-item-heading"><span className="erp-code">{value.item.code}</span><h3>{value.item.name}</h3><p className="wf-muted">{value.item.specification||'규격 미입력'} · {value.item.unit}</p>{!value.item.active&&<span className="wf-status wf-status-warning">사용 중지</span>}</div>
      {value.virtual?<BundleStock key={value.item.id} value={value} canManage={canManage}/>:<>
        <ErpStockStates owned={value.quantity} held={value.customerHeld||0} borrowed={value.borrowedOutstanding||0} pending={value.pendingOpening} unit={value.item.unit||''}/>
        <p className="wf-muted">고객 소유 보관품·차용 미반환·원가 미확정 대기는 회사 소유 재고와 합산하지 않습니다. 차용 미반환은 창고에 남은 수량이 아니며, 반환이 필요한 수량을 양수로 표시합니다.</p>
        {canManage&&<dl className="erp-stock-totals"><div><dt>회사 소유 재고금액</dt><dd>{value.value==null?'미확정':number(value.value)}{value.value!=null&&<small>원</small>}</dd></div><div><dt>평균 재고단가</dt><dd>{value.averagePrice==null?'산정 불가':number(value.averagePrice)}{value.averagePrice!=null&&<small>원</small>}</dd></div></dl>}
        {value.status==='UNINITIALIZED'&&<p className="erp-notice"><strong>재고 미등록</strong><br/>회사 소유 기초재고 또는 입고가 반영되면 확정 수량·금액을 확인할 수 있습니다.</p>}
        {value.pendingOpening&&<div className="erp-notice" aria-label="원가 미확정 이관 대기"><strong>원가 확인 후 재고 확정 필요</strong><p>{value.pendingOpening.basisDate} 기준 · 원본 수량 {value.pendingOpening.quantity===null?'공란':`${number(value.pendingOpening.quantity)} ${value.pendingOpening.unit}`}</p><p>{value.pendingOpening.source}</p><p>창고가 지정되지 않은 원본 대기 수량입니다. 출고 가능 수량·재고자산에 포함하지 않으며, 기본 매입단가만 수정해도 재고가 확정되지는 않습니다.</p>{canOpenOpening&&<button className="wf-btn wf-btn-primary" disabled={!value.item.active} onClick={onOpening}>원가 입력·기초재고 확정</button>}</div>}
        {!!value.warehouses.length&&<div className="erp-table-scroll"><table className="erp-table"><caption>창고별 재고 상태</caption><thead><tr><th>창고</th><th>{stockLabels.owned}</th><th>{stockLabels.held}</th><th>{stockLabels.borrowed}</th>{canManage&&<th>회사 소유 금액 (원)</th>}</tr></thead><tbody>{value.warehouses.map(r=><tr key={r.warehouseId}><td>{r.warehouseName}<small className="erp-cell-note">{r.warehouseCode}{r.warehouseActive?'':' · 사용 중지'}</small></td><td className="erp-number">{r.recorded===false?'미등록':number(r.quantity)}</td><td className="erp-number">{number(r.customerHeld||0)}</td><td className="erp-number">{number(r.borrowedOutstanding||0)}</td>{canManage&&<td className="erp-number">{r.value==null?'미등록':number(r.value)}</td>}</tr>)}</tbody></table></div>}
      </>}
      {canManage&&<dl className="erp-prices">{!value.virtual&&<div><dt>기본 매입단가</dt><dd>{number(value.item.purchasePrice??0)}원</dd></div>}<div><dt>기본 판매단가</dt><dd>{number(value.item.salePrice??0)}원</dd></div></dl>}
      <div className="erp-inventory-footer"><small className="wf-muted">조회 {new Date(value.checkedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}</small>{canManage&&<button className="wf-btn" onClick={onEdit}><Pencil size={14} aria-hidden="true"/>품목 수정</button>}</div>
    </>:<div className="erp-empty"><PackageSearch size={32} aria-hidden="true"/><p>품목명을 입력하거나 목록에서 품목을 선택해 주세요.</p></div>}
  </section>;
}
function BundleStock({value,canManage}:{value:InventoryResult;canManage:boolean}){
  return <section aria-label="창고별 세트 출고 가능 수량"><dl className="erp-stock-totals"><div><dt>세트 출고 가능 수량</dt><dd>{number(value.quantity||0)}<small>세트</small></dd></div></dl>
    <p className="erp-notice">세트의 별도 재고자산은 없습니다. 활성 창고별 회사 소유 구성품으로 완성할 수 있는 1세트 단위 수량을 합산합니다. 서로 다른 창고의 부족 구성품을 합치거나 고객 보관품·차용 미반환·원가 미확정 대기를 더하지 않습니다.</p>
    {!value.item.active&&<p className="erp-error">사용 중지한 세트는 출고할 수 없습니다.</p>}
    {!value.warehouses.length&&<p>창고를 등록하면 창고별 출고 가능 수량을 확인할 수 있습니다.</p>}
    <div className="erp-stock-warehouses">{value.warehouses.map(w=><article className="erp-bundle-part" key={w.warehouseId} aria-label={`${w.warehouseName} 세트 현황`}><h4>{w.warehouseName} <small>{w.warehouseCode}</small></h4><p><strong>출고 가능 {number(w.quantity)}세트</strong>{!w.warehouseActive?' · 창고 사용 중지':''}</p>{canManage&&<p>1세트 예상 원가: <strong>{w.estimatedCost==null?'산정 불가':`${number(w.estimatedCost)}원`}</strong></p>}
      {!w.canShip&&w.warehouseActive&&value.item.active&&<p className="erp-notice">1세트를 구성할 회사 소유 재고가 부족하거나 사용 중지한 구성품이 있습니다.</p>}
      <details><summary>구성품별 재고 상태·{canManage?'원가':'필요 수량'}</summary>{w.components?.map(c=><div className="erp-stock-component" key={c.itemId}><strong>{c.code} · {c.name}{c.active===false?' · 사용 중지':''}</strong><p>세트당 필요 {number(c.perSet)} {c.unit}{canManage?` · 예상 원가 ${c.estimatedCost==null?'산정 불가':number(c.estimatedCost)+'원'}`:''}</p><ErpStockStates owned={c.recorded===false?null:c.quantity} held={c.customerHeld||0} borrowed={c.borrowedOutstanding||0} pending={c.pendingCost?{quantity:c.pendingQuantity??null,unit:c.pendingUnit||c.unit}:null} unit={c.unit}/></div>)}</details>
    </article>)}</div>
    <p className="wf-muted">예상 원가는 선택 창고의 이동평균원가로 구성품마다 원 단위 반올림한 합계입니다. 실제 출고 확정 시 최신 수량·원가를 다시 검증합니다.</p>
  </section>;
}
