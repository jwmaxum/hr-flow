import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const servicePath = fileURLToPath(new URL('../src/services/payrollService.ts', import.meta.url));
const compiled = ts.transpileModule(readFileSync(servicePath, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const copy = value => JSON.parse(JSON.stringify(value));
const sourceInput = { name: 'payroll.csv', mimeType: 'text/csv', base64: 'YQ==' };
const pdf = { filename: 'payroll.pdf', mimeType: 'application/pdf', base64: Buffer.from('%PDF-local-test').toString('base64') };
const record = { id: 'record-a', companyId: 'company-a', revision: 2 };
const draft = { id: 'draft-a', companyId: 'company-a', draftVersion: 1, status: 'PENDING', rows: [{ companyId: 'company-a', userId: 'employee-a' }] };

function fixture() {
  const calls = [], downloads = [], urls = [], revoked = [], tokenCalls = [];
  const hooks = {};
  const store = {
    sessionReady: true,
    userData: { uid: 'admin-a', companyId: 'company-a', role: 'ADMIN', status: 'ACTIVE', mustChangePassword: false },
    companyData: { id: 'company-a', status: 'ACTIVE', subscriptionStatus: 'ACTIVE', accessUntil: '2099-01-01T00:00:00.000Z' },
  };
  const auth = { currentUser: { uid: 'admin-a', async getIdToken() { tokenCalls.push(true); await hooks.token?.(); return 'synthetic-token'; } } };
  const replies = {
    preview: { fingerprint: 'fingerprint-a' }, list: { records: [record], employees: [{ companyId: 'company-a', userId: 'employee-a' }] },
    approve: { record }, monthlyPdf: pdf, annualPdf: pdf,
    importSource: { draft }, startCorrection: { draft }, getDraft: { draft }, updateDraft: { draft }, cancelDraft: { draft }, getDraftVersion: { draft },
    listDrafts: { drafts: [draft] }, approveDraft: { record, draftId: 'draft-a', revision: 2 },
    listRevisions: { revisions: [record] }, listDraftVersions: { versions: [{ companyId: 'company-a', draftVersion: 1 }] },
    sourceDownload: { filename: 'payroll.csv', mimeType: 'text/csv', base64: 'YQ==', size: 1, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Uint8Array, Blob, btoa, atob,
    crypto: { subtle: { async digest(algorithm, bytes) { await hooks.digest?.(); return webcrypto.subtle.digest(algorithm, bytes); } } },
    URL: { createObjectURL(blob) { const url = `blob:local-${urls.length}`; urls.push({ url, blob }); return url; }, revokeObjectURL(url) { revoked.push(url); } },
    window: { setTimeout(callback) { callback(); return 1; } },
    document: {
      createElement(tag) {
        assert.equal(tag, 'a');
        return { href: '', download: '', click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {} };
      },
      body: { append() {} },
    },
    require(name) {
      if (name === '../firebase') return { auth, functions: {} };
      if (name === '../store/authStore') return { useAuthStore: { getState: () => store } };
      if (name === 'firebase/functions') return { httpsCallable(_functions, callable) {
        assert.equal(callable, 'managePayroll');
        return async payload => { calls.push(copy(payload)); await hooks.rpc?.(payload); return { data: copy(replies[payload.action]) }; };
      } };
      throw new Error(`Unexpected payroll test dependency: ${name}`);
    },
  }, { filename: servicePath });
  return {
    ...module.exports, store, auth, hooks, calls, replies, downloads, urls, revoked, tokenCalls,
    switchCompany() { store.userData.companyId = 'company-b'; store.companyData.id = 'company-b'; },
  };
}

const requests = [
  ['preview', [2026, 10], { year: 2026, month: 10 }],
  ['list', [2026], { year: 2026 }],
  ['approve', [2026, 10, 'fingerprint-a'], { year: 2026, month: 10, expectedFingerprint: 'fingerprint-a' }],
  ['monthlyPdf', ['record-a'], { id: 'record-a' }],
  ['monthlyPdf', ['record-a', 1], { id: 'record-a', revision: 1 }],
  ['annualPdf', [2026, 'employee-a'], { year: 2026, employeeId: 'employee-a' }],
  ['importSource', [2026, 10, 'verified source', sourceInput], { year: 2026, month: 10, reason: 'verified source', source: sourceInput }],
  ['startCorrection', ['record-a', 'verified correction'], { recordId: 'record-a', reason: 'verified correction' }],
  ['getDraft', ['draft-a'], { id: 'draft-a' }],
  ['updateDraft', ['draft-a', 1, 'corrected source amount', [{ userId: 'employee-a', amounts: { pension: 0 } }]],
    { id: 'draft-a', expectedDraftVersion: 1, reason: 'corrected source amount', rows: [{ userId: 'employee-a', amounts: { pension: 0 } }] }],
  ['cancelDraft', ['draft-a', 1, 'cancelled review'], { id: 'draft-a', expectedDraftVersion: 1, reason: 'cancelled review' }],
  ['getDraftVersion', ['draft-a', 1], { id: 'draft-a', draftVersion: 1 }],
  ['listDrafts', [2026], { year: 2026 }],
  ['approveDraft', ['draft-a', 1], { id: 'draft-a', expectedDraftVersion: 1 }],
  ['listRevisions', ['record-a'], { id: 'record-a' }],
  ['listDraftVersions', ['draft-a'], { id: 'draft-a' }],
  ['sourceDownload', [{ draftId: 'draft-a' }], { draftId: 'draft-a' }],
  ['sourceDownload', [{ recordId: 'record-a' }], { recordId: 'record-a' }],
  ['sourceDownload', [{ recordId: 'record-a', revision: 1 }], { recordId: 'record-a', revision: 1 }],
];

test('payroll RPCs derive company and actor on the server and retain explicit revision selectors', async t => {
  for (const [method, args, payload] of requests) {
    await t.test(`${method}: ${JSON.stringify(payload).slice(0, 65)}`, async () => {
      const f = fixture();
      await f.payrollService[method](...args);
      assert.deepEqual(f.calls, [{ action: method, ...payload }]);
      assert.equal(f.tokenCalls.length, 1);
      assert.equal(Object.hasOwn(f.calls[0], 'companyId'), false);
      assert.equal(Object.hasOwn(f.calls[0], 'actor'), false);
      assert.equal(Object.hasOwn(f.calls[0], 'actorId'), false);
    });
  }
});

test('payroll response company checks reject foreign drafts, rows, list metadata and revisions', async t => {
  const cases = [
    ['list', [2026], { records: [{ ...record, companyId: 'company-b' }], employees: [] }],
    ['list', [2026], { records: [], employees: [{ companyId: 'company-b' }] }],
    ['list', [2026], { records: null, employees: [] }],
    ['approve', [2026, 10, 'fingerprint-a'], { record: { ...record, companyId: 'company-b' } }],
    ['approveDraft', ['draft-a', 1], { record: { ...record, companyId: 'company-b' }, draftId: 'draft-a', revision: 2 }],
    ['approveDraft', ['draft-a', 1], { record, draftId: 'draft-b', revision: 2 }],
    ['approveDraft', ['draft-a', 1], { record, draftId: 'draft-a', revision: 1.2 }],
    ['listRevisions', ['record-a'], { revisions: [{ ...record, companyId: 'company-b' }] }],
    ['listDraftVersions', ['draft-a'], { versions: [{ companyId: 'company-b', draftVersion: 1 }] }],
    ['listDrafts', [2026], { drafts: [{ ...draft, companyId: 'company-b' }] }],
    ['listDrafts', [2026], { drafts: null }],
  ];
  for (const [method, args, reply] of cases) {
    await t.test(`${method} rejects foreign or malformed metadata`, async () => {
      const f = fixture(); f.replies[method] = reply;
      await assert.rejects(f.payrollService[method](...args));
      assert.equal(f.downloads.length, 0);
    });
  }
  for (const method of ['importSource', 'startCorrection', 'getDraft', 'updateDraft', 'cancelDraft', 'getDraftVersion']) {
    const request = requests.find(item => item[0] === method);
    for (const invalid of [
      { ...draft, companyId: 'company-b' },
      { ...draft, rows: [{ companyId: 'company-b', userId: 'foreign-employee' }] },
      { ...draft, rows: Array.from({ length: 2001 }, () => ({ companyId: 'company-a' })) },
      { ...draft, draftVersion: 0 }, { ...draft, status: 'INVALID' },
    ]) {
      const f = fixture(); f.replies[method] = { draft: invalid };
      await assert.rejects(f.payrollService[method](...request[1]));
    }
  }
});

test('payroll operations deny inactive or unverified sessions before acquiring tokens or calling RPCs', async t => {
  const invalidSessions = [
    ['signed out', f => { f.auth.currentUser = null; }],
    ['missing profile', f => { f.store.userData = null; }],
    ['wrong authenticated user', f => { f.auth.currentUser.uid = 'other-admin'; }],
    ['platform operator', f => { f.store.userData.role = 'SUPER_ADMIN'; }],
    ['sub administrator', f => { f.store.userData.role = 'SUB_ADMIN'; }],
    ['member', f => { f.store.userData.role = 'MEMBER'; }],
    ['resigned', f => { f.store.userData.status = 'RESIGNED'; }],
    ['suspended', f => { f.store.userData.status = 'SUSPENDED'; }],
    ['initial password', f => { f.store.userData.mustChangePassword = true; }],
    ['unverified session', f => { f.store.sessionReady = false; }],
    ['missing company', f => { f.store.companyData = null; }],
    ['missing company ID', f => { f.store.userData.companyId = ''; }],
    ['foreign company', f => { f.store.companyData.id = 'company-b'; }],
    ['suspended company', f => { f.store.companyData.status = 'SUSPENDED'; }],
    ['expired subscription without verified access', f => { f.store.companyData.subscriptionStatus = 'EXPIRED'; delete f.store.companyData.accessUntil; }],
    ['elapsed verified access window', f => { f.store.companyData.accessUntil = new Date(Date.now() - 1000).toISOString(); }],
    ['invalid verified access window', f => { f.store.companyData.accessUntil = 'invalid-access-time'; }],
  ];
  for (const [label, mutate] of invalidSessions) {
    await t.test(label, async () => {
      const f = fixture(); mutate(f);
      for (const [method, args] of requests) await assert.rejects(async () => f.payrollService[method](...args));
      assert.equal(f.tokenCalls.length, 0); assert.equal(f.calls.length, 0);
    });
  }
  const staleLabel = fixture(); staleLabel.store.companyData.subscriptionStatus = 'EXPIRED';
  await staleLabel.payrollService.getDraft('draft-a');
  assert.equal(staleLabel.calls.length, 1, 'a verified future entitlement takes precedence over a stale display label');
  const legacySession = fixture(); delete legacySession.store.companyData.accessUntil;
  await legacySession.payrollService.getDraft('draft-a');
  assert.equal(legacySession.calls.length, 1, 'older verified sessions still reach the authoritative server gate');
});

test('payroll responses from a previous user or company are discarded across token and RPC awaits', async t => {
  for (const checkpoint of ['token', 'rpc']) {
    for (const change of [
      f => f.switchCompany(), f => { f.auth.currentUser = null; },
      f => { f.store.userData.role = 'SUB_ADMIN'; }, f => { f.store.userData.mustChangePassword = true; },
      f => { f.store.companyData.subscriptionStatus = 'EXPIRED'; },
    ]) {
      await t.test(`changed session during ${checkpoint}`, async () => {
        const f = fixture(); f.hooks[checkpoint] = () => change(f);
        await assert.rejects(f.payrollService.getDraft('draft-a'));
        assert.equal(f.calls.length, checkpoint === 'token' ? 0 : 1);
        assert.equal(f.downloads.length, 0);
      });
    }
  }
  const f = fixture(); const previous = f.payrollSessionKey(); f.switchCompany();
  assert.throws(() => f.assertPayrollSession(previous));
});

test('failed token acquisition stops the RPC and failed RPCs expose no download', async () => {
  const tokenFailure = fixture(); tokenFailure.hooks.token = () => { throw new Error('Synthetic authentication failure'); };
  await assert.rejects(tokenFailure.payrollService.getDraft('draft-a'), /Synthetic authentication failure/);
  assert.equal(tokenFailure.calls.length, 0); assert.equal(tokenFailure.downloads.length, 0);
  const rpcFailure = fixture(); rpcFailure.hooks.rpc = () => { throw new Error('Synthetic request failure'); };
  await assert.rejects(rpcFailure.payrollService.getDraft('draft-a'), /Synthetic request failure/);
  assert.equal(rpcFailure.calls.length, 1); assert.equal(rpcFailure.downloads.length, 0);
});

function localFile(name, bytes, properties = {}) {
  return { name, size: bytes.length, type: 'untrusted-browser-type', async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }, ...properties };
}

test('payroll source selection bounds file size and extension and preserves original binary bytes', async () => {
  const f = fixture(); const scope = f.payrollSessionKey();
  const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
  const selected = await f.readPayrollSourceFile(localFile('source.CSV', bytes), scope);
  assert.deepEqual(copy(selected), { name: 'source.CSV', mimeType: 'text/csv', base64: Buffer.from(bytes).toString('base64') });
  const selectedXlsx = await f.readPayrollSourceFile(localFile('source.xlsx', bytes), scope);
  assert.equal(selectedXlsx.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const maximum = new Uint8Array(3 * 1024 * 1024);
  assert.equal((await f.readPayrollSourceFile(localFile('maximum.csv', maximum), scope)).base64.length, 4 * 1024 * 1024);
  for (const invalid of [
    localFile('empty.csv', new Uint8Array()), localFile('source.xls', bytes), localFile('source.csv.exe', bytes),
    localFile('large.csv', bytes, { size: 3 * 1024 * 1024 + 1 }), localFile('changed.csv', bytes, { size: bytes.length + 1 }),
  ]) await assert.rejects(f.readPayrollSourceFile(invalid, scope));
  assert.equal(f.calls.length, 0);
});

test('source selection discards file bytes after a company switch and rejects stale selection scopes', async () => {
  const f = fixture(); const scope = f.payrollSessionKey();
  const file = localFile('source.csv', new Uint8Array([65]), { async arrayBuffer() { f.switchCompany(); return new Uint8Array([65]).buffer; } });
  await assert.rejects(f.readPayrollSourceFile(file, scope));
  let read = false;
  await assert.rejects(f.readPayrollSourceFile(localFile('source.csv', new Uint8Array([65]), { async arrayBuffer() { read = true; } }), scope));
  assert.equal(read, false); assert.equal(f.calls.length, 0);
});

async function sourceFile(bytes, extras = {}) {
  const hash = await webcrypto.subtle.digest('SHA-256', bytes);
  return { filename: 'payroll.csv', mimeType: 'text/csv', base64: Buffer.from(bytes).toString('base64'),
    sha256: Buffer.from(hash).toString('hex'), size: bytes.length, ...extras };
}

test('source downloads verify hash and bytes before using a sanitized canonical filename', async () => {
  const f = fixture(); const bytes = new TextEncoder().encode('local payroll source\n');
  const file = await sourceFile(bytes, { filename: '../folder:bad\u0000.csv' });
  await f.downloadPayrollSourceFile(file, f.payrollSessionKey());
  assert.equal(f.downloads.length, 1); assert.equal(f.urls.length, 1);
  assert.equal(f.downloads[0].filename, '.._folder_bad_.csv');
  assert.equal(f.urls[0].blob.type, 'text/csv');
  assert.deepEqual(new Uint8Array(await f.urls[0].blob.arrayBuffer()), bytes);
  assert.deepEqual(f.revoked, [f.downloads[0].href]);
  const xlsx = await sourceFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
    filename: 'source.csv', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  await f.downloadPayrollSourceFile(xlsx, f.payrollSessionKey());
  assert.equal(f.downloads[1].filename, 'source.xlsx');
});

test('bad source download metadata, hash, size, MIME or signature never creates a Blob URL or clicks download', async () => {
  const good = await sourceFile(new Uint8Array([65]));
  const invalidFiles = [
    { ...good, mimeType: 'text/html' }, { ...good, base64: '' }, { ...good, base64: 'not base64' },
    { ...good, base64: 'A'.repeat(4 * 1024 * 1024 + 1) },
    { ...good, sha256: 'wrong' }, { ...good, sha256: '0'.repeat(64) }, { ...good, size: 2 },
    { ...good, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  ];
  for (const file of invalidFiles) {
    const f = fixture(); await assert.rejects(f.downloadPayrollSourceFile(file, f.payrollSessionKey()));
    assert.equal(f.urls.length, 0); assert.equal(f.downloads.length, 0);
  }
});

test('source and PDF downloads reject changed company scopes before exposing private data', async () => {
  const f = fixture(); const scope = f.payrollSessionKey(); const file = await sourceFile(new Uint8Array([65]));
  f.hooks.digest = () => f.switchCompany();
  await assert.rejects(f.downloadPayrollSourceFile(file, scope));
  assert.throws(() => f.downloadPayrollPdf(pdf, scope));
  assert.equal(f.urls.length, 0); assert.equal(f.downloads.length, 0);
  const ready = fixture(); ready.downloadPayrollPdf(pdf, ready.payrollSessionKey());
  assert.equal(ready.downloads.length, 1);
  assert.throws(() => ready.downloadPayrollPdf({ ...pdf, mimeType: 'text/html' }, ready.payrollSessionKey()));
  assert.throws(() => ready.downloadPayrollPdf({ ...pdf, base64: Buffer.from('not a PDF').toString('base64') }, ready.payrollSessionKey()));
  assert.equal(ready.downloads.length, 1);
});
