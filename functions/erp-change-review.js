const {FieldPath}=require('firebase-admin/firestore');
const {fail}=require('./security-context');
const M=require('./erp-ledger-model');
const {digest}=require('./erp-governance');
const CATEGORIES={STOCK:'재고 변동',TRADE:'거래 수정·정산',DELETE:'취소·삭제·사용중지',DOCUMENT:'거래서류 변경',CLOSE:'월마감·승인',MASTER:'기준정보·권한'};
const MAX_RECORDS=1000,MAX_BYTES=20*1024*1024,PAGE_SIZE=30;
const atPath=(o,path)=>path.split('.').reduce((v,k)=>v?.[k],o);
const scalar=v=>v==null?'—':typeof v==='boolean'?(v?'사용':'중지'):typeof v==='number'?v.toLocaleString('ko-KR',{maximumFractionDigits:4}):String(v).slice(0,240);
const states={DRAFT:'초안',ISSUED:'발행',CANCELLED:'취소',COMMITTED:'확정',PENDING:'대기',CLOSED:'마감',REOPENED:'재개방',APPROVED:'승인',REJECTED:'반려'};
const fields=[['name','명칭'],['code','코드'],['active','사용 여부'],['date','거래일'],['direction','구분'],['quantity','수량'],['value','재고금액(원)'],['price','거래단가'],['purchasePrice','매입단가(원)'],['salePrice','판매단가(원)'],['supply','공급가액'],['tax','부가세'],['total','거래금액'],['returnedQuantity','누적 반품수량'],['status','상태'],['cancelledBy','취소 연결'],['number','문서번호'],['input.issueDate','발행일'],['input.sourceDocumentNo','원출고 문서'],['access','ERP 권한'],['month','대상 월'],['version','보관 버전'],['dueDate','마감 예정일'],['agedDays','장기 미확인 기준(일)'],['urgentDays','우선 확인 기준(일)'],['configured','회사별 기준 사용']];
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
  const groups=new Map(),sources=new Map();
  for(const record of records){
    const key=record.operationId||record.id;
    if(!sources.has(key))sources.set(key,[]);sources.get(key).push(record);
    let event=groups.get(key);
    if(!event){event={id:key,at:record.at,actorId:record.actorId||'',actorName:record.actorName||record.actorId||'담당자',actorErpAccess:record.actorErpAccess||'',authorization:record.authorization||'',approvedBy:record.approvedBy||null,reason:record.reason||'',domain:record.domain,action:record.action,categories:new Set(),documents:new Set(),changes:[],changeCount:0,historyIds:[],parts:new Set(),expectedParts:record.parts||1};groups.set(key,event);}
    event.historyIds.push(record.id);event.parts.add(record.part||1);event.expectedParts=Math.max(event.expectedParts,record.parts||1);
    if(record.domain==='control')event.categories.add(/^ERP_(ACCESS|REVIEW_POLICY)/.test(record.action)?'MASTER':'CLOSE');
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
  return [...groups.values()].map(({parts,...e})=>{
    const source=sources.get(e.id).sort((a,b)=>a.id.localeCompare(b.id));
    const priceChanged=source.some(r=>(r.changes||[]).some(c=>c.path.startsWith('erpItems/')&&c.before&&c.after&&['purchasePrice','salePrice'].some(k=>digest(c.before[k]??null)!==digest(c.after[k]??null))));
    return {...e,categories:[...e.categories],documents:[...e.documents].slice(0,12),fingerprint:digest(source),important:priceChanged||['STOCK','TRADE','DELETE','DOCUMENT'].some(c=>e.categories.has(c)),incomplete:parts.size!==e.expectedParts||source.length!==e.expectedParts||source.some(r=>(r.parts||1)!==e.expectedParts||!Number.isSafeInteger(r.part||1)||(r.part||1)<1||(r.part||1)>e.expectedParts)};
  }).sort((a,b)=>b.at.localeCompare(a.at)||b.id.localeCompare(a.id));
}
function createChangeReview({db,context,now=()=>new Date()}){
  const receiptRef=(parent,event)=>parent.collection('erpReviewConfirmations').doc(digest([event.id,event.fingerprint]));
  async function admin(request,tx){const user=await context(request,tx);if(user.role!=='ADMIN')fail('permission-denied','변경 확인 완료는 회사 ADMIN만 처리할 수 있습니다.');return user;}
  async function read(tx,v,parent){
    const from=M.date(v.from),to=M.date(v.to),category=v.category||'ALL',status=v.reviewStatus||'ALL';
    if(from>to||(Date.parse(to)-Date.parse(from))/86400000>92)fail('invalid-argument','조회 기간은 93일 이내로 선택해 주세요.');
    if(category!=='ALL'&&!Object.hasOwn(CATEGORIES,category))fail('invalid-argument','변경 유형을 선택해 주세요.');
    if(!['ALL','UNREVIEWED','REVIEWED'].includes(status))fail('invalid-argument','확인 상태를 선택해 주세요.');
    const start=new Date(from+'T00:00:00+09:00').toISOString(),end=new Date(Date.parse(to+'T00:00:00+09:00')+86400000).toISOString();
      let cursor=null,bytes=0;const records=[];
      while(true){
        let q=parent.collection('erpChangeHistory').where('at','>=',start).where('at','<',end).orderBy('at','desc').orderBy(FieldPath.documentId(),'desc');
        if(cursor)q=q.startAfter(cursor);
        const batch=await tx.get(q.limit(25));
        for(const doc of batch.docs){const row=doc.data();if(row.companyId!==parent.id)fail('permission-denied','변경 이력의 회사를 확인해 주세요.');bytes+=Buffer.byteLength(JSON.stringify(row));records.push({...row,id:doc.id});}
        if(records.length>MAX_RECORDS||bytes>MAX_BYTES)fail('resource-exhausted','변경 이력이 많습니다. 조회 기간을 좁혀 주세요. 일부 합계만 표시하지 않습니다.');
        if(batch.size<25)break;cursor=batch.docs.at(-1);
      }
      const events=projectReview(records);
      if(events.some(e=>e.incomplete))fail('failed-precondition','분할된 변경 이력을 모두 확인하지 못했습니다. 조회 기간을 넓히거나 전체 변경 이력을 확인해 주세요.');
      const important=events.filter(e=>e.important),receipts=important.length?await tx.getAll(...important.map(e=>receiptRef(parent,e))):[];
      for(let i=0;i<important.length;i++){
        const event=important[i],receipt=receipts[i].data();
        if(receipt&&(receipt.companyId!==parent.id||receipt.eventId!==event.id||receipt.fingerprint!==event.fingerprint))fail('permission-denied','확인 기록의 회사를 확인해 주세요.');
        event.confirmation=receipt?{by:receipt.acknowledgedBy,name:receipt.acknowledgedName,at:receipt.acknowledgedAt}:null;
      }
      for(const event of events)event.reviewStatus=event.important?(event.confirmation?'REVIEWED':'UNREVIEWED'):'NOT_REQUIRED';
      const snapshot=digest([from,to,category,status,events.map(e=>[e.id,e.fingerprint,e.confirmation||null])]),selected=events.filter(e=>(category==='ALL'||e.categories.includes(category))&&(status==='ALL'||e.reviewStatus===status));
      let offset=0;
      if(v.cursor){M.exactObject(v.cursor,['offset','snapshot']);if(v.cursor.snapshot!==snapshot)fail('aborted','변경 내역 또는 확인 상태가 바뀌었습니다. 처음부터 다시 조회해 주세요.');if(!Number.isSafeInteger(v.cursor.offset)||v.cursor.offset<0||v.cursor.offset>selected.length)fail('invalid-argument','조회 위치를 확인해 주세요.');offset=v.cursor.offset;}
      const categories=Object.entries(CATEGORIES).map(([key,label])=>({key,label,count:events.filter(e=>e.categories.includes(key)).length}));
      return {companyId:parent.id,from,to,category,reviewStatus:status,total:events.length,unreviewedCount:important.filter(e=>!e.confirmation).length,reviewedCount:important.filter(e=>e.confirmation).length,filteredTotal:selected.length,categories,rows:selected.slice(offset,offset+PAGE_SIZE),offset,nextCursor:offset+PAGE_SIZE<selected.length?{offset:offset+PAGE_SIZE,snapshot}:null,snapshot};
  }
  const review=(request,v,parent)=>db.runTransaction(async tx=>{await context(request,tx);return read(tx,v,parent);});
  review.monthly=async(tx,parent)=>{
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(now());
    return read(tx,{from:today.slice(0,7)+'-01',to:today,reviewStatus:'UNREVIEWED'},parent);
  };
  review.alerts=(request,parent)=>db.runTransaction(async tx=>{await admin(request,tx);const result=await review.monthly(tx,parent);return {companyId:parent.id,month:result.from.slice(0,7),pendingCount:result.unreviewedCount,checkedAt:now().toISOString()};});
  review.confirm=async(request,v,parent)=>{
    if(!Array.isArray(v.items)||!v.items.length||v.items.length>PAGE_SIZE)fail('invalid-argument','확인할 변경을 1~30건 선택해 주세요.');
    const ids=new Set();for(const item of v.items){M.exactObject(item,['id','fingerprint']);if(typeof item.id!=='string'||!item.id||item.id.length>256||item.id.includes('/')||!(/^[a-f0-9]{64}$/).test(item.fingerprint)||ids.has(item.id))fail('invalid-argument','확인할 변경 정보를 다시 조회해 주세요.');ids.add(item.id);}
    return db.runTransaction(async tx=>{
      const user=await admin(request,tx),events=[];let bytes=0,count=0;
      for(const item of v.items){
        const docs=await tx.get(parent.collection('erpChangeHistory').where('operationId','==',item.id).limit(MAX_RECORDS+1));
        let rows=docs.docs;
        if(!rows.length){const legacy=await tx.get(parent.collection('erpChangeHistory').doc(item.id));if(legacy.exists&&!legacy.data().operationId)rows=[legacy];}
        const records=rows.map(doc=>{const row=doc.data();if(row.companyId!==parent.id)fail('permission-denied','변경 이력의 회사를 확인해 주세요.');bytes+=Buffer.byteLength(JSON.stringify(row));count++;return {...row,id:doc.id};});
        if(count>MAX_RECORDS||bytes>MAX_BYTES)fail('resource-exhausted','한 번에 확인할 변경 수를 줄여 주세요.');
        const projected=projectReview(records),event=projected[0];
        if(projected.length!==1||event.id!==item.id||event.incomplete||event.fingerprint!==item.fingerprint||!event.important)fail('failed-precondition','변경 원본이 바뀌었거나 누락되었습니다. 다시 조회한 후 확인해 주세요.');
        events.push(event);
      }
      const inbox=require('./erp-review-inbox');
      const receipts=await tx.getAll(...events.map(e=>receiptRef(parent,e))),inboxState=(await tx.get(inbox.stateRef(parent))).data();let confirmed=0;
      if(inboxState&&inboxState.companyId!==parent.id)fail('permission-denied','누적 점검함의 회사를 확인해 주세요.');
      for(let i=0;i<events.length;i++){
        const event=events[i],existing=receipts[i].data();
        if(existing){if(existing.companyId!==parent.id||existing.eventId!==event.id||existing.fingerprint!==event.fingerprint)fail('permission-denied','확인 기록을 검증하지 못했습니다.');tx.set(inbox.entryRef(parent,event),inbox.summary(parent,event,{by:existing.acknowledgedBy,name:existing.acknowledgedName,at:existing.acknowledgedAt}));continue;}
        const at=now().toISOString();
        tx.create(receiptRef(parent,event),{companyId:parent.id,eventId:event.id,fingerprint:event.fingerprint,historyIds:event.historyIds,acknowledgedBy:user.uid,acknowledgedName:user.name||user.uid,acknowledgedAt:at});
        tx.set(inbox.entryRef(parent,event),inbox.summary(parent,event,{by:user.uid,name:user.name||user.uid,at}));
        tx.create(parent.collection('erpAudit').doc(),{companyId:parent.id,actorId:user.uid,actorName:user.name||user.uid,action:'CHANGE_REVIEW_CONFIRMED',eventId:event.id,fingerprint:event.fingerprint,at});confirmed++;
      }
      if(inboxState&&confirmed)tx.update(inbox.stateRef(parent),{revision:inboxState.revision+1});
      return {companyId:parent.id,confirmed,alreadyConfirmed:events.length-confirmed};
    });
  };
  return review;
}
module.exports={createChangeReview,projectReview,CATEGORIES};
