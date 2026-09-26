// Firebase for the web app: Auth, and Firestore for the live note list
// (read-only; every write goes through the /v1 api). Initialised on first use,
// so tests and the signed-out pages never touch it.
//
// The config is per environment (Vercel env vars, docs/runbooks/site.md) and
// never committed. These are public client identifiers, restricted by the
// Browser key's referrers and Auth's authorized domains, not secrets.
import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId: string;
}

/**
 * The config from the build's env. authDomain is the page's own host: the
 * site proxies /__/auth/* to the project's firebaseapp.com (vercel.json), so
 * the sign-in popup and its iframe are same-origin and survive browsers that
 * block third-party storage. A local dev server has no proxy, so it uses the
 * project's own domain.
 */
export function firebaseConfigFromEnv(
  env: Record<string, string | undefined> = import.meta.env,
  pageHost: string = typeof window === 'undefined' ? '' : window.location.host,
  dev: boolean = Boolean(import.meta.env.DEV),
): FirebaseWebConfig {
  const need = (name: string) => {
    const v = (env[name] ?? '').trim();
    if (!v) throw new Error(`${name} is not set`);
    return v;
  };
  const projectId = need('VITE_FIREBASE_PROJECT_ID');
  return {
    apiKey: need('VITE_FIREBASE_API_KEY'),
    projectId,
    appId: need('VITE_FIREBASE_APP_ID'),
    messagingSenderId: need('VITE_FIREBASE_MESSAGING_SENDER_ID'),
    authDomain: dev || !pageHost ? `${projectId}.firebaseapp.com` : pageHost,
  };
}

let instance: { app: FirebaseApp; auth: Auth; db: Firestore } | null = null;

export function firebase() {
  if (instance) return instance;
  const app = initializeApp(firebaseConfigFromEnv());
  const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
    // initializeAuth, unlike getAuth, doesn't bundle the popup/redirect resolver.
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  instance = { app, auth, db: getFirestore(app) };
  return instance;
}
