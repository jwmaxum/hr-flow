const {createHash}=require('node:crypto');
const {fail}=require('./security-context');
const {erpMaster:master}=require('./erp-service');
const M=require('./erp-ledger-model');
const {digits}=require('./erp-finance-model');
const {settlementReport,financeSnapshot}=require('./erp-settlement-model');

const MAX_BYTES=5*1024*1024,MAX_PDF_ROWS=2000;
const amount=(value,currency)=>value/10**digits(currency);
const types={SALE:'출고',PURCHASE:'입고',SALES_RETURN:'판매반품',PURCHASE_RETURN:'매입반품',CANCEL:'취소',RECEIPT:'수금',REFUND:'환불'};
const statuses={CREDIT:'외상출고',PAID:'입금완료',PARTIAL:'부분입금',UNCONFIRMED:'입금 미확인',REFUND_DUE:'초과수금',NO_BALANCE:'청구잔액 없음'};
const c=(label,width=1,numeric=false)=>({label,width,numeric});
const section=(name,columns,rows,note='')=>({name,columns,rows,note});
const round=value=>Math.round(value*10000)/10000;

function dashboardReport(d,generatedAt){
  const trade=(name,rows)=>section(name,[c('거래일',1.1),c('문서번호',2),c('거래회사',1.8),c('유형',1),c('통화',.7),c('공급가액',1.2,true),c('부가세',1.1,true),c('합계',1.2,true),c('원화 공급가액',1.4,true)],
    rows.map(r=>[r.date,r.documentNo,r.partnerName,types[r.kind]||r.kind,r.currency,amount(r.supply,r.currency),amount(r.tax,r.currency),amount(r.gross,r.currency),r.amountKRW]),'당월 취소·반품 포함. 원화 공급가액은 거래 당시 환율 기준입니다.');
  return {
    kind:'DASHBOARD',companyId:d.companyId,companyName:d.companyName,month:d.month,from:d.from,asOf:d.asOf,partnerId:'',partnerName:'',generatedAt,sourceSnapshot:d.snapshot,
    title:'월별 ERP 경영 보고서',name:`ERP_월별보고서_${d.month}`,
    notes:[`조회기간 ${d.from} ~ ${d.asOf}${d.partialMonth?' (당월 진행 중)':' (월말 기준)'}`,`기초재고 마감일 ${d.basisDate||'미설정'}. 원가 미확정 ${d.pendingCount}개 품목은 재고자산에서 제외합니다.`,
      '매출·매입은 부가세 제외 순액, 외상잔액은 부가세 포함입니다. 서로 다른 통화는 합산하지 않습니다.',
      '은행에서 자체 확인해 등록한 수금 원장을 사용합니다. 화면의 100건 표시 제한과 달리 출력에는 조회 대상 전체 내역을 포함합니다.'],
    sections:[
      section('월별 요약',[c('항목',2),c('금액 또는 건수',1,true),c('기준',3)],[
        ['재고자산',d.inventoryValue,`${d.asOf} 기준 장부금액 (KRW)`],['당월 순매출',d.salesKRW,'부가세 제외 (KRW)'],['당월 순매입',d.purchasesKRW,'부가세 제외, 원매입 환불액 반영 (KRW)'],['매출총이익',d.marginKRW,'순매출 - 출고원가 (KRW)'],['원가 미확정 대기',d.pendingCount,'품목 수'],['재고자산 상세',d.assetCount,'품목·창고 수'],['매출 상세',d.saleCount,'원장 행 수'],['매입 상세',d.purchaseCount,'원장 행 수'],
        ...d.currencies.map(r=>[`외상잔액 (${r.currency})`,amount(r.outstanding,r.currency),'거래처별 양수 미수잔액 합계'])]),
      section('최근 6개월',[c('월'),c('재고자산 (KRW)',1.5,true),c('순매출 (KRW)',1.5,true),c('순매입 (KRW)',1.5,true),c('외상잔액 (KRW)',1.5,true)],d.trend.map(r=>[r.month,r.inventoryValue,r.salesKRW,r.purchasesKRW,r.outstandingKRW]),'외화 미수금은 원화 추이 합계에 포함하지 않습니다.'),
      section('통화별 매출 매입',[c('통화'),c('순매출 공급가',1.5,true),c('순매출 세금포함',1.5,true),c('순매입 공급가',1.5,true),c('순매입 세금포함',1.5,true),c('당월 외상출고액',1.5,true),c('기존 출고 미확인액',1.5,true)],d.currencies.map(r=>[r.currency,...['sales','salesGross','purchases','purchasesGross','creditSalesGross','unconfirmedSalesGross'].map(k=>amount(r[k],r.currency))])),
      section('통화별 수금 미수',[c('통화'),c('당월 순수금',1.5,true),c('문서 양수잔액 합계',1.5,true),c('미배분 순수금',1.5,true),c('거래처 외상잔액',1.5,true),c('환불예정 잔액',1.5,true)],d.currencies.map(r=>[r.currency,...['receipts','documentOutstanding','unallocated','outstanding','refundDue'].map(k=>amount(r[k],r.currency))]),'미배분 수금·다른 문서의 초과수금 때문에 문서 잔액 합계와 거래처 순미수금은 다를 수 있습니다.'),
      section('거래처별 미수',[c('대상회사',2.5),c('통화'),c('문서 순잔액',1.5,true),c('미배분 순수금',1.5,true),c('거래처 순미수',1.5,true),c('문서 연체금액',1.5,true)],d.partners.map(r=>[r.partnerName,r.currency,...['documentBalance','unallocated','balance','overdueAmount'].map(k=>amount(r[k],r.currency))])),
      section('재고자산 내역',[c('품목코드',1.2),c('품목명',2.2),c('창고',1.3),c('단위',.6),c('기말수량',1,true),c('재고금액 (KRW)',1.5,true),c('평균단가 (KRW)',1.5,true)],d.assets.map(r=>[r.code,r.name,r.warehouseName,r.unit,r.closingQuantity,r.closingValue,r.closingQuantity?round(r.closingValue/r.closingQuantity):null]),'단위가 다른 수량은 합산하지 않습니다. 고객 소유 보관품·원가 미확정 대기는 제외합니다.'),
      trade('매출내역',d.sales),trade('매입내역',d.purchases),
    ],
  };
}

