const {createHash} = require('node:crypto');
const {fail} = require('./security-context');
const {fileType, filename, TYPES} = require('./drafting-attachments');
const M = require('./erp-ledger-model');

const MAX_BYTES = 5 * 1024 * 1024, MAX_FILES = 5, MAX_TOTAL = 20 * 1024 * 1024;
const CHECKS = [
  ['INVENTORY', '품목·창고별 재고수량과 재고금액 대사'],
  ['TRADES', '매출·매입 및 취소·반품 내역 확인'],
  ['RECEIVABLES', '외상매출·수금·미수잔액 자체 확인'],
  ['APPROVALS', '승인 대기·가격 조정 내역 검토'],
  ['PENDING_COST', '원가 미확정 품목의 자산 제외 확인'],
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function monthOf(value) {
  if (typeof value !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) fail('invalid-argument', '마감 월을 선택해 주세요.');
  return value;
}
function idOf(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) fail('invalid-argument', '증빙 식별자를 확인해 주세요.');
  return value.toLowerCase();
}
const empty = (companyId, month) => ({companyId, month, revision:0, schemaVersion:1,
  items:CHECKS.map(([key,label]) => ({key,label,checked:false,note:'',checkedBy:null,checkedByName:null,checkedAt:null})), evidence:[], noEvidenceReason:''});
