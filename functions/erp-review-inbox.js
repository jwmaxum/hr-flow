const {FieldPath}=require('firebase-admin/firestore');
const {fail}=require('./security-context');
const {digest}=require('./erp-governance');
const M=require('./erp-ledger-model');
const PAGE_SIZE=30,VERSION=1;
const stateRef=parent=>parent.collection('erpReviewState').doc('inbox');
const entryRef=(parent,event)=>parent.collection('erpReviewInbox').doc(digest([event.id,event.fingerprint]));
const receiptRef=(parent,event)=>parent.collection('erpReviewConfirmations').doc(digest([event.id,event.fingerprint]));
const seoulDate=at=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date(at));
const ageDays=(at,today)=>Math.max(0,Math.floor((Date.parse(today)-Date.parse(seoulDate(at)))/86400000));
function summary(parent,event,confirmation=null){
  if(event.incomplete||!Number.isFinite(Date.parse(event.at)))fail('failed-precondition','중요 변경 원본을 모두 확인하지 못했습니다. 전체 변경 이력을 확인해 주세요.');
  return {companyId:parent.id,id:event.id,fingerprint:event.fingerprint,at:event.at,actorName:event.actorName,actorErpAccess:event.actorErpAccess,authorization:event.authorization,approvedBy:event.approvedBy,reason:event.reason,domain:event.domain,action:event.action,categories:event.categories,documents:event.documents,changeCount:event.changeCount,reviewStatus:confirmation?'REVIEWED':'UNREVIEWED',confirmation};
}
function verifyReceipt(parent,event,receipt){
  if(!receipt)return null;
  if(receipt.companyId!==parent.id||receipt.eventId!==event.id||receipt.fingerprint!==event.fingerprint)fail('permission-denied','확인 기록의 회사를 확인해 주세요.');
  return {by:receipt.acknowledgedBy,name:receipt.acknowledgedName,at:receipt.acknowledgedAt};
}
// Called by the governed writer in the SAME transaction as immutable history.
// There is no asynchronous trigger window in which new changes can disappear.
function recordInbox(tx,parent,records){
  for(const event of require('./erp-change-review').projectReview(records))if(event.important)tx.create(entryRef(parent,event),summary(parent,event));
}
async function loadEvent(tx,parent,id){
  if(typeof id!=='string'||!id||id.length>256||id.includes('/'))fail('invalid-argument','변경 번호를 확인해 주세요.');
  const docs=await tx.get(parent.collection('erpChangeHistory').where('operationId','==',id).limit(1001));
  let rows=docs.docs;
  if(!rows.length){const legacy=await tx.get(parent.collection('erpChangeHistory').doc(id));if(legacy.exists&&!legacy.data().operationId)rows=[legacy];}
  let bytes=0;
  const records=rows.map(doc=>{const row=doc.data();if(row.companyId!==parent.id)fail('permission-denied','변경 이력의 회사를 확인해 주세요.');bytes+=Buffer.byteLength(JSON.stringify(row));return {...row,id:doc.id};});
  if(records.length>1000||bytes>20*1024*1024)fail('resource-exhausted','변경 원본의 크기 제한을 초과했습니다. 전체 변경 이력을 확인해 주세요.');
  const events=require('./erp-change-review').projectReview(records),event=events[0];
  if(events.length!==1||event.id!==id||event.incomplete)fail('failed-precondition','분할된 변경 원본이 누락되었습니다. 전체 변경 이력을 확인해 주세요.');
  return {event,bytes};
}
function createReviewInbox({db,context,now}){
  async function state(tx,parent){
    const value=(await tx.get(stateRef(parent))).data()||{companyId:parent.id,version:VERSION,ready:false,lastHistoryId:'',processed:0,revision:0};
    if(value.companyId!==parent.id)fail('permission-denied','누적 점검함의 회사를 확인해 주세요.');
    if(value.version!==VERSION)fail('failed-precondition','누적 점검함 버전을 확인해 주세요.');
    return value;
  }
  // Resumable bootstrap, ordered by immutable document ID. New writes are
  // already indexed atomically, including IDs before this cursor. Read receipts
  // before writes so a concurrent confirmation cannot be resurrected as pending.
  async function prepare(request,parent){
    return db.runTransaction(async tx=>{
      await context(request,tx);const current=await state(tx,parent);if(current.ready)return current;
      let q=parent.collection('erpChangeHistory').orderBy(FieldPath.documentId());
      if(current.lastHistoryId)q=q.startAfter(current.lastHistoryId);
      const docs=await tx.get(q.select('companyId','operationId').limit(25)),events=new Map();let bytes=0,processed=0,last=current.lastHistoryId;
      for(const doc of docs.docs){
        const r=doc.data();if(r.companyId!==parent.id)fail('permission-denied','변경 이력의 회사를 확인해 주세요.');
        const id=r.operationId||doc.id;
        if(!events.has(id)){
          const loaded=await loadEvent(tx,parent,id);
          if(processed&&bytes+loaded.bytes>20*1024*1024)break;
          bytes+=loaded.bytes;events.set(id,loaded.event);
        }
        processed++;last=doc.id;
      }
      const important=[...events.values()].filter(e=>e.important),receipts=important.length?await tx.getAll(...important.map(e=>receiptRef(parent,e))):[];
      const entries=important.map((e,i)=>[entryRef(parent,e),summary(parent,e,verifyReceipt(parent,e,receipts[i].data()))]);
      const next={...current,lastHistoryId:last,processed:current.processed+processed,ready:docs.size<25&&processed===docs.size,revision:current.revision+1,updatedAt:now().toISOString()};
      for(const [ref,value] of entries)tx.set(ref,value);
      tx.set(stateRef(parent),next);return next;
    });
  }
  async function read(tx,parent,v={}){
    const minDays=v.minDays??0;if(![0,7,30].includes(minDays))fail('invalid-argument','미확인 경과일을 선택해 주세요.');
    const current=await state(tx,parent),today=seoulDate(now()),checkedAt=now().toISOString();
    if(!current.ready)return {companyId:parent.id,ready:false,processed:current.processed,checkedAt,rows:[],pendingCount:null};
    const governance=(await tx.get(parent.collection('erpGovernance').doc('control'))).data();
    if(governance&&governance.companyId!==parent.id)fail('permission-denied','회사 변경 상태를 확인해 주세요.');
    const snapshot=digest([VERSION,parent.id,today,minDays,current.revision,governance?.revision||0]);
    if(v.cursor){M.exactObject(v.cursor,['at','key','snapshot']);if(v.cursor.snapshot!==snapshot)fail('aborted','변경 또는 확인 상태가 바뀌었습니다. 점검함을 처음부터 새로고침해 주세요.');if(typeof v.cursor.at!=='string'||!Number.isFinite(Date.parse(v.cursor.at))||!(/^[a-f0-9]{64}$/).test(v.cursor.key))fail('invalid-argument','점검함 조회 위치를 확인해 주세요.');}
    const end=days=>new Date(Date.parse(today+'T00:00:00+09:00')+(1-days)*86400000).toISOString();
    const base=parent.collection('erpReviewInbox').where('reviewStatus','==','UNREVIEWED');
    const all=base.where('at','<',end(0)),aged=base.where('at','<',end(7)),urgent=base.where('at','<',end(30)),previous=base.where('at','<',new Date(today.slice(0,7)+'-01T00:00:00+09:00').toISOString());
    const selected=base.where('at','<',end(minDays));
    let page=selected.orderBy('at','asc').orderBy(FieldPath.documentId(),'asc');if(v.cursor)page=page.startAfter(v.cursor.at,v.cursor.key);
    const [total,week,month,prior,docs,oldest]=await Promise.all([tx.get(all.count()),tx.get(aged.count()),tx.get(urgent.count()),tx.get(previous.count()),tx.get(page.limit(PAGE_SIZE+1)),tx.get(all.orderBy('at','asc').limit(1))]);
    const rows=docs.docs.slice(0,PAGE_SIZE).map(doc=>{const r=doc.data();if(r.companyId!==parent.id||doc.id!==digest([r.id,r.fingerprint]))fail('permission-denied','중요 변경 목록의 회사를 확인해 주세요.');return {...r,ageDays:ageDays(r.at,today)};});
    const oldestRow=oldest.docs[0]?.data();if(oldestRow&&oldestRow.companyId!==parent.id)fail('permission-denied','중요 변경 목록의 회사를 확인해 주세요.');
    const last=docs.docs[PAGE_SIZE-1];
    return {companyId:parent.id,ready:true,today,checkedAt,minDays,pendingCount:total.data().count,agedCount:week.data().count,urgentCount:month.data().count,previousMonthCount:prior.data().count,oldestAgeDays:oldestRow?ageDays(oldestRow.at,today):0,oldestAt:oldestRow?.at||null,filteredTotal:(minDays===30?month:minDays===7?week:total).data().count,rows,nextCursor:docs.size>PAGE_SIZE?{at:last.data().at,key:last.id,snapshot}:null,snapshot};
  }
  async function list(request,parent,v={}){
    // Warm companies use one read-only transaction. Bootstrap transactions are
    // separate from aggregates (no read-after-write and no count write locks).
    const result=await db.runTransaction(async tx=>{await context(request,tx);return read(tx,parent,v);},{readOnly:true});
    if(result.ready)return result;
    const progress=await prepare(request,parent);return {...result,processed:progress.processed};
  }
  async function detail(request,parent,v){
    return db.runTransaction(async tx=>{await context(request,tx);const {event}=await loadEvent(tx,parent,v.id);if(!event.important||event.fingerprint!==v.fingerprint)fail('failed-precondition','변경 원본이 달라졌습니다. 점검함을 다시 조회해 주세요.');return {...summary(parent,event,verifyReceipt(parent,event,(await tx.get(receiptRef(parent,event))).data())),changes:event.changes};},{readOnly:true});
  }
  return {list,read,detail,state};
}
module.exports={createReviewInbox,recordInbox,entryRef,stateRef,summary,ageDays};
