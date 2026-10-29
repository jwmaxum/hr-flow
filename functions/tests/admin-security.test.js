const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createAdminSecurityService } = require('../admin-security-service');

if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('A loopback FIRESTORE_EMULATOR_HOST is required; production tests are prohibited.');
}
const projectId = 'demo-admin-security';
// Emulator tests must not probe the external Compute metadata service.
process.env.METADATA_SERVER_DETECTION = 'none';
const app = initializeApp({ projectId }, 'admin-security-test');
const db = getFirestore(app);
const now = () => new Date('2026-10-24T02:00:00.000Z');
const authTime = Math.floor(now().getTime() / 1000);
const request = (uid, data = {}, token = {}) => ({ ...(uid ? { auth: { uid, token: { auth_time: authTime, ...token } } } : {}), data });
const secret = 'Synthetic-test-password-2026!';
const domainKey = value => createHash('sha256').update(value).digest('hex');
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

async function fixture() {
  const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  assert.equal(response.status, 200);
  const authUsers = new Map(), objects = new Map(), events = [], faults = {};
  const batch = db.batch();
  for (const [companyId, adminUid, domain] of [['a', 'admin', 'a.example'], ['b', 'foreign', 'b.example']]) {
    batch.set(db.doc(`companies/${companyId}`), { nameKo: companyId, adminUid, domain, status: 'ACTIVE', createdAt: now().toISOString(),
      accessUntil: Timestamp.fromMillis(now().getTime() + 90 * 86400000) });
    batch.set(db.doc(`tenantRegistry/${companyId}`), { companyId, status: 'ACTIVE', createdAt: now().toISOString() });
    batch.set(db.doc(`companyDomains/${domainKey(domain)}`), { companyId, createdAt: now().toISOString() });
  }
  for (const [uid, role, companyId, status] of [
    ['admin', 'ADMIN', 'a', 'ACTIVE'], ['coadmin', 'ADMIN', 'a', 'ACTIVE'], ['member', 'MEMBER', 'a', 'ACTIVE'],
    ['manager', 'SUB_ADMIN', 'a', 'ACTIVE'], ['retired', 'MEMBER', 'a', 'RESIGNED'],
    ['foreign', 'ADMIN', 'b', 'ACTIVE'], ['foreign-member', 'MEMBER', 'b', 'ACTIVE'],
    ['root', 'SUPER_ADMIN', 'PLATFORM', 'ACTIVE'],
  ]) {
    const user = { uid, role, companyId, name: uid, status, mustChangePassword: false, email: `${uid}@${companyId}.example`,
      divisionId: '', teamId: '', createdAt: now().toISOString() };
    batch.set(db.doc(`UserProfile/${uid}`), user); authUsers.set(uid, { email: user.email, emailVerified: true, disabled: false });
  }
  await batch.commit();
  const auth = {
    getUser: async uid => {
      if (!authUsers.has(uid)) throw Object.assign(new Error('Synthetic account absent'), { code: 'auth/user-not-found' });
      return { uid, ...authUsers.get(uid) };
    },
    updateUser: async (uid, patch) => {
      events.push({ action: 'updateUser', uid, keys: Object.keys(patch).sort(), ...(patch.email ? { email: patch.email } : {}), ...(patch.disabled === undefined ? {} : { disabled: patch.disabled }) });
      await faults.beforeUpdate?.(uid, patch);
      if (faults.updateError) throw Object.assign(new Error('Synthetic Auth update failure'), { code: faults.updateError });
      if (!authUsers.has(uid)) throw Object.assign(new Error('Synthetic account absent'), { code: 'auth/user-not-found' });
      const safePatch = { ...patch }; delete safePatch.password;
      authUsers.set(uid, { ...authUsers.get(uid), ...safePatch });
      await faults.afterUpdate?.(uid, patch);
      return { uid };
    },
    revokeRefreshTokens: async uid => {
      events.push({ action: 'revokeRefreshTokens', uid });
      if (faults.revokeError) throw new Error('Synthetic revoke failure');
    },
    deleteUsers: async uids => {
      assert.ok(uids.length <= 1000); events.push({ action: 'deleteUsers', uids });
      if (faults.deleteUsersFailure) return { failureCount: 1, errors: [{ index: 0, error: { code: 'auth/internal-error' } }] };
      // Admin SDK bulk deletion is idempotent for already missing UIDs.
      for (const uid of uids) authUsers.delete(uid);
      return { failureCount: 0, successCount: uids.length, errors: [] };
    },
  };
  const bucket = { deleteFiles: async options => {
    events.push({ action: 'deleteFiles', ...options });
    if (faults.storageError) throw new Error('Synthetic Storage failure');
    for (const path of objects.keys()) if (path.startsWith(options.prefix)) objects.delete(path);
  } };
  const service = createAdminSecurityService({ db, auth, bucket, now });
  return { service, auth, bucket, authUsers, objects, events, faults };
}

