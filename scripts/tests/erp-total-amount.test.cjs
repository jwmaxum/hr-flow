const {test}=require('node:test');
const assert=require('node:assert/strict');
const {manualInput,parseManual}=require('../../functions/erp-manual-schema.js');
const {amounts,parseMatrix,HEADERS}=require('../../functions/erp-import-schema.js');
function parse({quantity='3',total='1000',currency='KRW',basis='세금포함',notes='',...extra}={}){
  const input={direction:'출고',date:'2026-11-12',warehouseId:'wh',partnerId:'buyer',currency,exchangeRate:currency==='KRW'?'1':'1400',priceBasis:basis,allowNewItems:false,allowNewPartners:false,payment:{status:'CREDIT'},lines:[{code:'SET',name:'세트',specification:'',unit:'SET',taxType:'과세',quantity,price:'',amountMode:'TOTAL',totalAmount:total,notes,...extra}]};
  manualInput(input);return parseManual(input,{basisDate:'2026-11-11',order:1,documentNo:'DOC',companyLabel:'테스트'});
}
test('exact totals remain authoritative for indivisible, zero derived-price and fractional quantities',()=>{
  for(const quantity of ['3','0.3','1000000']){const p=parse({quantity});assert.deepEqual(p.errors,[]);assert.deepEqual(amounts(p.rows[0]),{supply:909,tax:91,total:1000,value:909});}
  const tiny=parse({quantity:'1000000',total:'1'});assert.deepEqual(tiny.errors,[]);assert.equal(tiny.rows[0].priceScaled,0);assert.equal(amounts(tiny.rows[0]).total,1);
});
test('total currency precision and tax basis preserve exact smallest units',()=>{
  assert.deepEqual(amounts(parse({basis:'세금별도'}).rows[0]),{supply:1000,tax:100,total:1100,value:1000});
  const usd=parse({total:'0.01',currency:'USD'});assert.deepEqual(amounts(usd.rows[0]),{supply:0.01,tax:0,total:0.01,value:14});
  assert.equal(amounts(parse({currency:'JPY',total:'1'}).rows[0]).total,1);
  for(const opts of [{total:'-1'},{total:'1.1'},{currency:'USD',total:'0.001'},{price:'100'},{amountMode:'UNKNOWN'},{quantity:'0'}]){
    try{assert.notEqual(parse(opts).errors.length,0);}catch(error){assert.equal(error.code,'invalid-argument');}
  }
});
test('free total requires a reason and spreadsheet unit-price amounts stay unchanged',()=>{
  assert.match(parse({total:'0'}).errors[0].message,/무상/);assert.deepEqual(parse({total:'0',notes:'증정'}).errors,[]);
  const guide=[];guide[4]=['','회사'];guide[5]=['','2026-11-11'];const data=[];data[8]=HEADERS.MOVEMENTS;data[9]=['2026-11-12',1,'출고','DOC',1,'CODE','품목','','EA','','',3,333.3333,'KRW',1,'과세',0.1,'세금포함','','','','','','','','',''];
  const parsed=parseMatrix([{sheet:'작성안내',data:guide},{sheet:'거래입력',data}],'MOVEMENTS');assert.deepEqual(parsed.errors,[]);assert.equal(parsed.rows[0].amountMode,undefined);assert.equal(amounts(parsed.rows[0]).total,1000);
});
test('outgoing VAT modes control total and unit prices independently of legacy document basis',()=>{
  for(const [vatMode,supply,tax,total]of [['INCLUDED',909,91,1000],['EXCLUDED',1000,100,1100],['EXEMPT',1000,0,1000],['ZERO',1000,0,1000]]){
    for(const basis of ['세금포함','세금별도']){
      const p=parse({vatMode,basis,taxType:'면세'});assert.deepEqual(p.errors,[]);assert.deepEqual(amounts(p.rows[0]),{supply,tax,total,value:supply});
      const unit=parse({vatMode,basis,amountMode:'UNIT',totalAmount:undefined,quantity:'1',price:'1000'});assert.deepEqual(unit.errors,[]);assert.deepEqual(amounts(unit.rows[0]),{supply,tax,total,value:supply});
    }
  }
  assert.throws(()=>parse({vatMode:'INVALID'}),e=>e.code==='invalid-argument');
});
