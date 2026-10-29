const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAttachmentService, MAX_BYTES } = require('../attachment-service');

const clock = new Date('2026-10-24T01:00:00.000Z');
const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const pdf = Buffer.from('%PDF-1.7\nfixture');
function fixture() {
  const records = new Map(), files = new Map(), saved = [], verification = [];
  const context = { afterSave: null, afterDownload: null, nextId: 0 };
  const company = id => records.set(`companies/${id}`, { status: 'ACTIVE', accessUntil: { toMillis: () => clock.getTime() + 86400000 } });
  company('a'); company('b');
  for (const [uid, role, companyId, divisionId] of [
    ['owner', 'MEMBER', 'a', 'one'], ['peer', 'MEMBER', 'a', 'two'], ['admin', 'ADMIN', 'a', ''],
    ['manager', 'SUB_ADMIN', 'a', 'one'], ['wrong-division', 'SUB_ADMIN', 'a', 'two'], ['foreign', 'ADMIN', 'b', ''],
  ]) records.set(`UserProfile/${uid}`, { uid, role, companyId, divisionId, status: 'ACTIVE', mustChangePassword: false });
  const db = { collection: name => ({ doc: id => ({ get: async () => ({ exists: records.has(`${name}/${id}`), data: () => {
    const value = records.get(`${name}/${id}`); return value && { ...value };
  } }) }) }) };
  const auth = { verifyIdToken: async (token, checkRevoked) => {
    verification.push({ token, checkRevoked });
    if (!token.startsWith('fixture:') || token === 'fixture:revoked') throw new Error('fixture invalid token');
    return { uid: token.slice(8), auth_time: clock.getTime() / 1000 };
  } };
  const bucket = { name: 'fixture.appspot.com', file: path => ({
    save: async (bytes, options) => {
      assert.equal(options.preconditionOpts.ifGenerationMatch, 0);
      if (files.has(path)) throw Object.assign(new Error('immutable object exists'), { code: 412 });
      files.set(path, { bytes: Buffer.from(bytes), metadata: { ...options.metadata, size: String(bytes.length) } });
      saved.push({ path, options }); if (context.afterSave) await context.afterSave(path);
    },
    getMetadata: async () => {
      if (!files.has(path)) throw Object.assign(new Error('missing fixture object'), { code: 404 });
      return [{ ...files.get(path).metadata }];
    },
    download: async options => {
      assert.equal(options.validation, 'crc32c');
      const file = files.get(path); if (!file) throw Object.assign(new Error('missing fixture object'), { code: 404 });
      const bytes = Buffer.from(file.bytes); if (context.afterDownload) await context.afterDownload(path); return [bytes];
    },
    delete: async () => { files.delete(path); },
  }) };
  const service = createAttachmentService({ db, auth, bucket, now: () => clock, uuid: () => `00000000-0000-4000-8000-${String(++context.nextId).padStart(12, '0')}` });
  async function invoke(action, uid = 'owner', overrides = {}) {
    const headers = { Authorization: uid ? `Bearer fixture:${uid}` : '', Origin: 'https://hr-flow.pages.dev', 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('증빙 원본.png'), ...overrides.headers };
    const req = { method: action === 'upload' ? 'POST' : 'GET', query: { category: 'expenses', documentId: 'record', ...overrides.query }, rawBody: png, ...overrides,
      get: name => Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] };
    const res = { statusCode: 200, headers: {}, ended: false,
      set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
      status(value) { this.statusCode = value; return this; },
      json(value) { this.body = value; this.ended = true; return this; }, send(value) { this.body = value; this.ended = true; return this; } };
    await service[action](req, res); assert.equal(res.ended, true); return res;
  }
  async function seed(category = 'expenses', uid = 'owner', bytes = png, contentType = 'image/png') {
    const uploaded = await invoke('upload', uid, { query: { category }, rawBody: bytes, headers: { 'Content-Type': contentType } });
    assert.equal(uploaded.statusCode, 200);
    const owner = records.get(`UserProfile/${uid}`);
    records.set(`${category}/record`, { companyId: owner.companyId, userId: uid, authorId: uid, divisionId: owner.divisionId,
      attachmentPath: uploaded.body.path, attachmentName: '증빙 원본.png' });
    return uploaded.body.path;
  }
  return { records, files, saved, verification, context, invoke, seed, bucket };
}

