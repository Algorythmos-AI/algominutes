// What the app needs from sign-in, apart from Firebase so it can be tested
// without it (firebaseAdapter.ts is the real one).

export type Provider = 'google' | 'apple';

export interface AuthUser {
  uid: string;
  isAnonymous: boolean;
  email: string | null;
  displayName: string | null;
}

/** A guest's link attempt. `conflict`: that Apple or Google account is already a separate AlgoMinutes account. */
export type LinkResult = { outcome: 'linked' } | { outcome: 'cancelled' } | { outcome: 'conflict'; switchToExisting: () => Promise<void> };

export interface AuthAdapter {
  /** Calls back with the user now and on every change; returns the unsubscribe. */
  onChange(cb: (user: AuthUser | null) => void): () => void;
  /** Finishes a redirect sign-in the page came back from, if any. */
  completeRedirect(): Promise<void>;
  /** A popup, or a full-page redirect when the browser blocks popups. Resolves false when the user closed the popup. */
  signIn(provider: Provider): Promise<boolean>;
  continueAsGuest(): Promise<void>;
  /** Attaches Apple or Google to the current guest, keeping its uid and its notes. */
  linkGuest(provider: Provider): Promise<LinkResult>;
  signOut(): Promise<void>;
  idToken(forceRefresh: boolean): Promise<string | null>;
}

/** Firebase auth error codes that mean "a popup can't work here; use a redirect". */
export const REDIRECT_INSTEAD = new Set([
  'auth/popup-blocked',
  'auth/operation-not-supported-in-this-environment',
]);

/** The user closed or replaced the popup: not an error to show. */
export const CANCELLED = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);

export function codeOf(err: unknown): string {
  const c = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : '';
  return typeof c === 'string' ? c : '';
}
