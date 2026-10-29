import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';

// This module is selected ONLY by vite.e2e.config.mjs, never the production build.
if (import.meta.env.MODE !== 'e2e' || window.location.origin !== 'http://127.0.0.1:5173') {
  throw new Error('The isolated Firebase bootstrap only runs on the E2E loopback origin.');
}
const app = initializeApp({
  apiKey: 'demo-e2e-not-a-production-key',
  projectId: 'demo-hr-flow-e2e',
  authDomain: '127.0.0.1',
  appId: 'demo-hr-flow-e2e-app',
  storageBucket: 'demo-hr-flow-e2e.appspot.com',
});
export const auth = getAuth(app);
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
export const db = getFirestore(app, '(default)');
connectFirestoreEmulator(db, '127.0.0.1', 8080);
export const functions = getFunctions(app, 'us-central1');
connectFunctionsEmulator(functions, '127.0.0.1', 5001);