test('attachment HTTP verifies bearer revocation, denies missing identity and limits CORS/methods', async () => {
  const f = fixture();
  assert.equal((await f.invoke('upload', null)).statusCode, 401);
  assert.equal((await f.invoke('upload', 'revoked')).statusCode, 401);
  assert.equal((await f.invoke('upload', 'owner', { headers: { Authorization: 'Bearer token with spaces' } })).statusCode, 401);
  assert.equal((await f.invoke('upload', 'owner', { headers: { Origin: 'https://attacker.invalid' } })).statusCode, 403);
  assert.equal((await f.invoke('upload', null, { method: 'OPTIONS' })).statusCode, 204);
  assert.equal((await f.invoke('upload', 'owner', { method: 'GET' })).statusCode, 405);
  assert.ok(f.verification.every(entry => entry.checkRevoked === true)); assert.equal(f.files.size, 0);
});

test('both production origins allow attachment preflights but never authorize anonymous requests', async () => {
  for (const origin of ['https://hr-flow.pages.dev', 'https://hr-flow-chj.pages.dev']) {
    for (const [action, method] of [['upload', 'POST'], ['download', 'GET']]) {
      const f = fixture();
      const preflight = await f.invoke(action, null, { method: 'OPTIONS', headers: { Origin: origin } });
      assert.equal(preflight.statusCode, 204);
      assert.equal(preflight.headers['access-control-allow-origin'], origin);
      assert.equal(preflight.headers.vary, 'Origin');
      assert.equal(preflight.headers['access-control-allow-methods'], `${method}, OPTIONS`);
      assert.equal(preflight.headers['access-control-allow-headers'], 'Authorization, Content-Type, X-File-Name');
      assert.equal(preflight.headers['cache-control'], 'private, no-store');
      const anonymous = await f.invoke(action, null, { headers: { Origin: origin } });
      assert.equal(anonymous.statusCode, 401);
      assert.equal(anonymous.headers['access-control-allow-origin'], origin);
      assert.equal(f.verification.length, 0);
      assert.equal(f.files.size, 0);
    }
  }
});

test('attachment CORS rejects lookalikes, suffixes, subdomains, non-HTTPS and alternate ports', async () => {
  const origins = ['https://hr-flow-chj-pages.dev', 'https://hr-flow-chj.pages.dev.attacker.invalid',
    'https://preview.hr-flow-chj.pages.dev', 'http://hr-flow-chj.pages.dev',
    'https://hr-flow-chj.pages.dev:8443', 'https://other.pages.dev'];
  for (const origin of origins) {
    for (const action of ['upload', 'download']) {
      const f = fixture();
      for (const overrides of [{ method: 'OPTIONS' }, {}]) {
        const response = await f.invoke(action, 'owner', { ...overrides, headers: { Origin: origin } });
        assert.equal(response.statusCode, 403, `${action}: ${origin}`);
        assert.equal(response.headers['access-control-allow-origin'], undefined);
        assert.equal(response.headers['cache-control'], 'private, no-store');
      }
      assert.equal(f.verification.length, 0);
      assert.equal(f.files.size, 0);
    }
  }
});

test('the new production origin retains attachment tenant and department authorization', async () => {
  const f = fixture();
  await f.seed();
  const headers = { Origin: 'https://hr-flow-chj.pages.dev' };
  for (const uid of ['foreign', 'wrong-division', 'peer', 'revoked']) {
    const response = await f.invoke('download', uid, { headers });
    assert.equal(response.statusCode, uid === 'revoked' ? 401 : 403);
    assert.equal(response.headers['access-control-allow-origin'], headers.Origin);
    assert.equal(Buffer.isBuffer(response.body), false);
  }
  const owner = await f.invoke('download', 'owner', { headers });
  assert.equal(owner.statusCode, 200);
  assert.deepEqual(owner.body, png);
  assert.ok(f.verification.every(entry => entry.checkRevoked === true));
  assert.equal(f.files.size, 1);
});

test('upload checks current account readiness, company status and entitlement before saving', async () => {
  for (const mutate of [
    f => f.records.get('UserProfile/owner').status = 'RESIGNED',
    f => f.records.get('UserProfile/owner').mustChangePassword = true,
    f => f.records.get('UserProfile/owner').sessionValidAfter = clock.getTime() / 1000 + 10,
    f => f.records.get('companies/a').status = 'SUSPENDED',
    f => f.records.get('companies/a').accessUntil = { toMillis: () => clock.getTime() - 1 },
    f => f.records.delete('companies/a'),
  ]) {
    const f = fixture(); mutate(f); const response = await f.invoke('upload'); assert.ok([401, 403].includes(response.statusCode)); assert.equal(f.files.size, 0);
  }
});