function statementReport(data,company,partner,to,generatedAt,companyId,partnerId){
  const report=settlementReport(data,to,partnerId),summary=report.summaries;
  const payments=data.events.filter(r=>!r.documentId&&r.partnerId===partnerId&&r.date<=to).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  return {
    kind:'STATEMENT',companyId,companyName:M.text(company.nameKo||company.name||companyId,'회사명',240),month:'',from:'',asOf:to,partnerId,partnerName:M.text(partner.name,'거래처명',120,true),generatedAt,sourceSnapshot:financeSnapshot(data,companyId,to),
    title:'거래처별 미수명세서',name:`ERP_미수명세서_${to}_${M.hash(partnerId).slice(0,8)}`,
    notes:[`조회 기준일 ${to}까지의 누적 매출·수금·배분 원장 기준입니다.`,
      `거래처 등록번호: ${M.text(partner.registrationNumber||'미등록','등록번호',80)}`,
      '문서 순잔액 - 미배분 순수금 = 거래처 순미수금. 음수 순미수금은 초과수금·환불예정 잔액입니다.',
      '완납·반품·취소 문서도 포함합니다. 연체금액은 문서별 양수 잔액 기준이며 미배분 수금은 자동 상계하지 않습니다.',
      '수금은 회사에서 자체 확인하여 등록한 내역입니다. 통화별 금액을 구분하여 확인해 주세요.'],
    sections:[
      section('통화별 미수 총괄',[c('통화',.7),c('순청구 총액',1.3,true),c('순수금 총액',1.3,true),c('문서 순잔액',1.3,true),c('미배분 순수금',1.3,true),c('거래처 순미수',1.3,true),c('문서 연체금액',1.3,true)],summary.map(r=>[r.currency,amount(M.signed(r.documentBalance+r.allocated),r.currency),...['netReceipts','documentBalance','unallocated','balance','overdueAmount'].map(k=>amount(r[k],r.currency))])),
      section('출고 문서별 잔액',[c('출고일',1),c('문서번호',2.4),c('통화',.6),c('순청구액',1.1,true),c('배분 수금액',1.1,true),c('문서 잔액',1.1,true),c('지급기일',1),c('연체일수',.7,true),c('입금상태',1)],report.documents.map(d=>[d.date,d.documentNo,d.currency,...['billed','allocated','balance'].map(k=>amount(d[k],d.currency)),d.dueDate||'미설정',d.overdueDays,statuses[d.paymentStatus]||d.paymentStatus]),'기준일까지의 모든 출고 문서입니다. 과거 출고의 입금 미확인 상태는 임의로 완납 처리하지 않습니다.'),
      section('수금 환불 내역',[c('처리일'),c('유형'),c('통화'),c('순수금 증감',1.5,true)],payments.map(r=>[r.date,types[r.kind]||r.kind,r.currency,amount(r.receipt,r.currency)]),'수금은 양수, 환불·수금취소는 음수입니다. 환불취소는 양수로 복원됩니다. 내부 회수 메모·계좌 참조 정보는 출력하지 않습니다.'),
    ],
  };
}

