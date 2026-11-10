const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const ts = require('../../client/node_modules/typescript');

// Execute the actual page handlers with local SDK doubles. No Firebase or network calls.
function fixture(file, { values = {}, profile = {}, company = {}, failAuth = false, verified = true, available = true, capture = true } = {}) {
  const filename = path.resolve(__dirname, '../../client/src', file);
  let source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = ast.statements.flatMap(statement => ts.isVariableStatement(statement)
    ? [...statement.declarationList.declarations].filter(declaration => declaration.initializer && ts.isArrowFunction(declaration.initializer)).map(declaration => declaration.initializer)
    : ts.isFunctionDeclaration(statement) ? [statement] : []).find(node => node.body && ts.isBlock(node.body));
  assert.ok(component, 'component not found');
  const declarations = [...component.body.statements].filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
  const stateNames = declarations.filter(declaration => ts.isArrayBindingPattern(declaration.name) && declaration.initializer && ts.isCallExpression(declaration.initializer) && declaration.initializer.expression.getText(ast) === 'useState')
    .map(declaration => declaration.name.elements[0].name.getText(ast));
  if (capture) {
    const functions = declarations.filter(declaration => declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))).map(declaration => declaration.name.getText(ast));
    const lastReturn = [...component.body.statements].reverse().find(ts.isReturnStatement);
    source = source.slice(0, lastReturn.getStart(ast)) + `globalThis.__handlers = {${functions.join(',')}}; return null;\n` + source.slice(lastReturn.end);
  }
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const calls = [], effects = [], states = {};
  let stateIndex = 0;
  const store = {
    user: { uid: 'admin' }, userData: { uid: 'admin', email: 'admin@example.test', name: 'Admin', role: 'ADMIN', companyId: 'tenant-a', ...profile },
    companyData: { id: 'tenant-a', adminUid: 'owner', domain: 'example.test', status: 'ACTIVE', ...company },
    loading: false, sessionReady: true, authError: null, initAuth: () => () => {},
    ...values.store,
    async fetchCompanyDomain(id) { calls.push({ type: 'refreshCompany', id }); },
    async logout() { calls.push({ type: 'logout' }); },
    async refreshSession() { calls.push({ type: 'refreshSession' }); },
  };
  const useAuthStore = () => store; useAuthStore.getState = () => store;
  const auth = { currentUser: { uid: 'admin', email: 'admin@example.test', emailVerified: verified,
    async reload() { calls.push({ type: 'reloadAuth' }); },
    async getIdToken(force) { calls.push({ type: 'token', force }); return 'local-token'; },
  } };
  const noop = () => {};
  const element = (type, props) => ({ type, props: props || {} });
  const react = { lazy(loader) {
    // Keep structural route assertions without evaluating any dynamic page import.
    const match = /default:\s*[\w$]+\.([\w$]+)/.exec(String(loader));
    assert.ok(match, 'lazy page must retain an explicit named component binding');
    return match[1];
  }, useState(initial) { const name = stateNames[stateIndex++]; const value = Object.hasOwn(values, name) ? values[name] : typeof initial === 'function' ? initial() : initial; states[name] = value; return [value, update => { states[name] = typeof update === 'function' ? update(states[name]) : update; }]; }, useEffect(effect) { effects.push(effect); }, useMemo(compute) { return compute(); } };
  react.default = react;
  const firestore = {
    collection(_db, name) { return { collection: name }; }, doc(_db, collection, id) { return { collection, id }; },
    where(field, operator, value) { return { field, operator, value }; }, query(ref, ...filters) { return { ...ref, filters }; },
    async getDocs(query) { calls.push({ type: 'read', query }); return { docs: [], forEach(callback) { [{ ref: { id: 'log-a' } }, { ref: { id: 'log-b' } }].forEach(callback); } }; },
    onSnapshot() { return noop; },
    writeBatch() { return { delete(ref) { calls.push({ type: 'batchDelete', id: ref.id }); }, async commit() { calls.push({ type: 'batchCommit' }); } }; },
    async addDoc(ref, data) { calls.push({ type: 'addDoc', ref, data }); },
    async deleteDoc(ref) { calls.push({ type: 'deleteDoc', ref }); },
    async updateDoc(ref, data) { calls.push({ type: 'updateDoc', ref, data }); }, async setDoc(ref, data) { calls.push({ type: 'setDoc', ref, data }); },
  };
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, Date, Error, JSON, Promise, crypto: webcrypto, Blob,
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
    alert() { calls.push({ type: 'alert' }); }, console: { error: noop, log: noop },
    window: { confirm: () => true, prompt: () => 'mock-reauth-input', addEventListener: noop, removeEventListener: noop },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' };
      if (name === 'read-excel-file/browser') return { default: async () => [] };
      if (name === 'lucide-react') return new Proxy({}, { get: (_target, key) => String(key) });
      if (name === 'firebase/auth') return {
        EmailAuthProvider: { credential(email) { return { email }; } },
        async reauthenticateWithCredential() { calls.push({ type: 'reauth' }); if (failAuth) throw new Error('local reauthentication failure'); },
        async verifyBeforeUpdateEmail(_user, email) { calls.push({ type: 'verifyEmail', email }); },
        async createUserWithEmailAndPassword(_auth, _email, password) { calls.push({ type: 'signup', length: password.length }); return { user: auth.currentUser }; },
        async sendEmailVerification() { calls.push({ type: 'verifySignupEmail' }); },
        signInWithEmailAndPassword() { throw new Error('page must reauthenticate the existing user'); },
      };
      if (name === 'firebase/firestore') return firestore;
      if (name === 'firebase/functions') return { httpsCallable(_functions, action) { return async payload => { calls.push({ type: 'callable', action, payload }); return { data: action === 'checkDomainAvailability' ? { available } : { success: true, successCount: 2, failCount: 0 } }; }; } };
      if (name.endsWith('/firebase')) return { auth, db: {}, functions: {} };
      if (name.endsWith('/store/authStore')) return { useAuthStore };
      if (name.endsWith('/services/accountSecurityService')) return { saveCompanySignup: noop, accountSecurity: { async changePassword() { calls.push({ type: 'passwordChange' }); } } };
      if (name.endsWith('/password-policy.mjs')) return require(path.resolve(path.dirname(filename), name));
      if (name === 'react-router-dom') return { HashRouter: 'HashRouter', Routes: 'Routes', Route: 'Route', Navigate: 'Navigate', useLocation: () => ({ pathname: values.path || '/dashboard' }), useNavigate: () => noop };
      if (name.endsWith('/utils/leaveCalculator')) return { calculateLeaveEntitlement: () => ({ totalEntitlement: 0 }) };
      if (name.endsWith('/utils/errors')) {
        const helperPath = path.resolve(__dirname, '../../client/src/utils/errors.ts');
        const helperCode = ts.transpileModule(fs.readFileSync(helperPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
        const helper = { exports: {} };
        vm.runInNewContext(helperCode, { module: helper, exports: helper.exports }, { filename: helperPath });
        return helper.exports;
      }
      if (name.startsWith('./') || name.startsWith('../')) { const key = name.split('/').at(-1); return { [key]: key }; }
      throw new Error(`unexpected module ${name}`);
    },
  };
  vm.runInNewContext(compiled, context, { filename });
  const exported = module.exports.default || Object.values(module.exports)[0];
  const result = exported(values.props || {});
  return { get calls() { return JSON.parse(JSON.stringify(calls)); }, effects, states, handlers: context.__handlers, result };
}
function types(result, found = []) {
  if (!result || typeof result !== 'object') return found;
  if (result.type) found.push(result.type);
  Object.values(result.props || {}).forEach(value => Array.isArray(value) ? value.forEach(child => types(child, found)) : types(value, found));
  return found;
}
const event = { preventDefault() {} };
const samplePassword = Buffer.alloc(15, 120).toString();

