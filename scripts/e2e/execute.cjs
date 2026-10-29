const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { assertE2EEnvironment } = require('./safety.cjs');

(async () => {
  assertE2EEnvironment(process.env);
  const root = path.resolve(__dirname, '../..');
  const response = await fetch('http://127.0.0.1:4400/emulators', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('E2E emulator hub is unavailable.');
  const services = await response.json();
  for (const [name, port] of Object.entries({ auth: 9099, firestore: 8080, storage: 9199, functions: 5001 })) {
    if (services[name]?.host !== '127.0.0.1' || services[name]?.port !== port) throw new Error('All four isolated emulators must be running.');
  }
  const rulesCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/security-rules.test.mjs'], { cwd: root, env: process.env, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  });
  if (rulesCode !== 0) { process.exitCode = rulesCode; return; }
  console.log('Security rules passed. Starting the isolated browser test server.');
  const vitePath = require.resolve('vite', { paths: [path.join(root, 'client')] });
  const { createServer } = await import(pathToFileURL(vitePath).href);
  const server = await createServer({ root: path.join(root, 'client'), mode: 'e2e',
    configFile: path.join(root, 'client/vite.e2e.config.mjs'), logLevel: 'warn', clearScreen: false });
  try {
    await server.listen();
    console.log('Local test server ready. Starting desktop/mobile browser checks.');
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', 'playwright.config.cjs'],
        { cwd: root, env: process.env, stdio: 'inherit' });
      child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
    });
    process.exitCode = exitCode;
  } finally { await server.close(); }
})().catch(() => { console.error('Isolated browser E2E setup failed; credentials and request bodies omitted.'); process.exitCode = 1; });
