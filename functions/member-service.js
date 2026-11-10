const { HttpsError } = require('firebase-functions/v2/https');
const { authorizeContext } = require('./security-context');

// Deliberately restricted to newly created employee accounts. First sign-in
// still requires changing this temporary password before using business features.
const INITIAL_MEMBER_PASSWORD = '!123456';
const fail = (code, message) => { throw new HttpsError(code, message); };
const read = (db, reader, ref) => reader === db ? ref.get() : reader.get(ref);

function createMemberService({ db, auth, now = () => new Date() }) {
  async function authorize(request, reader = db) {
    return (await authorizeContext({ db, request, reader, now, roles: ['ADMIN', 'SUPER_ADMIN'] })).companyId;
  }

  async function divisionForTeam(teamId, companyId, reader = db) {
    if (!teamId) return '';
    const team = await read(db, reader, db.collection('teams').doc(teamId));
    if (!team.exists || team.data().companyId !== companyId) fail('invalid-argument', '소속 회사의 팀을 선택해 주세요.');
    const divisionId = team.data().divisionId;
    if (typeof divisionId !== 'string' || !divisionId || divisionId.includes('/')) fail('invalid-argument', '팀의 소속 본부를 확인해 주세요.');
    const division = await read(db, reader, db.collection('divisions').doc(divisionId));
    if (!division.exists || division.data().companyId !== companyId) fail('invalid-argument', '팀의 소속 본부를 확인해 주세요.');
    return divisionId;
  }

  return async request => {
    const companyId = await authorize(request);
    const { name, email, teamId = '', joinDate } = request.data || {};
    if (typeof name !== 'string' || !name.trim() || name.length > 100 ||
        typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
        typeof teamId !== 'string' || teamId.length > 128 || teamId.includes('/')) {
      fail('invalid-argument', '이름, 이메일, 소속 팀을 확인해 주세요.');
    }
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(now());
    const startDate = joinDate || today;
    const parsedDate = typeof startDate === 'string' ? new Date(`${startDate}T00:00:00Z`) : new Date(NaN);
    if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
        Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== startDate) {
      fail('invalid-argument', '입사일은 유효한 날짜(YYYY-MM-DD)로 입력해 주세요.');
    }
    // Validate the tenant/team before creating Auth, then recheck both before
    // committing the profile so a concurrent permission change rolls Auth back.
    await divisionForTeam(teamId, companyId);
    let created;
    try {
      created = await auth.createUser({ email: email.trim().toLowerCase(), password: INITIAL_MEMBER_PASSWORD, displayName: name.trim() });
      await db.runTransaction(async tx => {
        const currentCompanyId = await authorize(request, tx);
        if (currentCompanyId !== companyId) fail('aborted', '소속 회사가 변경되었습니다. 다시 로그인해 주세요.');
        const divisionId = await divisionForTeam(teamId, companyId, tx);
        tx.create(db.collection('UserProfile').doc(created.uid), {
          uid: created.uid, email: email.trim().toLowerCase(), name: name.trim(), role: 'MEMBER',
          companyId, teamId, divisionId, teamHistory: [], joinDate: startDate,
          mustChangePassword: true, status: 'ACTIVE', createdAt: now().toISOString(),
        });
      });
    } catch (error) {
      if (created) {
        try { await auth.deleteUser(created.uid); }
        catch { fail('internal', '직원 계정 생성을 완료하지 못했습니다. 관리자에게 문의해 주세요.'); }
      }
      if (error instanceof HttpsError) throw error;
      if (['auth/email-already-exists', 'auth/email-already-in-use'].includes(error.code)) fail('already-exists', '이미 등록된 이메일 주소입니다.');
      if (error.code === 'auth/invalid-email') fail('invalid-argument', '유효한 이메일 주소를 입력해 주세요.');
      fail('internal', '직원 등록 중 오류가 발생했습니다.');
    }
    return { success: true, uid: created.uid, message: '신규 직원 계정이 생성되었습니다. 최초 로그인 시 비밀번호를 변경해야 합니다.' };
  };
}

module.exports = { createMemberService, INITIAL_MEMBER_PASSWORD };
