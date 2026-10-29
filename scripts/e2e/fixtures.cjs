const { randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const { PROJECT_ID, STORAGE_BUCKET, assertE2EEnvironment } = require('./safety.cjs');

let state;
const documentId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function runtime() {
  assertE2EEnvironment();
  if (!state) throw new Error('E2E fixtures have not been seeded.');
  return state;
}
function accountFor(value) {
  const current = runtime();
  const uid = typeof value === 'string' ? value : value?.uid;
  const account = Object.values(current.fixtures.accounts).find(item => item.uid === uid);
  if (!account) throw new Error('Only a generated E2E account can be changed.');
  return account;
}
function ownedExpense(snapshot) {
  const current = runtime();
  if (!snapshot.exists) throw new Error('The E2E expense does not exist.');
  const record = snapshot.data();
  if (![current.fixtures.companyA, current.fixtures.companyB].includes(record.companyId) ||
      !Object.values(current.fixtures.accounts).some(account => account.uid === record.userId && account.companyId === record.companyId)) {
    throw new Error('Refusing to inspect an expense outside the generated E2E fixtures.');
  }
  return { id: snapshot.id, ...record };
}

async function seedFixtures() {
  // Validate before importing or initializing any Admin SDK service.
  assertE2EEnvironment();
  if (state) throw new Error('E2E fixtures are already active; use one test worker.');
  const requireFunctions = createRequire(path.resolve(__dirname, '../../functions/package.json'));
  const { initializeApp, deleteApp } = requireFunctions('firebase-admin/app');
  const { getAuth } = requireFunctions('firebase-admin/auth');
  const { getFirestore, Timestamp } = requireFunctions('firebase-admin/firestore');
  const { getStorage } = requireFunctions('firebase-admin/storage');
  const runId = randomBytes(8).toString('hex');
  const id = name => `e2e-${runId}-${name}`;
  const app = initializeApp({ projectId: PROJECT_ID, storageBucket: STORAGE_BUCKET }, id('admin-app'));
  const db = getFirestore(app, '(default)');
  const auth = getAuth(app);
  const bucket = getStorage(app).bucket(STORAGE_BUCKET);
  const companyA = id('company-a'), companyB = id('company-b');
  const divisionA = id('division-a'), divisionOtherA = id('division-other-a'), divisionB = id('division-b');
  const teamA = id('team-a'), otherTeamA = id('team-other-a'), teamB = id('team-b');
  const specifications = {
    platform: ['플랫폼 운영자', 'SUPER_ADMIN', 'PLATFORM', '', '', 'ACTIVE'],
    adminA: ['A 관리자', 'ADMIN', companyA, divisionA, teamA, 'ACTIVE'],
    memberA: ['A 직원', 'MEMBER', companyA, divisionA, teamA, 'ACTIVE'],
    passwordA: ['A 비밀번호 직원', 'MEMBER', companyA, divisionA, teamA, 'ACTIVE'],
    requiredA: ['A 초기 비밀번호 직원', 'MEMBER', companyA, divisionA, teamA, 'ACTIVE'],
    memberB: ['B 직원', 'MEMBER', companyB, divisionB, teamB, 'ACTIVE'],
    managerA: ['A 본부장', 'SUB_ADMIN', companyA, divisionA, teamA, 'ACTIVE'],
    otherManagerA: ['다른 A 본부장', 'SUB_ADMIN', companyA, divisionOtherA, otherTeamA, 'ACTIVE'],
    suspendedA: ['A 정지 직원', 'MEMBER', companyA, divisionA, teamA, 'SUSPENDED'],
    resignedA: ['A 퇴사 직원', 'MEMBER', companyA, divisionA, teamA, 'RESIGNED'],
    disabledA: ['A 비활성 직원', 'MEMBER', companyA, divisionA, teamA, 'ACTIVE'],
  };
  const accounts = Object.fromEntries(Object.entries(specifications).map(([key, [label, role, companyId, divisionId, teamId, status]]) => [key, {
    uid: id(key), email: `${key.toLowerCase()}.${runId}@e2e.example.invalid`,
    password: key === 'requiredA' ? `!${randomBytes(4).toString('base64url')}` : `E2E!${randomBytes(24).toString('base64url')}`, name: `자동점검 ${label}`,
    role, companyId, divisionId, teamId, status,
  }]));
  const foreignPayrollId = id('foreign-payroll');
  const fixtures = { accounts, companyA, companyB, divisionA, divisionOtherA, divisionB, teamA, otherTeamA, teamB, foreignPayrollId, runId };
  state = { app, deleteApp, db, auth, bucket, fixtures, createdUsers: [], documentPaths: [] };
  const createdAt = new Date().toISOString();
  const accessUntil = Timestamp.fromMillis(Date.now() + 30 * 86400000);
  try {
    for (const [key, account] of Object.entries(accounts)) {
      await auth.createUser({ uid: account.uid, email: account.email, password: account.password,
        emailVerified: true, disabled: key === 'disabledA', displayName: account.name });
      state.createdUsers.push(account.uid);
    }
    const batch = db.batch();
    const set = (collection, key, value) => {
      const reference = db.collection(collection).doc(key);
      batch.set(reference, value); state.documentPaths.push(reference.path);
    };
    for (const [companyId, label, ownerUid] of [[companyA, 'A', accounts.adminA.uid], [companyB, 'B', accounts.memberB.uid]]) {
      set('companies', companyId, { nameKo: `자동점검 회사 ${label}`, nameEn: `E2E Company ${label}`,
        domain: `company-${label.toLowerCase()}.e2e.example.invalid`, adminUid: ownerUid,
        status: 'ACTIVE', createdAt, accessUntil, subscriptionStatus: 'ACTIVE',
        subscriptionEndDate: accessUntil.toDate().toISOString(), planType: 'MONTHLY' });
      set('tenantRegistry', companyId, { status: 'ACTIVE', createdAt });
      set('config', companyId, { companyId, defaultDomain: `company-${label.toLowerCase()}.e2e.example.invalid`, createdAt });
    }
    for (const [key, account] of Object.entries(accounts)) {
      set('UserProfile', account.uid, { uid: account.uid, email: account.email, name: account.name,
        role: account.role, companyId: account.companyId, divisionId: account.divisionId,
        teamId: account.teamId, status: account.status, mustChangePassword: key === 'requiredA',
        teamHistory: [], joinDate: '2025-01-01', annualLeaveTotal: 15, usedLeave: 1,
        annualSalary: 24000000, salaryType: 'ANNUAL', dependents: 1,
        childrenUnder20: 0, nonTaxable: 200000, createdAt,
        ...(key === 'platform' ? { annualSalary: 0 } : {}),
      });
    }
    for (const [divisionId, companyId, label, headId] of [
      [divisionA, companyA, 'A 본부', accounts.managerA.uid],
      [divisionOtherA, companyA, '다른 A 본부', accounts.otherManagerA.uid],
      [divisionB, companyB, 'B 본부', ''],
    ]) set('divisions', divisionId, { companyId, name: `자동점검 ${label}`, headId });
    for (const [teamId, companyId, divisionId, label, leaderId] of [
      [teamA, companyA, divisionA, 'A팀', accounts.managerA.uid],
      [otherTeamA, companyA, divisionOtherA, '다른 A팀', accounts.otherManagerA.uid],
      [teamB, companyB, divisionB, 'B팀', ''],
    ]) set('teams', teamId, { companyId, divisionId, name: `자동점검 ${label}`, leaderId });
    // A synthetic foreign-company aggregate is sufficient to exercise the
    // authorization check before any monthly PDF document data is disclosed.
    set('payroll_records', foreignPayrollId, { companyId: companyB, schemaVersion: 1,
      year: 2026, month: 10, employeeCount: 1, totalGross: 2000000, totalNet: 1800000,
      approvedBy: accounts.memberB.uid, approvedByName: accounts.memberB.name,
      approvedAt: Timestamp.fromMillis(Date.UTC(2026, 9, 25)), divisionName: '자동점검 B 본부' });
    await batch.commit();
    return fixtures;
  } catch {
    await clearFixtures().catch(() => {});
    // Do not print SDK error objects, credential payloads, or generated passwords.
    throw new Error('Could not seed isolated E2E fixtures.');
  }
}

async function getExpense(id) {
  const current = runtime();
  if (!documentId(id)) throw new Error('An E2E expense document ID is required.');
  return ownedExpense(await current.db.collection('expenses').doc(id).get());
}

async function findExpenseByTitle(title) {
  const current = runtime();
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('An E2E expense title is required.');
  const matches = await current.db.collection('expenses')
    .where('companyId', 'in', [current.fixtures.companyA, current.fixtures.companyB])
    .where('title', '==', title).get();
  if (matches.size !== 1) throw new Error('Expected one generated E2E expense.');
  return ownedExpense(matches.docs[0]);
}

async function readAttachment(objectPath) {
  const current = runtime();
  if (typeof objectPath !== 'string' || objectPath.includes('..') || /[\u0000-\u001f\\]/.test(objectPath) ||
      ![current.fixtures.companyA, current.fixtures.companyB].some(id => objectPath.startsWith(`companies/${id}/`))) {
    throw new Error('Only an attachment owned by this E2E run can be read.');
  }
  const [bytes] = await current.bucket.file(objectPath).download({ validation: 'crc32c' });
  return bytes;
}

async function setProfileStatus(value, status) {
  const current = runtime(), account = accountFor(value);
  if (!['ACTIVE', 'SUSPENDED', 'RESIGNED'].includes(status)) throw new Error('Unsupported E2E profile status.');
  await current.db.collection('UserProfile').doc(account.uid).update({ status });
}

async function revokeTestUser(value) {
  const current = runtime(), account = accountFor(value);
  await current.auth.revokeRefreshTokens(account.uid);
}

async function readProfile(value) {
  const current = runtime(), account = accountFor(value);
  const snapshot = await current.db.collection('UserProfile').doc(account.uid).get();
  if (!snapshot.exists || snapshot.data().companyId !== account.companyId) throw new Error('The generated E2E profile is unavailable.');
  return snapshot.data();
}

async function readPayrollRecord(companyId, year, month) {
  const current = runtime();
  if (![current.fixtures.companyA, current.fixtures.companyB].includes(companyId) ||
      year !== 2026 || ![10, 11].includes(month)) throw new Error('Only a generated E2E payroll period may be inspected.');
  const snapshot = await current.db.collection('payroll_records').where('companyId', '==', companyId)
    .where('year', '==', year).where('month', '==', month).get();
  const records = snapshot.docs.filter(item => item.data().schemaVersion === 2);
  if (records.length !== 1) throw new Error('Expected exactly one generated approved E2E payroll snapshot.');
  const record = records[0].data();
  if (!Array.isArray(record.rows) || record.rows.some(row => row.companyId !== companyId ||
      !Object.values(current.fixtures.accounts).some(account => account.uid === row.userId && account.companyId === companyId))) {
    throw new Error('Refusing to inspect payroll rows outside this generated E2E company.');
  }
  return { id: records[0].id, ...record };
}

async function clearFixtures() {
  assertE2EEnvironment();
  if (!state) return;
  const current = state;
  const failures = [];
  const attempt = async operation => {
    try { await operation(); } catch { failures.push(true); }
  };
  // Only this run's company IDs and exact UIDs may be removed. No project-wide
  // clear/reset endpoint is used, even though this is an ephemeral demo project.
  for (const companyId of [current.fixtures.companyA, current.fixtures.companyB]) {
    for (const collection of ['expenses', 'leaves', 'attendance', 'notices', 'audit_logs', 'salary_history', 'payroll_records']) {
      await attempt(async () => {
        const records = await current.db.collection(collection).where('companyId', '==', companyId).get();
        for (const record of records.docs) await attempt(() => record.ref.delete());
      });
    }
    await attempt(() => current.bucket.deleteFiles({ prefix: `companies/${companyId}/` }));
  }
  for (const reference of current.documentPaths) await attempt(() => current.db.doc(reference).delete());
  for (const uid of current.createdUsers) await attempt(() => current.auth.deleteUser(uid));
  await attempt(() => current.deleteApp(current.app));
  state = undefined;
  if (failures.length) throw new Error('Could not completely remove isolated E2E fixtures.');
}

module.exports = { seedFixtures, clearFixtures, getExpense, findExpenseByTitle, readAttachment, setProfileStatus, revokeTestUser, readProfile, readPayrollRecord };
