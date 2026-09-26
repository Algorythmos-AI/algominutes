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
import type { Firestore } from 'firebase/firestore';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId: string;
}

/**
 * The config from the build's env. authDomain is VITE_FIREBASE_AUTH_DOMAIN,
 * the environment's own site host (staging.algominutes.algorythmos.com): the
 * site proxies /__/auth/* there to the project's firebaseapp.com (vercel.json),
 * so the popup and its iframe are same-origin and survive browsers that block
 * third-party storage. It's set per environment, not taken from the page, so a
 * build on a host without the proxy (a PR preview) still signs in, through
 * the project's own domain. A local dev server always uses that.
 */
export function firebaseConfigFromEnv(
  env: Record<string, string | undefined> = import.meta.env,
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
    authDomain: (!dev && (env.VITE_FIREBASE_AUTH_DOMAIN ?? '').trim()) || `${projectId}.firebaseapp.com`,
  };
}

let instance: { app: FirebaseApp; auth: Auth } | null = null;

export function firebase() {
  if (instance) return instance;
  const app = initializeApp(firebaseConfigFromEnv());
  const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
    // initializeAuth, unlike getAuth, doesn't bundle the popup/redirect resolver.
    popupRedirectResolver: browserPopupRedirectResolver,
  });
  instance = { app, auth };
  return instance;
}

let db: Promise<Firestore> | null = null;

/**
 * Firestore, loaded on first use. It's the biggest part of the Firebase SDK
 * (with its re2js dependency, over a third of the app), and nothing before
 * sign-in needs it, so it stays out of the first download.
 */
export function firestore(): Promise<Firestore> {
  db ??= import('firebase/firestore').then(({ getFirestore }) => getFirestore(firebase().app));
  return db;
}
