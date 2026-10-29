import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, Timestamp, updateDoc, where } from 'firebase/firestore';
import { ref, uploadBytes, getBytes, getMetadata, listAll, deleteObject } from 'firebase/storage';

// This suite is deliberately bound to local demo emulators, never production.
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-hr-flow',
  firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.rules', 'utf8') },
  storage: { host: '127.0.0.1', port: 9199, rules: readFileSync('storage.rules', 'utf8') }
});
let checks = 0;
const allow = async (label, action) => { try { const result = await assertSucceeds(action); checks++; return result; } catch (error) { throw new Error(`Expected ALLOW: ${label}`, { cause: error }); } };
const deny = async (label, action) => { try { await assertFails(action); checks++; } catch (error) { throw new Error(`Expected DENY: ${label}`, { cause: error }); } };
const users = [
  ['alice', 'ADMIN', 'a', 'div1', 'team1'], ['admin2', 'ADMIN', 'a', 'div1', 'team1'],
  ['bob', 'MEMBER', 'a', 'div1', 'team1'], ['carol', 'MEMBER', 'a', 'div2', 'team2'],
  ['manager', 'SUB_ADMIN', 'a', 'div1', 'team1'], ['manager2', 'SUB_ADMIN', 'a', 'div2', 'team2'],
  ['outsider', 'ADMIN', 'b', 'divB', 'teamB'], ['foreignMember', 'MEMBER', 'b', 'divB', 'teamB'],
  ['retired', 'MEMBER', 'a', 'div1', 'team1', { status: 'RESIGNED' }],
  ['retiredAdmin', 'ADMIN', 'a', 'div1', 'team1', { status: 'RESIGNED' }],
  ['pendingPassword', 'MEMBER', 'a', 'div1', 'team1', { mustChangePassword: true }],
  ['pendingAdmin', 'ADMIN', 'a', 'div1', 'team1', { mustChangePassword: true }],
  ['suspended', 'ADMIN', 'suspended', '', ''], ['expired', 'ADMIN', 'expired', '', ''],
  ['missingEntitlement', 'ADMIN', 'missingEntitlement', '', ''], ['badEntitlement', 'ADMIN', 'badEntitlement', '', ''],
  ['deleted', 'ADMIN', 'deleted', '', ''], ['deleting', 'ADMIN', 'deleting', '', ''],
  ['missingCompany', 'ADMIN', 'nonexistent', '', ''],
  ['root', 'SUPER_ADMIN', 'PLATFORM', '', ''],
  ['retiredRoot', 'SUPER_ADMIN', 'PLATFORM', '', '', { status: 'RESIGNED' }],
  ['pendingRoot', 'SUPER_ADMIN', 'PLATFORM', '', '', { mustChangePassword: true }],
  ['sessionUser', 'MEMBER', 'a', 'div1', 'team1', { sessionValidAfter: 200 }],
];
const contexts = Object.fromEntries([...users.map(([uid]) => [uid, testEnv.authenticatedContext(uid, { email: `${uid}@example.test`, email_verified: true })]),
  ['newcomer', testEnv.authenticatedContext('newcomer', { email: 'newcomer@unrelated.test', email_verified: false })],
  ['anonymous', testEnv.unauthenticatedContext()]]);
