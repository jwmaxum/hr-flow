const { randomUUID } = require('node:crypto');
const { authorizeContext, fail } = require('./security-context');
const { createDraftingAttachments, MAX_BYTES, TYPES, filename, fileType } = require('./drafting-attachments');
const origins = new Set(['https://hr-flow.pages.dev', 'https://hr-flow-chj.pages.dev', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5176', 'http://127.0.0.1:5176']);
function legacyAttachmentPath(url, bucketName) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'firebasestorage.googleapis.com' || parsed.username || parsed.password || parsed.port) return null;
    const prefix = `/v0/b/${bucketName}/o/`;
    return parsed.pathname.startsWith(prefix) ? decodeURIComponent(parsed.pathname.slice(prefix.length)) : null;
  } catch { return null; }
}
function createAttachmentService({ db, auth, bucket, now = () => new Date(), uuid = randomUUID }) {
  const authorize = request => authorizeContext({ db, request, now });
  const drafting = createDraftingAttachments({ db, bucket, now, uuid });
  async function identity(req) {
    const match = /^Bearer ([^\s]+)$/.exec(req.get('Authorization') || '');
    if (!match) fail('unauthenticated', '로그인이 필요합니다.');
    let token;
    try { token = await auth.verifyIdToken(match[1], true); }
    catch { fail('unauthenticated', '로그인을 다시 확인해 주세요.'); }
    return { auth: { uid: token.uid, token } };
  }
  function prepare(req, res, method) {
    res.set('Cache-Control', 'private, no-store'); res.set('X-Content-Type-Options', 'nosniff');
    const origin = req.get('Origin');
    if (origin && !origins.has(origin)) { res.status(403).json({ error: '허용되지 않은 요청입니다.' }); return false; }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', `${method}, OPTIONS`);
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name');
      res.set('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type');
    }
    if (req.method === 'OPTIONS') { res.status(204).send(''); return false; }
    if (req.method !== method) { res.status(405).json({ error: '허용되지 않은 요청입니다.' }); return false; }
    return true;
  }
  function categoryInput(req) {
    const category = req.query.category;
    if (!['expenses', 'leaves', 'notices', 'drafting'].includes(category)) fail('invalid-argument', '첨부 구분을 확인해 주세요.');
    return category;
  }
  async function recordAccess(request, category, documentId) {
    const user = await authorize(request);
    const record = await db.collection(category).doc(documentId).get();
    const data = record.data();
    if (!record.exists || data.companyId !== user.companyId) fail('permission-denied', '첨부파일 접근 권한이 없습니다.');
    if (category !== 'notices' && user.role !== 'ADMIN' && data.userId !== user.uid &&
      !(user.role === 'SUB_ADMIN' && user.divisionId && data.divisionId === user.divisionId)) fail('permission-denied', '첨부파일 접근 권한이 없습니다.');
    const path = data.attachmentPath || legacyAttachmentPath(data.attachmentUrl, bucket.name);
    const prefix = `companies/${user.companyId}/${category}/${category === 'notices' ? '' : `${data.userId}/`}`;
    if (typeof path !== 'string' || !path.startsWith(prefix) || path.length <= prefix.length || path.includes('..') || /[\u0000-\u001f\\]/.test(path)) fail('not-found', '첨부파일을 찾을 수 없습니다.');
    return { user, data, path };
  }
  function errorResponse(error, res) {
    const status = { unauthenticated: 401, 'permission-denied': 403, 'failed-precondition': 403, 'not-found': 404, 'invalid-argument': 400, 'resource-exhausted': 413, aborted: 409 }[error.code] || (error.code === 404 ? 404 : 500);
    if (status === 500) console.error('[AttachmentError]', error.code || 'internal');
    res.status(status).json({ error: status === 500 ? '첨부파일을 처리하지 못했습니다.' : '첨부파일 접근 권한, 파일 형식 또는 크기를 확인해 주세요.' });
  }
  return {
    async upload(req, res) {
      if (!prepare(req, res, 'POST')) return;
      try {
        const request = await identity(req), user = await authorize(request), category = categoryInput(req);
        if (category === 'notices' && !['ADMIN', 'SUB_ADMIN'].includes(user.role)) fail('permission-denied', '공지를 작성할 권한이 없습니다.');
        const bytes = req.rawBody;
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) fail('resource-exhausted', '10MB 이하 파일이 필요합니다.');
        const type = fileType(bytes);
        if (!type || req.get('Content-Type')?.split(';')[0] !== type) fail('invalid-argument', '지원하지 않는 파일입니다.');
        let name;
        try { name = filename(decodeURIComponent(req.get('X-File-Name') || '')); } catch { fail('invalid-argument', '파일 이름을 확인해 주세요.'); }
        if (category === 'drafting') {
          res.status(200).json(await drafting.upload(request, req.query, bytes, req.get('Content-Type'), name));
          return;
        }
        const path = `companies/${user.companyId}/${category}/${category === 'notices' ? '' : `${user.uid}/`}${uuid()}.${TYPES[type]}`;
        const file = bucket.file(path);
        await file.save(bytes, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: type, cacheControl: 'private, no-store',
          metadata: { ownerUid: user.uid } } });
        try {
          const current = await authorize(request);
          if (current.companyId !== user.companyId || current.role !== user.role || current.divisionId !== user.divisionId) fail('permission-denied', '소속 정보가 변경되었습니다.');
        } catch (error) { await file.delete().catch(() => {}); throw error; }
        res.status(200).json({ path, name });
      } catch (error) { errorResponse(error, res); }
    },
    async download(req, res) {
      if (!prepare(req, res, 'GET')) return;
      try {
        const request = await identity(req), category = categoryInput(req), documentId = req.query.documentId;
        if (typeof documentId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(documentId)) fail('invalid-argument', '신청 기록을 확인해 주세요.');
        if (category === 'drafting') {
          const result = await drafting.download(request, req.query);
          res.set('Content-Type', result.contentType);
          res.set('Content-Disposition', `attachment; filename="attachment.${TYPES[result.contentType]}"; filename*=UTF-8''${encodeURIComponent(result.name)}`);
          res.status(200).send(result.bytes);
          return;
        }
        const initial = await recordAccess(request, category, documentId), file = bucket.file(initial.path);
        const [metadata] = await file.getMetadata();
        if (!TYPES[metadata.contentType] || !Number(metadata.size) || Number(metadata.size) > MAX_BYTES) fail('invalid-argument', '지원하지 않는 파일입니다.');
        const [bytes] = await file.download({ validation: 'crc32c' });
        if (bytes.length > MAX_BYTES || fileType(bytes) !== metadata.contentType) fail('invalid-argument', '파일 형식을 확인해 주세요.');
        const current = await recordAccess(request, category, documentId);
        if (current.path !== initial.path || current.user.companyId !== initial.user.companyId) fail('permission-denied', '첨부파일 정보가 변경되었습니다.');
        const name = filename(current.data.attachmentName || current.data.fileName || initial.path.split('/').at(-1));
        res.set('Content-Type', metadata.contentType);
        res.set('Content-Disposition', `attachment; filename="attachment.${TYPES[metadata.contentType]}"; filename*=UTF-8''${encodeURIComponent(name)}`);
        res.status(200).send(bytes);
      } catch (error) { errorResponse(error, res); }
    },
  };
}
module.exports = { createAttachmentService, legacyAttachmentPath, fileType, MAX_BYTES };