test('binary upload preserves 10MiB support and rejects oversized, empty, spoofed and unsafe content', async () => {
  const f = fixture(), boundary = Buffer.alloc(MAX_BYTES); png.copy(boundary);
  const accepted = await f.invoke('upload', 'owner', { rawBody: boundary }); assert.equal(accepted.statusCode, 200);
  assert.equal(f.files.get(accepted.body.path).bytes.length, MAX_BYTES);
  for (const rawBody of [Buffer.alloc(0), Buffer.alloc(MAX_BYTES + 1), '<html>', null]) assert.equal((await f.invoke('upload', 'owner', { rawBody })).statusCode, 413);
  assert.equal((await f.invoke('upload', 'owner', { rawBody: Buffer.from('<script>') })).statusCode, 400);
  assert.equal((await f.invoke('upload', 'owner', { headers: { 'Content-Type': 'text/html' } })).statusCode, 400);
  for (const [bytes, type] of [[pdf, 'application/pdf'], [Buffer.from('ffd8ffe000', 'hex'), 'image/jpeg'], [Buffer.from('GIF89a123'), 'image/gif'], [Buffer.from('RIFF1234WEBP'), 'image/webp']]) {
    assert.equal((await f.invoke('upload', 'owner', { rawBody: bytes, headers: { 'Content-Type': type } })).statusCode, 200);
  }
});

test('upload creates immutable company/owner paths with original name only in response and no download token', async () => {
  const f = fixture();
  const response = await f.invoke('upload', 'owner', { headers: { 'X-File-Name': encodeURIComponent('../private\\원본\n.png') } });
  assert.equal(response.statusCode, 200); assert.match(response.body.path, /^companies\/a\/expenses\/owner\/[a-f0-9-]+\.png$/);
  assert.equal(response.body.path.includes('private'), false); assert.equal(/[\\/\n]/.test(response.body.name), false);
  const options = f.saved[0].options; assert.equal(options.metadata.cacheControl, 'private, no-store'); assert.equal(options.metadata.metadata.ownerUid, 'owner');
  assert.equal(JSON.stringify(options).includes('firebaseStorageDownloadTokens'), false);
  const path = response.body.path; f.context.nextId = 0;
  assert.equal((await f.invoke('upload', 'owner', { rawBody: Buffer.concat([png, Buffer.from('different')]) })).statusCode, 500);
  assert.deepEqual(f.files.get(path).bytes, png);
  assert.equal((await f.invoke('upload', 'owner', { headers: { 'X-File-Name': '%' } })).statusCode, 400);
});

test('notice upload requires a company manager and cannot be performed by a member', async () => {
  const f = fixture();
  assert.equal((await f.invoke('upload', 'owner', { query: { category: 'notices' } })).statusCode, 403);
  assert.equal((await f.invoke('upload', 'manager', { query: { category: 'notices' } })).statusCode, 200);
});

