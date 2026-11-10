const { createHash } = require('node:crypto');
const { authorizeContext, recentAuthentication, fail } = require('./security-context');
const { isValidNewPassword, PASSWORD_LENGTH_ERROR } = require('./password-policy.mjs');

function createAdminSecurityService({ db, auth, bucket, now = () => new Date() }) {
  const authorize = (request, options = {}) => authorizeContext({ db, request, now, roles: ['ADMIN', 'SUPER_ADMIN'], ...options });
  const domainKey = domain => createHash('sha256').update(domain).digest('hex');
  const domainInput = value => {
    if (typeof value !== 'string' || value.length > 253) fail('invalid-argument', '도메인을 확인해 주세요.');
    const domain = value.replace(/^@/, '').trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) fail('invalid-argument', '도메인을 확인해 주세요.');
    return domain;
  };
  return {
    async checkDomain(request) {
      const caller = await authorize(request);
      const domain = domainInput(request.data?.domain);
      const [companies, reservation] = await Promise.all([
        db.collection('companies').where('domain', '==', domain).limit(1).get(),
        db.collection('companyDomains').doc(domainKey(domain)).get(),
      ]);
      const reservedFor = reservation.data()?.companyId;
      return { available: (!reservedFor || reservedFor === caller.companyId) &&
        (companies.empty || companies.docs[0].id === caller.companyId) };
    },
    async resetPassword(request) {
      const caller = await authorize(request);
      recentAuthentication(request, now);
      const { uid, password } = request.data || {};
      if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')) {
        fail('invalid-argument', '유효한 사용자 ID가 필요합니다.');
      }
      if (!isValidNewPassword(password)) fail('invalid-argument', PASSWORD_LENGTH_ERROR);
      const targetRef = db.collection('UserProfile').doc(uid), target = await targetRef.get();
      if (!target.exists || target.data().role === 'SUPER_ADMIN') fail('permission-denied', '관리할 수 없는 계정입니다.');
      if (caller.role !== 'SUPER_ADMIN' && (target.data().companyId !== caller.companyId || uid === caller.uid ||
        target.data().role === 'ADMIN' || caller.company.adminUid === uid)) fail('permission-denied', '소속 회사 직원 계정만 관리할 수 있습니다.');
      await db.runTransaction(async tx => {
        const current = await authorize(request, { reader: tx });
        const latest = await tx.get(targetRef);
        if (current.companyId !== caller.companyId || current.role !== caller.role || !latest.exists ||
            latest.data().companyId !== target.data().companyId || latest.data().role !== target.data().role) fail('aborted', '계정 권한이 변경되었습니다. 다시 시도해 주세요.');
        tx.update(targetRef, { mustChangePassword: true });
      });
      await auth.updateUser(uid, { password });
      await auth.revokeRefreshTokens(uid);
      return { success: true, message: '비밀번호가 초기화되었습니다. 해당 직원은 최초 로그인 후 비밀번호를 변경해야 합니다.' };
    },
    async syncDomain(request) {
      const caller = await authorize(request, { roles: ['ADMIN'] });
      recentAuthentication(request, now);
      const domain = domainInput(request.data?.newDomain);
      const account = await auth.getUser(caller.uid);
      if (!account.emailVerified || account.disabled || account.email?.toLowerCase().split('@')[1] !== domain) {
        fail('failed-precondition', '새 회사 도메인의 관리자 이메일 인증을 먼저 완료해 주세요.');
      }
      await db.runTransaction(async tx => {
        const current = await authorize(request, { roles: ['ADMIN'], reader: tx });
        if (current.companyId !== caller.companyId) fail('aborted', '소속 정보가 변경되었습니다.');
        const reservationRef = db.collection('companyDomains').doc(domainKey(domain));
        const [existing, reservation] = await Promise.all([
          tx.get(db.collection('companies').where('domain', '==', domain).limit(1)), tx.get(reservationRef),
        ]);
        if ((!existing.empty && existing.docs[0].id !== caller.companyId) ||
          (reservation.exists && reservation.data().companyId !== caller.companyId)) fail('already-exists', '이미 다른 회사에서 사용하는 도메인입니다.');
        tx.set(reservationRef, { companyId: caller.companyId, createdAt: now().toISOString() });
        tx.update(db.collection('companies').doc(caller.companyId), { domain, updatedAt: now().toISOString(), updatedBy: caller.uid });
        tx.set(db.collection('config').doc(caller.companyId), { companyId: caller.companyId, defaultDomain: domain }, { merge: true });
      });
      const users = await db.collection('UserProfile').where('companyId', '==', caller.companyId).get();
      let successCount = 0, failCount = 0;
      for (const doc of users.docs) {
        const current = await authorize(request, { roles: ['ADMIN'] });
        const profile = (await doc.ref.get()).data();
        if (current.companyId !== caller.companyId || profile?.companyId !== caller.companyId) fail('aborted', '소속 정보가 변경되었습니다.');
        if (profile.role === 'SUPER_ADMIN') continue;
        const email = typeof profile.email === 'string' && profile.email.includes('@') ? `${profile.email.split('@')[0]}@${domain}` : '';
        if (!email) { failCount++; continue; }
        try {
          await auth.updateUser(doc.id, { email });
          await doc.ref.update({ email });
          successCount++;
        } catch { failCount++; }
      }
      return { success: true, successCount, failCount, message: `${successCount}명의 사용자 도메인 동기화가 완료되었습니다.${failCount ? ` (실패: ${failCount}명, 다시 실행해 주세요.)` : ''}` };
    },
    async deleteCompany(request) {
      await authorize(request, { roles: ['SUPER_ADMIN'] }); recentAuthentication(request, now);
      const companyId = request.data?.companyId;
      if (typeof companyId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(companyId) || companyId === 'PLATFORM') fail('invalid-argument', '조직 ID를 확인해 주세요.');
      const companyRef = db.collection('companies').doc(companyId), registryRef = db.collection('tenantRegistry').doc(companyId);
      await db.runTransaction(async tx => {
        await authorize(request, { roles: ['SUPER_ADMIN'], reader: tx });
        const snapshot = await tx.get(companyRef);
        if (!snapshot.exists) fail('not-found', '조직을 찾을 수 없습니다.');
        tx.update(companyRef, { status: 'DELETING' });
        tx.set(registryRef, { status: 'DELETING', reservedAt: now().toISOString() }, { merge: true });
      });
      // Any error leaves the tenant locked. A retry resumes its deletion.
      const users = await db.collection('UserProfile').where('companyId', '==', companyId).get();
      for (const user of users.docs) {
        if (user.data().role === 'SUPER_ADMIN') fail('failed-precondition', '플랫폼 계정이 포함된 조직은 삭제할 수 없습니다.');
        try { await auth.updateUser(user.id, { disabled: true }); await auth.revokeRefreshTokens(user.id); }
        catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
      }
      for (let i = 0; i < users.docs.length; i += 1000) {
        const result = await auth.deleteUsers(users.docs.slice(i, i + 1000).map(user => user.id));
        if (result.failureCount) fail('internal', '계정 삭제를 완료하지 못했습니다. 조직은 차단된 상태이며 다시 시도할 수 있습니다.');
      }
      await bucket.deleteFiles({ prefix: `companies/${companyId}/`, force: false });
      for (const collection of await db.listCollections()) {
        if (['companies', 'tenantRegistry', 'companyDomains', 'UserProfile'].includes(collection.id)) continue;
        while (true) {
          const docs = await collection.where('companyId', '==', companyId).limit(100).get();
          if (docs.empty) break;
          for (const doc of docs.docs) await db.recursiveDelete(doc.ref);
        }
      }
      for (const name of ['config', 'officialLetterSettings', 'officialLetterPrinters']) await db.recursiveDelete(db.collection(name).doc(companyId));
      // Missing parent documents can still have subcollections. Older deletion
      // versions left inboxes for removed employees and archived letter roots.
      for (const [root, child] of [['officialLetterNotifications', 'items'], ['officialLetters', 'history']]) {
        for (const parent of await db.collection(root).listDocuments()) {
          while (true) {
            const records = await parent.collection(child).where('companyId', '==', companyId).limit(100).get();
            if (records.empty) break;
            for (const record of records.docs) await db.recursiveDelete(record.ref);
          }
        }
      }
      for (const user of users.docs) {
        await db.recursiveDelete(db.collection('officialLetterNotifications').doc(user.id));
        await db.recursiveDelete(user.ref);
      }
      const deletedAt = now().toISOString();
      await db.runTransaction(async tx => {
        tx.set(companyRef, { status: 'DELETED', createdAt: deletedAt, deletedAt });
        tx.set(registryRef, { status: 'DELETED', deletedAt }, { merge: true });
      });
      return { success: true, message: '조직 데이터와 계정이 삭제되었습니다. 조직 ID는 재사용할 수 없습니다.' };
    },
  };
}
module.exports = { createAdminSecurityService };
