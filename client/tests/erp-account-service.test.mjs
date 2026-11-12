import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=ts.transpileModule(readFileSync(new URL('../src/services/erpAccountService.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(){
  const state={scope:'admin:a',reply:{companyId:'a'},calls:[],hook:null},module={exports:{}};
  vm.runInNewContext(source,{module,exports:module.exports,Intl,Date,require(name){
    if(name==='../firebase')return {functions:{}};
    if(name==='./erpService')return {erpService:{}};
    if(name==='./erpLedgerService')return {erpScope(company,write){assert.equal(company,'a');assert.equal(write,true);if(!state.scope)throw Error('denied');return state.scope;}};
    if(name==='firebase/functions')return {httpsCallable(_f,fn){return async data=>{state.calls.push({fn,data});state.hook?.();return {data:state.reply};};}};
    throw Error(`Unexpected import ${name}`);
  }});return {...module.exports,state};
}
test('private money and custody responses cannot cross a changed session or company',async()=>{
  for(const name of ['erpFinance','erpCustody']) {
    const invoke=f=>name==='erpFinance'?f.erpFinance.report('a','2026-01-01','2026-12-31'):f.erpCustody.list('a');
    let f=fixture();f.state.scope='';await assert.rejects(invoke(f),/denied/);assert.equal(f.state.calls.length,0);
    f=fixture();f.state.hook=()=>{f.state.scope='foreign:b';};await assert.rejects(invoke(f),/권한/);
    for(const reply of [null,{}, {companyId:'b'}, {job:{companyId:'b'}}]){f=fixture();f.state.reply=reply;await assert.rejects(invoke(f),/소속/);}
  }
});
test('confirmation preserves the reviewed identifier and fingerprint, and rejects foreign jobs',async()=>{
  for(const name of ['erpFinance','erpCustody']) {
    const f=fixture(),job={id:'job-a',fingerprint:'review-a',companyId:'a'};f.state.reply={job};await f[name].commit('a',job);
    assert.deepEqual(JSON.parse(JSON.stringify(f.state.calls[0].data)),{id:'job-a',fingerprint:'review-a',companyId:'a',action:'commit'});
    f.state.reply={job:{...job,companyId:'b'}};await assert.rejects(f[name].commit('a',job),/소속/);
  }
});
test('minor currency units display consistently including refund balances',()=>{
  const f=fixture();assert.equal(f.erpMoney(123,'KRW'),'123');assert.equal(f.erpMoney(123,'JPY'),'123');assert.equal(f.erpMoney(123,'USD'),'1.23');assert.equal(f.erpMoney(-123,'EUR'),'-1.23');
});
test('document allocation uses the reviewed job and preserves company session checks',async()=>{
  const f=fixture();await f.erpFinance.settlements('a','2026-11-13','buyer');
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.calls[0].data)),{companyId:'a',action:'settlementReport',to:'2026-11-13',partnerId:'buyer'});
  const job={id:'allocation-a',companyId:'a',fingerprint:'reviewed'};f.state.reply={job};await f.erpFinance.commitSettlement('a',job);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.calls[1].data)),{companyId:'a',action:'settlementCommit',id:job.id,fingerprint:job.fingerprint});
  f.state.hook=()=>{f.state.scope='foreign:b';};await assert.rejects(f.erpFinance.settlements('a','2026-11-13'),/권한/);
});
