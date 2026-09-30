// The signed-in session: in chrome.storage.session only (memory, cleared when the browser closes, and out of
// content scripts' reach), never chrome.storage.local (ADR 0002 §3).
import { AuthRefusedError, refreshIdToken, uidOf, type Fetch } from './http';

export interface Session {
  uid: string;
  idToken: string;
  refreshToken: string;
  /** When the ID token expires (ms since the epoch). */
  expiresAt: number;
}

export interface Deps {
  storage: chrome.storage.StorageArea;
  fetch: Fetch;
  now: () => number;
}

const KEY = 'session';
/** Refresh this long before the ID token expires, so a call never goes out with one about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function readSession(deps: Deps): Promise<Session | null> {
  const got = (await deps.storage.get(KEY))[KEY] as Session | undefined;
  return got ?? null;
}

export async function saveSession(deps: Deps, tokens: { idToken: string; refreshToken: string; expiresIn: number }): Promise<Session> {
  const session: Session = {
    uid: uidOf(tokens.idToken),
    idToken: tokens.idToken,
    refreshToken: tokens.refreshToken,
    expiresAt: deps.now() + tokens.expiresIn * 1000,
  };
  await deps.storage.set({ [KEY]: session });
  return session;
}

export async function signOut(deps: Deps): Promise<void> {
  await deps.storage.remove(KEY);
}

/**
 * An ID token good for at least five more minutes, refreshed if need be, or null when signed out. Firebase
 * refusing the refresh (the user was deleted, or their sessions revoked) signs the extension out; the
 * network failing throws, and the session stays for the next try.
 */
export async function idToken(deps: Deps): Promise<string | null> {
  const session = await readSession(deps);
  if (!session) return null;
  if (session.expiresAt - deps.now() > REFRESH_MARGIN_MS) return session.idToken;
  try {
    return (await saveSession(deps, await refreshIdToken(deps.fetch, session.refreshToken))).idToken;
  } catch (err) {
    // silent-catch-ok: Firebase refusing the refresh means the session is over, and signing out is the handling; anything else is rethrown
    if (!(err instanceof AuthRefusedError)) throw err;
    await signOut(deps);
    return null;
  }
}
