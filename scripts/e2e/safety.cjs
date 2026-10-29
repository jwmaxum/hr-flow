const PROJECT_ID = 'demo-hr-flow-e2e';
const WEB_ORIGIN = 'http://127.0.0.1:5173';
const HOSTS = Object.freeze({
  auth: '127.0.0.1:9099',
  firestore: '127.0.0.1:8080',
  storage: '127.0.0.1:9199',
  functions: '127.0.0.1:5001',
  hub: '127.0.0.1:4400',
});

// The real attachment handler keeps this bucket name. STORAGE_EMULATOR_HOST
// redirects its SDK requests to the local Storage emulator, never this bucket.
const STORAGE_BUCKET = 'weberp-8f25f.firebasestorage.app';
const requiredHosts = Object.freeze({
  FIREBASE_AUTH_EMULATOR_HOST: HOSTS.auth,
  FIRESTORE_EMULATOR_HOST: HOSTS.firestore,
  FIREBASE_STORAGE_EMULATOR_HOST: HOSTS.storage,
  STORAGE_EMULATOR_HOST: `http://${HOSTS.storage}`,
  FUNCTIONS_EMULATOR_HOST: HOSTS.functions,
});
const credentialNames = Object.freeze([
  'FIREBASE_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CREDENTIALS',
  'GOOGLE_CLOUD_KEYFILE_JSON', 'GCLOUD_KEYFILE_JSON', 'FIREBASE_SERVICE_ACCOUNT',
]);

function assertE2EEnvironment(env = process.env) {
  if (!env || env.GCLOUD_PROJECT !== PROJECT_ID) {
    throw new Error('E2E requires the exact demo project; production execution is prohibited.');
  }
  for (const name of ['GOOGLE_CLOUD_PROJECT', 'FIREBASE_PROJECT_ID', 'HR_FLOW_E2E_PROJECT_ID']) {
    if (env[name] !== undefined && env[name] !== PROJECT_ID) {
      throw new Error(`E2E project mismatch: ${name}.`);
    }
  }
  for (const [name, expected] of Object.entries(requiredHosts)) {
    if (env[name] !== expected) {
      throw new Error(`E2E requires the fixed loopback emulator: ${name}.`);
    }
  }
  if (env.FIREBASE_EMULATOR_HUB !== undefined && env.FIREBASE_EMULATOR_HUB !== HOSTS.hub) {
    throw new Error('E2E requires the fixed loopback emulator hub.');
  }
  for (const name of credentialNames) {
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(`E2E must not receive deployment credentials: ${name}.`);
    }
  }
  if (env.FIREBASE_CONFIG !== undefined) {
    let config;
    try { config = JSON.parse(env.FIREBASE_CONFIG); } catch {
      throw new Error('E2E FIREBASE_CONFIG must be demo-project JSON, never a credentials file.');
    }
    if (!config || Array.isArray(config) || typeof config !== 'object' || config.projectId !== PROJECT_ID) {
      throw new Error('E2E FIREBASE_CONFIG project mismatch.');
    }
  }
  return Object.freeze({ projectId: PROJECT_ID, webOrigin: WEB_ORIGIN, hosts: HOSTS });
}

module.exports = { PROJECT_ID, WEB_ORIGIN, HOSTS, STORAGE_BUCKET, assertE2EEnvironment };
