const {FieldPath}=require('firebase-admin/firestore');
const {fail}=require('./security-context');

// Bounded keyset pages cover old and new items without a search-index migration.
async function searchItems({request,companyRef,context,user,master}) {
  const input=request.data;
  if(Object.keys(input).some(k=>!['action','companyId','search','cursor'].includes(k)))fail('invalid-argument','품목 검색 요청을 확인해 주세요.');
  const search=master.normalize(master.text(input.search,'검색어',120));
  const signature=master.hash([companyRef.id,search].join(':'));
  let query=companyRef.collection('erpItems').orderBy(FieldPath.documentId());
  if(input.cursor){
    const c=input.cursor;
    if(typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['id','signature'].includes(k))||c.signature!==signature)fail('invalid-argument','검색어 또는 회사가 변경되었습니다. 처음부터 다시 검색해 주세요.');
    query=query.startAfter(master.identifier(c.id));
  }
  const snapshots=await query.limit(251).get(),records=[];let scanned=0,last='';
  const terms=search.split(' ').filter(Boolean);
  for(const doc of snapshots.docs.slice(0,250)){
    const data=doc.data();master.verifyTenant(data,companyRef.id);scanned++;last=doc.id;
    const haystack=master.normalize([data.code,data.name,data.specification].filter(Boolean).join(' '));
    if(data.active&&terms.every(term=>haystack.includes(term)))records.push(master.view('items',doc.id,data,true));
    if(records.length===50)break;
  }
  const current=await context(request);
  if(current.uid!==user.uid||current.role!==user.role||current.erpAccess!==user.erpAccess)fail('permission-denied','ERP 권한이 변경되었습니다. 다시 로그인해 주세요.');
  return {records,scanned,nextCursor:scanned<snapshots.size?{id:last,signature}:null};
}
module.exports={searchItems};