contexts.sessionFresh = testEnv.authenticatedContext('sessionUser', { email: 'sessionUser@example.test', auth_time: 200 });
contexts.sessionUser = testEnv.authenticatedContext('sessionUser', { email: 'sessionUser@example.test', auth_time: 199 });
const db = uid => contexts[uid].firestore();
const document = (uid, ...path) => doc(db(uid), ...path);
const ownRequest = (companyId = 'a', userId = 'bob', divisionId = 'div1', teamId = 'team1') => ({ companyId, userId, divisionId, teamId, status: 'PENDING', createdAt: '2026-10-24', amount: 100 });
const storageRef = (uid, path) => ref(contexts[uid].storage('test.appspot.com'), path);
const png = new Uint8Array([137, 80, 78, 71]);
const future = Timestamp.fromMillis(Date.now() + 86400000 * 30);
const past = Timestamp.fromMillis(Date.now() - 1000);
const notification = (recipientId, recipientRole, companyId = 'a') => ({ companyId, recipientId, recipientRole,
  letterId: 'letter-a', revision: 1, event: 'SUBMITTED', title: '서류 결재 요청이 도착했습니다.', status: 'PENDING',
  requiresAction: true, readAt: null, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z' });
try {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async context => {
    const seed = context.firestore();
    for (const id of ['a', 'b', 'expired', 'suspended', 'missingEntitlement', 'badEntitlement', 'deleted', 'deleting']) {
      await setDoc(doc(seed, 'companies', id), { nameKo: id, adminUid: id === 'a' ? 'alice' : id === 'b' ? 'outsider' : id,
        domain: `${id}.test`, createdAt: new Date().toISOString(), plan: 'FREE',
        status: id === 'suspended' ? 'SUSPENDED' : id === 'deleted' ? 'DELETED' : id === 'deleting' ? 'DELETING' : 'ACTIVE',
        ...(id === 'missingEntitlement' ? {} : { accessUntil: id === 'expired' ? past : id === 'badEntitlement' ? '2099-01-01' : future }),
        subscriptionStatus: 'ACTIVE', subscriptionEndDate: '2099-01-01T00:00:00.000Z' });
    }
    for (const [uid, role, companyId, divisionId, teamId, extra = {}] of users) await setDoc(doc(seed, 'UserProfile', uid), {
      uid, email: `${uid}@example.test`, name: uid, companyId, role, divisionId, teamId, status: 'ACTIVE',
      mustChangePassword: false, createdAt: '2026-10-24T00:00:00.000Z', annualSalary: 12345678, ...extra
    });
    await setDoc(doc(seed, 'companies', 'unregistered-owner'), { adminUid: 'newcomer', status: 'ACTIVE', accessUntil: future });
    for (const [id, companyId, headId] of [['div1', 'a', 'manager'], ['div2', 'a', 'manager2'], ['divB', 'b', 'outsider']]) {
      await setDoc(doc(seed, 'divisions', id), { name: id, companyId, headId });
    }
    for (const [id, companyId, divisionId, leaderId] of [['team1', 'a', 'div1', 'bob'], ['team2', 'a', 'div2', 'carol'], ['teamB', 'b', 'divB', 'foreignMember']]) {
      await setDoc(doc(seed, 'teams', id), { name: id, companyId, divisionId, leaderId });
    }
    for (const [id, companyId, userId, divisionId, teamId] of [['a', 'a', 'bob', 'div1', 'team1'], ['a2', 'a', 'carol', 'div2', 'team2'], ['b', 'b', 'foreignMember', 'divB', 'teamB']]) {
      for (const name of ['expenses', 'leaves']) await setDoc(doc(seed, name, `${name}-${id}`), ownRequest(companyId, userId, divisionId, teamId));
      await setDoc(doc(seed, 'attendance', `attendance-${id}`), { companyId, userId, divisionId, teamId, type: 'IN', createdAt: '2026-10-24' });
      await setDoc(doc(seed, 'notices', `notice-${id}`), { companyId, authorId: companyId === 'a' ? 'alice' : 'outsider', title: 'Notice', createdAt: '2026-10-24' });
      await setDoc(doc(seed, 'payroll_records', `payroll-${id}`), { companyId, approvedBy: companyId === 'a' ? 'alice' : 'outsider', totalGross: 100, createdAt: '2026-10-24' });
    }
    for (const [id, companyId, approvedBy] of [['modern-a', 'a', 'alice'], ['modern-b', 'b', 'outsider']]) {
      await setDoc(doc(seed, 'payroll_records', id), { companyId, approvedBy, schemaVersion: 2, scope: 'COMPANY',
        year: 2026, month: 10, rows: [{ companyId, userId: companyId === 'a' ? 'bob' : 'foreignMember', name: 'Stored snapshot' }],
        sums: { monthlyGross: 100 }, totalGross: 100, totalNet: 90, employeeCount: 1,
        approvedAtIso: '2026-10-24T00:00:00.000Z', revision: 1 });
      for (const child of ['revisions', 'legacySources']) await setDoc(doc(seed, 'payroll_records', id, child, 'saved-1'), {
        companyId, recordId: id, revision: 1, snapshot: { companyId, rows: [] }, dataHash: 'synthetic-private-history'
      });
      await setDoc(doc(seed, 'payroll_records', id, 'revisions', 'wrong-company'), { companyId: companyId === 'a' ? 'b' : 'a', recordId: id });
      await setDoc(doc(seed, 'payroll_drafts', 'draft-' + companyId), { companyId, status: 'PENDING', draftVersion: 1, rows: [] });
      for (const child of ['versions', 'baseline']) {
        await setDoc(doc(seed, 'payroll_drafts', 'draft-' + companyId, child, 'saved-1'), { companyId, draftId: 'draft-' + companyId, draftVersion: 1 });
        await setDoc(doc(seed, 'payroll_drafts', 'draft-' + companyId, child, 'wrong-company'), { companyId: companyId === 'a' ? 'b' : 'a', draftId: 'draft-' + companyId });
        await setDoc(doc(seed, 'payroll_drafts', 'draft-' + companyId, child, 'wrong-parent'), { companyId, draftId: 'another-draft' });
      }
    }
    await setDoc(doc(seed, 'notices', 'manager-own'), { companyId: 'a', authorId: 'manager', title: 'Own notice' });
    await setDoc(doc(seed, 'expenses', 'legacy-attachment'), { ...ownRequest(), attachmentUrl: 'https://example.invalid/legacy' });
    await setDoc(doc(seed, 'expenses', 'legacy-private-path'), { ...ownRequest(), attachmentPath: 'companies/a/expenses/bob/legacy/archive.png' });
    await setDoc(doc(seed, 'notices', 'legacy-notice-attachment'), { companyId: 'a', authorId: 'manager', title: 'Legacy notice',
      attachmentUrl: 'https://example.invalid/legacy-notice', attachmentPath: '' });
    await setDoc(doc(seed, 'tenantRegistry', 'deleted'), { companyId: 'deleted', status: 'DELETED' });
    await setDoc(doc(seed, 'officialLetters', 'letter-a'), { companyId: 'a', creatorId: 'bob', participantIds: ['bob', 'manager'], status: 'ISSUED', revision: 1 });
    await setDoc(doc(seed, 'officialLetters', 'letter-a', 'history', '000001'), { companyId: 'a', content: 'archived' });
    await setDoc(doc(seed, 'officialLetterSettings', 'a'), { companyId: 'a', lastFront: 1 });
    await setDoc(doc(seed, 'officialLetterNumbers', 'a_001-261024'), { companyId: 'a' });
    await setDoc(doc(seed, 'officialLetterPrinters', 'a', 'printers', 'printer-a'), { companyId: 'a', name: 'Private printer', version: 1, active: true });
    await setDoc(doc(seed, 'officialLetterPrinters', 'a', 'printers', 'printer-a', 'inspections', 'inspection-a'), { companyId: 'a', result: 'PASS' });
    for (const [uid, role, companyId] of users) await setDoc(doc(seed, 'officialLetterNotifications', uid, 'items', 'letter-a'), notification(uid, role, companyId));
    await setDoc(doc(seed, 'officialLetterNotifications', 'bob', 'items', 'wrong-company'), notification('bob', 'MEMBER', 'b'));
    await setDoc(doc(seed, 'officialLetterNotifications', 'bob', 'items', 'wrong-role'), notification('bob', 'ADMIN'));
    for (const path of ['companies/a/expenses/bob/receipt.png', 'companies/a/leaves/bob/medical.pdf', 'companies/a/notices/notice.png',
      'companies/a/official-assets/seal.png', 'companies/a/official-pdfs/letter-a/r1.pdf', 'companies/a/payroll-sources/draft-a/source.csv', 'companies/a/backup/private.json', 'legacy/private.json']) {
      await uploadBytes(ref(context.storage('test.appspot.com'), path), png, { contentType: 'image/png' });
    }
  });

  // Registration and tombstones are exclusively callable/Admin SDK operations.
  for (const uid of ['newcomer', 'alice', 'root']) {
    await deny(`${uid} company registration`, setDoc(document(uid, 'companies', `new-${uid}`), { adminUid: uid, status: 'ACTIVE', plan: 'FREE' }));
    await deny(`${uid} self ADMIN creation`, setDoc(document(uid, 'UserProfile', uid === 'newcomer' ? uid : `forged-${uid}`), { uid, email: `${uid}@example.test`, role: 'ADMIN', companyId: 'a' }));
    for (const operation of ['get', 'set', 'delete']) {
      const registry = document(uid, 'tenantRegistry', 'deleted');
      await deny(`${uid} registry ${operation}`, operation === 'get' ? getDoc(registry) : operation === 'set' ? setDoc(registry, { status: 'ACTIVE' }) : deleteDoc(registry));
    }
  }
  await deny('deleted company cannot be recreated', setDoc(document('newcomer', 'companies', 'deleted'), { adminUid: 'newcomer', status: 'ACTIVE', plan: 'FREE' }));
  await deny('matching owner and verified profile fields cannot bypass server registration', setDoc(document('newcomer', 'UserProfile', 'newcomer'), {
    uid: 'newcomer', email: 'newcomer@unrelated.test', role: 'ADMIN', companyId: 'unregistered-owner', status: 'ACTIVE'
  }));
  await deny('deleting company cannot be restored by platform client', updateDoc(document('root', 'companies', 'deleting'), { status: 'ACTIVE' }));
  await deny('platform client cannot delete company outside service', deleteDoc(document('root', 'companies', 'a')));
  await deny('employee cannot delete own profile', deleteDoc(document('bob', 'UserProfile', 'bob')));
  await deny('ADMIN cannot delete employee profile outside service', deleteDoc(document('alice', 'UserProfile', 'bob')));

  // Positive controls preserve active tenant operations and ADMIN payroll management.
  await allow('self name update', updateDoc(document('bob', 'UserProfile', 'bob'), { name: 'Bob' }));
  await deny('self name rejects invalid type', updateDoc(document('bob', 'UserProfile', 'bob'), { name: { injected: true } }));
  await allow('ADMIN self salary update', updateDoc(document('alice', 'UserProfile', 'alice'), { annualSalary: 44444444 }));
  await allow('ADMIN self private HR fields preserve existing personnel edit', updateDoc(document('alice', 'UserProfile', 'alice'), {
    rrn: 'synthetic-private-field', address: 'synthetic address', phone: 'synthetic phone', personalEmail: 'private@example.test'
  }));
  await allow('ADMIN employee salary update', updateDoc(document('alice', 'UserProfile', 'bob'), { annualSalary: 55555555 }));
  await allow('ADMIN employee role update', updateDoc(document('alice', 'UserProfile', 'bob'), { role: 'SUB_ADMIN' }));
  await allow('ADMIN restores employee role', updateDoc(document('alice', 'UserProfile', 'bob'), { role: 'MEMBER' }));
  await allow('ADMIN reads payroll', getDoc(document('alice', 'payroll_records', 'payroll-a')));
  await allow('member own profile', getDoc(document('bob', 'UserProfile', 'bob')));
  await allow('ADMIN full employee directory', getDocs(query(collection(db('alice'), 'UserProfile'), where('companyId', '==', 'a'))));
  await allow('platform reads company metadata', getDocs(collection(db('root'), 'companies')));
  await allow('platform suspends company', updateDoc(document('root', 'companies', 'b'), { status: 'SUSPENDED' }));
  await allow('platform restores company', updateDoc(document('root', 'companies', 'b'), { status: 'ACTIVE' }));
  for (const [uid, target] of [['bob', 'bob'], ['alice', 'alice'], ['alice', 'bob'], ['root', 'bob']]) {
    for (const patch of [{ status: 'RESIGNED' }, { mustChangePassword: true }, { lastPasswordChange: '2099-01-01' }, { sessionValidAfter: 0 }, { companyId: 'b' }, { tenantId: 'b' }, { uid: 'outsider' }, { email: 'forged@example.test' }, { createdAt: '2099' }]) {
      await deny(`${uid} security metadata change ${Object.keys(patch)[0]}`, updateDoc(document(uid, 'UserProfile', target), patch));
    }
  }
  await deny('pending password cannot clear flag', updateDoc(document('pendingPassword', 'UserProfile', 'pendingPassword'), { mustChangePassword: false }));
  await deny('old session cannot read own profile', getDoc(document('sessionUser', 'UserProfile', 'sessionUser')));
  await deny('old session cannot read company data', getDoc(document('sessionUser', 'notices', 'notice-a')));
  await allow('refreshed session may read own profile', getDoc(document('sessionFresh', 'UserProfile', 'sessionUser')));
  await allow('refreshed session may read company data', getDoc(document('sessionFresh', 'notices', 'notice-a')));
  await deny('member salary self escalation', updateDoc(document('bob', 'UserProfile', 'bob'), { annualSalary: 99999999 }));
  await deny('member role escalation', updateDoc(document('bob', 'UserProfile', 'bob'), { role: 'ADMIN' }));
  await deny('owner cannot be demoted', updateDoc(document('admin2', 'UserProfile', 'alice'), { role: 'MEMBER' }));
  await deny('owner cannot be retired', updateDoc(document('admin2', 'UserProfile', 'alice'), { status: 'RESIGNED' }));
  await deny('ADMIN cannot mint SUPER_ADMIN', updateDoc(document('alice', 'UserProfile', 'bob'), { role: 'SUPER_ADMIN' }));
  for (const uid of ['alice', 'root']) for (const patch of [{ accessUntil: future }, { subscriptionEndDate: '2100-01-01' }, { subscriptionStatus: 'ACTIVE' }, { domain: 'stolen.test' }, { adminUid: 'admin2' }, { createdAt: '2099' }]) {
    // Use a distinct timestamp/status value, not an unchanged write.
    const changed = 'accessUntil' in patch ? { accessUntil: Timestamp.fromMillis(future.toMillis() + 1000) } : 'subscriptionStatus' in patch ? { subscriptionStatus: 'TRIAL' } : patch;
    await deny(`${uid} company controlled field ${Object.keys(patch)[0]}`, updateDoc(document(uid, 'companies', 'a'), changed));
  }

  // Financial fields are never exposed via full subordinate profile documents.
  for (const uid of ['manager', 'manager2', 'bob']) await deny(`${uid} employee salary document`, getDoc(document(uid, 'UserProfile', 'carol')));
  await deny('same division SUB_ADMIN salary document', getDoc(document('manager', 'UserProfile', 'bob')));
  await deny('SUB_ADMIN full directory query', getDocs(query(collection(db('manager'), 'UserProfile'), where('companyId', '==', 'a'), where('divisionId', '==', 'div1'))));
  await allow('SUB_ADMIN own profile', getDoc(document('manager', 'UserProfile', 'manager')));

  const foreign = [['companies', 'b'], ['UserProfile', 'outsider'], ['divisions', 'divB'], ['teams', 'teamB'],
    ['expenses', 'expenses-b'], ['leaves', 'leaves-b'], ['attendance', 'attendance-b'], ['notices', 'notice-b'], ['payroll_records', 'payroll-b']];
  for (const uid of ['bob', 'manager', 'alice']) for (const [name, id] of foreign) {
    await deny(`${uid} foreign get ${name}`, getDoc(document(uid, name, id)));
    await deny(`${uid} foreign update ${name}`, updateDoc(document(uid, name, id), { name: 'forged' }));
    await deny(`${uid} foreign delete ${name}`, deleteDoc(document(uid, name, id)));
  }
  for (const uid of ['bob', 'manager', 'alice']) for (const name of ['UserProfile', 'divisions', 'teams', 'expenses', 'leaves', 'attendance', 'notices', 'payroll_records']) {
    await deny(`${uid} foreign list ${name}`, getDocs(query(collection(db(uid), name), where('companyId', '==', 'b'))));
  }

  // Auth status, password completion and server entitlement affect every business path.
  for (const uid of ['retired', 'retiredAdmin', 'pendingPassword', 'pendingAdmin', 'suspended', 'expired', 'missingEntitlement', 'badEntitlement', 'deleted', 'deleting', 'missingCompany', 'retiredRoot', 'pendingRoot']) {
    const companyId = users.find(([id]) => id === uid)[2];
    await deny(`${uid} own sensitive profile`, getDoc(document(uid, 'UserProfile', uid)));
    await deny(`${uid} business read`, getDoc(document(uid, 'notices', 'notice-a')));
    await deny(`${uid} payroll read`, getDoc(document(uid, 'payroll_records', 'payroll-a')));
    await deny(`${uid} business create`, setDoc(document(uid, 'expenses', `blocked-${uid}`), ownRequest(companyId, uid, '', '')));
    await deny(`${uid} company config write`, setDoc(document(uid, 'config', companyId), { forged: true }));
  }
  await allow('expired ADMIN safe own company metadata for renewal', getDoc(document('expired', 'companies', 'expired')));
  await deny('pending password metadata direct read', getDoc(document('pendingPassword', 'companies', 'a')));

  // Routing is derived from the current server profile, with validated organization references.
  for (const name of ['expenses', 'leaves']) {
    await allow(`own routed ${name}`, setDoc(document('bob', name, `own-${name}`), ownRequest()));
    const privatePath = `companies/a/${name}/bob/receipt.png`;
    await allow(`own private ${name} attachment`, setDoc(document('bob', name, `attachment-${name}`), {
      ...ownRequest(), attachmentPath: privatePath, attachmentName: 'receipt.png', attachmentUrl: ''
    }));
    for (const attachmentPath of [
      `companies/b/${name}/bob/receipt.png`, `companies/ab/${name}/bob/receipt.png`,
      `companies/a/${name === 'expenses' ? 'leaves' : 'expenses'}/bob/receipt.png`,
      `companies/a/${name}/carol/receipt.png`, `companies/a/${name}/bob-other/receipt.png`,
      `companies/a/${name}/bob/`, `companies/a/${name}/bob/..`, `companies/a/${name}/bob/.`,
      `companies/a/${name}/bob/../carol/receipt.png`, `companies/a/${name}/bob/nested/receipt.png`,
      `companies/a/${name}/bob/receipt\\forged.png`, `companies/a/${name}/bob/receipt\nforged.png`,
      `companies/a/${name}/bob/${'x'.repeat(1024)}.png`, 'https://example.invalid/private.png',
      null, 42, { path: privatePath }, [privatePath]
    ]) {
      await deny(`forged ${name} current attachment path/type`, setDoc(document('bob', name, `forged-path-${name}`), {
        ...ownRequest(), attachmentPath, attachmentUrl: ''
      }));
    }
    await allow(`member own ${name} read`, getDoc(document('bob', name, `own-${name}`)));
    await allow(`member own ${name} query`, getDocs(query(collection(db('bob'), name), where('companyId', '==', 'a'), where('userId', '==', 'bob'))));
    await allow(`manager own-division ${name} read`, getDoc(document('manager', name, `own-${name}`)));
    await allow(`manager own-division ${name} query`, getDocs(query(collection(db('manager'), name), where('companyId', '==', 'a'), where('divisionId', '==', 'div1'))));
    for (const forged of [ownRequest('a', 'alice'), ownRequest('b'), ownRequest('a', 'bob', 'div2', 'team2'),
      ownRequest('a', 'bob', 'divB', 'teamB'), ownRequest('a', 'bob', 'div1', 'team2'), { ...ownRequest(), tenantId: 'b' },
      { ...ownRequest(), attachmentUrl: 'https://example.invalid/new-token' }]) {
      await deny(`forged ${name} route/subject/tenant/url`, setDoc(document('bob', name, `forged-${name}`), forged));
    }
    await deny(`forged ${name} route update`, updateDoc(document('bob', name, `own-${name}`), { divisionId: 'div2', teamId: 'team2' }));
    await deny(`wrong division ${name} read`, getDoc(document('manager2', name, `own-${name}`)));
    await deny(`wrong division ${name} approval`, updateDoc(document('manager2', name, `own-${name}`), { status: 'SUB_APPROVED' }));
    for (const attachmentPath of [`companies/b/${name}/bob/receipt.png`, `companies/a/${name}/carol/receipt.png`]) {
      await deny(`approval cannot replace ${name} private attachment`, updateDoc(document('manager', name, `own-${name}`), {
        status: 'SUB_APPROVED', attachmentPath
      }));
    }
    if (name === 'expenses') {
      await allow('pending expense can replace its own private attachment', updateDoc(document('bob', name, 'own-expenses'), {
        attachmentPath: privatePath, attachmentName: 'receipt.png'
      }));
      for (const attachmentPath of ['companies/b/expenses/bob/receipt.png', 'companies/a/expenses/carol/receipt.png',
        'companies/a/leaves/bob/receipt.png', null]) {
        await deny('pending expense cannot rebind private attachment scope', updateDoc(document('bob', name, 'own-expenses'), { attachmentPath }));
      }
      await allow('pending expense can clear its private attachment', updateDoc(document('bob', name, 'own-expenses'), { attachmentPath: '' }));
    }
    await allow(`correct division ${name} approval`, updateDoc(document('manager', name, `own-${name}`), { status: 'SUB_APPROVED', updatedAt: '2026-10-24', updatedBy: 'manager' }));
    await allow(`ADMIN ${name} final approval`, updateDoc(document('alice', name, `own-${name}`), { status: 'APPROVED' }));
  }
  await allow('legacy attachment retained on content edit', updateDoc(document('bob', 'expenses', 'legacy-attachment'), { amount: 123 }));
  await allow('legacy private attachment retained on content edit', updateDoc(document('bob', 'expenses', 'legacy-private-path'), { amount: 123 }));
  await deny('legacy private attachment cannot be replaced with foreign path', updateDoc(document('bob', 'expenses', 'legacy-private-path'), {
    attachmentPath: 'companies/b/expenses/bob/forged.png'
  }));
  await deny('legacy URL cannot be replaced by new bearer URL', updateDoc(document('bob', 'expenses', 'legacy-attachment'), { attachmentUrl: 'https://example.invalid/new' }));
  await deny('unchanged legacy URL cannot authorize a foreign private expense path', updateDoc(document('bob', 'expenses', 'legacy-attachment'), {
    attachmentPath: 'companies/b/expenses/bob/forged.png'
  }));
  await allow('legacy URL can be cleared for private path migration', updateDoc(document('bob', 'expenses', 'legacy-attachment'), { attachmentUrl: '', attachmentPath: 'companies/a/expenses/bob/private.png', attachmentName: 'private.png' }));
  for (const patch of [{ headId: 'outsider' }, { headId: 'retired' }, { companyId: 'b' }, { tenantId: 'b' }]) await deny('division foreign/retired head or tenant', updateDoc(document('alice', 'divisions', 'div1'), patch));
  for (const patch of [{ divisionId: 'divB' }, { leaderId: 'outsider' }, { leaderId: 'retired' }, { companyId: 'b' }, { tenantId: 'b' }]) await deny('team foreign/retired reference or tenant', updateDoc(document('alice', 'teams', 'team1'), patch));
  await deny('profile invalid foreign team', updateDoc(document('alice', 'UserProfile', 'bob'), { teamId: 'teamB', divisionId: 'divB' }));
  await deny('profile team/division mismatch', updateDoc(document('alice', 'UserProfile', 'bob'), { teamId: 'team2', divisionId: 'div1' }));
  await allow('valid head appointment', updateDoc(document('alice', 'divisions', 'div1'), { headId: 'bob' }));
  await allow('valid team leader appointment', updateDoc(document('alice', 'teams', 'team1'), { leaderId: 'manager' }));

  await allow('own-division attendance list', getDocs(query(collection(db('manager'), 'attendance'), where('companyId', '==', 'a'), where('divisionId', '==', 'div1'))));
  await deny('cross-division attendance list', getDocs(query(collection(db('manager'), 'attendance'), where('companyId', '==', 'a'), where('divisionId', '==', 'div2'))));
  await allow('member routed attendance create', setDoc(document('bob', 'attendance', 'own-attendance'), { companyId: 'a', userId: 'bob', type: 'IN', divisionId: 'div1', teamId: 'team1' }));
  await deny('attendance missing server route', setDoc(document('bob', 'attendance', 'bad-route'), { companyId: 'a', userId: 'bob', type: 'IN' }));
  for (const uid of ['alice', 'root']) for (const [name, id, patches] of [
    ['attendance', 'attendance-a', [{ companyId: 'b' }, { tenantId: 'b' }, { userId: 'outsider' }, { divisionId: 'divB' }]],
    ['payroll_records', 'payroll-a', [{ companyId: 'b' }, { tenantId: 'b' }, { approvedBy: 'outsider' }, { userId: 'outsider' }]],
    ['notices', 'notice-a', [{ companyId: 'b' }, { tenantId: 'b' }, { authorId: 'outsider' }]],
  ]) for (const patch of patches) await deny(`${uid} ${name} reparent or subject spoof`, updateDoc(document(uid, name, id), patch));
  await allow('ADMIN attendance content correction', updateDoc(document('alice', 'attendance', 'attendance-a'), { location: '본사' }));
  await allow('ADMIN payroll amount correction', updateDoc(document('alice', 'payroll_records', 'payroll-a'), { totalGross: 200 }));
  await allow('ADMIN payroll with same-company subject', setDoc(document('alice', 'payroll_records', 'own-subject'), { companyId: 'a', approvedBy: 'alice', userId: 'bob', totalGross: 10 }));
  for (const userId of ['outsider', 'missing-user', '']) await deny('payroll foreign or missing subject', setDoc(document('alice', 'payroll_records', 'forged-subject'), { companyId: 'a', approvedBy: 'alice', userId, totalGross: 10 }));
  await allow('ADMIN reads own server-approved snapshot', getDoc(document('alice', 'payroll_records', 'modern-a')));
  await allow('platform reads server-approved snapshot', getDoc(document('root', 'payroll_records', 'modern-a')));
  for (const uid of ['outsider', 'bob', 'manager', 'retiredAdmin', 'pendingAdmin']) {
    await deny(`${uid} cannot read another scope modern payroll`, getDoc(document(uid, 'payroll_records', 'modern-a')));
  }
  for (const uid of ['alice', 'root']) {
    for (const patch of [{ totalGross: 1 }, { rows: [{ companyId: 'b', userId: 'foreignMember' }] },
      { schemaVersion: 1 }, { companyId: 'b' }]) {
      await deny(`${uid} cannot change immutable server snapshot`, updateDoc(document(uid, 'payroll_records', 'modern-a'), patch));
    }
    await deny(`${uid} cannot delete immutable server snapshot`, deleteDoc(document(uid, 'payroll_records', 'modern-a')));
    await deny(`${uid} cannot replace server snapshot with legacy aggregate`, setDoc(document(uid, 'payroll_records', 'modern-a'), {
      companyId: 'a', approvedBy: 'alice', totalGross: 1
    }));
  }
  for (const extra of [{ schemaVersion: 2 }, { rows: [{ companyId: 'b', userId: 'foreignMember' }] }, { sums: { monthlyGross: 1 } },
    { scope: 'COMPANY' }, { approvedAtIso: '2026-10-24T00:00:00Z' }, { taxTable: {} }, { revision: 1 }]) {
    await deny('client cannot forge detailed or modern payroll metadata', setDoc(document('alice', 'payroll_records', 'forged-modern'), {
      companyId: 'a', approvedBy: 'alice', totalGross: 1, ...extra
    }));
    await deny('client cannot upgrade legacy payroll into forged snapshot', updateDoc(document('alice', 'payroll_records', 'payroll-a'), extra));
  }
  await allow('legacy aggregate create remains compatible', setDoc(document('alice', 'payroll_records', 'legacy-delete'), {
    companyId: 'a', approvedBy: 'alice', totalGross: 1
  }));
  await allow('legacy aggregate delete remains compatible', deleteDoc(document('alice', 'payroll_records', 'legacy-delete')));
  const payrollPrivatePaths = [
    ['payroll_drafts', 'draft-a'], ['payroll_drafts', 'draft-a', 'versions', 'saved-1'], ['payroll_drafts', 'draft-a', 'baseline', 'saved-1'],
    ['payroll_records', 'modern-a', 'revisions', 'saved-1'], ['payroll_records', 'modern-a', 'legacySources', 'saved-1'],
  ];
  for (const path of payrollPrivatePaths) {
    for (const uid of ['alice', 'root']) await allow(`${uid} reads scoped payroll draft/history ${path.join('/')}`, getDoc(document(uid, ...path)));
    for (const uid of ['outsider', 'bob', 'manager', 'retiredAdmin', 'pendingAdmin']) await deny(`${uid} cannot read private payroll draft/history ${path.join('/')}`, getDoc(document(uid, ...path)));
    for (const uid of ['alice', 'root', 'outsider', 'bob']) {
      await deny(`${uid} cannot edit server-managed payroll draft/history`, updateDoc(document(uid, ...path), { companyId: 'b', status: 'APPROVED' }));
      await deny(`${uid} cannot delete server-managed payroll draft/history`, deleteDoc(document(uid, ...path)));
    }
  }
  for (const uid of ['alice', 'root']) {
    await deny(`${uid} cannot create payroll draft`, setDoc(document(uid, 'payroll_drafts', 'forged-draft'), { companyId: 'a', status: 'APPROVED' }));
    for (const path of [['payroll_records', 'modern-a', 'revisions'], ['payroll_records', 'modern-a', 'legacySources'],
      ['payroll_drafts', 'draft-a', 'versions'], ['payroll_drafts', 'draft-a', 'baseline']]) {
      await deny(`${uid} cannot create private payroll history`, setDoc(document(uid, ...path, 'forged-history'), { companyId: 'a', recordId: 'modern-a', draftId: 'draft-a' }));
    }
    for (const path of [['payroll_records', 'modern-a', 'revisions', 'wrong-company'], ['payroll_drafts', 'draft-a', 'versions', 'wrong-company'],
      ['payroll_drafts', 'draft-a', 'baseline', 'wrong-company'], ['payroll_drafts', 'draft-a', 'versions', 'wrong-parent'], ['payroll_drafts', 'draft-a', 'baseline', 'wrong-parent']]) {
      await deny(`${uid} cannot read malformed cross-company payroll child ${path.join('/')}`, getDoc(document(uid, ...path)));
    }
  }
  await deny('SUB_ADMIN edits another author notice', updateDoc(document('manager', 'notices', 'notice-a'), { title: 'Forged' }));
  await allow('SUB_ADMIN edits own notice', updateDoc(document('manager', 'notices', 'manager-own'), { title: 'Updated' }));
  await allow('ADMIN edits company notice', updateDoc(document('alice', 'notices', 'manager-own'), { title: 'Admin Updated' }));
  const notice = { companyId: 'a', authorId: 'manager', title: 'Private notice', createdAt: '2026-10-24', attachmentUrl: '' };
  await allow('SUB_ADMIN creates own company notice attachment', setDoc(document('manager', 'notices', 'private-notice'), {
    ...notice, attachmentPath: 'companies/a/notices/notice.png'
  }));
  for (const attachmentPath of ['companies/b/notices/notice.png', 'companies/ab/notices/notice.png',
    'companies/a/expenses/manager/notice.png', 'companies/a/notices/', 'companies/a/notices/..',
    'companies/a/notices/../b/notice.png', 'companies/a/notices/notice\\forged.png',
    'companies/a/notices/notice\nforged.png', null, 42, { path: 'companies/a/notices/notice.png' }]) {
    await deny('notice creation cannot inject current attachment path/type', setDoc(document('manager', 'notices', 'forged-private-notice'), {
      ...notice, attachmentPath
    }));
    for (const uid of ['manager', 'alice', 'root']) {
      await deny(`${uid} cannot replace notice attachment scope/type`, updateDoc(document(uid, 'notices', 'private-notice'), { attachmentPath }));
    }
  }
  await allow('ADMIN replaces same-company notice attachment', updateDoc(document('alice', 'notices', 'private-notice'), {
    attachmentPath: 'companies/a/notices/replacement.pdf', attachmentName: 'replacement.pdf'
  }));
  await allow('ADMIN clears company notice attachment', updateDoc(document('alice', 'notices', 'private-notice'), { attachmentPath: '' }));
  await allow('legacy notice attachment retained on content edit', updateDoc(document('manager', 'notices', 'legacy-notice-attachment'), { title: 'Legacy updated' }));
  await deny('legacy notice URL cannot be replaced with a new bearer URL', updateDoc(document('alice', 'notices', 'legacy-notice-attachment'), {
    attachmentUrl: 'https://example.invalid/new-notice-token'
  }));
  await deny('unchanged legacy URL cannot authorize a foreign private notice path', updateDoc(document('alice', 'notices', 'legacy-notice-attachment'), {
    attachmentPath: 'companies/b/notices/forged.pdf'
  }));
  await allow('legacy notice migrates to private company attachment', updateDoc(document('alice', 'notices', 'legacy-notice-attachment'), {
    attachmentUrl: '', attachmentPath: 'companies/a/notices/private.pdf'
  }));

  // Company transfer never results in a record visible in the victim tenant.
  for (const name of ['attendance', 'payroll_records']) {
    const id = `inject-${name}`;
    await allow(`create own ${name} control`, setDoc(document('alice', name, id), name === 'attendance'
      ? { companyId: 'a', userId: 'alice', divisionId: 'div1', teamId: 'team1', type: 'IN' }
      : { companyId: 'a', approvedBy: 'alice', totalGross: 1 }));
    await deny(`A to B ${name} injection`, updateDoc(document('alice', name, id), { companyId: 'b' }));
    await deny(`B cannot read A ${name}`, getDoc(document('outsider', name, id)));
  }

  // Official data, printer inspections and original attachments remain server-only.
  for (const uid of ['bob', 'manager', 'alice', 'outsider', 'root']) {
    for (const path of ['officialLetters/letter-a', 'officialLetters/letter-a/history/000001', 'officialLetterSettings/a', 'officialLetterNumbers/a_001-261024',
      'officialLetterPrinters/a/printers/printer-a', 'officialLetterPrinters/a/printers/printer-a/inspections/inspection-a']) {
      const target = doc(db(uid), path);
      await deny(`${uid} private data get ${path}`, getDoc(target));
      await deny(`${uid} private data update ${path}`, updateDoc(target, { forged: true }));
      await deny(`${uid} private data delete ${path}`, deleteDoc(target));
    }
  }
  const inboxItem = (uid, owner = uid, id = 'letter-a') => doc(db(uid), 'officialLetterNotifications', owner, 'items', id);
  for (const [uid, role] of [['bob', 'MEMBER'], ['manager', 'SUB_ADMIN'], ['alice', 'ADMIN']]) {
    await allow(`${uid} own inbox get`, getDoc(inboxItem(uid)));
    assert.equal((await allow(`${uid} own inbox list`, getDocs(query(collection(db(uid), 'officialLetterNotifications', uid, 'items'), where('companyId', '==', 'a'), where('recipientRole', '==', role), where('recipientId', '==', uid))))).size, 1);
    for (const patch of [{ readAt: 'now' }, { requiresAction: false }]) await deny(`${uid} inbox forged update`, updateDoc(inboxItem(uid), patch));
    await deny(`${uid} inbox delete`, deleteDoc(inboxItem(uid)));
  }
  for (const uid of ['manager', 'alice', 'outsider', 'root', 'anonymous']) await deny(`${uid} other inbox`, getDoc(inboxItem(uid, 'bob')));
  await deny('inbox incorrect company', getDoc(inboxItem('bob', 'bob', 'wrong-company')));
  await deny('inbox incorrect role', getDoc(inboxItem('bob', 'bob', 'wrong-role')));
  for (const uid of ['retired', 'pendingPassword', 'suspended', 'expired', 'deleted', 'deleting']) await deny(`${uid} inbox inactive`, getDoc(inboxItem(uid)));
  await deny('unbounded inbox query', getDocs(collection(db('bob'), 'officialLetterNotifications', 'bob', 'items')));

  for (const uid of ['bob', 'manager', 'alice', 'outsider', 'root', 'retired', 'pendingPassword', 'expired', 'anonymous']) {
    for (const path of ['companies/a/expenses/bob/receipt.png', 'companies/a/leaves/bob/medical.pdf', 'companies/a/notices/notice.png',
      'companies/a/official-assets/seal.png', 'companies/a/official-pdfs/letter-a/r1.pdf', 'companies/a/backup/private.json', 'legacy/private.json']) {
      const target = storageRef(uid, path);
      await deny(`${uid} private Storage get`, getBytes(target));
      await deny(`${uid} private Storage metadata`, getMetadata(target));
      await deny(`${uid} private Storage write`, uploadBytes(target, png, { contentType: 'image/png' }));
      await deny(`${uid} private Storage delete`, deleteObject(target));
    }
    await deny(`${uid} private Storage list`, listAll(storageRef(uid, 'companies/a/expenses/bob')));
  }
  await deny('payment claim registration requires the server', setDoc(document('alice', 'payment_claims', 'ORDER123'), { companyId: 'a', companyName: 'A', adminUid: 'alice', adminName: 'Alice', orderId: 'ORDER123', status: 'PENDING', createdAt: serverTimestamp() }));
  await deny('payment claim client cannot verify', updateDoc(document('alice', 'payment_claims', 'ORDER123'), { status: 'VERIFIED' }));
  console.log(`Security rules: ${checks} authorization, tenant isolation, entitlement, organization and private-storage checks passed.`);
} finally { await testEnv.cleanup(); }
