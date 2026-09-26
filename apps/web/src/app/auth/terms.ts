// A10 #3: record the account's acceptance of the current Terms and Privacy
// Policy, once per (uid, versions), as iOS AppEnvironment.recordTermsAcceptanceIfNeeded
// does. A guest hasn't created an account, so it waits until they do.
import { PRIVACY_VERSION, TERMS_VERSION } from '@algominutes/contracts';
import pkg from '../../../package.json';
import type { ApiClient } from '../../lib/api/client';
import type { AuthUser } from '../../lib/auth/adapter';
import { reportCrash } from '../../lib/crashReport';

const tag = `${TERMS_VERSION}|${PRIVACY_VERSION}`;
const key = (uid: string) => `terms_accepted.${uid}`;

type KV = Pick<Storage, 'getItem' | 'setItem'>;

function read(storage: KV, k: string): string | null {
  try {
    return storage.getItem(k);
  } catch (err) {
    // Storage can be blocked (private mode): posting again is harmless, so carry on.
    reportCrash('terms.storageRead', err);
    return null;
  }
}

// A post in flight per uid: two calls in the same moment (a re-render, StrictMode) post once.
const inFlight = new Map<string, Promise<boolean>>();

/** Posts the acceptance unless this uid already accepted these versions. Resolves true when it posted. */
export function recordTermsAcceptanceIfNeeded(api: Pick<ApiClient, 'acceptTerms'>, user: AuthUser | null, storage: KV = localStorage): Promise<boolean> {
  if (!user || user.isAnonymous) return Promise.resolve(false);
  if (read(storage, key(user.uid)) === tag) return Promise.resolve(false);
  const pending = inFlight.get(user.uid);
  if (pending) return pending.then(() => false);
  const p = post(api, user.uid, storage).finally(() => inFlight.delete(user.uid));
  inFlight.set(user.uid, p);
  return p;
}

async function post(api: Pick<ApiClient, 'acceptTerms'>, uid: string, storage: KV): Promise<boolean> {
  try {
    await api.acceptTerms({ termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION, appVersion: pkg.version, platform: 'web' });
  } catch (err) {
    // Non-fatal: retried on the next load. Never blocks the app.
    reportCrash('terms.acceptFailed', err);
    return false;
  }
  try {
    storage.setItem(key(uid), tag);
  } catch (err) {
    reportCrash('terms.storageWrite', err);
  }
  return true;
}