async function seedLifecycle(objects, orphanInbox = false) {
  const batch = db.batch();
  for (const companyId of ['a', 'b']) {
    for (const collection of ['attendance', 'divisions', 'teams', 'leaves', 'expenses', 'AuditLogs', 'payroll_records', 'backup_tasks', 'payments', 'payment_claims', 'customCompanyData']) {
      batch.set(db.doc(`${collection}/${companyId}-record`), { companyId, marker: `${companyId}-private` });
      batch.set(db.doc(`${collection}/${companyId}-record/history/version1`), { marker: `${companyId}-nested-without-company-field` });
    }
    // Detailed financial snapshots are immutable to browser clients, but a
    // platform-authorized whole-company deletion must still remove them.
    batch.set(db.doc(`payroll_records/${companyId}-detailed-payroll`), { companyId, schemaVersion: 2, scope: 'COMPANY',
      year: 2026, month: 10, rows: [{ companyId, userId: companyId === 'a' ? 'member' : 'foreign-member', name: `${companyId}-employee` }],
      sums: { monthlyGross: 100 }, marker: `${companyId}-private` });
    batch.set(db.doc(`officialLetters/${companyId}-letter`), { companyId, creatorId: companyId === 'a' ? 'member' : 'foreign-member', status: 'ISSUED', revision: 2 });
    batch.set(db.doc(`officialLetters/${companyId}-letter/history/000001`), { content: `${companyId}-old-content` });
    batch.set(db.doc(`officialLetterNumbers/${companyId}_001-261024`), { companyId, number: '001-261024' });
    // Canonical legacy settings/parents may have no companyId or no parent document.
    batch.set(db.doc(`officialLetterSettings/${companyId}`), { companyName: `${companyId}-company`, sealPath: `companies/${companyId}/official-assets/seal.png` });
    batch.set(db.doc(`config/${companyId}`), { privateSetting: true });
    batch.set(db.doc(`officialLetterPrinters/${companyId}/printers/printer1`), { companyId, name: 'Printer' });
    batch.set(db.doc(`officialLetterPrinters/${companyId}/printers/printer1/inspections/inspection1`), { printerId: 'printer1', result: 'PASS' });
    batch.set(db.doc(`officialLetterNotifications/${companyId === 'a' ? 'member' : 'foreign-member'}/items/${companyId}-letter`), { companyId, recipientRole: 'MEMBER', recipientId: companyId === 'a' ? 'member' : 'foreign-member' });
    for (const path of [`companies/${companyId}/official-assets/seal.png`, `companies/${companyId}/official-pdfs/letter/r2.pdf`, `companies/${companyId}/expenses/user/receipt.png`, `companies/${companyId}/leaves/user/medical.pdf`, `companies/${companyId}/notices/file.pdf`]) objects.set(path, Buffer.from(`${companyId}-private`));
  }
  if (orphanInbox) {
    batch.set(db.doc('officialLetterNotifications/deleted-profile/items/a-old'), { companyId: 'a', recipientId: 'deleted-profile', recipientRole: 'MEMBER' });
    batch.set(db.doc('officialLetterNotifications/deleted-profile/items/b-keep'), { companyId: 'b', recipientId: 'deleted-profile', recipientRole: 'MEMBER' });
    for (let i = 0; i < 105; i++) {
      batch.set(db.doc(`officialLetterNotifications/deleted-profile/items/a-${i}`), { companyId: 'a' });
      batch.set(db.doc(`officialLetters/missing-parent/history/a-${i}`), { companyId: 'a', revision: i });
    }
    batch.set(db.doc('officialLetters/missing-parent/history/b-keep'), { companyId: 'b' });
  }
  objects.set('companies/ab/official-assets/not-a.png', Buffer.from('neighbor-prefix-must-remain'));
  await batch.commit();
}
const allPaths = async () => {
  const paths = [];
  const visit = async collections => {
    for (const collection of collections) {
      for (const reference of await collection.listDocuments()) {
        if ((await reference.get()).exists) paths.push(reference.path);
        await visit(await reference.listCollections());
      }
    }
  };
  await visit(await db.listCollections());
  return paths.sort();
};