test('administrator UI security and lifecycle regressions', async t => {
  await t.test('company signup accepts either length boundary without requiring mixed characters', async () => {
    for (const [password, accepted] of [['123456', true], ['!'.repeat(15), true], ['abcde', false], ['a'.repeat(16), false]]) {
      const f = fixture('pages/Login.tsx', { values: { regEmail: 'owner@example.test', regName: 'Owner', regOrgKo: '테스트', regOrgEn: 'Example', regPassword: password, regConfirmPassword: password } });
      await f.handlers.handleRegister(event);
      assert.equal(f.calls.some(call => call.type === 'signup'), accepted);
      assert.equal(f.calls.some(call => call.type === 'verifySignupEmail'), accepted);
    }
  });
  await t.test('pending password takes priority over expired subscription without mounting business layout', () => {
    for (const subscriptionStatus of ['TRIAL', 'EXPIRED']) {
      const f = fixture('App.tsx', { capture: false, profile: { mustChangePassword: true }, company: { subscriptionStatus }, values: { store: { sessionReady: false } } });
      const mounted = types(f.result);
      assert.ok(mounted.includes('LoginModal')); assert.ok(!mounted.includes('Sidebar')); assert.ok(!mounted.includes('WorkspaceShell')); assert.ok(!mounted.includes('Routes'));
    }
  });
  await t.test('expired account without pending password retains subscription route and blocks business routes', () => {
    const f = fixture('App.tsx', { capture: false, company: { subscriptionStatus: 'EXPIRED' }, values: { store: { sessionReady: false } } });
    const mounted = types(f.result); assert.ok(mounted.includes('SubscriptionManagement')); assert.ok(!mounted.includes('AttendanceDashboard')); assert.ok(!mounted.includes('OfficialLetters'));
  });
  await t.test('ready account retains document aliases and normal business routing', () => {
    const f = fixture('App.tsx', { capture: false }); const mounted = types(f.result);
    assert.ok(mounted.includes('AttendanceDashboard')); assert.equal(mounted.filter(name => name === 'OfficialLetters').length, 2);
  });
  await t.test('loading and session errors mount no business pages', () => {
    for (const store of [{ loading: true }, { authError: 'local offline failure', sessionReady: false }]) {
      const f = fixture('App.tsx', { capture: false, values: { store } });
      const mounted = types(f.result); assert.ok(!mounted.includes('Sidebar')); assert.ok(!mounted.includes('WorkspaceShell')); assert.ok(!mounted.includes('AttendanceDashboard'));
    }
  });
  await t.test('protected business route rejects unready account while subscription keeps its role requirement', () => {
    const blocked = fixture('components/ProtectedRoute.tsx', { capture: false, values: { store: { sessionReady: false }, props: { children: 'business' } } });
    assert.equal(blocked.result.type, 'Navigate'); assert.equal(blocked.result.props.to, '/subscription-required');
    for (const [role, permitted] of [['ADMIN', true], ['SUB_ADMIN', true], ['MEMBER', false]]) {
      const f = fixture('components/ProtectedRoute.tsx', { capture: false, profile: { role }, values: { path: '/subscription', store: { sessionReady: false }, props: { requireAdmin: true, children: 'subscription' } } });
      assert.equal(f.result.type === 'Navigate', !permitted);
    }
  });
  await t.test('administrator settings mount consumes existing session metadata without forcing another session', async () => {
    const f = fixture('pages/AdminSettings.tsx'); for (const effect of f.effects) await effect();
    assert.equal(f.states.tempDomain, 'example.test'); assert.equal(f.calls.length, 0);
  });
  await t.test('unverified new domain sends SDK verification before any domain write', async () => {
    const f = fixture('pages/AdminSettings.tsx', { verified: false, values: { tempDomain: 'new.example.test', verifyPassword: samplePassword } });
    await f.handlers.handleUpdateDomain(event);
    assert.deepEqual(f.calls.map(call => call.type), ['reauth', 'token', 'callable', 'reloadAuth', 'token', 'verifyEmail']);
    assert.equal(f.calls.at(-1).email, 'admin@new.example.test'); assert.match(f.states.message.text, /다시 로그인/);
  });
  await t.test('verified current domain is saved only via server then explicitly refreshes session', async () => {
    const f = fixture('pages/AdminSettings.tsx', { values: { tempDomain: 'example.test', verifyPassword: samplePassword } });
    await f.handlers.handleUpdateDomain(event);
    assert.deepEqual(f.calls.filter(call => call.type === 'callable').map(call => call.action), ['checkDomainAvailability', 'adminSyncCompanyDomain']);
    assert.deepEqual(f.calls.find(call => call.action === 'adminSyncCompanyDomain').payload, { newDomain: 'example.test' });
    assert.equal(f.calls.at(-1).type, 'refreshCompany'); assert.equal(f.calls.at(-1).id, 'tenant-a');
    assert.ok(!f.calls.some(call => ['updateDoc', 'setDoc'].includes(call.type)));
  });
  await t.test('domain conflict and failed reauthentication cannot save a domain', async () => {
    for (const options of [{ available: false }, { failAuth: true }]) {
      const f = fixture('pages/AdminSettings.tsx', { ...options, values: { tempDomain: 'example.test', verifyPassword: samplePassword } });
      await f.handlers.handleUpdateDomain(event);
      assert.ok(!f.calls.some(call => call.action === 'adminSyncCompanyDomain' || call.type === 'verifyEmail'));
    }
  });
  await t.test('manual password change reauthenticates and uses server before logout', async () => {
    const f = fixture('pages/AdminSettings.tsx', { values: { newPassword: '123456', confirmPassword: '123456', verifyPassword: samplePassword } });
    await f.handlers.handleChangePassword(event);
    assert.deepEqual(f.calls.map(call => call.type), ['reauth', 'token', 'passwordChange', 'logout']);
  });
  await t.test('employee status is server-only with self and owner retirement protections', async () => {
    const f = fixture('pages/EmployeeManagement.tsx', { values: { loading: false } });
    await f.handlers.handleToggleStatus({ uid: 'admin' }, 'RESIGNED'); await f.handlers.handleToggleStatus({ uid: 'owner' }, 'RESIGNED');
    assert.ok(!f.calls.some(call => call.type === 'callable'));
    await f.handlers.handleToggleStatus({ uid: 'member', name: 'Member' }, 'RESIGNED');
    assert.equal(f.calls.find(call => call.type === 'callable').payload.action, 'setMemberStatus');
    assert.ok(!f.calls.some(call => call.type === 'updateDoc'));
  });
  await t.test('employee deletion reauthenticates, refreshes token and sends tenant-free server action', async () => {
    const f = fixture('pages/EmployeeManagement.tsx', { values: { loading: false, deleteConfirmEmp: { uid: 'member', name: 'Member' }, adminPassword: samplePassword } });
    await f.handlers.handleDeleteAll();
    assert.deepEqual(f.calls.slice(0, 3).map(call => call.type), ['reauth', 'token', 'callable']);
    assert.deepEqual(f.calls[2].payload, { action: 'deleteMember', uid: 'member', deleteRecords: true });
    assert.ok(!f.calls.some(call => ['deleteDoc', 'batchDelete'].includes(call.type)));
  });
  await t.test('employee reset generates temporary credential only after reauthentication and uses server reset', async () => {
    const f = fixture('pages/EmployeeManagement.tsx', { values: { loading: false } });
    await f.handlers.handleInitializePassword({ uid: 'member', name: 'Member' });
    assert.deepEqual(f.calls.slice(0, 3).map(call => call.type), ['reauth', 'token', 'callable']);
    const call = f.calls[2]; assert.equal(call.action, 'adminResetPassword'); assert.equal(call.payload.uid, 'member'); assert.ok(call.payload.password.length >= 12 && call.payload.password.length <= 15);
    assert.ok(!f.calls.some(call => call.type === 'updateDoc'));
  });
  await t.test('organization member deletion uses server and scoped audit after reauthentication', async () => {
    const f = fixture('pages/OrganizationAdmin.tsx', { values: { loading: false } });
    await f.handlers.handleDeleteEmployee('member', 'Member');
    assert.deepEqual(f.calls.slice(0, 3).map(call => call.type), ['reauth', 'token', 'callable']);
    assert.deepEqual(f.calls[2].payload, { action: 'deleteMember', uid: 'member' });
    const audit = f.calls.find(call => call.type === 'addDoc'); assert.equal(audit.data.companyId, 'tenant-a');
    assert.ok(!f.calls.some(call => call.type === 'deleteDoc'));
  });
  await t.test('organization logs are queried for current company after reauthentication', async () => {
    const f = fixture('pages/OrganizationAdmin.tsx', { values: { loading: false, deleteLogsPassword: samplePassword } });
    await f.handlers.handleDeleteAllLogs();
    assert.deepEqual(f.calls.slice(0, 3).map(call => call.type), ['reauth', 'token', 'read']);
    assert.equal(f.calls[2].query.collection, 'AuditLogs');
    assert.deepEqual(f.calls[2].query.filters, [{ field: 'companyId', operator: '==', value: 'tenant-a' }]);
    assert.equal(f.calls.filter(call => call.type === 'batchDelete').length, 2); assert.equal(f.calls.at(-2).type, 'batchCommit');
  });
  await t.test('platform subscription extension and reset both require reauthentication and token refresh', async () => {
    const f = fixture('pages/SuperAdminDashboard.tsx', { profile: { role: 'SUPER_ADMIN', companyId: 'PLATFORM' }, values: { loading: false, subscriptionTarget: { id: 'tenant-b' }, subscriptionPassword: samplePassword, subscriptionDaysToAdd: 30, resetTarget: { uid: 'member' }, newPassword: samplePassword } });
    await f.handlers.handleSubscriptionUpdateWithAuth();
    assert.deepEqual(f.calls.slice(0, 3).map(call => call.type), ['reauth', 'token', 'callable']);
    assert.deepEqual(f.calls[2].payload, { action: 'extendSubscription', companyId: 'tenant-b', days: 30 });
    const count = f.calls.length; await f.handlers.handleResetPassword();
    assert.deepEqual(f.calls.slice(count, count + 3).map(call => call.type), ['reauth', 'token', 'callable']);
    assert.equal(f.calls[count + 2].action, 'adminResetPassword');
  });
  await t.test('rejected reauthentication stops employee, organization and platform mutations', async () => {
    for (const [file, values, handler, args] of [
      ['pages/EmployeeManagement.tsx', { deleteConfirmEmp: { uid: 'member' }, adminPassword: samplePassword }, 'handleDeleteAll', []],
      ['pages/EmployeeManagement.tsx', {}, 'handleInitializePassword', [{ uid: 'member' }]],
      ['pages/OrganizationAdmin.tsx', { deleteLogsPassword: samplePassword }, 'handleDeleteAllLogs', []],
      ['pages/OrganizationAdmin.tsx', {}, 'handleDeleteEmployee', ['member', 'Member']],
      ['pages/SuperAdminDashboard.tsx', { resetTarget: { uid: 'member' }, newPassword: samplePassword }, 'handleResetPassword', []],
      ['pages/SuperAdminDashboard.tsx', { subscriptionTarget: { id: 'tenant-b' }, subscriptionPassword: samplePassword }, 'handleSubscriptionUpdateWithAuth', []],
    ]) {
      const f = fixture(file, { failAuth: true, values: { loading: false, ...values } }); await f.handlers[handler](...args);
      assert.ok(!f.calls.some(call => ['callable', 'read', 'updateDoc', 'deleteDoc', 'batchCommit'].includes(call.type)), file);
    }
  });
});