test('download checks record company, owner and current SUB_ADMIN division on every request', async () => {
  const f = fixture(); await f.seed();
  for (const uid of ['owner', 'admin', 'manager']) {
    const response = await f.invoke('download', uid); assert.equal(response.statusCode, 200); assert.deepEqual(response.body, png);
    assert.equal(response.headers['cache-control'], 'private, no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.headers['content-disposition'], /filename\*=UTF-8''/);
  }
  for (const uid of ['peer', 'wrong-division', 'foreign']) assert.equal((await f.invoke('download', uid)).statusCode, 403);
  f.records.get('UserProfile/manager').divisionId = 'two'; assert.equal((await f.invoke('download', 'manager')).statusCode, 403);
  f.records.get('UserProfile/owner').status = 'RESIGNED'; assert.equal((await f.invoke('download', 'owner')).statusCode, 403);
});

test('leave proofs use the same owner/division boundaries and notices require same active company', async () => {
  const f = fixture(); await f.seed('leaves');
  assert.equal((await f.invoke('download', 'manager', { query: { category: 'leaves', documentId: 'record' } })).statusCode, 200);
  assert.equal((await f.invoke('download', 'wrong-division', { query: { category: 'leaves', documentId: 'record' } })).statusCode, 403);
  await f.seed('notices', 'admin');
  assert.equal((await f.invoke('download', 'peer', { query: { category: 'notices', documentId: 'record' } })).statusCode, 200);
  assert.equal((await f.invoke('download', 'foreign', { query: { category: 'notices', documentId: 'record' } })).statusCode, 403);
});

test('legacy URLs are recovered only from the configured Firebase bucket and exact tenant/category/owner prefix', async () => {
  const f = fixture(), path = await f.seed(); const record = f.records.get('expenses/record'); delete record.attachmentPath;
  record.attachmentUrl = `https://firebasestorage.googleapis.com/v0/b/${f.bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=fixture-old-token`;
  assert.equal((await f.invoke('download')).statusCode, 200);
  for (const url of [
    'https://attacker.invalid/file.png', `https://firebasestorage.googleapis.com/v0/b/other-bucket/o/${encodeURIComponent(path)}`,
    `https://firebasestorage.googleapis.com/v0/b/${f.bucket.name}/o/${encodeURIComponent(path.replace('/a/', '/b/'))}`,
    `https://firebasestorage.googleapis.com/v0/b/${f.bucket.name}/o/${encodeURIComponent(path.replace('/owner/', '/peer/'))}`,
    `http://firebasestorage.googleapis.com/v0/b/${f.bucket.name}/o/${encodeURIComponent(path)}`,
  ]) { record.attachmentUrl = url; assert.equal((await f.invoke('download')).statusCode, 404); }
});

test('download ignores caller supplied paths and rejects record paths that escape category, company or owner', async () => {
  const f = fixture(), path = await f.seed();
  assert.equal((await f.invoke('download', 'owner', { query: { category: 'expenses', documentId: 'record', path: 'companies/b/secrets' } })).statusCode, 200);
  assert.equal((await f.invoke('download', 'owner', { query: { category: 'expenses', documentId: '../record' } })).statusCode, 400);
  assert.equal((await f.invoke('download', 'owner', { query: { category: 'unknown', documentId: 'record' } })).statusCode, 400);
  for (const attachmentPath of [path.replace('/a/', '/b/'), path.replace('/owner/', '/peer/'), path.replace('/expenses/', '/leaves/'), path + '/../other', path + '\\other']) {
    f.records.get('expenses/record').attachmentPath = attachmentPath; assert.equal((await f.invoke('download')).statusCode, 404);
  }
});

test('upload rechecks readiness after storage save and cleans up files when access is revoked', async () => {
  for (const mutate of [
    f => f.records.get('UserProfile/owner').companyId = 'b',
    f => f.records.get('UserProfile/owner').status = 'RESIGNED',
    f => f.records.get('UserProfile/owner').mustChangePassword = true,
    f => f.records.get('companies/a').accessUntil = { toMillis: () => clock.getTime() - 1 },
  ]) { const f = fixture(); f.context.afterSave = () => mutate(f); assert.equal((await f.invoke('upload')).statusCode, 403); assert.equal(f.files.size, 0); }
});

test('download rechecks record and authorization after binary read before returning private content', async () => {
  for (const mutate of [
    f => f.records.get('UserProfile/owner').status = 'RESIGNED',
    f => f.records.get('UserProfile/owner').companyId = 'b',
    f => f.records.get('companies/a').status = 'SUSPENDED',
    f => f.records.get('expenses/record').attachmentPath += 'changed',
    f => f.records.delete('expenses/record'),
  ]) { const f = fixture(); await f.seed(); f.context.afterDownload = () => mutate(f); const response = await f.invoke('download'); assert.equal(response.statusCode, 403); assert.equal(Buffer.isBuffer(response.body), false); }
});

test('download rejects unsafe metadata, mismatched magic and objects larger than the allowed size', async () => {
  for (const mutate of [
    file => file.metadata.contentType = 'text/html', file => file.metadata.size = String(MAX_BYTES + 1),
    file => file.bytes = Buffer.from('<html>'), file => file.bytes = Buffer.alloc(MAX_BYTES + 1),
  ]) { const f = fixture(), path = await f.seed(); mutate(f.files.get(path)); assert.equal((await f.invoke('download')).statusCode, 400); }
});
