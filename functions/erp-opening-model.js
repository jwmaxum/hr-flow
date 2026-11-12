const { fail } = require('./security-context');
const { erpMaster: master } = require('./erp-service');
const M = require('./erp-ledger-model');
const { parseMatrix, HEADERS, SHEETS } = require('./erp-import-schema');

function openingInput(value) {
  M.exactObject(value,['date','warehouseId','reason','zeroCostConfirmed','lines']);
  const result={date:M.date(value.date),warehouseId:master.identifier(value.warehouseId),reason:M.text(value.reason,'원가 확인 근거',500,true),zeroCostConfirmed:value.zeroCostConfirmed};
  if(typeof result.zeroCostConfirmed!=='boolean'||result.reason.length<3)fail('invalid-argument','원가 확인 근거와 무상 원가 확인을 입력해 주세요.');
  if(!Array.isArray(value.lines)||!value.lines.length||value.lines.length>50)fail('invalid-argument','확정할 품목은 1~50개로 선택해 주세요.');
  const seen=new Set();
  result.lines=value.lines.map(line=>{
    M.exactObject(line,['itemId','quantity','price']);const itemId=master.identifier(line.itemId);
    if(seen.has(itemId))fail('invalid-argument','같은 품목을 중복 선택하지 마세요.');seen.add(itemId);
    const quantityScaled=M.decimal(line.quantity,4,'확정 수량',1e12),priceScaled=M.decimal(line.price,4,'원가',1e13);
    if(!priceScaled&&!result.zeroCostConfirmed)fail('invalid-argument','0원 원가는 무상 재고 확인과 근거가 필요합니다.');
    return {itemId,quantityScaled,priceScaled};
  }).sort((a,b)=>a.itemId.localeCompare(b.itemId));
  return result;
}
function pendingOf(item) {
  const pending=item.pendingOpening;
  if(!pending||pending.status!=='PENDING_COST')fail('failed-precondition','아직 원가가 미확정인 이관 대기 품목만 선택해 주세요.');
  M.date(pending.basisDate);
  if(!item.active||item.itemType==='BUNDLE'||item.unit!==pending.unit)fail('failed-precondition','활성 일반 품목과 원본 단위를 확인해 주세요.');
  const quantityScaled=pending.quantity===null?null:M.decimal(pending.quantity,4,'원본 수량',1e12);
  return {...pending,quantityScaled};
}
async function prepareOpening(tx,parent,input) {
  const docs=await tx.getAll(...input.lines.map(line=>parent.collection('erpItems').doc(line.itemId)));
  const guide=[],data=[];data[8]=HEADERS.OPENING;let basisDate='';
  for(let i=0;i<docs.length;i++) {
    const doc=docs[i];if(!doc.exists)fail('not-found','회사의 이관 대기 품목을 찾을 수 없습니다.');
    const item=doc.data();master.verifyTenant(item,parent.id);const pending=pendingOf(item),line=input.lines[i];
    if(basisDate&&basisDate!==pending.basisDate)fail('invalid-argument','기준일이 같은 품목끼리 확정해 주세요.');basisDate=pending.basisDate;
    if(pending.quantityScaled!==null&&pending.quantityScaled!==line.quantityScaled)fail('failed-precondition','원본 수량을 바꾸지 말고 확인해 주세요. 수량이 다른 품목은 별도로 대사해야 합니다.');
    data.push([i+1,item.code,item.name,item.specification||'',item.unit,item.taxType,'상품',item.group||'','','',line.quantityScaled/10000,'단가',line.priceScaled/10000,'','KRW',input.reason]);
  }
  guide[4]=['','이관 대기 원가 확정'];guide[5]=['',basisDate];
  return parseMatrix([{sheet:'작성안내',data:guide},{sheet:SHEETS.OPENING,data}],'OPENING');
}
function postingOf(state,job) {
  const input=job.pendingOpening;
  if(!input)return null;
  if(job.source.kind!=='PENDING_OPENING'||job.type!=='OPENING')fail('failed-precondition','이관 확정 원본을 확인해 주세요.');
  if(input.date<job.basisDate||state.lastDate&&input.date<state.lastDate||state.lastDate&&input.date===job.basisDate)fail('failed-precondition',`반영일은 기준일 ${job.basisDate} 및 마지막 거래일 ${state.lastDate||job.basisDate} 이후여야 합니다.`);
  const late=input.date>job.basisDate,order=late?(state.lastDate===input.date?(state.lastOrder||0)+1:1):0;
  if(!Number.isSafeInteger(order)||order>999999)fail('failed-precondition','반영일의 처리순서 한도를 확인해 주세요.');
  return {late,date:input.date,order};
}
async function validateOpeningRow(tx,parent,job,row,item,balances) {
  const pending=pendingOf(item),line=job.pendingOpening.lines.find(line=>line.itemId===item.id);
  if(!line||pending.basisDate!==job.basisDate||line.quantityScaled!==row.quantityScaled||line.priceScaled!==row.priceScaled||pending.quantityScaled!==null&&pending.quantityScaled!==row.quantityScaled)fail('failed-precondition','이관 원본 수량·기준일이 변경되었습니다. 새로 검증해 주세요.');
  const movements=await tx.get(parent.collection('erpMovements').where('itemId','==',item.id).limit(1));
  if(!balances.empty||!movements.empty)fail('failed-precondition',`${item.name}: 이미 다른 창고 재고나 거래가 있습니다. 원본과 현재고를 먼저 대사해 주세요.`);
}
async function openingList(tx,parent,now) {
  const [items,state]=await Promise.all([tx.get(parent.collection('erpItems').where('pendingOpening.status','in',['PENDING_COST','CONFIRMED']).limit(501)),tx.get(parent.collection('erpState').doc('ledger'))]);
  if(items.size>500)fail('resource-exhausted','이관 관리 품목이 500개를 초과했습니다. 분할 조회를 요청해 주세요.');
  if(state.exists)master.verifyTenant(state.data(),parent.id);
  const records=items.docs.map(doc=>{const item=doc.data();master.verifyTenant(item,parent.id);return {id:doc.id,code:item.code,name:item.name,unit:item.unit,active:item.active,pendingOpening:item.pendingOpening};}).sort((a,b)=>a.code.localeCompare(b.code));
  const ledger=state.data()||{},today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(now());
  return {companyId:parent.id,records,basisDate:ledger.basisDate||'',lastDate:ledger.lastDate||'',suggestedDate:ledger.lastDate?[today,ledger.lastDate].sort().at(-1):ledger.basisDate||records.find(r=>r.pendingOpening.status==='PENDING_COST')?.pendingOpening.basisDate||today};
}
module.exports={openingInput,prepareOpening,postingOf,validateOpeningRow,openingList};
