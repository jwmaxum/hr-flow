const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { PROJECT_ID, WEB_ORIGIN, HOSTS, assertE2EEnvironment } = require('../e2e/safety.cjs');

test('CI reporter omits sensitive errors, call logs, step arguments and stdout', t => {
  const fs = require('node:fs');
  const Reporter = require('../e2e/reporter.cjs');
  const secret = 'synthetic-password-and-bearer-must-not-be-saved';
  let output = '';
  let report = '';
  t.mock.method(console, 'log', value => { output += value; });
  t.mock.method(console, 'error', value => { output += value; });
  t.mock.method(fs, 'mkdirSync', () => {});
  t.mock.method(fs, 'writeFileSync', (_, value) => { report = value; });
  const reporter = new Reporter();
  reporter.onBegin({}, { allTests: () => [1] });
  reporter.onTestBegin({ title: 'synthetic test', parent: { project: () => ({ name: 'chromium-desktop' }) } });
  reporter.onTestEnd({ title: 'synthetic test', expectedStatus: 'passed', parent: { project: () => ({ name: 'chromium-desktop' }) } },
    { status: 'failed', duration: 1, retry: 0, stdout: [secret], errors: [{ message: secret, stack: secret, value: secret,
      location: { file: '/test/smoke.spec.cjs', line: 42 }, }] });
  reporter.onError({ message: secret });
  reporter.onEnd({ status: 'failed', duration: 1 });
  assert.equal((output + report).includes(secret), false);
  const parsed = JSON.parse(report);
  assert.equal(parsed.setupErrors, 1);
  assert.equal(parsed.tests[0].status, 'failed');
  assert.equal(parsed.tests[0].errorCount, 1);
});

const valid = () => ({
  GCLOUD_PROJECT: PROJECT_ID, GOOGLE_CLOUD_PROJECT: PROJECT_ID, HR_FLOW_E2E_PROJECT_ID: PROJECT_ID,
  FIREBASE_AUTH_EMULATOR_HOST: HOSTS.auth, FIRESTORE_EMULATOR_HOST: HOSTS.firestore,
  FIREBASE_STORAGE_EMULATOR_HOST: HOSTS.storage, STORAGE_EMULATOR_HOST: `http://${HOSTS.storage}`,
  FUNCTIONS_EMULATOR_HOST: HOSTS.functions, FIREBASE_EMULATOR_HUB: HOSTS.hub,
  FIREBASE_CONFIG: JSON.stringify({ projectId: PROJECT_ID, storageBucket: `${PROJECT_ID}.appspot.com` }),
});

test('the complete isolated demo environment is accepted without reading credentials or mutating env', () => {
  const env = Object.freeze(valid());
  const result = assertE2EEnvironment(env);
  assert.equal(result.projectId, 'demo-hr-flow-e2e');
  assert.equal(result.webOrigin, WEB_ORIGIN);
  assert.equal(result.hosts, HOSTS);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.hosts), true);
  assert.equal(env.FIREBASE_TOKEN, undefined);
});

test('missing, real, and near-matching projects cannot initialize an E2E session', () => {
  for (const project of [undefined, '', 'weberp-8f25f', 'demo-other-project', `${PROJECT_ID}/documents`, `${PROJECT_ID}.attacker.invalid`]) {
    assert.throws(() => assertE2EEnvironment({ ...valid(), GCLOUD_PROJECT: project }), /exact demo project/);
  }
  assert.throws(() => assertE2EEnvironment(null), /exact demo project/);
});

test('alternate project variables cannot silently redirect an otherwise valid run', () => {
  for (const name of ['GOOGLE_CLOUD_PROJECT', 'FIREBASE_PROJECT_ID', 'HR_FLOW_E2E_PROJECT_ID']) {
    assert.throws(() => assertE2EEnvironment({ ...valid(), [name]: 'live-project' }), /project mismatch/);
  }
});

test('Auth, Firestore, Storage and Functions hosts must be the fixed loopback endpoints', () => {
  for (const name of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST', 'FUNCTIONS_EMULATOR_HOST']) {
    const expected = valid()[name];
    for (const value of [undefined, '', 'example.invalid:8080', 'https://' + expected, expected + '/',
      '127.0.0.1:1', expected + '.attacker.invalid', 'user@' + expected, expected + '/live-project']) {
      assert.throws(() => assertE2EEnvironment({ ...valid(), [name]: value }), /fixed loopback emulator/);
    }
  }
});

test('the Google Storage SDK endpoint cannot use HTTPS, remote hosts, credentials, or paths', () => {
  for (const value of [undefined, 'https://' + HOSTS.storage, `http://${HOSTS.storage}/`,
    `http://user@${HOSTS.storage}`, 'http://storage.googleapis.com', `http://${HOSTS.storage}/bucket`]) {
    assert.throws(() => assertE2EEnvironment({ ...valid(), STORAGE_EMULATOR_HOST: value }), /fixed loopback emulator/);
  }
});

test('a configured emulator hub must also be the isolated loopback hub', () => {
  assert.throws(() => assertE2EEnvironment({ ...valid(), FIREBASE_EMULATOR_HUB: 'example.invalid:4400' }), /loopback emulator hub/);
});

test('deployment credentials are rejected instead of being consumed by test fixtures', () => {
  for (const name of ['FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS',
    'GOOGLE_CLOUD_KEYFILE_JSON', 'GCLOUD_KEYFILE_JSON', 'FIREBASE_SERVICE_ACCOUNT']) {
    for (const value of ['test-placeholder-do-not-use', ' ', '{}']) {
      assert.throws(() => assertE2EEnvironment({ ...valid(), [name]: value }), /must not receive deployment credentials/);
    }
    assert.doesNotThrow(() => assertE2EEnvironment({ ...valid(), [name]: '' }));
  }
});

test('FIREBASE_CONFIG cannot name a live project or reference a local credentials file', () => {
  for (const value of ['not-json', '/private/service-account.json', 'null', '[]', '{}',
    JSON.stringify({ projectId: 'live-project' }), JSON.stringify({ projectId: PROJECT_ID + '-other' })]) {
    assert.throws(() => assertE2EEnvironment({ ...valid(), FIREBASE_CONFIG: value }), /FIREBASE_CONFIG/);
  }
});

test('unsafe fixture entry fails before loading Admin SDK or making a network request', () => {
  const script = `
    const Module = require('node:module');
    const original = Module._load;
    let loaded = false;
    Module._load = function (name, ...rest) { if (name.startsWith('firebase-admin/')) { loaded = true; throw Error('SDK loaded too early'); } return original.call(this, name, ...rest); };
    global.fetch = () => { throw Error('Network attempted too early'); };
    const fixture = require('./scripts/e2e/fixtures.cjs');
    Promise.allSettled([fixture.seedFixtures(), fixture.clearFixtures(), fixture.getExpense('example')]).then(results => {
      if (loaded || results.some(result => result.status !== 'rejected' || !/exact demo project/.test(result.reason.message))) process.exitCode = 1;
      else console.log('blocked-before-admin-and-network');
    });
  `;
  const response = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '../..'),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GCLOUD_PROJECT: 'live-project' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(response.status, 0);
  assert.match(response.stdout, /blocked-before-admin-and-network/);
});
