import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto,createHash} from 'node:crypto';
import vm from 'node:vm';
import readXlsx from 'read-excel-file/node';
import JSZip from 'jszip';
import {financeWorkbook} from '../src/utils/erpFinanceWorkbook.ts';
const require=createRequire(import.meta.url),fixtures=require('../../functions/tests/erp-finance-export-fixtures.cjs');

test('financial workbooks preserve all rows, source totals, foreign decimal amounts and inert identifiers',async()=>{
  for(const report of [fixtures.monthly(105),fixtures.statement(105)]){
    const buffer=Buffer.from(await(await financeWorkbook(report)).arrayBuffer()),sheets=await readXlsx(buffer),zip=await JSZip.loadAsync(buffer);
    assert.equal(sheets.length,report.sections.length+1);assert.ok(JSON.stringify(sheets[0]).includes(report.snapshot));
    for(let i=0;i<report.sections.length;i++){
      const expected=report.sections[i],actual=sheets[i+1].data;
      assert.deepEqual(actual[0],expected.columns.map(c=>c.label));assert.equal(actual.length,expected.rows.length+1);
      for(let r=0;r<expected.rows.length;r++)assert.deepEqual(actual[r+1],expected.rows[r]);
      assert.equal((await zip.file(`xl/worksheets/sheet${i+2}.xml`).async('string')).includes('<f>'),false);
    }
    assert.match(await zip.file('xl/workbook.xml').async('string'),/_xlnm.Print_Titles/);
    assert.match(await zip.file('xl/worksheets/sheet1.xml').async('string'),/orientation="landscape"/);
  }
});
const source=require('typescript').transpileModule(readFileSync(new URL('../src/services/erpFinanceExportService.ts',import.meta.url),'utf8'),{compilerOptions:{target:99,module:1}}).outputText;
function fixture(){
  const bytes=Buffer.from('%PDF-synthetic'),state={scope:'admin:a',calls:[],clicks:0,blobs:[],hook:null,hashHook:null,reply:{companyId:'a',kind:'DASHBOARD',month:'2026-11',asOf:'2026-11-13',partnerId:'',sourceSnapshot:'a'.repeat(64),snapshot:'b'.repeat(64),name:'ERP_월별보고서_2026-11.pdf',mimeType:'application/pdf',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')}};
  const module={exports:{}};
  vm.runInNewContext(source,{module,exports:module.exports,Uint8Array,Number,Blob,Set,atob,setTimeout:fn=>fn(),URL:{createObjectURL(blob){state.blobs.push(blob);return 'blob:test';},revokeObjectURL(){}},document:{createElement(){return {click(){state.clicks++;}};}},crypto:{subtle:{async digest(...args){state.hashHook?.();return webcrypto.subtle.digest(...args);}}},require(name){
    if(name==='../firebase')return {functions:{}};
    if(name==='./erpLedgerService')return {erpScope(id,write){assert.equal(id,'a');assert.equal(write,true);if(!state.scope)throw Error('denied');return state.scope;}};
    if(name==='firebase/functions')return {httpsCallable(){return async input=>{state.calls.push(input);state.hook?.();return {data:state.reply};};}};
    throw Error(`Unexpected import ${name}`);
  }});return {state,download:module.exports.downloadFinanceReport};
}
const request={companyId:'a',kind:'DASHBOARD',month:'2026-11',snapshot:'a'.repeat(64)};
test('private report downloads verify snapshot, file integrity and session before exposing a PDF',async()=>{
  let f=fixture();await f.download(request,'PDF');assert.equal(f.state.clicks,1);assert.equal(f.state.calls[0].action,'dashboardExport');assert.equal(f.state.calls[0].format,'PDF');
  for(const patch of [{companyId:'b'},{month:'2026-10'},{sourceSnapshot:'c'.repeat(64)},{partnerId:'foreign'},{kind:'STATEMENT'},{mimeType:'text/html'},{name:'../file.pdf'},{sha256:'0'.repeat(64)},{size:999},{base64:'bad!'},{base64:Buffer.from('<html>').toString('base64'),size:6}]){
    f=fixture();Object.assign(f.state.reply,patch);await assert.rejects(f.download(request,'PDF'));assert.equal(f.state.clicks,0);assert.equal(f.state.blobs.length,0);
  }
  for(const stage of ['hook','hashHook']){f=fixture();f.state[stage]=()=>{f.state.scope='other';};await assert.rejects(f.download(request,'PDF'),/권한/);assert.equal(f.state.clicks,0);}
  f=fixture();f.state.scope='';await assert.rejects(f.download(request,'PDF'),/denied/);assert.equal(f.state.calls.length,0);
});
test('partner print requests bind the selected partner and as-of date instead of accepting another statement',async()=>{
  const f=fixture(),input={companyId:'a',kind:'STATEMENT',partnerId:'buyer',to:'2026-11-13',snapshot:'a'.repeat(64)};Object.assign(f.state.reply,{kind:'STATEMENT',month:'',partnerId:'buyer'});
  await f.download(input,'PDF');assert.equal(f.state.calls[0].action,'statementExport');assert.equal(f.state.calls[0].partnerId,'buyer');assert.equal(f.state.calls[0].to,input.to);
  f.state.reply.partnerId='other';await assert.rejects(f.download(input,'PDF'),/조회 조건/);assert.equal(f.state.clicks,1);
});
