'use strict';

const { createHash } = require('node:crypto');
const { fail } = require('./security-context');
const { ledgerPage } = require('./erp-bootstrap-backup');

const PAGE_DOCUMENTS = 100;
const PAGE_BYTES = 320000;
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const pageId = index => String(index).padStart(8, '0');
const corruptUpload = () => fail('data-loss', '보관한 업로드 자료가 검증 결과와 다릅니다. 파일을 새로 검증해 주세요.');
// Upload values are JSON scalars, arrays and maps. The Admin SDK reads int64
// and double as JS numbers; validate their wire values before trusting a match.
function exactNumbers(value, wire) {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && !Object.is(value,-0)) return String(wire?.integerValue) === String(value);
    return wire?.doubleValue !== undefined && Object.is(Number(wire.doubleValue),value);
  }
  if (Array.isArray(value)) return value.every((v,i) => exactNumbers(v,wire?.arrayValue?.values?.[i]));
  if (value && typeof value === 'object') return Object.keys(value).every(key => exactNumbers(value[key],wire?.mapValue?.fields?.[key]));
  return true;
}
const relativeRef = (root, path) => {
  const [collection, id, extra] = path.split('/');
  if (!collection || !id || extra !== undefined) corruptUpload();
  return root.collection(collection).doc(id);
};

async function parallelGroups(values, size, fn) {
  for (let start = 0; start < values.length; start += size) await Promise.all(values.slice(start, start + size).map(fn));
}

// The independent, server-only canonical copy is derived from the validated upload.
// It remains available if a prepared ledger needs to be reconstructed after a mismatch.
function makeUploadPages(operations, parent) {
  const pages = [];
  const paths = new Set();
  let entries = [], bytes = 0;
  function flush() {
    if (!entries.length) return;
    pages.push({ index: pages.length, entries, digest: digest(entries) });
    entries = []; bytes = 0;
  }
  for (const operation of operations) {
    const path = operation.ref.path.slice(parent.path.length + 1);
    if (paths.has(path)) fail('invalid-argument', '이관 파일에 같은 원장 문서가 두 번 포함되어 있습니다.');
    paths.add(path);
    const entry = { path, data: operation.data };
    const length = Buffer.byteLength(JSON.stringify(entry)) + 100;
    if (entries.length >= PAGE_DOCUMENTS || bytes + length > PAGE_BYTES) flush();
    entries.push(entry); bytes += length;
  }
  flush();
  return { pages, manifest: { pageCount: pages.length, documentCount: paths.size, fingerprint: digest(pages.map(page => page.digest)) } };
}

async function persistUpload(db, jobRef, pages, authorizeBatch) {
  await parallelGroups(pages, 8, async page => {
    const ref = jobRef.collection('uploadPages').doc(pageId(page.index));
    await db.runTransaction(async tx => {
      await authorizeBatch(tx);
      const [job, old] = await tx.getAll(jobRef,ref);
      if (!job.exists || job.get('status') === 'CANCELLED') fail('failed-precondition','취소된 이관입니다.');
      if (!old.exists) {
        if (job.get('status') !== 'PREPARING') corruptUpload();
        tx.create(ref, page);
        return;
      }
      const saved = old.data();
      if (saved.index !== page.index || saved.digest !== page.digest || digest(saved.entries) !== page.digest) corruptUpload();
    });
  });
}

async function readUpload(db, jobRef, manifest, visit) {
  const hashes = [];
  let count = 0;
  for (let i = 0; i < manifest.pageCount; i += 8) {
    const refs = Array.from({length: Math.min(8,manifest.pageCount-i)}, (_, j) => jobRef.collection('uploadPages').doc(pageId(i+j)));
    const docs = await db.getAll(...refs);
    const pages = docs.map((snap,j) => {
      const page = snap.data();
      if (!page || page.index !== i+j || !Array.isArray(page.entries) || digest(page.entries) !== page.digest) corruptUpload();
      if (!exactNumbers(page.entries,snap.toDocumentProto().fields.entries)) corruptUpload();
      count += page.entries.length;
      hashes.push(page.digest);
      return page;
    });
    await Promise.all(pages.map(visit));
  }
  if (count !== manifest.documentCount || digest(hashes) !== manifest.fingerprint) corruptUpload();
}

// Never overwrite a row in a prepared bank. A repair writes to a new bank.
async function fillVersion(db, bank, version, jobRef, job, authorizeBatch) {
  let mismatch = false;
  await readUpload(db, jobRef, job.upload, async page => {
    const marker = version.collection('pages').doc(pageId(page.index));
    const matches = await db.runTransaction(async tx => {
      await authorizeBatch(tx);
      const [v, progress, liveJob] = await tx.getAll(version, marker, jobRef);
      if (!v.exists || v.get('companyId') !== job.companyId || v.get('jobId') !== job.id ||
          v.get('uploadFingerprint') !== job.upload.fingerprint) corruptUpload();
      if (!liveJob.exists || liveJob.get('status') === 'CANCELLED') fail('failed-precondition', '취소된 이관입니다.');
      if (progress.exists) return progress.get('digest') === page.digest;
      if (v.get('state') !== 'PREPARING') return false;
      const refs = page.entries.map(entry => relativeRef(bank,entry.path));
      const existing = await tx.getAll(...refs);
      if (existing.some((snap,i) => snap.exists && digest(snap.data()) !== digest(page.entries[i].data))) return false;
      existing.forEach((snap,i) => { if (!snap.exists) tx.create(refs[i],page.entries[i].data); });
      tx.create(marker, { digest: page.digest, count: page.entries.length });
      return true;
    });
    if (!matches) mismatch = true;
  });
  return !mismatch;
}

// A deep membership scan also detects extra rows and orphan/nested descendants.
// Only hashes of the expected documents are retained between bounded pages.
async function matchesUpload(db, bank, jobRef, job) {
  const expected = new Map();
  const kinds = new Set();
  await readUpload(db,jobRef,job.upload,page => {
    for (const entry of page.entries) {
      if (expected.has(entry.path)) corruptUpload();
      expected.set(entry.path,digest(entry.data)); kinds.add(entry.path.split('/')[0]);
    }
  });
  const actual = await bank.listCollections();
  if (actual.length !== kinds.size || actual.some(col => !kinds.has(col.id))) return false;
  let mismatch = false;
  await parallelGroups(actual,6,async col => {
    let lastPath = '';
    while (!mismatch) {
      let page;
      try {
        page = await ledgerPage({ db, root: bank, collection: col.id, lastPath, pageSize: 96 });
      } catch (error) {
        // A wrong company field in a candidate is a staged-data mismatch. The
        // separately verified canonical upload and the source backup stay private.
        if (error?.code === 'failed-precondition' && error.message === '백업 대상 문서의 회사 연결을 확인해 주세요.') {
          mismatch = true; return;
        }
        throw error;
      }
      for (const row of page.rows) {
        if (expected.get(row.path) !== digest(row.data) || !exactNumbers(row.data,{mapValue:{fields:row.fields}})) { mismatch = true; return; }
        expected.delete(row.path);
      }
      if (page.done) break;
      if (!page.rows.length) corruptUpload();
      lastPath = page.rows.at(-1).path;
    }
  });
  return !mismatch && !expected.size;
}

module.exports = { makeUploadPages, persistUpload, fillVersion, matchesUpload, digest };