function finalize(report){
  // Hash public report content, excluding download time. No ledger or issue-counter writes.
  const {generatedAt,...content}=report;
  const output={...report,snapshot:M.hash(content)};
  if(Buffer.byteLength(JSON.stringify(output))>MAX_BYTES)fail('resource-exhausted','보고서가 출력 한도를 초과했습니다. 일부 내역만 출력하지 않습니다. 기간별 원장을 이용해 주세요.');
  return output;
}
function createFinanceExportHandler({db,now,context,load,dashboard,renderPdf}){
  return async(request,input,parent)=>{
    const monthly=input.action==='dashboardExport';
    M.exactObject(input,['action','companyId','snapshot','format',...(monthly?['month']:['to','partnerId'])]);
    if(!['DATA','PDF'].includes(input.format)||typeof input.snapshot!=='string'||! /^[a-f0-9]{64}$/.test(input.snapshot))fail('invalid-argument','조회 후 Excel 또는 PDF 출력을 선택해 주세요.');
    let report;
    if(monthly){
      const d=await dashboard(request,{action:'dashboard',companyId:parent.id,month:input.month},parent,{full:true});
      if(input.snapshot!==d.snapshot)fail('failed-precondition','원장 또는 조회 기준일이 변경되었습니다. 월별 대시보드를 다시 조회해 주세요.');
      report=dashboardReport(d,now().toISOString());
    }else{
      const to=M.date(input.to),partnerId=master.identifier(input.partnerId);
      report=await db.runTransaction(async tx=>{
        await context(request,tx);const data=await load(tx,parent);
        if(input.snapshot!==financeSnapshot(data,parent.id,to))fail('failed-precondition','매출·수금·배분이 변경되었습니다. 외상매출을 다시 조회해 주세요.');
        const [company,partner]=await Promise.all([tx.get(parent),tx.get(parent.collection('erpPartners').doc(partnerId))]);
        if(!partner.exists)fail('not-found','현재 회사의 거래처를 선택해 주세요.');master.verifyTenant(partner.data(),parent.id);
        return statementReport(data,company.data()||{},partner.data(),to,now().toISOString(),parent.id,partnerId);
      });
    }
    const output=finalize(report);
    if(input.format==='DATA'){await context(request);return output;}
    if(output.sections.reduce((sum,s)=>sum+s.rows.length,0)>MAX_PDF_ROWS)fail('resource-exhausted','PDF는 상세 2,000행까지 출력합니다. 전체 내역은 Excel로 내려받아 주세요.');
    const pdf=await renderPdf(output);
    if(!Buffer.isBuffer(pdf)||pdf.length>MAX_BYTES||pdf.subarray(0,5).toString()!=='%PDF-')fail('resource-exhausted','PDF 출력 한도를 초과했습니다. Excel 보고서를 이용해 주세요.');
    await context(request);
    return {companyId:parent.id,kind:output.kind,month:output.month,asOf:output.asOf,partnerId:output.partnerId,sourceSnapshot:output.sourceSnapshot,snapshot:output.snapshot,name:output.name+'.pdf',mimeType:'application/pdf',size:pdf.length,sha256:createHash('sha256').update(pdf).digest('hex'),base64:pdf.toString('base64')};
  };
}
module.exports={createFinanceExportHandler,dashboardReport,statementReport,finalize,MAX_PDF_ROWS,MAX_BYTES};
