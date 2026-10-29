const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PROJECT_ID, assertE2EEnvironment } = require('./safety.cjs');

const root = path.resolve(__dirname, '../..');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL|KEYFILE|SERVICE_ACCOUNT)/i.test(key) && !key.startsWith('VITE_') &&
  !['NODE_OPTIONS', 'DEBUG', 'FIREBASE_DEBUG', 'FIREBASE_DEBUG_MODE', 'FIREBASE_CLI_EXPERIMENTS', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS'].includes(key)));
// Isolate file-backed CLI login and ADC lookup as well as environment values.
// Do not alter HOME or any persistent user configuration.
if (process.platform !== 'win32' && fs.existsSync(path.join(os.homedir(), '.config/gcloud/application_default_credentials.json'))) {
  throw new Error('Run isolated E2E in a clean CI/container environment without cached user ADC.');
}
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
const configRoot = fs.mkdtempSync(path.join(root, 'tmp/e2e-config-'));
for (const name of ['firebase', 'appdata', 'gcloud']) fs.mkdirSync(path.join(configRoot, name));
Object.assign(env, {
  GCLOUD_PROJECT: PROJECT_ID, GOOGLE_CLOUD_PROJECT: PROJECT_ID, FIREBASE_PROJECT_ID: PROJECT_ID, HR_FLOW_E2E_PROJECT_ID: PROJECT_ID,
  HR_FLOW_E2E_RUN: '1', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
  STORAGE_EMULATOR_HOST: 'http://127.0.0.1:9199', FUNCTIONS_EMULATOR_HOST: '127.0.0.1:5001',
  FIREBASE_EMULATOR_HUB: '127.0.0.1:4400',
  FIREBASE_CLI_DISABLE_USAGE: '1', FUNCTIONS_DISCOVERY_TIMEOUT: '60', METADATA_SERVER_DETECTION: 'none',
  GCE_METADATA_HOST: '127.0.0.1:9', GCE_METADATA_IP: '127.0.0.1:9',
  XDG_CONFIG_HOME: path.join(configRoot, 'firebase'), APPDATA: path.join(configRoot, 'appdata'), CLOUDSDK_CONFIG: path.join(configRoot, 'gcloud'),
  NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
});
delete env.FIREBASE_CONFIG;
if (fs.readdirSync(path.join(root, 'functions')).some(entry => {
  const name = entry.toLowerCase();
  return name === '.runtimeconfig.json' || name === '.secret.local' || name === '.env' || name.startsWith('.env.') && name !== '.env.example';
})) {
  throw new Error('Functions dotenv/secret files must not be loaded by isolated E2E.');
}
if (process.platform === 'win32') {
  const sockets = path.join(root, 'tmp/e2e-java-sockets');
  fs.mkdirSync(sockets, { recursive: true });
  env.JAVA_TOOL_OPTIONS = `${env.JAVA_TOOL_OPTIONS || ''} -Djava.net.preferIPv4Stack=true -Djdk.net.unixdomain.tmpdir="${sockets.replaceAll('\\', '/')}"`.trim();
}
assertE2EEnvironment(env);
const firebase = require.resolve('firebase-tools/lib/bin/firebase.js');
const child = spawn(process.execPath, [firebase, 'emulators:exec', '--project', PROJECT_ID,
  '--config', path.join(root, 'firebase.e2e.json'), '--only', 'auth,firestore,storage,functions',
  '--non-interactive', 'node scripts/e2e/execute.cjs'], { cwd: root, env, stdio: 'inherit' });
child.on('error', () => { console.error('Unable to start the isolated E2E runner.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
