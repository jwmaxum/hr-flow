const {fail}=require('./security-context');
const {erpMaster:master}=require('./erp-service');
const M=require('./erp-ledger-model');
const {minor}=require('./erp-finance-model');
const {settlementReport}=require('./erp-settlement-model');

function createShipmentHandler({db,now,context,load}) {
  return async(request,input,parent)=>{
    const listing=input.action==='shipmentList';
    M.exactObject(input,['action','companyId',...(listing?['from','to','search','status','offset','snapshot']:['documentId'])]);
    const asOf=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(now());
    let filters,offset;
    if(listing){
      filters={from:M.date(input.from),to:M.date(input.to),search:M.text(input.search||'','검색어',80),status:input.status||'ALL'};
      offset=input.offset||0;
      if(filters.from>filters.to||!['ALL','OPEN','PAID','REFUND'].includes(filters.status)||!Number.isSafeInteger(offset)||offset<0||offset>20000)fail('invalid-argument','조회 조건을 확인해 주세요.');
    }else master.identifier(input.documentId);
    return db.runTransaction(async tx=>{
      await context(request,tx);
      const data=await load(tx,parent),report=settlementReport(data,asOf);
      if(listing){
        const snapshot=M.hash({data,filters,asOf});
        if(offset&&input.snapshot!==snapshot)fail('failed-precondition','출고·수금 내역이 변경되었습니다. 처음부터 다시 조회해 주세요.');
        const search=master.normalize(filters.search);
        const rows=report.documents.filter(d=>d.date>=filters.from&&d.date<=filters.to&&(!search||master.normalize(`${d.documentNo} ${d.partnerName}`).includes(search))&&
          (filters.status==='ALL'||filters.status==='OPEN'&&d.balance>0||filters.status==='PAID'&&d.balance===0||filters.status==='REFUND'&&d.balance<0));
        return {companyId:parent.id,asOf,snapshot,rows:rows.slice(offset,offset+30),total:rows.length,nextOffset:rows.length>offset+30?offset+30:null};
      }
      const doc=report.documents.find(d=>d.id===input.documentId);
      if(!doc)fail('not-found','현재 회사의 확정 출고 문서를 찾을 수 없습니다.');
      const registry=await tx.get(parent.collection('erpDocuments').doc(doc.id));
      if(!registry.exists)fail('failed-precondition','출고 문서 연결을 확인해 주세요.');master.verifyTenant(registry.data(),parent.id);
      if(registry.data().direction!=='출고'||registry.data().partnerId!==doc.partnerId||registry.data().currency!==doc.currency)fail('failed-precondition','출고 문서 연결을 확인해 주세요.');
      const originals=data.movements.filter(r=>r.type==='MOVEMENTS'&&r.direction==='출고'&&!r.bundleParentId&&r.documentNo===doc.documentNo);
      if(!originals.length||originals.length>200)fail('failed-precondition','출고 품목 수를 확인해 주세요.');
      const links=await tx.getAll(...originals.map(row=>parent.collection('erpMovementLinks').doc(row.id)));
      const rows=originals.map((row,index)=>{
        const link=links[index].data()||{};if(links[index].exists)master.verifyTenant(link,parent.id);
        if(row.partnerId!==doc.partnerId||row.currency!==doc.currency)fail('failed-precondition','출고 품목 연결을 확인해 주세요.');
        const returned=link.returnedQuantityScaled||0;
        if(!Number.isSafeInteger(returned)||returned<0||returned>row.quantityScaled)fail('failed-precondition','반품 연결을 확인해 주세요.');
        return {id:row.id,itemId:row.itemId,warehouseId:row.warehouseId,warehouseCode:row.warehouseCode||'',warehouseName:row.warehouseName,code:row.code,name:row.name,specification:row.specification,unit:row.unit,
          rowNo:row.rowNo,date:row.date,type:row.type,direction:row.direction,documentNo:row.documentNo,stockMode:row.stockMode||'DIRECT',currency:row.currency,
          quantity:row.quantityScaled/10000,returnedQuantity:returned/10000,returnableQuantity:link.cancelledBy?0:(row.quantityScaled-returned)/10000,cancelledBy:link.cancelledBy||null,
          price:row.priceScaled/10000,priceBasis:row.priceBasis,taxType:row.taxType,supplyMinor:minor(row.supply,row.currency),taxMinor:minor(row.tax,row.currency),grossMinor:minor(row.total,row.currency),cost:row.cost};
      }).sort((a,b)=>a.rowNo-b.rowNo);
      const events=data.events.filter(r=>r.documentId===doc.id&&r.date<=asOf);
      const sum=key=>M.signed(events.reduce((total,row)=>total+row[key],0));
      const group=report.summaries.find(r=>r.partnerId===doc.partnerId&&r.currency===doc.currency);
      return {companyId:parent.id,asOf,document:{...doc,supplyMinor:sum('supply'),taxMinor:sum('tax')},rows,events,
        allocations:report.allocations.filter(a=>a.lines.some(l=>l.documentId===doc.id)),unallocated:group?.unallocated||0,partnerBalance:group?.balance||0,
        suggestedDate:[asOf,data.ledger.lastDate,data.state.lastDate,data.settlementState.lastDate].filter(Boolean).sort().at(-1)};
    });
  };
}
module.exports={createShipmentHandler};
