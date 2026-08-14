import { initializeApp } from 'firebase/app';
import {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence,
  browserPopupRedirectResolver,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
// Firebase web config is per-environment and regenerated (A4), never committed.
// Read it from Vite build-time env (see apps/web/.env.example). These are public,
// domain-restricted client keys, not secrets.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);

// Persistence chain: try IndexedDB first, then localStorage, sessionStorage, in-memory.
// Capacitor WKWebView IndexedDB can hang on first write; the chain falls through
// to a working store so onAuthStateChanged still fires after signInWithCredential.
//
// `popupRedirectResolver` is required for `signInWithPopup` to work. `getAuth(app)`
// auto-bundles it; `initializeAuth(app, { persistence })` does NOT, so we attach
// it explicitly. Without this, the web "Sign in with Google" button throws
// `auth/argument-error` because Firebase has no resolver to drive the popup.
// The Capacitor native paths (FirebaseAuthentication.signInWith*) use their own
// flow and don't need this — but it's harmless on native.
export const auth = initializeAuth(app, {
  persistence: [
    indexedDBLocalPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    inMemoryPersistence,
  ],
  popupRedirectResolver: browserPopupRedirectResolver,
});

export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const storage = getStorage(app);
