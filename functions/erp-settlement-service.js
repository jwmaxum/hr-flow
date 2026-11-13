const M = require('./erp-ledger-model');
const { erpMaster: master } = require('./erp-service');
const { fail } = require('./security-context');
const { settlementReport, financeSnapshot } = require('./erp-settlement-model');
const digits = currency => ['KRW','JPY'].includes(currency) ? 0 : 2;

function createSettlementHandler({ db, now, context, load }) {
  const activeAssignee=(profile,companyId)=>profile?.companyId===companyId&&(profile.status||'ACTIVE')==='ACTIVE'&&['ADMIN','SUB_ADMIN','MEMBER'].includes(profile.role);
  async function directory(tx,parent) {
    const users=await tx.get(db.collection('UserProfile').where('companyId','==',parent.id).limit(5001));
    if(users.size>5000)fail('resource-exhausted','담당자 목록이 5,000명을 초과했습니다. 검색 조회를 요청해 주세요.');
    return users.docs.filter(doc=>activeAssignee(doc.data(),parent.id)).map(doc=>({id:doc.id,name:M.text(doc.data().name||'이름 미등록','담당자 이름',120)})).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  }
  async function plan(tx, parent, job) {
    const data = await load(tx,parent), input = job.input;
    const latest = input.type==='FOLLOW_UP' ? data.settlementState.followUpLastDate : [data.state.lastDate,data.ledger.lastDate,data.settlementState.lastDate].filter(Boolean).sort().at(-1);
    if (latest && input.date < latest) fail('failed-precondition', `마지막 매출·수금·배분 처리일 ${latest} 이후로 등록해 주세요.`);
    const report = settlementReport(data,input.date);
    const entry = {...input,companyId:parent.id,sequence:(data.settlementState.revision || 0)+1,createdAt:job.createdAt,createdBy:job.createdBy};
    let summary,assigneeSnapshot=null;
    if (input.type === 'ALLOCATE') {
      const receipt = report.receipts.find(row => row.id === input.receiptId && !row.cancelled);
      if (!receipt) fail('failed-precondition','취소되지 않은 기존 수금을 선택해 주세요.');
      let total = 0;
      entry.lines = input.lines.map(line => {
        const doc = report.documents.find(row => row.id === line.documentId);
        if (!doc || doc.partnerId !== receipt.partnerId || doc.currency !== receipt.currency) fail('failed-precondition','원수금과 같은 거래처·통화의 출고 문서를 선택해 주세요.');
        const amountMinor = M.decimal(line.amount,digits(doc.currency),'배분 금액',9e12);
        if (!amountMinor || amountMinor > doc.balance) fail('failed-precondition','배분 금액은 0보다 크고 문서 미수잔액 이하여야 합니다.');
        total = M.signed(total + amountMinor);
        return {documentId:doc.id,documentNo:doc.documentNo,amountMinor};
      });
      if (total > receipt.available) fail('failed-precondition','원수금의 미배분 금액을 초과했습니다.');
      if (total > receipt.allocatable) fail('failed-precondition','환불을 반영한 거래처의 미배분 순수금을 초과했습니다. 기존 초과 배분을 해제한 후 확인해 주세요.');
      Object.assign(entry,{partnerId:receipt.partnerId,partnerName:receipt.partnerName,currency:receipt.currency});
      summary = {type:input.type,partnerName:receipt.partnerName,currency:receipt.currency,total,before:receipt.available,after:receipt.available-total,lines:entry.lines};
    } else if (input.type === 'RELEASE') {
      const source = report.allocations.find(row => row.id === input.sourceId && row.active);
      if (!source) fail('failed-precondition','해제 가능한 수금 배분을 선택해 주세요.');
      Object.assign(entry,{partnerId:source.partnerId,partnerName:source.partnerName,currency:source.currency});
      summary = {type:input.type,partnerName:source.partnerName,currency:source.currency,total:source.lines.reduce((sum,line)=>M.signed(sum+line.amountMinor),0),lines:source.lines};
    } else if (input.type === 'TERMS') {
      const doc = report.documents.find(row => row.id === input.documentId);
      if (!doc) fail('failed-precondition','확정된 출고 문서를 선택해 주세요.');
      if (input.dueDate && input.dueDate < doc.date) fail('invalid-argument','지급기일은 출고일 이후로 입력해 주세요.');
      Object.assign(entry,{partnerId:doc.partnerId,partnerName:doc.partnerName,currency:doc.currency,documentNo:doc.documentNo});
      summary = {type:input.type,partnerName:doc.partnerName,currency:doc.currency,documentNo:doc.documentNo,previousDueDate:doc.dueDate,dueDate:input.dueDate};
    } else {
      const doc=report.documents.find(row=>row.id===input.documentId);
      if(!doc)fail('failed-precondition','확정된 출고 문서를 선택해 주세요.');
      if(input.expectedDate&&input.expectedDate<input.date&&input.expectedDate!==doc.expectedDate)fail('invalid-argument','새 회수 예정일은 관리 적용일 이후로 입력해 주세요.');
      let assigneeName='';
      if(input.assigneeId){
        const snap=await tx.get(db.collection('UserProfile').doc(input.assigneeId)),profile=snap.data();
        if(!snap.exists||!activeAssignee(profile,parent.id))fail('failed-precondition','같은 회사의 활성 담당자를 선택해 주세요.');
        assigneeName=M.text(profile.name||'이름 미등록','담당자 이름',120);
        assigneeSnapshot={id:snap.id,companyId:profile.companyId,status:profile.status||'ACTIVE',role:profile.role,name:assigneeName};
      }
      Object.assign(entry,{partnerId:doc.partnerId,partnerName:doc.partnerName,currency:doc.currency,documentNo:doc.documentNo,assigneeName});
      summary={type:input.type,partnerName:doc.partnerName,currency:doc.currency,documentNo:doc.documentNo,previousExpectedDate:doc.expectedDate,expectedDate:input.expectedDate,previousAssigneeName:doc.assigneeName,assigneeName};
    }
    return {entry,summary,state:data.settlementState,fingerprint:M.hash({input,data,entry,assigneeSnapshot})};
  }
  return async (request,input,user,parent) => {
    if (input.action === 'settlementReport') {
      M.exactObject(input,['action','companyId','to','partnerId']);
      const to=M.date(input.to),partnerId=input.partnerId?master.identifier(input.partnerId):'';
      return db.runTransaction(async tx=>{
        await context(request,tx);const data=await load(tx,parent),assignees=await directory(tx,parent);
        const result={companyId:parent.id,snapshot:financeSnapshot(data,parent.id,to),...settlementReport(data,to,partnerId),assignees,followUpLastDate:data.settlementState.followUpLastDate||null,lastDate:[data.state.lastDate,data.ledger.lastDate,data.settlementState.lastDate].filter(Boolean).sort().at(-1)||null};
        const activeIds=new Set(assignees.map(person=>person.id));
        for(const doc of result.documents)doc.assigneeActive=!!doc.assigneeId&&activeIds.has(doc.assigneeId);
        if(Buffer.byteLength(JSON.stringify(result))>8e6)fail('resource-exhausted','문서 배분 조회가 너무 큽니다. 거래처별로 조회하거나 원장 분할 집계를 요청해 주세요.');
        return result;
      });
    }
    M.exactObject(input,['action','companyId','id',...(input.action==='settlementPreview'?['input']:['fingerprint'])]);
    const id=master.identifier(input.id),ref=parent.collection('erpSettlementJobs').doc(id);
    let normalized;
    if(input.action==='settlementPreview') {
      const v=input.input;
      if (!v || !['ALLOCATE','RELEASE','TERMS','FOLLOW_UP'].includes(v.type)) fail('invalid-argument','배분·해제·지급기일·회수 관리 처리를 선택해 주세요.');
      M.exactObject(v,['type','date','notes',...({ALLOCATE:['receiptId','lines'],RELEASE:['sourceId'],TERMS:['documentId','dueDate'],FOLLOW_UP:['documentId','expectedDate','assigneeId']})[v.type]]);
      normalized={type:v.type,date:M.date(v.date),notes:M.text(v.notes,'처리 사유',500,true)};
      if (v.type==='ALLOCATE') {
        normalized.receiptId=master.identifier(v.receiptId);
        if(!Array.isArray(v.lines)||!v.lines.length||v.lines.length>50)fail('invalid-argument','1~50개 문서에 배분해 주세요.');
        const seen=new Set();normalized.lines=v.lines.map(line=>{M.exactObject(line,['documentId','amount']);const documentId=master.identifier(line.documentId);if(seen.has(documentId))fail('invalid-argument','문서별로 한 번씩 입력해 주세요.');seen.add(documentId);return {documentId,amount:M.text(line.amount,'배분 금액',30,true)};});
      } else if(v.type==='RELEASE')normalized.sourceId=master.identifier(v.sourceId);
      else if(v.type==='TERMS')Object.assign(normalized,{documentId:master.identifier(v.documentId),dueDate:v.dueDate===''?'':M.date(v.dueDate)});
      else Object.assign(normalized,{documentId:master.identifier(v.documentId),expectedDate:v.expectedDate===''?'':M.date(v.expectedDate),assigneeId:v.assigneeId===''?'':master.identifier(v.assigneeId)});
    }
    return db.runTransaction(async tx=>{
      await context(request,tx);const snap=await tx.get(ref),old=snap.data();if(old){master.verifyTenant(old,parent.id);if(old.kind)fail('failed-precondition','해당 업무의 전용 미리보기를 사용해 주세요.');}
      if(input.action==='settlementPreview') {
        if(old){if(M.hash(old.input)!==M.hash(normalized))fail('already-exists','내용이 변경되었습니다. 새로 검증해 주세요.');return {job:old};}
        const job={id,companyId:parent.id,input:normalized,status:'PENDING',createdAt:now().toISOString(),createdBy:user.uid};
        const result=await plan(tx,parent,job),saved={...job,summary:result.summary,fingerprint:result.fingerprint};tx.create(ref,saved);return {job:saved};
      }
      if(!old||input.fingerprint!==old.fingerprint)fail('failed-precondition','확인한 미리보기로 다시 시도해 주세요.');
      if(old.status==='COMMITTED')return {job:old,idempotent:true};
      const fresh=await plan(tx,parent,old);if(fresh.fingerprint!==old.fingerprint)fail('failed-precondition','매출·수금·배분 내역이 변경되었습니다. 새 미리보기를 확인해 주세요.');
      const at=now().toISOString();tx.create(parent.collection('erpSettlements').doc(id),{...fresh.entry,committedAt:at});
      tx.set(parent.collection('erpState').doc('settlements'),{...fresh.state,companyId:parent.id,revision:fresh.entry.sequence,...(old.input.type==='FOLLOW_UP'?{followUpLastDate:old.input.date}:{lastDate:old.input.date}),updatedAt:at});
      tx.create(parent.collection('erpAudit').doc(),{companyId:parent.id,actorId:user.uid,action:`SETTLEMENT_${old.input.type}`,settlementId:id,at});
      tx.update(ref,{status:'COMMITTED',committedAt:at});return {job:{...old,status:'COMMITTED',committedAt:at},idempotent:false};
    });
  };
}
module.exports={createSettlementHandler};
