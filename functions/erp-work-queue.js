const {fail}=require('./security-context');
const {accessOf}=require('./erp-governance');
const {erpMaster:master}=require('./erp-service');
const M=require('./erp-ledger-model');
const {loadFinance}=require('./erp-finance-model');
const {settlementReport}=require('./erp-settlement-model');
const {pendingOf}=require('./erp-stock-state');

const MAX=100, DISPLAY=10;
const dateOf=value=>typeof value==='string'?value.slice(0,10):'';
function section(key,rows,hasMore=false){
  rows.sort((a,b)=>a.priority-b.priority||(a.date||'9999').localeCompare(b.date||'9999')||a.id.localeCompare(b.id));
  return {key,status:'READY',count:rows.length,hasMore,rows:rows.slice(0,DISPLAY)};
}
// Read-only projection. Each category is isolated, but the caller's current
// identity is checked again before any category is returned to the browser.
function createWorkQueue({db,now,context,listPlans}){
  return async(request,parent)=>{
    M.exactObject(request.data,['action','companyId']);
    const user=await context(request,db,false),access=accessOf(user);
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(now());
    async function authorize(reader){
      const current=await context(request,reader,false);
      if(current.uid!==user.uid||current.companyId!==parent.id||accessOf(current)!==access)fail('permission-denied','ERP 권한이 변경되었습니다. 시작 화면을 다시 열어 주세요.');
      return current;
    }
    const handlers={
      approvals:async tx=>{
        let query=parent.collection('erpApprovals').where('status','==','PENDING');
        if(access!=='ADMIN')query=query.where('requestedBy','==',user.uid);
        const docs=await tx.get(query.orderBy('createdAt','asc').limit(MAX+1));
        return section('approvals',docs.docs.slice(0,MAX).map(d=>{
          const r=d.data();master.verifyTenant(r,parent.id);
          if(access!=='ADMIN'&&r.requestedBy!==user.uid)fail('permission-denied','본인 승인 요청만 조회할 수 있습니다.');
          return {id:d.id,title:access==='ADMIN'?`${r.requesterName||'담당자'} · 승인 요청`:'내 승인 요청',detail:access==='ADMIN'?'변경 내용을 확인하고 승인·반려해 주세요.':'ADMIN 검토 대기 중입니다.',date:dateOf(r.createdAt),dateLabel:'요청일',priority:1,badge:access==='ADMIN'?'승인 대기':'검토 대기',view:'approvals',source:d.id};
        }),docs.size>MAX);
      },
      closing:async tx=>{
        const result=await listPlans(tx,parent,user);
        return section('closing',result.plans.filter(p=>p.actionCount>0).map(p=>({id:p.month,title:`${p.month} 월마감`,detail:access==='ADMIN'?`미확인 ${p.pendingCount}항목 · 완료 보고 ${p.awaitingAdminCount}건`:`내 미보고 ${p.myPendingCount}항목`,date:p.dueDate,dateLabel:'마감 예정일',priority:p.dueDate<=today?0:2,badge:p.dueDate<today?'기한 경과':p.dueDate===today?'오늘 마감':'예정',view:'closing',source:p.month})),result.hasMore);
      },
    };
    if(access==='ADMIN')Object.assign(handlers,{
      recovery:async tx=>{
        const report=settlementReport(await loadFinance(tx,parent),today);
        const groups=new Map(report.summaries.map(r=>[`${r.partnerId}:${r.currency}`,r]));
        const rows=report.documents.filter(d=>d.balance>0).map(d=>{
          const unallocated=Math.max(0,groups.get(`${d.partnerId}:${d.currency}`)?.unallocated||0);
          const overdue=d.overdueDays>0||d.promiseOverdueDays>0,date=d.expectedDate||d.dueDate;
          return {id:d.id,title:`${d.partnerName} · ${d.documentNo}`,detail:unallocated?'기등록 미배분 수금을 먼저 확인해 주세요.':d.assigneeName?`회수 담당 ${d.assigneeName}`:'회수 담당·예정일을 확인해 주세요.',date,dateLabel:d.expectedDate?'회수 예정일':d.dueDate?'지급기일':'일정 미지정',priority:overdue||date&&date<=today?0:date?2:1,badge:unallocated?'수금 배분 확인':overdue?'기한 경과':date===today?'오늘 회수':date?'회수 예정':'일정 확인',amountMinor:d.balance,currency:d.currency,unallocatedMinor:unallocated,view:'shipments',source:d.documentNo};
        });
        return section('recovery',rows);
      },
      statements:async tx=>{
        const docs=await tx.get(parent.collection('erpIssuedDocuments').where('status','==','DRAFT').where('kind','==','STATEMENT').where('replacesId','>','').limit(MAX+1));
        return section('statements',docs.docs.slice(0,MAX).map(d=>{
          const r=d.data();master.verifyTenant(r,parent.id);
          return {id:d.id,title:`명세표 정정 · ${r.input?.sourceDocumentNo||r.replacesNumber||'원문서 확인'}`,detail:`이전 명세표 ${r.replacesNumber||'번호 확인'} · 정정 초안을 확인하고 발행해 주세요.`,date:dateOf(r.updatedAt),dateLabel:'최종 수정일',priority:1,badge:'정정 초안',view:'documents',source:'',draftId:d.id};
        }),docs.size>MAX);
      },
      borrowed:async tx=>{
        const docs=await tx.get(parent.collection('erpBorrowings').where('outstandingQuantityScaled','>',0).limit(MAX+1));
        return section('borrowed',docs.docs.slice(0,MAX).map(d=>{
          const r=d.data();master.verifyTenant(r,parent.id);
          if(!Number.isSafeInteger(r.outstandingQuantityScaled)||r.outstandingQuantityScaled<0||r.cancelled)fail('failed-precondition','차용 원장을 확인해 주세요.');
          return {id:d.id,title:`${r.code||''} · ${r.name||'차용 품목'}`,detail:`${r.warehouseName||'창고 확인'} · ${r.ownerName||'원소유자 확인'}`,quantity:r.outstandingQuantityScaled/10000,unit:r.unit||'',date:r.date,dateLabel:'차용일',priority:1,badge:'현물 반환 필요',view:'custody',source:d.id};
        }),docs.size>MAX);
      },
      opening:async tx=>{
        const docs=await tx.get(parent.collection('erpItems').where('pendingOpening.status','==','PENDING_COST').limit(MAX+1));
        return section('opening',docs.docs.slice(0,MAX).map(d=>{
          const r=d.data();master.verifyTenant(r,parent.id);const p=pendingOf(r);
          return {id:d.id,title:`${r.code} · ${r.name}`,detail:!r.active?'사용 중지 품목입니다. 품목 상태를 먼저 확인해 주세요.':'실제 원가·반영일·창고를 확인한 후 확정해 주세요.',quantity:p.quantity,unit:p.unit,date:p.basisDate,dateLabel:'원본 기준일',priority:p.basisDate>today?2:1,badge:p.basisDate>today?'기준일 도래 전':'원가 미확정',view:'opening',source:d.id};
        }),docs.size>MAX);
      },
    });
    const sections=await Promise.all(Object.entries(handlers).map(async([key,read])=>{
      try{return await db.runTransaction(async tx=>{await authorize(tx);return read(tx);});}
      catch(error){
        if(['permission-denied','unauthenticated'].includes(error.code))throw error;
        return {key,status:'ERROR',count:null,hasMore:false,rows:[],message:error.code==='resource-exhausted'?'조회 범위를 초과했습니다. 해당 업무 화면에서 확인해 주세요.':'업무 목록을 확인하지 못했습니다. 새로고침하거나 해당 업무 화면에서 확인해 주세요.'};
      }
    }));
    await authorize(db);
    return {companyId:parent.id,access,today,checkedAt:now().toISOString(),sections};
  };
}
module.exports={createWorkQueue};
