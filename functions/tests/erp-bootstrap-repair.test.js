const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createErpBootstrapService, CONFIRM_PHRASE } = require('../erp-bootstrap-service');
const { workbook, opening, cell } = require('./erp-import-fixtures.cjs');

test('empty-ledger stage repair requires a new password challenge, preserves ownership, and rejects changed canonical uploads', async t => {
  assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(localhost|127\.0\.0\.1):\d+$/);
  const project = 'demo-erp-repair';
  const app = initializeApp({projectId:project}, 'repair-' + randomUUID());
  t.after(() => deleteApp(app));
  const db = getFirestore(app);
  const company = db.collection('companies').doc('repair-' + randomUUID());
  const uid = 'owner-' + randomUUID(), other = 'other-' + randomUUID();
  const date = new Date('2026-11-27T00:00:00Z');
  const service = createErpBootstrapService({db,now:() => new Date(date)});
  await company.set({nameKo:'복원 검증 회사',status:'ACTIVE',accessUntil:Timestamp.fromDate(new Date('2031-01-01Z'))});
  for (const id of [uid,other]) await db.doc('UserProfile/'+id).set({uid:id,companyId:company.id,role:'ADMIN',status:'ACTIVE'});
  const request = (data, options = {}) => service({auth:{uid:options.uid || uid,token:{
    auth_time:Math.floor(+date/1000) - (options.age || 0),firebase:{sign_in_provider:options.provider || 'password'}
  }},data:{...data,companyId:company.id}});
  const source = await workbook('OPENING',[opening()],{company:'복원 검증 회사',modifyZip:async zip => {
    const name = 'xl/worksheets/sheet1.xml';
    zip.file(name,cell(cell(await zip.file(name).async('string'),'B7','WH-01'),'B8','본사 창고'));
  }});
  const reject = (promise,code) => assert.rejects(promise,error => error.code === code);
  const stage = versionId => company.collection('erpLedgerVersions').doc(versionId);
  const inventory = versionId => stage(versionId).collection('ledger').doc(company.id).collection('erpInventory');
  const preview = id => request({action:'preview',id,source});
  let first = (await preview('restore-first')).bootstrap;
  const control = company.collection('erpBootstrapJobs').doc(first.id);
  const candidate = stage(first.stage.versionId);
  // Freeze the isolated fixture at the point after upload pages are committed but
  // before the client receives a verified preview; retry must reuse this job.
  const interrupted = db.batch();
  interrupted.update(control,{'status':'PREPARING','stage.status':'PREPARING'});
  interrupted.update(candidate,{state:'PREPARING'});
  await interrupted.commit();
  assert.equal((await request({action:'get',id:first.id})).bootstrap.status,'PREPARING');
  const resumed = (await preview(first.id)).bootstrap;
  assert.equal(resumed.fingerprint,first.fingerprint);
  assert.equal(resumed.stage.versionId,first.stage.versionId);
  assert.equal(resumed.stage.status,'VERIFIED');
  first = resumed;
  assert.equal(first.protection.hasExistingData,false);

  async function mismatch(job) {
    const doc = (await inventory(job.stage.versionId).get()).docs[0];
    await doc.ref.update({quantity:99,value:999});
    const normal = {action:'commit',id:job.id,fingerprint:job.fingerprint,confirmPhrase:CONFIRM_PHRASE};
    const result = await request(normal);
    assert.equal(result.stageMismatch,true);
    assert.equal(result.bootstrap.stage.status,'MISMATCH');
    assert.equal((await company.get()).get('erpActiveLedgerVersion'),undefined);
    return {...normal,repairStage:true,repairWarningAccepted:true,repairChallenge:result.bootstrap.stageConflict.challenge};
  }

  const fix = await mismatch(first);
  await reject(request({action:'get',id:first.id},{uid:other}),'permission-denied');
  await reject(request(fix,{uid:other}),'permission-denied');
  await reject(request(fix),'failed-precondition');
  date.setSeconds(date.getSeconds()+2);
  await reject(request({...fix,repairWarningAccepted:false}),'failed-precondition');
  await reject(request({...fix,repairChallenge:'different'}),'failed-precondition');
  await reject(request(fix,{provider:'google.com'}),'failed-precondition');

  // A damaged canonical source is not eligible for override even with both consents.
  const damaged = (await preview('damaged')).bootstrap;
  const secondFix = await mismatch(damaged);
  const page = company.collection('erpBootstrapJobs').doc(damaged.id).collection('uploadPages').doc('00000000');
  const entries = (await page.get()).get('entries');
  entries[0].data.notes = '변경된 원본';
  await page.update({entries});
  date.setSeconds(date.getSeconds()+2);
  await reject(request(secondFix),'data-loss');
  assert.equal((await company.get()).get('erpActiveLedgerVersion'),undefined);
  assert.equal((await company.collection('erpBootstrapBackups').get()).size,0);

  // Simulate a large reconstruction outliving the 5-minute reauthentication.
  // Sealing reuses the recorded approval; only the final pointer waits for reauth.
  const originalRead = db.getAll.bind(db);
  let advance = true;
  db.getAll = (...refs) => {
    if (advance && refs.some(ref => ref.path?.includes('/restore-first/uploadPages/'))) {
      advance = false;
      date.setSeconds(date.getSeconds()+301);
    }
    return originalRead(...refs);
  };
  await reject(request(fix),'failed-precondition');
  const sealed = (await request({action:'get',id:first.id})).bootstrap;
  assert.equal(sealed.stage.status,'VERIFIED');
  assert.equal(sealed.stageConflict,null);
  assert.ok(sealed.protection.repairChallengeIssuedAt);
  assert.ok((await control.get()).get('activationSeal'));
  assert.equal((await company.get()).get('erpActiveLedgerVersion'),undefined);
  db.getAll = originalRead;
  const continuation = {action:'commit',id:first.id,fingerprint:first.fingerprint,confirmPhrase:CONFIRM_PHRASE};
  await reject(request(continuation,{provider:'google.com'}),'failed-precondition');
  const repaired = await request(continuation);
  assert.equal(repaired.bootstrap.status,'COMMITTED');
  assert.equal(repaired.bootstrap.backup,null);
  assert.notEqual(repaired.bootstrap.stage.versionId,first.stage.versionId);
  assert.equal((await inventory(repaired.bootstrap.stage.versionId).get()).docs[0].get('quantity'),10);
  assert.equal((await inventory(first.stage.versionId).get()).docs[0].get('quantity'),99);
  assert.equal((await request(fix)).idempotent,true);
});
