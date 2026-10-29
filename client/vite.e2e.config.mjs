import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vite';
import production from './vite.config.ts';
import safety from '../scripts/e2e/safety.cjs';

const clientRoot = path.dirname(fileURLToPath(import.meta.url));
const normalize = value => value.replaceAll('\\', '/');
const productionFirebase = normalize(path.join(clientRoot, 'src/firebase.ts'));
const testFirebase = path.join(clientRoot, 'e2e/firebase.mjs');
const plain = id => normalize(id.split('?')[0]);

export default defineConfig(({ mode }) => {
  if (mode !== 'e2e' || process.env.HR_FLOW_E2E_RUN !== '1') throw new Error('Use npm run test:e2e for the isolated test build.');
  safety.assertE2EEnvironment(process.env);
  return mergeConfig(production, {
    envDir: false,
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    plugins: [{
      name: 'isolated-e2e-firebase', enforce: 'pre',
      resolveId(source, importer) {
        if (!importer || !/(?:^|\/)firebase(?:\.[cm]?[jt]sx?)?$/.test(plain(source))) return null;
        const candidate = normalize(path.resolve(path.dirname(plain(importer)), plain(source)));
        if (candidate === productionFirebase || candidate + '.ts' === productionFirebase) return testFirebase;
        return null;
      },
      load(id) {
        if (plain(id) === productionFirebase) throw new Error('Production Firebase bootstrap is forbidden in E2E.');
        return null;
      },
    }],
  });
});
