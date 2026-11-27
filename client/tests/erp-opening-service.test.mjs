import * as erpAccess from '../src/utils/erpAccess.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=ts.transpileModule(readFileSync(new URL('../src/services/erpImportService.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(){
  const state={auth:{currentUser:{uid:'admin'}},session:{userData:{uid:'admin',companyId:'a',role:'ADMIN',status:'ACTIVE'},companyData:{id:'a',status:'ACTIVE'},sessionReady:true},reply:{companyId:'a',records:[]},calls:[],hook:null},module={exports:{}};
  const steps=[];
  state.auth.currentUser.email='admin@example.test';
  state.auth.currentUser.getIdToken=async force=>{assert.equal(force,true);steps.push('refresh');state.afterRefresh?.();};
  vm.runInNewContext(source,{module,exports:module.exports,setTimeout:callback=>callback(),require(name){
    if(name==='../utils/erpAccess')return erpAccess;
    if(name==='../firebase')return {auth:state.auth,functions:{}};
    if(name==='../store/authStore')return {useAuthStore:{getState:()=>state.session}};
    if(name==='firebase/functions')return {httpsCallable(){return async data=>{state.calls.push(data);state.hook?.();return {data:state.reply};};}};
    if(name==='firebase/auth')return {
      EmailAuthProvider:{credential:(email,password)=>({email,password})},
      reauthenticateWithCredential:async(user,credential)=>{
        assert.equal(user.uid,'admin');assert.equal(credential.email,'admin@example.test');
        if(credential.password!=='test-password')throw {code:'auth/invalid-credential'};
        steps.push('reauth');state.afterAuth?.();
      }
    };
    throw Error('Unexpected import '+name);
  }});return {api:module.exports.erpImportService,bootstrap:module.exports.erpBootstrapService,phrase:module.exports.BOOTSTRAP_CONFIRM_PHRASE,state,steps};
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

const pendingJob = () => ({id:'review-job',companyId:'a',fingerprint:'reviewed',status:'PENDING',
  protection:{hasExistingData:true,challengeIssuedAt:'2026-01-01T01:00:00.000Z'}});
test('ordinary bootstrap only accepts a protected preview of an empty ledger', async () => {
  const f=fixture(), job=pendingJob();
  for(const protection of [undefined, null, {}, job.protection]) {
    await assert.rejects(f.bootstrap.commit('a',{...job,protection}),/보호|기존 장부/);
  }
  assert.equal(f.state.calls.length,0);
  f.state.reply={bootstrap:{companyId:'a'}};
  await f.bootstrap.commit('a',{...job,protection:{...job.protection,hasExistingData:false}});
  assert.equal(f.state.calls[0].resetExisting,undefined);
});
test('reset sends only the reviewed job and explicit flags after password authentication and token refresh',async()=>{
  const f=fixture();
  f.state.reply={bootstrap:{companyId:'a'}};
  f.state.hook=()=>f.steps.push('commit');
  await f.bootstrap.reset('a',pendingJob(),true,'test-password',()=>true);
  assert.deepEqual(f.steps,['reauth','refresh','commit']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.calls[0])),{
    action:'commit',companyId:'a',id:'review-job',fingerprint:'reviewed',confirmPhrase:f.phrase,
    resetExisting:true,warningAccepted:true
  });
});
test('wrong password, incomplete warning, foreign job, changed session and closed screen prevent reset submission',async()=>{
  for(const kind of ['wrong password','unchecked','missing password','foreign','changed company','closed screen','revoked role']) {
    const f=fixture(), job=pendingJob();let current=true;
    if(kind==='foreign')job.companyId='b';
    if(kind==='changed company')f.state.afterAuth=()=>{f.state.session.userData.companyId='b';};
    if(kind==='closed screen')f.state.afterRefresh=()=>{current=false;};
    if(kind==='revoked role')f.state.afterRefresh=()=>{f.state.session.userData.role='SUB_ADMIN';};
    const password=kind==='wrong password'?'invalid':kind==='missing password'?'':'test-password';
    await assert.rejects(f.bootstrap.reset('a',job,kind!=='unchecked',password,()=>current));
    assert.equal(f.state.calls.length,0,kind);
  }
});

test('repair uses the new warning challenge and a fresh password login, including for a first import',async()=>{
  const f=fixture(), job=pendingJob();
  job.protection.hasExistingData=false;
  job.stage={status:'MISMATCH'};job.stageConflict={challenge:'server-repair',challengeIssuedAt:'2026-01-01T02:00:00Z'};
  f.state.reply={bootstrap:{companyId:'a',status:'COMMITTED'}};
  await assert.rejects(f.bootstrap.commit('a',job));
  await assert.rejects(f.bootstrap.reset('a',job,false,'test-password',()=>true));
  await assert.rejects(f.bootstrap.reset('a',job,true,'incorrect',()=>true));
  assert.equal(f.state.calls.length,0);
  await f.bootstrap.reset('a',job,true,'test-password',()=>true);
  const sent=f.state.calls[0];assert.equal(sent.repairStage,true);assert.equal(sent.repairWarningAccepted,true);
  assert.equal(sent.repairChallenge,'server-repair');assert.equal(sent.resetExisting,undefined);assert.equal(sent.password,undefined);
  assert.deepEqual(f.steps,['reauth','refresh']);
});

test('final activation after repairing an empty ledger refreshes auth without restarting the repair', async () => {
  const f = fixture(), job = pendingJob();
  job.protection.hasExistingData = false;
  job.protection.repairChallengeIssuedAt = '2026-01-01T02:00:00Z';
  f.state.reply = {bootstrap:{companyId:'a',status:'COMMITTED'}};
  await assert.rejects(f.bootstrap.commit('a',job));
  await f.bootstrap.reset('a',job,true,'test-password',()=>true);
  assert.deepEqual(f.steps,['reauth','refresh']);
  const sent = f.state.calls[0];
  assert.equal(sent.resetExisting,undefined);
  assert.equal(sent.repairStage,undefined);
  assert.equal(sent.repairChallenge,undefined);
});
