import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=ts.transpileModule(readFileSync(new URL('../src/services/erpLedgerService.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(){const state={userData:{uid:'member',companyId:'a',role:'MEMBER',erpAccess:'INBOUND',status:'ACTIVE'},companyData:{id:'a',status:'ACTIVE'},sessionReady:true},calls=[],module={exports:{}},hook={fn:null};vm.runInNewContext(source,{module,exports:module.exports,require(name){if(name==='../firebase')return {auth:{currentUser:{uid:'member'}},functions:{}};if(name==='../store/authStore')return {useAuthStore:{getState:()=>state}};if(name==='firebase/functions')return {httpsCallable:()=>async input=>{calls.push(input);hook.fn?.();return {data:{correction:{status:'AWAITING_APPROVAL'},approvalRequested:true}};}};throw Error(name);}});return {...module.exports,state,calls,hook};}
test('assigned operators can submit correction requests but cannot enter ADMIN financial scope',async()=>{const f=fixture();assert.ok(f.erpScope('a','operator'));assert.throws(()=>f.erpScope('a',true));const r=await f.erpLedgerService.commit('a',{id:'correction',fingerprint:'reviewed'});assert.equal(r.approvalRequested,true);assert.equal(f.calls.length,1);});
test('ERP access is denied without a grant and downgraded responses are discarded',async()=>{const f=fixture();f.state.userData.erpAccess='NONE';assert.throws(()=>f.erpScope('a'));await assert.rejects(f.erpLedgerService.meta('a'));assert.equal(f.calls.length,0);f.state.userData.erpAccess='BOTH';f.hook.fn=()=>{f.state.userData.erpAccess='OUTBOUND';};await assert.rejects(f.erpLedgerService.preview('a','id',{}),/권한/);});
