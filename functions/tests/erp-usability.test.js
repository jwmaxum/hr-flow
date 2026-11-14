const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalize}=require('../erp-collection-service');
const {manualInput,parseManual}=require('../erp-manual-schema');
const {atInput}=require('../erp-input-error');
const input=(patch={})=>({mode:'NEW',partnerId:'buyer',currency:'KRW',date:'2026-11-14',receivedDate:'2026-11-14',amount:'1100',method:'BANK',reference:'',notes:'확인',confirmDistinct:false,lines:[],...patch});
test('draft monetary assistance and authoritative collection validation agree across currencies',async()=>{
  const {collectionMinor}=await import('../../client/src/utils/erpCollectionDraft.ts');
  for(const currency of ['KRW','JPY','USD','EUR','CNY'])for(const amount of ['1,100','1,234.50','1.000','0.01','0.001','0','1e3','1,00','-1','','9000000000000','9000000000001']){
    let server,client,se,ce;try{server=normalize(input({currency,amount})).amountMinor;}catch{se=true;}try{client=collectionMinor(amount,currency);}catch{ce=true;}
    assert.equal(!!ce,!!se,`${currency}/${amount}`);if(!se)assert.equal(client,server);
  }
});
test('validation errors identify form fields without returning submitted values',()=>{
  assert.throws(()=>normalize(input({amount:'PRIVATE_BAD_AMOUNT'})),e=>{assert.deepEqual(e.details,{kind:'ERP_INPUT',field:'collectionAmount'});assert.ok(!JSON.stringify(e).includes('PRIVATE_BAD_AMOUNT'));return e.code==='invalid-argument';});
  assert.throws(()=>normalize(input({lines:[{documentId:'a',amount:'1'},{documentId:'b',amount:'1e3'}]})),e=>e.details?.field==='collectionAllocation'&&e.details.row===2);
  const line={code:'A',name:'품목',unit:'EA',taxType:'과세',quantity:'1',price:'',amountMode:'TOTAL',totalAmount:'1000',notes:''};
  const movement={direction:'출고',date:'2026-11-14',warehouseId:'wh',partnerId:'buyer',currency:'KRW',exchangeRate:'1',priceBasis:'세금별도',payment:{status:'CREDIT'},allowNewItems:false,allowNewPartners:false,lines:[line,{...line,totalAmount:'0.001'}]};
  assert.throws(()=>manualInput(movement),e=>e.details?.field==='movementLine'&&e.details.row===2);
  const parsed=parseManual({...movement,lines:[{...line,amountMode:'UNIT',totalAmount:undefined,price:'100',quantity:'-1'}]},{basisDate:'2026-11-13',order:1,documentNo:'TEST',companyLabel:'합성 회사'});
  assert.equal(parsed.errors[0].row,10);
  const denied=Object.assign(new Error('권한 없음'),{code:'permission-denied'});assert.throws(()=>atInput('date',()=>{throw denied;}),e=>e===denied&&!e.details);
});
