import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createHash,webcrypto} from 'node:crypto';
import vm from 'node:vm';
const require=createRequire(import.meta.url),ts=require('typescript');
const source=ts.transpileModule(readFileSync(new URL('../src/services/erpControlService.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(){const module={exports:{}},state={scope:'admin:a',response:{},hook:null,readerHook:null},calls=[],downloads=[],events=[];
  vm.runInNewContext(source,{module,exports:module.exports,crypto:webcrypto,atob,Uint8Array,Event,window:{dispatchEvent:e=>events.push(e.type)},FileReader:class{readAsDataURL(){state.readerHook?.();this.result='data:image/png;base64,aGVsbG8=';this.onload();}},require(name){
    if(name==='firebase/functions')return {httpsCallable:()=>async data=>{calls.push(data);state.hook?.();return {data:state.response};}};
    if(name==='../firebase')return {functions:{}};
    if(name==='./erpLedgerService')return {erpScope:()=>state.scope};
    if(name==='./erpImportService')return {downloadErpFile:file=>downloads.push(file)};
    throw Error(name);
  }});return {...module.exports,state,calls,downloads,events};
}
const response=()=>{const bytes=Buffer.from('image fixture');return {companyId:'a',name:'확인.png',mimeType:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};};
test('evidence downloads require company, type and original byte integrity',async()=>{
  for(const bad of [{companyId:'b'},{name:'../evidence.png'},{mimeType:'text/html'},{sha256:'0'.repeat(64)},{size:1}]){const f=fixture();f.state.response={...response(),...bad};await assert.rejects(f.downloadEvidence('a','2026-10','proof','v1'));assert.equal(f.downloads.length,0);}
  const f=fixture();f.state.response=response();await f.downloadEvidence('a','2026-10','proof','v1');assert.equal(f.downloads.length,1);assert.equal(f.calls[0].archiveId,'v1');
});
test('reading local evidence or receiving a server reply cannot cross a changed session',async()=>{
  const f=fixture();f.state.readerHook=()=>{f.state.scope='other:b';};await assert.rejects(f.uploadEvidence('a','2026-10',1,'id',{size:10,type:'image/png',name:'proof.png'}),/권한/);assert.equal(f.calls.length,0);
  const g=fixture();g.state.response=response();g.state.hook=()=>{g.state.scope='other:b';};await assert.rejects(g.downloadEvidence('a','2026-10','id'));assert.equal(g.downloads.length,0);
});
test('only successful current-session approval decisions refresh the pending alert',async()=>{
  const f=fixture();await f.erpControl('a','decide',{id:'pending',decision:'APPROVE'});assert.deepEqual(f.events,['erp:approvals-changed']);
  const g=fixture();g.state.hook=()=>{g.state.scope='revoked';};await assert.rejects(g.erpControl('a','decide',{}));assert.deepEqual(g.events,[]);
});
