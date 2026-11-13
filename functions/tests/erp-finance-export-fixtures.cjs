const {dashboardReport,statementReport,finalize}=require('../erp-finance-export');
function monthly(count=4,long=false){
  const name=long?'한글 품목명 긴 설명과 규격을 포함한 다중 페이지 출력 검증 '.repeat(4):'=HYPERLINK("https://example.invalid")';
  const currencies=[{currency:'KRW',sales:1650,salesGross:1815,purchases:2000,purchasesGross:2200,creditSalesGross:1815,unconfirmedSalesGross:0,receipts:500,outstanding:1315,refundDue:0,documentOutstanding:1315,unallocated:0},{currency:'USD',sales:12345,salesGross:12345,purchases:5000,purchasesGross:5000,creditSalesGross:12345,unconfirmedSalesGross:0,receipts:1000,outstanding:11345,refundDue:0,documentOutstanding:11345,unallocated:0}];
  return finalize(dashboardReport({companyId:'synthetic-a',companyName:'에이 회사 출력 검증',month:'2026-11',from:'2026-11-01',asOf:'2026-11-13',partialMonth:true,basisDate:'2026-10-31',inventoryValue:2250,salesKRW:1650,purchasesKRW:2000,marginKRW:900,pendingCount:28,currencies,trend:[{month:'2026-10',inventoryValue:1000,salesKRW:0,purchasesKRW:0,outstandingKRW:0},{month:'2026-11',inventoryValue:2250,salesKRW:1650,purchasesKRW:2000,outstandingKRW:1315}],
    assets:Array.from({length:count},(_,i)=>({code:'000'+i,name,warehouseName:'본사 A&B 창고',unit:'개',closingQuantity:15,closingValue:2250})),assetCount:count,sales:[{id:'sale',date:'2026-11-12',documentNo:'MAN-합성-매출',partnerName:'거래처 A',kind:'SALE',currency:'KRW',supply:1650,tax:165,gross:1815,amountKRW:1650}],saleCount:1,purchases:[{date:'2026-11-12',documentNo:'IN-01',partnerName:'공급회사',kind:'PURCHASE_RETURN',currency:'USD',supply:-12345,tax:0,gross:-12345,amountKRW:-170000}],purchaseCount:1,partners:[{partnerName:'거래처 A',currency:'KRW',documentBalance:1315,unallocated:0,balance:1315,overdueAmount:1315}],partnerCount:1,snapshot:'a'.repeat(64)},'2026-11-13T00:00:00Z'));
}
function statement(count=4,long=false){
  const events=Array.from({length:count},(_,i)=>({id:'event-'+i,documentId:'doc-'+i,documentNo:'OUT-'+String(i).padStart(4,'0')+(long?'긴-한글-출고문서번호-설명-'.repeat(4):''),partnerId:'buyer',partnerName:'거래처 B',currency:'USD',saleDate:'2026-11-01',date:'2026-11-01',gross:12345,supply:12345,tax:0,receipt:0,paymentTerms:'CREDIT'}));
  const data={events,paid:[],settlements:events.map((e,i)=>({id:'term-'+i,sequence:i,type:'TERMS',partnerId:'buyer',documentId:e.documentId,dueDate:'2026-11-10',date:'2026-11-01'}))};
  return finalize(statementReport(data,{nameKo:'에이 회사 출력 검증'},{name:'거래처 B',registrationNumber:'000-00-00000'},'2026-11-13','2026-11-13T00:00:00Z','synthetic-a','buyer'));
}
module.exports={monthly,statement};