function ready(draft) {
  return CHECKS.every(([key]) => draft.items.some(r => r.key === key && r.checked && r.checkedBy && r.checkedAt)) &&
    (draft.evidence.length > 0 || draft.noEvidenceReason.trim().length >= 3);
}
function createClosingChecklist({db, bucket, now, context, stateOf, audit}) {
  async function read(tx, parent, month) {
    const doc = await tx.get(parent.collection('erpCloseChecklists').doc(month));
    const draft = doc.data() || empty(parent.id, month);
    if (draft.companyId !== parent.id || draft.month !== month || draft.schemaVersion !== 1 || !Array.isArray(draft.items) || !Array.isArray(draft.evidence)) fail('failed-precondition', '마감 체크리스트 자료를 확인해 주세요.');
    return draft;
  }
  function writable(state, month, draft, revision) {
    if (state.closedThrough && month <= state.closedThrough.slice(0,7)) fail('failed-precondition', '마감된 월의 체크리스트·증빙은 변경할 수 없습니다. 재개방 후 처리해 주세요.');
    if (!Number.isSafeInteger(revision) || revision !== draft.revision) fail('aborted', '체크리스트가 변경되었습니다. 다시 조회해 주세요.');
  }
  function save(tx, parent, state, before, after, user, action, reason) {
    tx.set(parent.collection('erpCloseChecklists').doc(after.month), after);
    tx.set(parent.collection('erpGovernance').doc('control'), {...state, revision:state.revision + 1});
    audit(tx, parent, user, action, {month:after.month, reason, before, after});
  }
  async function verifiedBytes(parent, month, descriptor) {
    const prefix = `companies/${parent.id}/erp-close-evidence/${month}/${idOf(descriptor.id)}/`;
    if (typeof descriptor.path !== 'string' || !descriptor.path.startsWith(prefix) || descriptor.path !== prefix + descriptor.sha256 + '.' + TYPES[descriptor.mimeType] ||
        !/^[a-f0-9]{64}$/.test(descriptor.sha256) || !/^\d+$/.test(descriptor.generation) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > MAX_BYTES) fail('failed-precondition', '증빙 저장 정보를 확인해 주세요.');
    const file = bucket.file(descriptor.path, {generation:descriptor.generation});
    const [meta] = await file.getMetadata();
    if (String(meta.generation) !== descriptor.generation || +meta.size !== descriptor.size || meta.contentType !== descriptor.mimeType ||
        meta.metadata?.companyId !== parent.id || meta.metadata?.month !== month || meta.metadata?.sha256 !== descriptor.sha256 || meta.metadata?.firebaseStorageDownloadTokens) fail('failed-precondition', '증빙 원본 정보를 확인하지 못했습니다.');
    const [bytes] = await file.download();
    if (bytes.length !== descriptor.size || sha(bytes) !== descriptor.sha256 || fileType(bytes) !== descriptor.mimeType) fail('failed-precondition', '증빙 원본 무결성 검증에 실패했습니다.');
    return bytes;
  }
  async function verify(parent, draft) {
    if (!ready(draft)) fail('failed-precondition', '체크리스트 전체 확인과 증빙 첨부 또는 미첨부 사유를 저장해 주세요.');
    for (const file of draft.evidence) await verifiedBytes(parent, draft.month, file);
  }
  async function handle(request, v, parent) {
    const month = monthOf(v.month);
    if (v.action === 'checklistGet') return db.runTransaction(async tx => {
      await context(request, tx); const [draft,state] = await Promise.all([read(tx,parent,month),stateOf(tx,parent)]);
      return {checklist:draft, ready:ready(draft), locked:!!state.closedThrough && month <= state.closedThrough.slice(0,7)};
    });
    if (v.action === 'evidenceDownload') {
      const id = idOf(v.id);
      const descriptor = await db.runTransaction(async tx => {
        await context(request, tx);
        let draft;
        if (v.archiveId !== undefined) {
          if (typeof v.archiveId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(v.archiveId)) fail('invalid-argument', '보관 버전을 선택해 주세요.');
          const archive = (await tx.get(parent.collection('erpMonthCloses').doc(v.archiveId))).data();
          if (!archive || archive.companyId !== parent.id || archive.month !== month) fail('not-found', '해당 회사·월의 보관본을 찾을 수 없습니다.');
          draft = archive.checklist;
        } else draft = await read(tx,parent,month);
        const file = draft?.evidence.find(r => r.id === id);
        if (!file) fail('not-found', '이 체크리스트에 연결된 증빙을 찾을 수 없습니다.');
        return file;
      });
      const bytes = await verifiedBytes(parent,month,descriptor);
      await context(request);
      // Recheck the saved reference after I/O, including removal while downloading.
      if (v.archiveId === undefined) {
        await db.runTransaction(async tx => {await context(request,tx); const current=await read(tx,parent,month);
          if (!current.evidence.some(r=>r.id===id && r.sha256===descriptor.sha256 && r.generation===descriptor.generation)) fail('aborted','증빙 연결이 변경되었습니다. 다시 조회해 주세요.');});
      }
      return {companyId:parent.id,name:descriptor.name,mimeType:descriptor.mimeType,size:descriptor.size,sha256:descriptor.sha256,base64:bytes.toString('base64')};
    }
    if (v.action === 'evidenceUpload') {
      const id = idOf(v.id), name = filename(v.name);
      if (typeof v.name !== 'string' || !v.name.trim() || name !== v.name || !Object.hasOwn(TYPES,v.mimeType) ||
          !(v.mimeType==='image/jpeg'?/\.jpe?g$/i:/\.(png|gif|webp|pdf)$/i).test(name)) fail('invalid-argument','PDF·PNG·JPG·GIF·WEBP 파일 이름과 형식을 확인해 주세요.');
      const ext = name.split('.').at(-1).toLowerCase();
      if (ext !== TYPES[v.mimeType] && !(v.mimeType==='image/jpeg' && ext==='jpeg')) fail('invalid-argument','파일 확장자와 형식이 일치하지 않습니다.');
      // A canonical decode/encode comparison avoids recursive regex matching
      // on multi-megabyte input, and rejects ignored characters/padding too.
      if (typeof v.base64 !== 'string' || !v.base64.length || v.base64.length % 4 !== 0 || v.base64.length > Math.ceil(MAX_BYTES/3)*4) fail('invalid-argument','5MB 이하 증빙 파일을 선택해 주세요.');
      const bytes = Buffer.from(v.base64,'base64');
      if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== v.base64 || fileType(bytes) !== v.mimeType) fail('invalid-argument','파일 내용과 형식을 확인해 주세요.');
      const hash = sha(bytes);
      const inspect = (draft,state) => {
        const existing = draft.evidence.find(r=>r.id===id);
        if (existing) {if(existing.sha256!==hash || existing.name!==name || existing.mimeType!==v.mimeType) fail('already-exists','증빙 ID가 이미 사용 중입니다. 파일을 다시 선택해 주세요.'); return existing;}
        writable(state,month,draft,v.revision);
        if (draft.evidence.length >= MAX_FILES || draft.evidence.reduce((n,f)=>n+f.size,0)+bytes.length > MAX_TOTAL) fail('resource-exhausted','증빙은 최대 5개, 합계 20MB까지 등록할 수 있습니다.');
        return null;
      };
      const initial = await db.runTransaction(async tx=>{await context(request,tx);const [draft,state]=await Promise.all([read(tx,parent,month),stateOf(tx,parent)]);return {draft,existing:inspect(draft,state)};});
      if (initial.existing) {
        await verifiedBytes(parent,month,initial.existing);
        return db.runTransaction(async tx=>{await context(request,tx);const [draft,state]=await Promise.all([read(tx,parent,month),stateOf(tx,parent)]);
          if(!inspect(draft,state))fail('aborted','증빙 연결이 변경되었습니다. 다시 조회해 주세요.');return {checklist:draft,idempotent:true};});
      }
      const path = `companies/${parent.id}/erp-close-evidence/${month}/${id}/${hash}.${TYPES[v.mimeType]}`, file = bucket.file(path);
      try {await file.save(bytes,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:v.mimeType,cacheControl:'private, no-store',metadata:{companyId:parent.id,month,sha256:hash}}});}
      catch(error){if(![409,412].includes(Number(error.code)))throw error;}
      const [meta]=await file.getMetadata();
      const descriptor={id,name,mimeType:v.mimeType,size:bytes.length,sha256:hash,path,generation:String(meta.generation)};
      await verifiedBytes(parent,month,descriptor);
      return db.runTransaction(async tx=>{
        const user=await context(request,tx),[draft,state]=await Promise.all([read(tx,parent,month),stateOf(tx,parent)]),existing=inspect(draft,state);
        if(existing)return {checklist:draft,idempotent:true};
        const at=now().toISOString(),after={...draft,revision:draft.revision+1,updatedAt:at,updatedBy:user.uid,evidence:[...draft.evidence,{...descriptor,uploadedAt:at,uploadedBy:user.uid,uploadedByName:user.name||user.uid}]};
        save(tx,parent,state,draft,after,user,'CLOSE_EVIDENCE_ADDED',name);return {checklist:after};
      });
    }
    return db.runTransaction(async tx=>{
      const user=await context(request,tx),[draft,state]=await Promise.all([read(tx,parent,month),stateOf(tx,parent)]);
      writable(state,month,draft,v.revision);
      const at=now().toISOString();let after={...draft,revision:draft.revision+1,updatedAt:at,updatedBy:user.uid};
      if(v.action==='checklistSave'){
        if(!Array.isArray(v.items)||v.items.length!==CHECKS.length||new Set(v.items.map(r=>r?.key)).size!==CHECKS.length)fail('invalid-argument','체크리스트 전체 항목을 확인해 주세요.');
        const items=CHECKS.map(([key,label])=>{
          const row=v.items.find(r=>r?.key===key);M.exactObject(row,['key','checked','note']);
          if(typeof row.checked!=='boolean')fail('invalid-argument','체크리스트 확인 여부를 선택해 주세요.');
          const note=M.text(row.note,'확인 메모',500),old=draft.items.find(r=>r.key===key);
          const unchanged=old?.checked===row.checked&&old?.note===note;
          return {key,label,checked:row.checked,note,checkedBy:row.checked?(unchanged?old.checkedBy:user.uid):null,checkedByName:row.checked?(unchanged?old.checkedByName:user.name||user.uid):null,checkedAt:row.checked?(unchanged?old.checkedAt:at):null};
        });
        after={...after,items,noEvidenceReason:M.text(v.noEvidenceReason,'미첨부 사유',500)};
        save(tx,parent,state,draft,after,user,'CLOSE_CHECKLIST_SAVED','월마감 확인 사항 저장');
      } else if(v.action==='evidenceRemove'){
        const id=idOf(v.id),reason=M.text(v.reason,'제외 사유',500,true);if(reason.length<3)fail('invalid-argument','증빙 제외 사유를 3자 이상 입력해 주세요.');
        if(!draft.evidence.some(r=>r.id===id))fail('not-found','증빙을 다시 조회해 주세요.');
        after={...after,evidence:draft.evidence.filter(r=>r.id!==id)};
        save(tx,parent,state,draft,after,user,'CLOSE_EVIDENCE_REMOVED',reason);
      } else fail('invalid-argument','지원하지 않는 체크리스트 요청입니다.');
      return {checklist:after,ready:ready(after)};
    });
  }
  function resetForReopen(tx,parent,draft,user) {
    tx.set(parent.collection('erpCloseChecklists').doc(draft.month),{...draft,revision:draft.revision+1,
      items:empty(parent.id,draft.month).items,updatedAt:now().toISOString(),updatedBy:user.uid});
  }
  return {read,handle,verify,ready,resetForReopen};
}
function checklistSections(draft) {
  return [
    {name:'마감 체크리스트',columns:[{label:'확인 항목',width:2},{label:'확인자',width:1},{label:'확인 시각 (UTC)',width:1.5},{label:'확인 메모',width:2}],rows:draft.items.map(r=>[r.label,r.checkedByName,r.checkedAt,r.note]),note:'마감 시점의 확인 기록입니다. 재개방·재마감 후에도 이 버전은 보존됩니다.'},
    {name:'마감 증빙',columns:[{label:'파일명',width:3},{label:'크기 (bytes)',width:1,numeric:true},{label:'등록자',width:1},{label:'등록 시각 (UTC)',width:1.5}],rows:draft.evidence.map(f=>[f.name,f.size,f.uploadedByName,f.uploadedAt]),note:draft.evidence.length?'증빙 원본은 ERP의 해당 마감 버전 보관함에서 내려받을 수 있습니다.':'미첨부 사유: '+draft.noEvidenceReason},
  ];
}
module.exports={createClosingChecklist,checklistSections,CHECKS,MAX_BYTES,MAX_FILES,MAX_TOTAL};
