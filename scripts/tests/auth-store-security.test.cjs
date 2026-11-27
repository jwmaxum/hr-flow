const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('../../client/node_modules/typescript');
const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,'../../client/src/store/authStore.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const tick = async () => { for (let i=0;i<15;i++) await Promise.resolve(); };
function fixture() {
  let authListener = null; let signouts = 0; let state;
  const responses = [], subscriptions = [], timers = [];
  const auth = {currentUser:null,async signOut(){signouts++;this.currentUser=null;authListener?.(null);}};
  const create = initialize => {
    const set = update => {state={...state,...(typeof update==='function'?update(state):update)};};
    state=initialize(set,()=>state); const use=()=>state;use.getState=()=>state;return use;
  };
  const module={exports:{}};
  vm.runInNewContext(compiled,{module,exports:module.exports,Error,Date,JSON,Symbol,Promise,setTimeout(callback){timers.push(callback);return timers.length;},clearTimeout(){},require(name){
    if(name==='zustand')return{create};
    if(name==='firebase/auth')return{onAuthStateChanged(_auth,callback){authListener=callback;return()=>{authListener=null;};}};
    if(name==='firebase/firestore')return{doc(_db,collection,id){return{path:`${collection}/${id}`};},onSnapshot(ref,next,error){const subscription={path:ref.path,next,error,active:true};subscriptions.push(subscription);return()=>{subscription.active=false;};}};
    if(name==='../firebase')return{auth,db:{}};
    if(name==='../services/accountSecurityService')return{accountSecurity:{async session(){assert.ok(responses.length,'unexpected session call');const response=responses.shift();if(response instanceof Error)throw response;return typeof response==='function'?response():response;}}};
    throw new Error(`unexpected module ${name}`);
  }});
  const store=module.exports.useAuthStore;
  store.getState().initAuth();
  return{store,auth,responses,subscriptions,timers,get signouts(){return signouts;},async login(uid,response){responses.push(response);auth.currentUser={uid,email:`${uid}@audit.test`};authListener(auth.currentUser);await tick();},snapshot(path,data){const sub=subscriptions.filter(item=>item.active&&item.path===path).at(-1);assert.ok(sub,`missing ${path}`);sub.next({exists:()=>data!==null,data:()=>data});}};
}
const profile=(uid='a',extra={})=>({uid,name:'Audit employee',email:`${uid}@audit.test`,companyId:'tenant-a',role:'MEMBER',status:'ACTIVE',teamId:'team-a',divisionId:'division-a',mustChangePassword:false,...extra});
const company={id:'tenant-a',nameKo:'Audit company',status:'ACTIVE',accessUntil:'2999-01-01T00:00:00.000Z'};
const ready=(uid='a',extra={})=>({profile:profile(uid,extra),company,businessAllowed:true});
test('client account authorization state transitions', async t => {
  await t.test('pending initial password exposes only session profile and starts no full listeners',async()=>{
    const f=fixture();await f.login('a',{profile:profile('a',{mustChangePassword:true}),company,businessAllowed:false});
    assert.equal(f.store.getState().sessionReady,false);assert.equal(f.store.getState().isLoginModalOpen,true);assert.equal(f.subscriptions.length,0);
    f.store.getState().setLoginModalOpen(false);assert.equal(f.store.getState().isLoginModalOpen,true);
  });
  await t.test('ready account subscribes only its own profile and own company',async()=>{
    const f=fixture();await f.login('a',ready());assert.equal(f.store.getState().sessionReady,true);
    assert.deepEqual(f.subscriptions.map(s=>s.path),['UserProfile/a','companies/tenant-a']);
    f.snapshot('UserProfile/a',{...profile(),annualSalary:12345});assert.equal(f.store.getState().userData.annualSalary,12345);
    await f.store.getState().logout();assert.equal(f.store.getState().userData,null);assert.ok(f.subscriptions.every(s=>!s.active));
  });
  await t.test('expired account keeps safe subscription metadata without private profile reads',async()=>{
    const f=fixture();await f.login('a',{profile:profile(),company,businessAllowed:false});
    assert.equal(f.store.getState().sessionReady,false);assert.equal(f.store.getState().companyData.subscriptionStatus,'EXPIRED');assert.equal(f.subscriptions.length,0);
  });
  await t.test('normal ERP writes keep the mounted workspace and company listener intact',async()=>{
    const f=fixture(), path='companies/tenant-a';
    await f.login('a',ready());
    f.snapshot(path,company);
    const mounted=f.store.getState();
    f.snapshot(path,{...company,erpLedgerWriteRevision:1});
    f.snapshot(path,{...company,erpLedgerWriteRevision:2});
    f.snapshot(path,{...company,erpLedgerWriteRevision:2});
    assert.strictEqual(f.store.getState(),mounted);
    assert.ok(f.subscriptions.every(s=>s.active));
  });
  await t.test('ledger cutover and company setting updates invalidate the mounted workspace even with a revision bump',async()=>{
    for(const change of [{erpActiveLedgerVersion:'v2'},{nameKo:'Changed company'},{accessUntil:'2020-01-01T00:00:00.000Z'}]){
      const f=fixture(), path='companies/tenant-a';
      await f.login('a',ready());
      f.snapshot(path,{...company,erpActiveLedgerVersion:'v1',erpLedgerWriteRevision:10});
      let finish;
      f.responses.push(()=>new Promise(resolve=>{finish=resolve;}));
      f.snapshot(path,{...company,erpActiveLedgerVersion:'v1',...change,erpLedgerWriteRevision:11});
      assert.equal(f.store.getState().loading,true);
      assert.equal(f.store.getState().sessionReady,false);
      assert.equal(f.store.getState().userData,null);
      assert.ok(f.subscriptions.every(s=>!s.active));
      finish({...ready(),company:{...company,...change},businessAllowed:!change.accessUntil});
      await tick();
      assert.equal(f.store.getState().sessionReady,!change.accessUntil);
    }
  });
  await t.test('state refusal signs out and clears profile and company caches',async()=>{
    const f=fixture();await f.login('a',Object.assign(new Error('inactive account'),{code:'functions/permission-denied'}));
    assert.equal(f.signouts,1);assert.equal(f.store.getState().user,null);assert.equal(f.store.getState().userData,null);assert.equal(f.store.getState().companyData,null);assert.equal(f.store.getState().sessionReady,false);
  });
  await t.test('a late previous-user session cannot replace the new user',async()=>{
    const f=fixture();let resolveOld;await f.login('old',()=>new Promise(resolve=>{resolveOld=resolve;}));
    await f.login('new',ready('new'));resolveOld(ready('old'));await tick();
    assert.equal(f.store.getState().userData.uid,'new');assert.ok(f.subscriptions.every(s=>!s.path.includes('/old')));
  });
  await t.test('network failure stays blocked and explicit session retry restores authorization',async()=>{
    const f=fixture();await f.login('a',Object.assign(new Error('offline'),{code:'functions/unavailable'}));
    assert.equal(f.signouts,0);assert.equal(f.store.getState().sessionReady,false);assert.equal(f.store.getState().userData,null);assert.ok(f.store.getState().authError);
    f.responses.push(ready());await f.store.getState().refreshSession();assert.equal(f.store.getState().sessionReady,true);assert.equal(f.store.getState().authError,null);
  });
  await t.test('role or division changes clear private data before a fresh session is accepted',async()=>{
    const f=fixture();await f.login('a',ready('a',{role:'ADMIN'}));let resolve;
    f.responses.push(()=>new Promise(done=>{resolve=done;}));f.snapshot('UserProfile/a',profile('a',{role:'SUB_ADMIN',divisionId:'division-b',annualSalary:999}));
    assert.equal(f.store.getState().sessionReady,false);assert.equal(f.store.getState().userData,null);
    resolve(ready('a',{role:'SUB_ADMIN',divisionId:'division-b'}));await tick();assert.equal(f.store.getState().userData.divisionId,'division-b');assert.equal(f.store.getState().userData.annualSalary,undefined);
  });
  await t.test('an access deadline callback rechecks server entitlement before further work',async()=>{
    const f=fixture();await f.login('a',ready());assert.equal(f.timers.length,1);
    f.responses.push({profile:profile(),company,businessAllowed:false});f.timers[0]();await tick();assert.equal(f.store.getState().sessionReady,false);assert.ok(f.subscriptions.every(s=>!s.active));
  });
});
