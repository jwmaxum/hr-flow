const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { createAccountSecurityService } = require('../account-security-service');
const { authorizeContext, legacyAccessUntil } = require('../security-context');

if (!/^(127\.0\.0\.1|localhost):8080$/.test(process.env.FIRESTORE_EMULATOR_HOST || '')) {
  throw new Error('Account security tests require the local Firestore emulator on port 8080.');
}
process.env.METADATA_SERVER_DETECTION = 'none';
const app = initializeApp({ projectId: 'demo-account-security' }, 'account-security-tests');
const db = getFirestore(app, '(default)');
const instant = new Date('2026-10-24T03:00:00.000Z');
const now = () => new Date(instant);
const seconds = Math.floor(instant.getTime() / 1000);
const future = Timestamp.fromMillis(instant.getTime() + 86400000);
const past = Timestamp.fromMillis(instant.getTime() - 1);
const generatedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request = (uid, action, data = {}, token = {}) => ({ ...(uid ? { auth: { uid, token: { auth_time: seconds - 30, email_verified: true, ...token } } } : {}), data: { action, ...data } });
const denied = (promise, code) => assert.rejects(promise, error => error.code === code);
const signup = { name: 'Audit owner', nameKo: '감사 회사', nameEn: 'Audit Company' };

async function fixture() {
  for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
  const writes = [
    ['companies/a', { nameKo: 'A 회사', nameEn: 'A', domain: 'a-audit.test', adminUid: 'admin', status: 'ACTIVE', createdAt: instant.toISOString(), accessUntil: future }],
    ['companies/b', { nameKo: 'B 회사', domain: 'b-audit.test', adminUid: 'other-admin', status: 'ACTIVE', accessUntil: future }],
    ['companies/expired', { nameKo: 'Expired company', status: 'ACTIVE', accessUntil: past, subscriptionStatus: 'EXPIRED' }],
    ['companies/suspended', { nameKo: 'Suspended company', status: 'SUSPENDED', accessUntil: future }],
    ['UserProfile/admin', { uid: 'admin', name: 'Company admin', email: 'admin@a-audit.test', role: 'ADMIN', companyId: 'a', status: 'ACTIVE', divisionId: 'd1' }],
    ['UserProfile/sub', { name: 'Division manager', role: 'SUB_ADMIN', companyId: 'a', status: 'ACTIVE', divisionId: 'd1', teamId: 't1' }],
    ['UserProfile/member', { name: 'Employee', email: 'member@a-audit.test', role: 'MEMBER', companyId: 'a', status: 'ACTIVE', divisionId: 'd1', teamId: 't1', annualSalary: 90000000, dependents: 3, address: 'Private address', annualLeaveTotal: 15, usedLeave: 2 }],
    ['UserProfile/other-division', { name: 'Other division', role: 'MEMBER', companyId: 'a', status: 'ACTIVE', divisionId: 'd2', annualSalary: 80000000 }],
    ['UserProfile/foreign', { name: 'Foreign employee', role: 'MEMBER', companyId: 'b', status: 'ACTIVE', divisionId: 'd1', annualSalary: 70000000 }],
    ['UserProfile/retired', { name: 'Retired', role: 'ADMIN', companyId: 'a', status: 'RESIGNED', divisionId: 'd1' }],
    ['UserProfile/pending', { name: 'Pending', role: 'MEMBER', companyId: 'a', status: 'ACTIVE', mustChangePassword: true, divisionId: 'd1', annualSalary: 60000000 }],
    ['UserProfile/expired', { name: 'Expired admin', role: 'ADMIN', companyId: 'expired', status: 'ACTIVE' }],
    ['UserProfile/suspended', { name: 'Suspended admin', role: 'ADMIN', companyId: 'suspended', status: 'ACTIVE' }],
    ['UserProfile/platform', { name: 'Platform', role: 'SUPER_ADMIN', companyId: 'PLATFORM', status: 'ACTIVE' }],
  ];
  await Promise.all(writes.map(([path, value]) => db.doc(path).set(value)));
  const accounts = new Map([['new-owner', { uid: 'new-owner', email: 'owner@new-audit.test', emailVerified: true, disabled: false }]]);
  const events = [], storageDeletes = [];
  const auth = {
    async getUser(uid) { return accounts.get(uid) || { uid, email: `${uid}@a-audit.test`, emailVerified: true, disabled: false }; },
    async updateUser(uid, value) { events.push({ type: 'update', uid, keys: Object.keys(value), disabled: value.disabled }); return { uid }; },
    async revokeRefreshTokens(uid) { events.push({ type: 'revoke', uid }); },
    async deleteUser(uid) { events.push({ type: 'delete', uid }); },
  };
  const bucket = { async deleteFiles(options) { storageDeletes.push(options.prefix); } };
  const manage = createAccountSecurityService({ db, auth, bucket, now, uuid: () => generatedId });
  const call = (uid, action, data, token) => manage(request(uid, action, data, token));
  return { auth, accounts, events, storageDeletes, call, manage };
}

