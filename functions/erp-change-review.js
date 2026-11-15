const {FieldPath}=require('firebase-admin/firestore');
const {fail}=require('./security-context');
const M=require('./erp-ledger-model');
const {digest}=require('./erp-governance');
const CATEGORIES={STOCK:'재고 변동',TRADE:'거래 수정·정산',DELETE:'취소·삭제·사용중지',DOCUMENT:'거래서류 변경',CLOSE:'월마감·승인',MASTER:'기준정보·권한'};
const MAX_RECORDS=1000,MAX_BYTES=20*1024*1024,PAGE_SIZE=30;
const atPath=(o,path)=>path.split('.').reduce((v,k)=>v?.[k],o);
const scalar=v=>v==null?'—':typeof v==='boolean'?(v?'사용':'중지'):typeof v==='number'?v.toLocaleString('ko-KR',{maximumFractionDigits:4}):String(v).slice(0,240);
const states={DRAFT:'초안',ISSUED:'발행',CANCELLED:'취소',COMMITTED:'확정',PENDING:'대기',CLOSED:'마감',REOPENED:'재개방',APPROVED:'승인',REJECTED:'반려'};
const fields=[['name','명칭'],['code','코드'],['active','사용 여부'],['date','거래일'],['direction','구분'],['quantity','수량'],['value','재고금액(원)'],['price','거래단가'],['purchasePrice','매입단가(원)'],['salePrice','판매단가(원)'],['supply','공급가액'],['tax','부가세'],['total','거래금액'],['returnedQuantity','누적 반품수량'],['status','상태'],['cancelledBy','취소 연결'],['number','문서번호'],['input.issueDate','발행일'],['input.sourceDocumentNo','원출고 문서'],['access','ERP 권한'],['month','대상 월'],['version','보관 버전'],['dueDate','마감 예정일']];
function differences(change){
  const values=[];
  for(const [key,label] of fields){
    const before=atPath(change.before,key),after=atPath(change.after,key);
    if((before==null&&after==null)||digest(before??null)===digest(after??null))continue;
    const show=v=>key==='status'?(states[v]||scalar(v)):key==='cancelledBy'?(v?'취소됨':'없음'):scalar(v);
    values.push({label,before:show(before),after:show(after)});
  }
  // Monetary minor units are converted per currency; never add different currencies.
  for(const [key,label] of [['amountMinor','수금·반환액']]){
    const before=atPath(change.before,key),after=atPath(change.after,key);
    if(before==null&&after==null||before===after)continue;
    const show=(v,r)=>{const currency=r?.currency||r?.input?.currency||'KRW';return v==null?'—':`${scalar(v/(currency==='USD'?100:1))} ${currency}`;};
    values.push({label,before:show(before,change.before),after:show(after,change.after)});
  }
  if(change.path.startsWith('erpIssuedDocuments/')){
    const before=change.before?.snapshot||change.before?.preview,after=change.after?.snapshot||change.after?.preview;
    const money=(v,doc,snapshot)=>v==null?'—':`${scalar(v/((doc?.input?.currency||snapshot?.currency)==='USD'?100:1))} ${doc?.input?.currency||snapshot?.currency||'KRW'}`;
    for(const [key,label] of [['supplyMinor','문서 공급가액'],['taxMinor','문서 부가세'],['totalMinor','문서 합계']]){
      if(before?.totals?.[key]===after?.totals?.[key])continue;
      values.push({label,before:money(before?.totals?.[key],change.before,before),after:money(after?.totals?.[key],change.after,after)});
    }
    const left=before?.rows||[],right=after?.rows||[];let changedRows=0;
    for(let i=0;i<Math.max(left.length,right.length);i++){
      const pairs=[];
      for(const [key,label] of [['code','품목코드'],['description','품목명'],['quantityScaled','수량'],['priceScaled','단가'],['supplyMinor','공급가액'],['taxMinor','부가세']]){
        if(left[i]?.[key]===right[i]?.[key])continue;
        const show=(row,doc,snapshot)=>row?.[key]==null?'—':key.endsWith('Minor')?money(row[key],doc,snapshot):scalar(key.endsWith('Scaled')?row[key]/10000:row[key]);
        const title=key==='priceScaled'&&(left[i]?.amountMode==='TOTAL'||right[i]?.amountMode==='TOTAL')?'환산단가':label;
        pairs.push({label:`${i+1}행 ${title}`,before:show(left[i],change.before,before),after:show(right[i],change.after,after)});
      }
      if(pairs.length&&++changedRows<=20)values.push(...pairs);
    }
    if(changedRows>20)values.push({label:'변경 행 수 (앞 20행 표시)',before:'—',after:scalar(changedRows)});
  }
  return values;
}
function projectReview(records){
  const named=records.flatMap(r=>(r.changes||[]).flatMap(c=>[c.before,c.after].filter(Boolean)));
  const itemNames=new Map(named.filter(r=>r.itemId&&r.name).map(r=>[r.itemId,r.name]));
  const warehouseNames=new Map(named.filter(r=>r.warehouseId&&r.warehouseName).map(r=>[r.warehouseId,r.warehouseName]));
  const groups=new Map();
  for(const record of records){
    const key=record.operationId||record.id;
    let event=groups.get(key);
    if(!event){event={id:key,at:record.at,actorId:record.actorId||'',actorName:record.actorName||record.actorId||'담당자',actorErpAccess:record.actorErpAccess||'',authorization:record.authorization||'',approvedBy:record.approvedBy||null,reason:record.reason||'',domain:record.domain,action:record.action,categories:new Set(),documents:new Set(),changes:[],changeCount:0,historyIds:[],parts:new Set(),expectedParts:record.parts||1};groups.set(key,event);}
    event.historyIds.push(record.id);event.parts.add(record.part||1);event.expectedParts=Math.max(event.expectedParts,record.parts||1);
    if(record.domain==='control')event.categories.add(/^ERP_ACCESS/.test(record.action)?'MASTER':'CLOSE');
    for(const change of record.changes||[]){
      const collection=change.path.split('/')[0],before=change.before,after=change.after,row=after||before||{};
      if(collection==='erpInventory')event.categories.add('STOCK');
      if(['erpMovements','erpDocuments','erpReceipts','erpSettlements','erpCustodyJobs','erpCustodyLots'].includes(collection))event.categories.add('TRADE');
      if(collection==='erpIssuedDocuments')event.categories.add('DOCUMENT');
      if(['erpItems','erpWarehouses','erpPartners','erpPrintSettings'].includes(collection))event.categories.add('MASTER');
      if(before&&(!after||before.active!==false&&after.active===false||before.status!=='CANCELLED'&&after.status==='CANCELLED'||!before.cancelledBy&&after.cancelledBy))event.categories.add('DELETE');
      for(const source of [before,after])for(const value of [source?.documentNo,source?.number,source?.input?.sourceDocumentNo])if(typeof value==='string'&&value)event.documents.add(value.slice(0,120));
      const values=differences(change);
      if(!values.length)continue;
      event.changeCount++;
      if(event.changes.length<40)event.changes.push({label:row.name||itemNames.get(row.itemId)||row.code||row.documentNo||row.number||row.input?.sourceDocumentNo||({erpInventory:'창고 재고',erpIssuedDocuments:'거래서류',erpReceipts:'수금·반환',erpSettlements:'수금 배분·기일'}[collection])||'관리 변경',warehouseName:row.warehouseName||warehouseNames.get(row.warehouseId)||'',currency:row.currency||row.input?.currency||'',values});
    }
  }
  return [...groups.values()].map(({parts,...e})=>({...e,categories:[...e.categories],documents:[...e.documents].slice(0,12),incomplete:parts.size!==e.expectedParts})).sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id));
}
function createChangeReview({db,context}){
  return async(request,v,parent)=>{
    const from=M.date(v.from),to=M.date(v.to),category=v.category||'ALL';
    if(from>to||(Date.parse(to)-Date.parse(from))/86400000>92)fail('invalid-argument','조회 기간은 93일 이내로 선택해 주세요.');
    if(category!=='ALL'&&!Object.hasOwn(CATEGORIES,category))fail('invalid-argument','변경 유형을 선택해 주세요.');
    const start=new Date(from+'T00:00:00+09:00').toISOString(),end=new Date(Date.parse(to+'T00:00:00+09:00')+86400000).toISOString();
    return db.runTransaction(async tx=>{
      await context(request,tx);
      let cursor=null,bytes=0;const records=[];
      while(true){
        let q=parent.collection('erpChangeHistory').where('at','>=',start).where('at','<',end).orderBy('at','desc').orderBy(FieldPath.documentId(),'desc');
        if(cursor)q=q.startAfter(cursor);
        const batch=await tx.get(q.limit(25));
        for(const doc of batch.docs){const row=doc.data();if(row.companyId!==parent.id)fail('permission-denied','변경 이력의 회사를 확인해 주세요.');bytes+=Buffer.byteLength(JSON.stringify(row));records.push({id:doc.id,...row});}
        if(records.length>MAX_RECORDS||bytes>MAX_BYTES)fail('resource-exhausted','변경 이력이 많습니다. 조회 기간을 좁혀 주세요. 일부 합계만 표시하지 않습니다.');
        if(batch.size<25)break;cursor=batch.docs.at(-1);
      }
      const events=projectReview(records);
      if(events.some(e=>e.incomplete))fail('failed-precondition','분할된 변경 이력을 모두 확인하지 못했습니다. 조회 기간을 넓히거나 전체 변경 이력을 확인해 주세요.');
      const snapshot=digest(records.map(r=>[r.id,r.operationId,r.at])),selected=events.filter(e=>category==='ALL'||e.categories.includes(category));
      let offset=0;
      if(v.cursor){M.exactObject(v.cursor,['offset','snapshot']);if(!Number.isSafeInteger(v.cursor.offset)||v.cursor.offset<0||v.cursor.offset>selected.length)fail('invalid-argument','조회 위치를 확인해 주세요.');if(v.cursor.snapshot!==snapshot)fail('aborted','변경 이력이 추가되었습니다. 처음부터 다시 조회해 주세요.');offset=v.cursor.offset;}
      const categories=Object.entries(CATEGORIES).map(([key,label])=>({key,label,count:events.filter(e=>e.categories.includes(key)).length}));
      return {companyId:parent.id,from,to,category,total:events.length,filteredTotal:selected.length,categories,rows:selected.slice(offset,offset+PAGE_SIZE),offset,nextCursor:offset+PAGE_SIZE<selected.length?{offset:offset+PAGE_SIZE,snapshot}:null,snapshot};
    });
  };
}
module.exports={createChangeReview,projectReview,CATEGORIES};
