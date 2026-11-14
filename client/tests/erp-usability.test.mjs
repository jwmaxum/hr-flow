import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collectionMinor,collectionDraft} from '../src/utils/erpCollectionDraft.ts';
import {erpInputLocation} from '../src/utils/erpInputErrors.ts';

test('collection assistance accepts grouped amounts without silently rounding or accepting exponents',()=>{
  for(const [value,currency,expected]of [['1,100','KRW',1100],['1,234.50','USD',123450],['12.000','JPY',12],['0.0100','EUR',1],['90000000000.00','CNY',9000000000000]])assert.equal(collectionMinor(value,currency),expected);
  for(const [value,currency]of [['','KRW'],['0','KRW'],['1e3','KRW'],['1,10','KRW'],['-1','KRW'],['0.001','USD'],['1.1','JPY'],['9000000000001','KRW'],['1','BAD']])assert.throws(()=>collectionMinor(value,currency));
});
test('draft allocation shows shortage, unallocated funds and the 50 document limit explicitly',()=>{
  const input={mode:'NEW',currency:'KRW',amount:'1,100',lines:[{amount:'500'},{amount:'700'},{amount:''}]};
  assert.deepEqual(collectionDraft(input,0),{source:1100,total:1200,remaining:-100,error:''});
  assert.equal(collectionDraft({...input,mode:'EXISTING'},1300).remaining,100);
  assert.equal(collectionDraft({...input,lines:[]},0).remaining,1100);
  assert.match(collectionDraft({...input,lines:Array.from({length:51},()=>({amount:'1'}))},0).error,/50/);
  assert.match(collectionDraft({...input,lines:[{amount:'1e2'}]},0).error,/숫자/);
});
test('input locations accept only known controls and bounded rows, never arbitrary selectors',()=>{
  assert.deepEqual(erpInputLocation({details:{kind:'ERP_INPUT',field:'movementLine',row:2}}),{field:'movementLine',row:2});
  for(const details of [{kind:'ERP_INPUT',field:'#password'},{kind:'ERP_INPUT',field:'movementLine',row:51},{kind:'ERP_INPUT',field:'movementLine',row:0},{kind:'ERP_INPUT',field:'movementLine',row:'1'},{kind:'OTHER',field:'date'}])assert.equal(erpInputLocation({details}),undefined);
});
