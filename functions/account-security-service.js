const { randomUUID, createHash } = require('node:crypto');
const { Timestamp } = require('firebase-admin/firestore');
const { authorizeContext, recentAuthentication, fail, milliseconds } = require('./security-context');
const { isValidNewPassword, PASSWORD_LENGTH_ERROR } = require('./password-policy.mjs');
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid-argument', '입력 내용을 확인해 주세요.');
  return value.trim();
};
const minimalProfile = user => Object.fromEntries(['uid', 'email', 'name', 'role', 'companyId', 'teamId', 'divisionId', 'status', 'mustChangePassword']
  .filter(key => user[key] !== undefined).map(key => [key, user[key]]));
const safeCompany = user => user.company ? { ...Object.fromEntries(['nameKo', 'nameEn', 'domain', 'adminUid', 'createdAt', 'status', 'subscriptionStatus',
  'subscriptionEndDate', 'planType', 'lastPaymentDate', 'lastBackupAt'].filter(k => user.company[k] !== undefined).map(k => [k, user.company[k]])),
  id: user.companyId, accessUntil: user.company.accessUntil?.toDate?.().toISOString() || null } : null;

function createAccountSecurityService({ db, auth, bucket, now = () => new Date(), uuid = randomUUID }) {
  const authorize = (request, options = {}) => authorizeContext({ db, request, now, roles: ['ADMIN', 'SUB_ADMIN', 'MEMBER', 'SUPER_ADMIN'], ...options });
  return async request => {
    const input = request.data || {};
    if (!request.auth?.uid) fail('unauthenticated', '로그인이 필요합니다.');
    if (input.action === 'session') {
      const snapshot = await db.collection('UserProfile').doc(request.auth.uid).get();
      if (!snapshot.exists) return { profile: null, company: null, businessAllowed: false };
      const user = await authorize(request, { allowPendingPassword: true, allowExpired: true });
      const entitled = user.role === 'SUPER_ADMIN' || milliseconds(user.company.accessUntil) > now().getTime();
      return { profile: minimalProfile(user), company: safeCompany(user), businessAllowed: !user.mustChangePassword && entitled };
    }
    if (input.action === 'createCompany') {
      if (request.auth.token.email_verified !== true) fail('failed-precondition', '이메일 인증을 완료한 후 다시 시도해 주세요.');
      recentAuthentication(request, now);
      const nameKo = text(input.nameKo, 120), nameEn = text(input.nameEn, 120), name = text(input.name, 100);
      const account = await auth.getUser(request.auth.uid);
      if (!account.emailVerified || account.disabled || !account.email) fail('permission-denied', '인증된 이메일 계정이 필요합니다.');
      const email = account.email.toLowerCase(), domain = email.split('@')[1];
      const companyId = uuid(); // Clients never choose or reclaim a tenant ID.
      const domainRef = db.collection('companyDomains').doc(createHash('sha256').update(domain).digest('hex'));
      return db.runTransaction(async tx => {
        const profileRef = db.collection('UserProfile').doc(request.auth.uid);
        const [profile, reserved, existing, registry] = await Promise.all([
          tx.get(profileRef), tx.get(domainRef),
          tx.get(db.collection('companies').where('domain', '==', domain).limit(1)),
          tx.get(db.collection('tenantRegistry').doc(companyId)),
        ]);
        if (profile.exists) fail('already-exists', '이미 조직에 등록된 계정입니다.');
        if (!existing.empty && existing.docs[0].data().adminUid === request.auth.uid && existing.docs[0].data().status === 'ACTIVE' &&
            (!reserved.exists || reserved.data().companyId === existing.docs[0].id)) {
          const ownedId = existing.docs[0].id;
          const ownedRegistry = await tx.get(db.collection('tenantRegistry').doc(ownedId));
          if (ownedRegistry.exists && ownedRegistry.data().status !== 'ACTIVE') fail('permission-denied', '이 조직은 복구할 수 없습니다.');
          const createdAt = now().toISOString();
          tx.create(profileRef, { uid: request.auth.uid, email, name, role: 'ADMIN', companyId: ownedId, teamId: '', divisionId: '',
            teamHistory: [], mustChangePassword: false, status: 'ACTIVE', createdAt });
          tx.set(db.collection('tenantRegistry').doc(ownedId), { status: 'ACTIVE' }, { merge: true });
          tx.set(domainRef, { companyId: ownedId, createdAt }, { merge: true });
          return { companyId: ownedId };
        }
        if (reserved.exists || !existing.empty) fail('already-exists', '이미 등록된 회사 도메인입니다. 회사 관리자에게 계정 등록을 요청해 주세요.');
        if (registry.exists) fail('aborted', '조직 등록을 다시 시도해 주세요.');
        const createdAt = now().toISOString();
        tx.create(db.collection('tenantRegistry').doc(companyId), { status: 'ACTIVE', createdAt });
        tx.create(domainRef, { companyId, createdAt });
        tx.create(db.collection('companies').doc(companyId), { nameKo, nameEn, domain, adminUid: request.auth.uid, createdAt,
          status: 'ACTIVE', plan: 'FREE', subscriptionStatus: 'TRIAL', accessUntil: Timestamp.fromMillis(now().getTime() + 90 * 86400000) });
        tx.create(profileRef, { uid: request.auth.uid, email, name, role: 'ADMIN', companyId, teamId: '', divisionId: '',
          teamHistory: [], mustChangePassword: false, status: 'ACTIVE', createdAt });
        tx.create(db.collection('config').doc(companyId), { companyId, defaultDomain: domain, updatedAt: createdAt, updatedBy: request.auth.uid });
        return { companyId };
      });
    }
    if (input.action === 'changePassword') {
      const initial = await authorize(request, { allowPendingPassword: true, allowExpired: true });
      recentAuthentication(request, now);
      if (!isValidNewPassword(input.newPassword)) {
        fail('invalid-argument', PASSWORD_LENGTH_ERROR);
      }
      await auth.updateUser(request.auth.uid, { password: input.newPassword });
      await db.runTransaction(async tx => {
        const current = await authorize(request, { reader: tx, allowPendingPassword: true, allowExpired: true });
        if (current.companyId !== initial.companyId || current.role !== initial.role || !!current.mustChangePassword !== !!initial.mustChangePassword) fail('aborted', '계정 정보가 변경되었습니다. 다시 로그인해 주세요.');
        tx.update(db.collection('UserProfile').doc(request.auth.uid), { mustChangePassword: false,
          lastPasswordChange: now().toISOString(), sessionValidAfter: Math.floor(now().getTime() / 1000) + 1 });
      });
      await auth.revokeRefreshTokens(request.auth.uid);
      return { success: true, signInAgain: true };
    }
    if (input.action === 'directory') {
      const user = await authorize(request, { roles: ['ADMIN', 'SUB_ADMIN'] });
      let query = db.collection('UserProfile').where('companyId', '==', user.companyId);
      if (user.role === 'SUB_ADMIN') {
        if (!user.divisionId) return { users: [] };
        query = query.where('divisionId', '==', user.divisionId);
      }
      const profiles = await query.get();
      const current = await authorize(request, { roles: ['ADMIN', 'SUB_ADMIN'] });
      if (user.companyId !== current.companyId || user.role !== current.role || user.divisionId !== current.divisionId) fail('aborted', '소속 정보가 변경되었습니다. 다시 시도해 주세요.');
      const keys = ['name', 'role', 'teamId', 'divisionId', 'annualLeaveTotal', 'usedLeave'];
      return { users: profiles.docs.filter(d => (d.data().status || 'ACTIVE') === 'ACTIVE').map(d => ({ uid: d.id,
        ...Object.fromEntries(keys.filter(k => d.data()[k] !== undefined).map(k => [k, d.data()[k]])) })) };
    }
    if (input.action === 'submitPaymentClaim') {
      const user = await authorize(request, { roles: ['ADMIN'], allowExpired: true });
      if (typeof input.orderId !== 'string' || !/^[A-Za-z0-9_-]{6,80}$/.test(input.orderId)) fail('invalid-argument', '결제 접수 정보를 확인해 주세요.');
      const ref = db.collection('payment_claims').doc(input.orderId);
      await db.runTransaction(async tx => {
        const current = await authorize(request, { reader: tx, roles: ['ADMIN'], allowExpired: true });
        if (current.companyId !== user.companyId) fail('aborted', '소속 정보가 변경되었습니다.');
        const existing = await tx.get(ref);
        if (existing.exists) {
          if (existing.data().companyId !== user.companyId || existing.data().adminUid !== user.uid) fail('already-exists', '이미 접수된 결제입니다.');
          return;
        }
        tx.create(ref, { companyId: user.companyId, companyName: user.company.nameKo, adminUid: user.uid,
          adminName: user.name || '', orderId: input.orderId, status: 'PENDING', createdAt: Timestamp.fromDate(now()) });
      });
      return { success: true };
    }
    if (['setMemberStatus', 'deleteMember'].includes(input.action)) {
      const caller = await authorize(request, { roles: ['ADMIN'] });
      const uid = text(input.uid, 128);
      if (uid.includes('/') || uid === caller.uid || uid === caller.company.adminUid) fail('permission-denied', '관리자 본인과 회사 소유자는 변경할 수 없습니다.');
      if (input.action === 'deleteMember') recentAuthentication(request, now);
      if (input.action === 'setMemberStatus' && !['ACTIVE', 'RESIGNED'].includes(input.status)) fail('invalid-argument', '계정 상태를 확인해 주세요.');
      const ref = db.collection('UserProfile').doc(uid);
      await db.runTransaction(async tx => {
        const current = await authorize(request, { roles: ['ADMIN'], reader: tx }), target = await tx.get(ref);
        if (current.companyId !== caller.companyId || !target.exists || target.data().companyId !== caller.companyId ||
            target.data().role === 'SUPER_ADMIN') fail('permission-denied', '소속 회사 직원만 관리할 수 있습니다.');
        tx.update(ref, { status: 'RESIGNED' });
      });
      try {
        await auth.updateUser(uid, { disabled: true }); await auth.revokeRefreshTokens(uid);
        if (input.action === 'setMemberStatus') {
          if (input.status === 'ACTIVE') {
            await auth.updateUser(uid, { disabled: false });
            await ref.update({ status: 'ACTIVE', sessionValidAfter: Math.floor(now().getTime() / 1000) + 1 });
          }
          return { success: true };
        }
        await auth.deleteUser(uid);
      } catch (error) {
        if (error.code !== 'auth/user-not-found' || input.action !== 'deleteMember') throw error;
      }
      if (input.deleteRecords === true) {
        for (const name of ['attendance', 'leaves', 'expenses']) {
          while (true) {
            const records = await db.collection(name).where('companyId', '==', caller.companyId).where('userId', '==', uid).limit(100).get();
            if (records.empty) break;
            for (const record of records.docs) await db.recursiveDelete(record.ref);
          }
        }
        for (const name of ['expenses', 'leaves']) await bucket.deleteFiles({ prefix: `companies/${caller.companyId}/${name}/${uid}/`, force: false });
      }
      await db.recursiveDelete(db.collection('officialLetterNotifications').doc(uid));
      await db.recursiveDelete(ref);
      return { success: true };
    }
    if (input.action === 'extendSubscription') {
      await authorize(request, { roles: ['SUPER_ADMIN'] }); recentAuthentication(request, now);
      const companyId = text(input.companyId, 128);
      if (companyId.includes('/') || companyId === 'PLATFORM' || !Number.isInteger(input.days) || input.days < 1 || input.days > 3660) fail('invalid-argument', '조직과 연장 일수를 확인해 주세요.');
      return db.runTransaction(async tx => {
        await authorize(request, { reader: tx, roles: ['SUPER_ADMIN'] });
        const ref = db.collection('companies').doc(companyId), snapshot = await tx.get(ref);
        if (!snapshot.exists || !['ACTIVE', 'SUSPENDED'].includes(snapshot.data().status)) fail('not-found', '조직을 찾을 수 없습니다.');
        const end = new Date(Math.max(now().getTime(), milliseconds(snapshot.data().accessUntil) || 0) + input.days * 86400000);
        tx.update(ref, { subscriptionStatus: 'ACTIVE', subscriptionEndDate: end.toISOString(), accessUntil: Timestamp.fromDate(end) });
        return { success: true };
      });
    }
    fail('invalid-argument', '지원하지 않는 요청입니다.');
  };
}
module.exports = { createAccountSecurityService };