test('admin security server authorization and company lifecycle', async t => {
  try {
    await t.test('password reset requires tenant employee scope and returns no credentials', async () => {
      const { service, events } = await fixture();
      for (const uid of ['member', 'manager']) {
        const result = await service.resetPassword(request('admin', { uid, password: secret, companyId: 'b', role: 'SUPER_ADMIN' }));
        assert.equal(result.success, true); assert.equal('password' in result, false);
        assert.equal((await db.doc(`UserProfile/${uid}`).get()).data().mustChangePassword, true);
        assert.ok(events.some(e => e.action === 'revokeRefreshTokens' && e.uid === uid));
      }
      assert.ok(events.filter(e => e.action === 'updateUser').every(e => e.keys.join() === 'password'));
      for (const uid of ['admin', 'coadmin', 'foreign', 'foreign-member', 'root', 'missing']) {
        await rejects(service.resetPassword(request('admin', { uid, password: secret })), 'permission-denied');
      }
      assert.equal((await db.doc('UserProfile/foreign-member').get()).data().mustChangePassword, false);
    });
    await t.test('platform password reset can manage tenant administrators but never platform accounts', async () => {
      const { service } = await fixture();
      assert.equal((await service.resetPassword(request('root', { uid: 'admin', password: secret }))).success, true);
      assert.equal((await service.resetPassword(request('root', { uid: 'foreign-member', password: secret }))).success, true);
      await rejects(service.resetPassword(request('root', { uid: 'root', password: secret })), 'permission-denied');
    });
    await t.test('reset validates UID, password and recent authenticated identity before side effects', async () => {
      const { service, events } = await fixture();
      for (const uid of [null, 'member', 'manager', 'retired', 'missing']) {
        await rejects(service.resetPassword(request(uid, { uid: 'member', password: secret })), uid ? 'permission-denied' : 'unauthenticated');
      }
      for (const value of [{ uid: '../member', password: secret }, { uid: '', password: secret }, { uid: 'a'.repeat(129), password: secret }, { uid: 'member', password: 'short' }, { uid: 'member', password: 'x'.repeat(129) }]) {
        await rejects(service.resetPassword(request('admin', value)), 'invalid-argument');
      }
      for (const token of [{ auth_time: undefined }, { auth_time: authTime - 301 }, { auth_time: authTime + 31 }]) {
        await rejects(service.resetPassword(request('admin', { uid: 'member', password: secret }, token)), 'failed-precondition');
      }
      assert.equal(events.length, 0);
    });
    await t.test('reset blocks inactive caller/company, incomplete password, stale session and expired entitlement', async () => {
      const { service, events } = await fixture();
      const profileRef = db.doc('UserProfile/admin'), companyRef = db.doc('companies/a');
      const originalProfile = (await profileRef.get()).data(), originalCompany = (await companyRef.get()).data();
      for (const [patch, code] of [[{ status: 'RESIGNED' }, 'permission-denied'], [{ mustChangePassword: true }, 'failed-precondition'], [{ sessionValidAfter: authTime + 1 }, 'unauthenticated']]) {
        try { await profileRef.update(patch); await rejects(service.resetPassword(request('admin', { uid: 'member', password: secret })), code); }
        finally { await profileRef.set(originalProfile); }
      }
      for (const patch of [{ status: 'SUSPENDED' }, { status: 'DELETING' }, { accessUntil: Timestamp.fromMillis(now().getTime()) }, { accessUntil: '2099-01-01' }, { accessUntil: null }]) {
        try { await companyRef.update(patch); await rejects(service.resetPassword(request('admin', { uid: 'member', password: secret })), 'permission-denied'); }
        finally { await companyRef.set(originalCompany); }
      }
      assert.equal(events.length, 0);
    });
    await t.test('reset rechecks caller and target permissions in its transaction', async () => {
      for (const change of [
        () => db.doc('UserProfile/admin').update({ role: 'MEMBER' }),
        () => db.doc('UserProfile/admin').update({ companyId: 'b' }),
        () => db.doc('UserProfile/member').update({ role: 'ADMIN' }),
        () => db.doc('UserProfile/member').update({ companyId: 'b' }),
      ]) {
        const state = await fixture();
        const proxy = new Proxy(db, { get(target, key) {
          if (key === 'runTransaction') return async (...args) => { await change(); return target.runTransaction(...args); };
          const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
        } });
        const service = createAdminSecurityService({ db: proxy, auth: state.auth, bucket: state.bucket, now });
        await assert.rejects(service.resetPassword(request('admin', { uid: 'member', password: secret })), error => ['permission-denied', 'aborted'].includes(error.code));
        assert.equal(state.events.length, 0);
      }
    });
    await t.test('reset Auth failures leave the security gate locked for retry', async () => {
      const { service, faults } = await fixture(); faults.updateError = 'auth/internal-error';
      await assert.rejects(service.resetPassword(request('admin', { uid: 'member', password: secret })));
      assert.equal((await db.doc('UserProfile/member').get()).data().mustChangePassword, true);
      delete faults.updateError;
      assert.equal((await service.resetPassword(request('admin', { uid: 'member', password: secret }))).success, true);
    });
    await t.test('domain checks and synchronization use the authenticated company, not payload IDs', async () => {
      const { service, authUsers } = await fixture();
      assert.equal((await service.checkDomain(request('admin', { domain: 'a.example' }))).available, true);
      assert.equal((await service.checkDomain(request('admin', { domain: 'b.example' }))).available, false);
      await db.doc(`companyDomains/${domainKey('reserved.example')}`).set({ companyId: 'retired-company' });
      assert.equal((await service.checkDomain(request('admin', { domain: 'reserved.example' }))).available, false);
      const foreignBefore = (await db.doc('companies/b').get()).data();
      authUsers.set('admin', { ...authUsers.get('admin'), email: 'admin@new.example', emailVerified: true });
      const result = await service.syncDomain(request('admin', { newDomain: '@NEW.EXAMPLE', companyId: 'b', uid: 'foreign', role: 'SUPER_ADMIN' }));
      assert.equal(result.success, true); assert.equal(result.successCount, 5); assert.equal(result.failCount, 0);
      assert.equal((await db.doc('companies/a').get()).data().domain, 'new.example');
      assert.deepEqual((await db.doc('companies/b').get()).data(), foreignBefore);
      assert.equal((await db.doc('config/a').get()).data().defaultDomain, 'new.example');
      assert.equal((await db.doc(`companyDomains/${domainKey('new.example')}`).get()).data().companyId, 'a');
      assert.equal(authUsers.get('member').email, 'member@new.example');
      assert.equal(authUsers.get('foreign').email, 'foreign@b.example');
    });
    await t.test('domain synchronization rejects reserved, invalid and unauthorized requests', async () => {
      const { service, events, authUsers } = await fixture();
      for (const uid of [null, 'member', 'manager', 'root']) await rejects(service.syncDomain(request(uid, { newDomain: 'new.example' })), uid ? 'permission-denied' : 'unauthenticated');
      for (const newDomain of ['', 'http://new.example', 'invalid', 'a/b.example', 'a'.repeat(254)]) await rejects(service.syncDomain(request('admin', { newDomain })), 'invalid-argument');
      await rejects(service.syncDomain(request('admin', { newDomain: 'new.example' }, { auth_time: authTime - 301 })), 'failed-precondition');
      authUsers.set('admin', { ...authUsers.get('admin'), email: 'admin@b.example' });
      await rejects(service.syncDomain(request('admin', { newDomain: 'b.example' })), 'already-exists');
      await db.doc(`companyDomains/${domainKey('reserved.example')}`).set({ companyId: 'deleted-company' });
      authUsers.set('admin', { ...authUsers.get('admin'), email: 'admin@reserved.example' });
      await rejects(service.syncDomain(request('admin', { newDomain: 'reserved.example' })), 'already-exists');
      assert.equal(events.length, 0); assert.equal((await db.doc('companies/a').get()).data().domain, 'a.example');
    });
    await t.test('domain synchronization reports per-user Auth failures and can retry without releasing reservations', async () => {
      const { service, faults, authUsers } = await fixture();
      authUsers.set('admin', { ...authUsers.get('admin'), email: 'admin@new.example', emailVerified: true });
      faults.beforeUpdate = async uid => { if (uid === 'member') throw new Error('Synthetic single account failure'); };
      const first = await service.syncDomain(request('admin', { newDomain: 'new.example' }));
      assert.equal(first.successCount, 4); assert.equal(first.failCount, 1);
      assert.equal(authUsers.get('member').email, 'member@a.example');
      assert.equal((await db.doc('UserProfile/member').get()).data().email, 'member@a.example');
      assert.equal((await db.doc(`companyDomains/${domainKey('new.example')}`).get()).data().companyId, 'a');
      delete faults.beforeUpdate;
      const retried = await service.syncDomain(request('admin', { newDomain: 'new.example' }));
      assert.equal(retried.failCount, 0); assert.equal(authUsers.get('member').email, 'member@new.example');
    });
    await t.test('a new domain requires a verified server Auth email, never a browser claim', async () => {
      const { service, authUsers, events } = await fixture();
      const original = authUsers.get('admin');
      for (const patch of [
        { email: 'admin@new.example', emailVerified: false },
        { email: 'admin@unrelated.example', emailVerified: true },
        { email: 'admin@new.example', emailVerified: true, disabled: true },
        { email: undefined, emailVerified: true },
      ]) {
        authUsers.set('admin', { ...original, ...patch });
        await rejects(service.syncDomain(request('admin', { newDomain: 'new.example', emailVerified: true, email: 'admin@new.example' },
          { email_verified: true, email: 'admin@new.example' })), 'failed-precondition');
        assert.equal((await db.doc('companies/a').get()).data().domain, 'a.example');
        assert.equal((await db.doc(`companyDomains/${domainKey('new.example')}`).get()).exists, false);
      }
      assert.equal(events.length, 0);
    });
    await t.test('concurrent domain claims reserve a domain for exactly one authenticated company', async () => {
      const { service, authUsers } = await fixture();
      for (const uid of ['admin', 'foreign']) authUsers.set(uid, { ...authUsers.get(uid), email: `${uid}@race.example`, emailVerified: true });
      const results = await Promise.allSettled([
        service.syncDomain(request('admin', { newDomain: 'race.example' })),
        service.syncDomain(request('foreign', { newDomain: 'race.example' })),
      ]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const failure = results.find(result => result.status === 'rejected');
      assert.equal(failure.reason.code, 'already-exists');
      const companyId = (await db.doc(`companyDomains/${domainKey('race.example')}`).get()).data().companyId;
      assert.ok(['a', 'b'].includes(companyId));
      assert.equal((await db.doc(`companies/${companyId}`).get()).data().domain, 'race.example');
      assert.notEqual((await db.doc(`companies/${companyId === 'a' ? 'b' : 'a'}`).get()).data().domain, 'race.example');
    });
    await t.test('company deletion requires a current active platform administrator and a valid target', async () => {
      const { service, events } = await fixture();
      for (const uid of [null, 'admin', 'member', 'manager', 'foreign']) await rejects(service.deleteCompany(request(uid, { companyId: 'a' })), uid ? 'permission-denied' : 'unauthenticated');
      for (const companyId of ['PLATFORM', '../a', '', 'a'.repeat(129)]) await rejects(service.deleteCompany(request('root', { companyId })), 'invalid-argument');
      await rejects(service.deleteCompany(request('root', { companyId: 'missing' })), 'not-found');
      await rejects(service.deleteCompany(request('root', { companyId: 'a' }, { auth_time: authTime - 301 })), 'failed-precondition');
      await db.doc('UserProfile/root').update({ mustChangePassword: true });
      await rejects(service.deleteCompany(request('root', { companyId: 'a' })), 'failed-precondition');
      assert.equal(events.length, 0); assert.equal((await db.doc('companies/a').get()).data().status, 'ACTIVE');
    });
    await t.test('company deletion recursively erases company records and files, deletes Auth and retains permanent reservations', async () => {
      const { service, objects, authUsers, events } = await fixture(); await seedLifecycle(objects);
      const foreignPaths = (await allPaths()).filter(path => /(?:^|\/)b(?:-|\/|_)|foreign/.test(path) ||
        ['companies/b', 'tenantRegistry/b', 'config/b', 'officialLetterSettings/b', `companyDomains/${domainKey('b.example')}`].includes(path));
      const foreignBefore = await Promise.all(foreignPaths.map(async path => [path, (await db.doc(path).get()).data()]));
      const result = await service.deleteCompany(request('root', { companyId: 'a' }));
      assert.equal(result.success, true);
      assert.deepEqual((await db.doc('companies/a').get()).data(), { status: 'DELETED', createdAt: now().toISOString(), deletedAt: now().toISOString() });
      assert.equal((await db.doc('tenantRegistry/a').get()).data().status, 'DELETED');
      assert.equal((await db.doc(`companyDomains/${domainKey('a.example')}`).get()).data().companyId, 'a');
      for (const uid of ['admin', 'coadmin', 'member', 'manager', 'retired']) assert.equal(authUsers.has(uid), false);
      assert.equal(authUsers.has('foreign'), true); assert.equal(authUsers.has('root'), true);
      assert.ok([...objects.keys()].every(path => !path.startsWith('companies/a/')));
      assert.ok(objects.has('companies/ab/official-assets/not-a.png')); assert.ok(objects.has('companies/b/official-assets/seal.png'));
      const remaining = await allPaths();
      for (const [path, data] of foreignBefore) {
        assert.ok(remaining.includes(path), `foreign path preserved: ${path}`);
        assert.deepEqual((await db.doc(path).get()).data(), data, `foreign data unchanged: ${path}`);
      }
      for (const path of ['config/a', 'officialLetterSettings/a', 'officialLetterPrinters/a/printers/printer1',
        'officialLetterPrinters/a/printers/printer1/inspections/inspection1', 'officialLetters/a-letter/history/000001']) {
        assert.equal((await db.doc(path).get()).exists, false, `private path erased: ${path}`);
      }
      assert.ok(!remaining.some(path => /(?:^|\/)a(?:-|\/|_)|UserProfile\/(?:admin|coadmin|member|manager|retired)$|officialLetterNotifications\/member\//.test(path) && !['companies/a', 'tenantRegistry/a'].includes(path)));
      const deletion = events.findIndex(e => e.action === 'deleteUsers');
      for (const uid of ['admin', 'coadmin', 'member', 'manager', 'retired']) assert.ok(events.slice(0, deletion).some(e => e.action === 'updateUser' && e.uid === uid && e.disabled === true));
      assert.deepEqual(events.find(e => e.action === 'deleteFiles'), { action: 'deleteFiles', prefix: 'companies/a/', force: false });
    });
    await t.test('Storage failure keeps the company locked and retry resumes even after Auth deletion', async () => {
      const { service, objects, faults, authUsers } = await fixture(); await seedLifecycle(objects); faults.storageError = true;
      await assert.rejects(service.deleteCompany(request('root', { companyId: 'a' })));
      assert.equal((await db.doc('companies/a').get()).data().status, 'DELETING');
      assert.equal((await db.doc('tenantRegistry/a').get()).data().status, 'DELETING');
      assert.equal((await db.doc('officialLetters/a-letter').get()).exists, true);
      assert.equal(authUsers.has('member'), false); assert.equal(objects.has('companies/a/official-assets/seal.png'), true);
      await rejects(service.checkDomain(request('admin', { domain: 'unused.example' })), 'permission-denied');
      delete faults.storageError;
      assert.equal((await service.deleteCompany(request('root', { companyId: 'a' }))).success, true);
      assert.equal((await db.doc('companies/a').get()).data().status, 'DELETED');
      assert.equal((await db.doc('officialLetters/a-letter/history/000001').get()).exists, false);
    });
    await t.test('bulk Auth deletion failure leaves data locked and retryable', async () => {
      const { service, objects, faults } = await fixture(); await seedLifecycle(objects); faults.deleteUsersFailure = true;
      await rejects(service.deleteCompany(request('root', { companyId: 'a' })), 'internal');
      assert.equal((await db.doc('companies/a').get()).data().status, 'DELETING');
      assert.equal((await db.doc('officialLetters/a-letter').get()).exists, true);
      assert.equal(objects.has('companies/a/official-assets/seal.png'), true);
      delete faults.deleteUsersFailure;
      assert.equal((await service.deleteCompany(request('root', { companyId: 'a' }))).success, true);
    });
    await t.test('Firestore cleanup failure preserves the permanent lock and a later retry completes', async () => {
      const state = await fixture(); await seedLifecycle(state.objects);
      let failOnce = true;
      const proxy = new Proxy(db, { get(target, key) {
        if (key === 'recursiveDelete') return async (reference, ...args) => {
          if (reference.path === 'officialLetterPrinters/a' && failOnce) { failOnce = false; throw new Error('Synthetic Firestore cleanup failure'); }
          return target.recursiveDelete(reference, ...args);
        };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      const service = createAdminSecurityService({ db: proxy, auth: state.auth, bucket: state.bucket, now });
      await assert.rejects(service.deleteCompany(request('root', { companyId: 'a' })));
      assert.equal((await db.doc('companies/a').get()).data().status, 'DELETING');
      assert.equal((await db.doc('tenantRegistry/a').get()).data().status, 'DELETING');
      assert.equal((await db.doc('UserProfile/member').get()).exists, true);
      assert.equal((await db.doc('companies/b').get()).data().status, 'ACTIVE');
      assert.equal((await service.deleteCompany(request('root', { companyId: 'a' }))).success, true);
      assert.equal((await db.doc('officialLetterPrinters/a/printers/printer1/inspections/inspection1').get()).exists, false);
    });
    await t.test('company deletion clears inboxes whose original user profile no longer exists', async () => {
      const { service, objects } = await fixture(); await seedLifecycle(objects, true);
      await service.deleteCompany(request('root', { companyId: 'a' }));
      assert.equal((await db.doc('officialLetterNotifications/deleted-profile/items/a-old').get()).exists, false);
      assert.equal((await db.doc('officialLetterNotifications/deleted-profile/items/b-keep').get()).exists, true);
      assert.equal((await db.collection('officialLetterNotifications/deleted-profile/items').where('companyId', '==', 'a').get()).size, 0);
      assert.equal((await db.collection('officialLetters/missing-parent/history').where('companyId', '==', 'a').get()).size, 0);
      assert.equal((await db.doc('officialLetters/missing-parent/history/b-keep').get()).exists, true);
      assert.equal((await db.doc('officialLetterNotifications/foreign-member/items/b-letter').get()).exists, true);
    });
  } finally { await deleteApp(app); }
});
