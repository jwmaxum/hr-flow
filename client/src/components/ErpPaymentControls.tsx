import type {PaymentOptions,PaymentSummary} from '../services/erpAccountService';
import {erpMoney as money} from '../services/erpAccountService';
export function ErpPaymentOptions({value,onChange}:{value:PaymentOptions;onChange:(patch:Partial<PaymentOptions>)=>void}){
  return <><label className="wf-field"><span>입금 기록 방식</span><select className="wf-input" value={value.receiptMode} onChange={e=>onChange({receiptMode:e.target.value as PaymentOptions['receiptMode'],confirmNew:false})}><option value="REUSE_FIRST">기등록 수금 우선 배분 · 부족액만 새 수금</option><option value="NEW">기존 수금과 별개인 새 입금</option></select></label>
    <label className="wf-field"><span>입금 확인 메모 *</span><input className="wf-input" required maxLength={500} value={value.notes} onChange={e=>onChange({notes:e.target.value})} placeholder="입금 확인 내용·확인자 메모" /></label>
    {value.receiptMode==='NEW'&&<label className="erp-active-field erp-form-wide"><input type="checkbox" required checked={value.confirmNew} onChange={e=>onChange({confirmNew:e.target.checked})} />기등록 수금과 별개인 새 입금입니다.</label>}
    <p className="wf-muted erp-form-wide">자체 확인한 입금만 기록하세요. 기등록 수금은 같은 거래처·통화의 미배분액에서 오래된 순서로 사용합니다. 미리보기에서 재사용 금액과 새 수금액을 확인하세요.</p></>;
}
export function ErpPaymentSummary({value}:{value:PaymentSummary}){
  return <div className="erp-notice" aria-label="입금완료 금액 확인"><strong>{value.documentNo} · {value.partnerName}</strong><p>문서 미수잔액: {money(value.before,value.currency)} → {money(value.after,value.currency)} {value.currency}</p><p>기등록 수금 반영 {money(value.reused,value.currency)} · 새 입금 기록 {money(value.newReceipt,value.currency)} {value.currency}</p><p>입금완료 반영일: {value.date}</p>{value.reused>0&&<details><summary>배분할 수금 내역</summary>{value.allocations.map((r,i)=><p key={i}>{r.receiptReference} · {money(r.amount,value.currency)} {value.currency}</p>)}</details>}</div>;
}
