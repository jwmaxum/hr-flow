import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=ts.transpileModule(readFileSync(new URL('../src/services/erpImportService.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(){
  const state={auth:{currentUser:{uid:'admin'}},session:{userData:{uid:'admin',companyId:'a',role:'ADMIN',status:'ACTIVE'},companyData:{id:'a',status:'ACTIVE'},sessionReady:true},reply:{companyId:'a',records:[]},calls:[],hook:null},module={exports:{}};
  vm.runInNewContext(source,{module,exports:module.exports,require(name){
    if(name==='../firebase')return {auth:state.auth,functions:{}};
    if(name==='../store/authStore')return {useAuthStore:{getState:()=>state.session}};
    if(name==='firebase/functions')return {httpsCallable(){return async data=>{state.calls.push(data);state.hook?.();return {data:state.reply};};}};
    throw Error('Unexpected import '+name);
  }});return {api:module.exports.erpImportService,state};
}
test('pending inventory requires the active company administrator and rejects foreign response data',async()=>{
  for(const mutate of [f=>{f.state.auth.currentUser=null;},f=>{f.state.session.userData.role='MEMBER';},f=>{f.state.session.companyData.id='b';},f=>{f.state.session.sessionReady=false;}]){
    const f=fixture();mutate(f);await assert.rejects(f.api.openingList('a'),/관리자/);assert.equal(f.state.calls.length,0);
  }
  const f=fixture();f.state.reply={companyId:'b',records:[]};await assert.rejects(f.api.openingList('a'),/소속/);
});
test('pending inventory replies cannot cross a sign-out or company change during the request',async()=>{
  const f=fixture();f.state.hook=()=>{f.state.session.userData.companyId='b';};await assert.rejects(f.api.openingList('a'),/관리자/);
  const p=fixture();p.state.reply={import:{companyId:'b'}};await assert.rejects(p.api.openingPreview('a','job',{}),/소속/);
});
test('opening cost requests preserve explicit decimal costs, empty quantities and zero-cost acknowledgement',async()=>{
  const f=fixture(),opening={date:'2026-11-13',warehouseId:'wh',reason:'원가 확인',zeroCostConfirmed:false,lines:[{itemId:'part',quantity:'',price:'10.1234'}]};f.state.reply={import:{companyId:'a'}};
  await f.api.openingPreview('a','job',opening);assert.deepEqual(JSON.parse(JSON.stringify(f.state.calls[0])),{action:'openingPreview',companyId:'a',id:'job',opening});
});
