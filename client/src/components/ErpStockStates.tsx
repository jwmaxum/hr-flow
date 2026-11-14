import {stockLabels} from '../utils/erpStock';
const number=(value:number|null)=>value===null?'수량 미입력':value.toLocaleString('ko-KR',{maximumFractionDigits:4});
export function ErpStockStates({owned,held,borrowed,pending,unit}:{owned:number|null;held:number;borrowed:number;pending?:{quantity:number|null;unit:string}|null;unit:string}){
  return <dl className="erp-stock-totals erp-stock-states" aria-label="소유·보관·차용·원가 상태">
    <div><dt>{stockLabels.owned}</dt><dd>{owned===null?'미등록':number(owned)}{owned!==null&&<small>{unit}</small>}</dd><p>확정된 회사 소유 수량</p></div>
    <div><dt>{stockLabels.held}</dt><dd>{number(held)}<small>{unit}</small></dd><p>고객에게 판매 후 실제 보관 중</p></div>
    <div><dt>{stockLabels.borrowed}</dt><dd>{number(borrowed)}<small>{unit}</small></dd><p>보관품을 빌려 출고한 미반환 수량</p></div>
    <div><dt>{stockLabels.pending}</dt><dd>{pending?number(pending.quantity):'없음'}{pending&&pending.quantity!==null&&<small>{pending.unit}</small>}</dd><p>{pending?'창고 미지정 · 출고·자산 제외':'확인 대기 수량 없음'}</p>{pending&&<small>이관 대기 수량 (원본 기준)</small>}</div>
  </dl>;
}
