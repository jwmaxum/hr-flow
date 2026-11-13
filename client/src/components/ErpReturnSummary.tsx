import type {ReturnSettlement} from '../services/erpLedgerService';
import {erpMoney as money} from '../services/erpAccountService';
export function ErpReturnSummary({value,pending=false}:{value:ReturnSettlement;pending?:boolean}){
  return <section className="erp-notice" aria-label="반품 정산 결과"><h3>{pending?'반품 정산 미리보기':'반품 정산 결과'}</h3>
    <p>{value.documentNo} · {value.partnerName} · {value.date}</p>
    <dl className="erp-stock-totals">{([['이번 반품금액',value.returnAmount],['미수금 차감액',value.receivableReduction],['남은 문서 미수금',value.receivableAfter],['거래처 반환 예정액',value.partnerReturnDue]] as const).map(([label,amount])=><div key={label}><dt>{label}</dt><dd>{money(amount,value.currency)}<small>{value.currency}</small></dd></div>)}</dl>
    <p>이 문서의 반환 대상 잔액 {money(value.documentReturnDue,value.currency)} {value.currency} · 거래처 전체 미수금 {money(value.partnerReceivableAfter,value.currency)} {value.currency}</p>
    <p className="wf-muted">거래처 반환 예정액은 같은 거래처·통화의 다른 출고와 기등록 수금·반품·실제 반환을 포함한 금액입니다. 실제 지급 완료를 뜻하지 않습니다. 거래명세표 정정은 바로 진행할 수 있습니다.</p>
    {value.allocationReleased>0&&<p className="wf-muted">초과 수금 배분 {money(value.allocationReleased,value.currency)} {value.currency}을 함께 정리{pending?'합니다.':'했습니다.'} 다른 문서의 정상 배분과 원수금은 유지합니다.</p>}
  </section>;
}
