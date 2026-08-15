// A6.3 guest → permanent account upgrade.
//
// The whole point is uid preservation: the guest already owns notes/workspace
// keyed to their anonymous Firebase uid, so we must ATTACH the Google (or Apple)
// identity to that same user — not sign in as a fresh one. That is what
// linkWithCredential / linkWithPopup do; a plain signInWith* would swap in a new
// uid and orphan everything the guest created.
import { auth } from '../firebase';
import {
  GoogleAuthProvider,
  OAuthProvider,
  linkWithCredential,
  linkWithPopup,
} from 'firebase/auth';
import type { UserCredential } from 'firebase/auth';
import { Capacitor } from './native-shim/core';
import { FirebaseAuthentication } from './native-shim/plugins';

export function isGuest(): boolean {
  return auth.currentUser?.isAnonymous === true;
}

/**
 * Upgrade the current anonymous guest to a permanent Google account, preserving
 * the uid.
 *
 * - web: linkWithPopup attaches the popup-obtained Google credential to the
 *   current user (same uid).
 * - native: we obtain the Google ID token, build a credential, and attach it
 *   with linkWithCredential (same uid).
 *
 * Throws `auth/credential-already-in-use` if that Google account is already a
 * separate AlgoMinutes user — the caller decides how to reconcile (we cannot
 * silently merge two uids).
 */
export async function upgradeGuestWithGoogle(): Promise<UserCredential> {
  const current = auth.currentUser;
  if (!current) throw new Error('No guest session to upgrade.');

  if (Capacitor.getPlatform() === 'web') {
    return linkWithPopup(current, new GoogleAuthProvider());
  }

  const result = await FirebaseAuthentication.signInWithGoogle();
  const idToken = result.credential?.idToken;
  if (!idToken) throw new Error('Google Sign-In failed: no ID token returned');
  const credential = GoogleAuthProvider.credential(idToken);
  return linkWithCredential(current, credential);
}

/**
 * Upgrade the current anonymous guest to a permanent Apple account, preserving
 * the uid. Same link-not-replace contract as Google above; offered on iOS and
 * on the web (Hide My Email).
 */
export async function upgradeGuestWithApple(): Promise<UserCredential> {
  const current = auth.currentUser;
  if (!current) throw new Error('No guest session to upgrade.');

  if (Capacitor.getPlatform() === 'web') {
    return linkWithPopup(current, new OAuthProvider('apple.com'));
  }

  const result = await FirebaseAuthentication.signInWithApple();
  const idToken = result.credential?.idToken;
  const nonce = result.credential?.nonce;
  if (!idToken) throw new Error('Apple Sign-In failed: no ID token returned');
  const credential = new OAuthProvider('apple.com').credential({ idToken, rawNonce: nonce });
  return linkWithCredential(current, credential);
}