test('account session, company enrollment, password and directory security', async t => {
  try {
    await t.test('sessions allow only safe own fields before password change or during expiry', async () => {
      const f = await fixture();
      await denied(f.call(null, 'session'), 'unauthenticated');
      assert.deepEqual(await f.call('new-owner', 'session'), { profile: null, company: null, businessAllowed: false });
      const pending = await f.call('pending', 'session');
      assert.equal(pending.profile.uid, 'pending'); assert.equal(pending.profile.mustChangePassword, true); assert.equal(pending.businessAllowed, false);
      for (const key of ['annualSalary', 'dependents', 'address', 'company', 'sessionValidAfter']) assert.equal(key in pending.profile, false);
      const expired = await f.call('expired', 'session'); assert.equal(expired.businessAllowed, false); assert.equal(expired.company.id, 'expired');
      assert.equal(typeof expired.company.accessUntil, 'string');
      const ready = await f.call('member', 'session'); assert.equal(ready.businessAllowed, true); assert.equal(ready.profile.annualSalary, undefined);
      const platform = await f.call('platform', 'session'); assert.equal(platform.businessAllowed, true); assert.equal(platform.company, null);
      for (const uid of ['retired', 'suspended']) await denied(f.call(uid, 'session'), 'permission-denied');
    });
    await t.test('common authorization rejects unready, expired, retired and stale-password sessions', async () => {
      await fixture();
      for (const [uid, code] of [['pending', 'failed-precondition'], ['expired', 'permission-denied'], ['retired', 'permission-denied'], ['suspended', 'permission-denied'], ['platform', 'permission-denied']]) {
        await denied(authorizeContext({ db, now, request: request(uid, 'any') }), code);
      }
      await db.doc('UserProfile/member').update({ sessionValidAfter: seconds - 10 });
      await denied(authorizeContext({ db, now, request: request('member', 'any') }), 'unauthenticated');
      const current = await authorizeContext({ db, now, request: request('member', 'any', {}, { auth_time: seconds }) }); assert.equal(current.uid, 'member');
      await db.doc('companies/a').update({ accessUntil: null });
      await denied(authorizeContext({ db, now, request: request('admin', 'any') }), 'permission-denied');
      assert.equal(legacyAccessUntil({ createdAt: instant.toISOString() }).getTime(), instant.getTime() + 90 * 86400000);
    });
    await t.test('company creation requires verified Auth email and recent authentication', async () => {
      const f = await fixture();
      await denied(f.call('new-owner', 'createCompany', signup, { email_verified: false }), 'failed-precondition');
      await denied(f.call('new-owner', 'createCompany', signup, { auth_time: seconds - 301 }), 'failed-precondition');
      await denied(f.call('new-owner', 'createCompany', signup, { auth_time: seconds + 31 }), 'failed-precondition');
      f.accounts.get('new-owner').emailVerified = false;
      await denied(f.call('new-owner', 'createCompany', signup), 'permission-denied');
      assert.equal((await db.doc(`companies/${generatedId}`).get()).exists, false);
    });
    await t.test('server creates UUID tenant, registry, ADMIN and config atomically and ignores forged identity fields', async () => {
      const f = await fixture();
      const result = await f.call('new-owner', 'createCompany', { ...signup, companyId: 'a', role: 'SUPER_ADMIN', createdAt: '2000-01-01', adminUid: 'platform' });
      assert.equal(result.companyId, generatedId);
      const [company, profile, registry, config] = await Promise.all(['companies', 'UserProfile', 'tenantRegistry', 'config'].map(name => db.doc(`${name}/${name === 'UserProfile' ? 'new-owner' : generatedId}`).get()));
      assert.equal(company.data().adminUid, 'new-owner'); assert.equal(company.data().createdAt, instant.toISOString());
      assert.equal(company.data().accessUntil.toMillis(), instant.getTime() + 90 * 86400000);
      assert.equal(profile.data().role, 'ADMIN'); assert.equal(profile.data().companyId, generatedId); assert.equal(profile.data().mustChangePassword, false);
      assert.equal(registry.data().status, 'ACTIVE'); assert.equal(config.data().companyId, generatedId);
      assert.equal((await db.doc('companies/a').get()).data().adminUid, 'admin');
      await denied(f.call('new-owner', 'createCompany', signup), 'already-exists');
    });
    await t.test('permanent tenant reservations and existing domains cannot be reclaimed', async () => {
      const f = await fixture();
      await db.doc(`tenantRegistry/${generatedId}`).set({ status: 'DELETED' });
      await denied(f.call('new-owner', 'createCompany', signup), 'aborted');
      assert.equal((await db.doc(`companies/${generatedId}`).get()).exists, false);
      await db.doc(`tenantRegistry/${generatedId}`).delete();
      f.accounts.get('new-owner').email = 'owner@a-audit.test';
      await denied(f.call('new-owner', 'createCompany', signup), 'already-exists');
      assert.equal((await db.doc('UserProfile/new-owner').get()).exists, false);
    });
    await t.test('legacy setup recovery requires the DB owner and preserves the existing entitlement and company identity', async () => {
      const f = await fixture();
      const oldCreatedAt = '2025-01-01T00:00:00.000Z';
      await db.doc('companies/legacy-owned').set({ nameKo: 'Existing company', nameEn: 'Existing', domain: 'new-audit.test', adminUid: 'new-owner', status: 'ACTIVE', createdAt: oldCreatedAt, accessUntil: future });
      const result = await f.call('new-owner', 'createCompany', { ...signup, companyId: 'b', createdAt: instant.toISOString() });
      assert.equal(result.companyId, 'legacy-owned');
      const company = (await db.doc('companies/legacy-owned').get()).data();
      assert.equal(company.createdAt, oldCreatedAt); assert.equal(company.nameKo, 'Existing company'); assert.equal(company.accessUntil.toMillis(), future.toMillis());
      assert.equal((await db.doc('UserProfile/new-owner').get()).data().companyId, 'legacy-owned');
      assert.equal((await db.doc('tenantRegistry/legacy-owned').get()).data().status, 'ACTIVE');
      assert.equal((await db.doc(`companies/${generatedId}`).get()).exists, false);
    });
    await t.test('a deleted legacy reservation cannot be recovered even by its former owner', async () => {
      const f = await fixture();
      await db.doc('companies/legacy-owned').set({ domain: 'new-audit.test', adminUid: 'new-owner', status: 'ACTIVE', accessUntil: future });
      await db.doc('tenantRegistry/legacy-owned').set({ status: 'DELETED' });
      await denied(f.call('new-owner', 'createCompany', signup), 'permission-denied');
      assert.equal((await db.doc('UserProfile/new-owner').get()).exists, false);
    });
    await t.test('password Auth failure does not clear the pending flag or revoke sessions', async () => {
      const f = await fixture(); f.auth.updateUser = async () => { throw Object.assign(new Error('Auth unavailable'), { code: 'auth/internal-error' }); };
      await assert.rejects(f.call('pending', 'changePassword', { newPassword: 'Audit-2026-Test' }));
      const profile = (await db.doc('UserProfile/pending').get()).data();
      assert.equal(profile.mustChangePassword, true); assert.equal(profile.sessionValidAfter, undefined); assert.equal(f.events.length, 0);
    });
    await t.test('password change requires recent active membership and a 6–15 character value', async () => {
      const f = await fixture();
      for (const newPassword of ['', 'short', 'x'.repeat(16), 123]) await denied(f.call('pending', 'changePassword', { newPassword }), 'invalid-argument');
      await denied(f.call('pending', 'changePassword', { newPassword: 'Audit-2026-Test' }, { auth_time: seconds - 301 }), 'failed-precondition');
      for (const uid of ['retired', 'suspended']) await denied(f.call(uid, 'changePassword', { newPassword: 'Audit-2026-Test' }), 'permission-denied');
      assert.equal(f.events.length, 0);
    });
    await t.test('successful password change updates only its own server flag, revokes refresh tokens and blocks its old login', async () => {
      const f = await fixture();
      const result = await f.call('pending', 'changePassword', { newPassword: 'Audit-2026-Test', uid: 'member', mustChangePassword: true });
      assert.deepEqual(result, { success: true, signInAgain: true });
      assert.deepEqual(f.events.map(event => [event.type, event.uid]), [['update', 'pending'], ['revoke', 'pending']]);
      const profile = (await db.doc('UserProfile/pending').get()).data();
      assert.equal(profile.mustChangePassword, false); assert.equal(profile.lastPasswordChange, instant.toISOString()); assert.equal(profile.sessionValidAfter, seconds + 1);
      assert.equal((await db.doc('UserProfile/member').get()).data().sessionValidAfter, undefined);
      await denied(f.call('pending', 'session'), 'unauthenticated');
      await denied(f.call('pending', 'session', {}, { auth_time: seconds }), 'unauthenticated');
      assert.equal((await f.call('pending', 'session', {}, { auth_time: seconds + 1 })).businessAllowed, true);
    });
    await t.test('platform administrator clears the initial password gate once and keeps access on subsequent logins', async () => {
      const f = await fixture();
      const ref = db.doc('UserProfile/platform');
      await ref.update({ mustChangePassword: true });
      assert.equal((await f.call('platform', 'session')).businessAllowed, false);
      assert.equal((await f.call('platform', 'changePassword', { newPassword: '123456' })).success, true);
      assert.equal((await ref.get()).data().mustChangePassword, false);
      assert.deepEqual(f.events.map(event => [event.type, event.uid]), [['update', 'platform'], ['revoke', 'platform']]);
      await denied(f.call('platform', 'session', {}, { auth_time: seconds }), 'unauthenticated');
      for (const authTime of [seconds + 1, seconds + 10]) {
        const session = await f.call('platform', 'session', {}, { auth_time: authTime });
        assert.equal(session.businessAllowed, true);
        assert.equal(session.profile.mustChangePassword, false);
        assert.equal(session.profile.role, 'SUPER_ADMIN');
      }
    });
    await t.test('membership changes during Auth password update cannot clear a pending activation flag', async () => {
      const f = await fixture();
      f.auth.updateUser = async () => { await db.doc('UserProfile/pending').update({ status: 'RESIGNED' }); return {}; };
      await denied(f.call('pending', 'changePassword', { newPassword: 'Audit-2026-Test' }), 'permission-denied');
      const profile = (await db.doc('UserProfile/pending').get()).data();
      assert.equal(profile.mustChangePassword, true); assert.equal(profile.sessionValidAfter, undefined); assert.equal(profile.status, 'RESIGNED');
    });
    await t.test('refresh-token revocation failure leaves the server cutoff enforced', async () => {
      const f = await fixture();
      f.auth.revokeRefreshTokens = async () => { throw Object.assign(new Error('Auth revoke unavailable'), { code: 'auth/internal-error' }); };
      await assert.rejects(f.call('pending', 'changePassword', { newPassword: 'Audit-2026-Test' }));
      assert.equal((await db.doc('UserProfile/pending').get()).data().sessionValidAfter, seconds + 1);
      await denied(f.call('pending', 'session', {}, { auth_time: seconds }), 'unauthenticated');
    });
    await t.test('directory returns a server whitelist with tenant and division scoping', async () => {
      const f = await fixture();
      const admin = (await f.call('admin', 'directory', { companyId: 'b' })).users;
      assert.ok(admin.some(user => user.uid === 'other-division')); assert.ok(!admin.some(user => ['foreign', 'retired'].includes(user.uid)));
      const sub = (await f.call('sub', 'directory', { companyId: 'b', divisionId: 'd2' })).users;
      assert.ok(sub.some(user => user.uid === 'member')); assert.ok(!sub.some(user => ['foreign', 'other-division', 'retired'].includes(user.uid)));
      const allowed = ['uid', 'name', 'role', 'teamId', 'divisionId', 'annualLeaveTotal', 'usedLeave'];
      for (const user of [...admin, ...sub]) assert.ok(Object.keys(user).every(key => allowed.includes(key)));
      assert.equal(sub.find(user => user.uid === 'member').annualLeaveTotal, 15);
      for (const [uid, code] of [['member', 'permission-denied'], ['pending', 'permission-denied'], ['retired', 'permission-denied'], ['expired', 'permission-denied'], ['suspended', 'permission-denied'], ['platform', 'permission-denied']]) await denied(f.call(uid, 'directory'), code);
      await db.doc('UserProfile/sub').update({ divisionId: '' }); assert.deepEqual((await f.call('sub', 'directory')).users, []);
    });
    await t.test('directory rechecks current company and role after its query', async () => {
      await fixture(); let changed = false;
      const wrap = query => ({ where: (...args) => wrap(query.where(...args)), async get() {
        const snapshot = await query.get(); if (!changed) { changed = true; await db.doc('UserProfile/sub').update({ companyId: 'b' }); } return snapshot;
      } });
      const scopedDb = { collection(name) { const collection = db.collection(name); return name === 'UserProfile' ? { doc: id => collection.doc(id), where: (...args) => wrap(collection.where(...args)) } : collection; } };
      const manage = createAccountSecurityService({ db: scopedDb, auth: {}, now });
      await denied(manage(request('sub', 'directory')), 'aborted');
    });
    await t.test('expired ADMIN may submit only a pending payment claim and duplicate requests cannot overwrite it', async () => {
      const f = await fixture();
      await f.call('expired', 'submitPaymentClaim', { orderId: 'AUDIT-ORDER-01', companyId: 'b', status: 'APPROVED', adminUid: 'platform' });
      const first = (await db.doc('payment_claims/AUDIT-ORDER-01').get()).data();
      assert.equal(first.companyId, 'expired'); assert.equal(first.adminUid, 'expired'); assert.equal(first.status, 'PENDING');
      await f.call('expired', 'submitPaymentClaim', { orderId: 'AUDIT-ORDER-01' });
      assert.deepEqual((await db.doc('payment_claims/AUDIT-ORDER-01').get()).data(), first);
      await denied(f.call('admin', 'submitPaymentClaim', { orderId: 'AUDIT-ORDER-01' }), 'already-exists');
      await denied(f.call('expired', 'submitPaymentClaim', { orderId: '../bad' }), 'invalid-argument');
      await denied(f.call('member', 'submitPaymentClaim', { orderId: 'AUDIT-ORDER-02' }), 'permission-denied');
      const company = (await db.doc('companies/expired').get()).data(); assert.equal(company.accessUntil.toMillis(), past.toMillis());
    });
    await t.test('only a recently authenticated platform administrator can extend server entitlement', async () => {
      const f = await fixture();
      await denied(f.call('admin', 'extendSubscription', { companyId: 'expired', days: 30 }), 'permission-denied');
      await denied(f.call('platform', 'extendSubscription', { companyId: 'expired', days: 30 }, { auth_time: seconds - 301 }), 'failed-precondition');
      for (const days of [0, -1, 1.5, 3661]) await denied(f.call('platform', 'extendSubscription', { companyId: 'expired', days }), 'invalid-argument');
      await f.call('platform', 'extendSubscription', { companyId: 'expired', days: 30 });
      const company = (await db.doc('companies/expired').get()).data();
      assert.equal(company.subscriptionStatus, 'ACTIVE'); assert.equal(company.accessUntil.toMillis(), instant.getTime() + 30 * 86400000);
      assert.equal((await f.call('expired', 'session')).businessAllowed, true);
    });
    await t.test('member lifecycle actions deny other roles, other companies, self and the company owner', async () => {
      const f = await fixture();
      await db.doc('UserProfile/secondary-admin').set({ name: 'Secondary admin', companyId: 'a', role: 'ADMIN', status: 'ACTIVE' });
      for (const action of ['setMemberStatus', 'deleteMember']) {
        for (const uid of ['member', 'sub', 'platform', 'retired', 'expired', 'suspended']) await denied(f.call(uid, action, { uid: 'member', status: 'RESIGNED' }), 'permission-denied');
        for (const target of ['admin', 'foreign', 'platform', 'missing', '../bad']) await denied(f.call('admin', action, { uid: target, status: 'RESIGNED' }), 'permission-denied');
        await denied(f.call('secondary-admin', action, { uid: 'admin', status: 'RESIGNED' }), 'permission-denied');
      }
      await denied(f.call('admin', 'setMemberStatus', { uid: 'member', status: 'SUSPENDED' }), 'invalid-argument');
      await denied(f.call('admin', 'deleteMember', { uid: 'member' }, { auth_time: seconds - 301 }), 'failed-precondition');
      assert.equal(f.events.length, 0); assert.equal((await db.doc('UserProfile/member').get()).data().status, 'ACTIVE');
    });
    await t.test('retirement disables Auth and revokes sessions, and restoration establishes a new session cutoff', async () => {
      const f = await fixture();
      await f.call('admin', 'setMemberStatus', { uid: 'member', status: 'RESIGNED', companyId: 'b', role: 'ADMIN' });
      assert.equal((await db.doc('UserProfile/member').get()).data().status, 'RESIGNED');
      assert.equal(f.events[0].disabled, true); assert.equal(f.events[1].type, 'revoke');
      await denied(f.call('member', 'session'), 'permission-denied');
      f.events.length = 0;
      await f.call('admin', 'setMemberStatus', { uid: 'member', status: 'ACTIVE' });
      const profile = (await db.doc('UserProfile/member').get()).data();
      assert.equal(profile.status, 'ACTIVE'); assert.equal(profile.role, 'MEMBER'); assert.equal(profile.companyId, 'a'); assert.equal(profile.sessionValidAfter, seconds + 1);
      assert.deepEqual(f.events.filter(event => event.type === 'update').map(event => event.disabled), [true, false]);
      await denied(f.call('member', 'session', {}, { auth_time: seconds }), 'unauthenticated');
    });
    await t.test('Auth failures during retirement or deletion keep the profile blocked and retain evidence', async () => {
      const f = await fixture();
      await db.doc('leaves/member-leave').set({ companyId: 'a', userId: 'member' });
      f.auth.updateUser = async () => { throw Object.assign(new Error('Auth unavailable'), { code: 'auth/internal-error' }); };
      await assert.rejects(f.call('admin', 'setMemberStatus', { uid: 'member', status: 'RESIGNED' }));
      assert.equal((await db.doc('UserProfile/member').get()).data().status, 'RESIGNED');
      f.auth.updateUser = async () => ({});
      f.auth.deleteUser = async () => { throw Object.assign(new Error('Auth delete unavailable'), { code: 'auth/internal-error' }); };
      await assert.rejects(f.call('admin', 'deleteMember', { uid: 'member', deleteRecords: true }));
      assert.equal((await db.doc('UserProfile/member').get()).data().status, 'RESIGNED');
      assert.equal((await db.doc('leaves/member-leave').get()).exists, true); assert.equal(f.storageDeletes.length, 0);
    });
    await t.test('member deletion preserves business records unless explicitly requested and always clears its private profile', async () => {
      const f = await fixture();
      await db.doc('leaves/member-leave').set({ companyId: 'a', userId: 'member' });
      await db.doc('UserProfile/member/private/details').set({ protected: true });
      await db.doc('officialLetterNotifications/member/items/letter-a').set({ companyId: 'a' });
      await f.call('admin', 'deleteMember', { uid: 'member' });
      assert.equal((await db.doc('UserProfile/member').get()).exists, false);
      assert.equal((await db.doc('UserProfile/member/private/details').get()).exists, false);
      assert.equal((await db.doc('officialLetterNotifications/member/items/letter-a').get()).exists, false);
      assert.equal((await db.doc('leaves/member-leave').get()).exists, true); assert.equal(f.storageDeletes.length, 0);
      assert.ok(f.events.some(event => event.type === 'delete' && event.uid === 'member'));
    });
    await t.test('explicit employee record deletion is scoped by both tenant and user and cannot erase another employee or company', async () => {
      const f = await fixture();
      for (const name of ['attendance', 'leaves', 'expenses']) {
        await db.doc(`${name}/own-target`).set({ companyId: 'a', userId: 'member' });
        await db.doc(`${name}/own-other`).set({ companyId: 'a', userId: 'sub' });
        await db.doc(`${name}/foreign-target`).set({ companyId: 'b', userId: 'member' });
      }
      await db.doc('officialLetters/retained-business-record').set({ companyId: 'a', creatorId: 'member' });
      await f.call('admin', 'deleteMember', { uid: 'member', deleteRecords: true, companyId: 'b' });
      for (const name of ['attendance', 'leaves', 'expenses']) {
        assert.equal((await db.doc(`${name}/own-target`).get()).exists, false);
        assert.equal((await db.doc(`${name}/own-other`).get()).exists, true);
        assert.equal((await db.doc(`${name}/foreign-target`).get()).exists, true);
      }
      assert.equal((await db.doc('officialLetters/retained-business-record').get()).exists, true);
      assert.deepEqual(f.storageDeletes.sort(), ['companies/a/expenses/member/', 'companies/a/leaves/member/']);
    });
  } finally {
    for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
    await deleteApp(app);
  }
});
