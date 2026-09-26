import {
  GoogleAuthProvider,
  OAuthProvider,
  getRedirectResult,
  linkWithPopup,
  linkWithRedirect,
  onIdTokenChanged,
  reauthenticateWithPopup,
  revokeAccessToken,
  signInAnonymously,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type AuthProvider,
  type User,
} from 'firebase/auth';
import { firebase } from '../../firebase';
import { CANCELLED, REDIRECT_INSTEAD, codeOf, type AuthAdapter, type AuthUser, type LinkResult, type Provider } from './adapter';

function providerFor(p: Provider): AuthProvider {
  if (p === 'google') return new GoogleAuthProvider();
  const apple = new OAuthProvider('apple.com');
  apple.addScope('email');
  apple.addScope('name');
  return apple;
}

const toUser = (u: User | null): AuthUser | null =>
  u && { uid: u.uid, isAnonymous: u.isAnonymous, email: u.email, displayName: u.displayName, providers: (u.providerData ?? []).map((p) => p.providerId) };

/** The real adapter, on the app's Firebase Auth. */
export function firebaseAdapter(auth: Auth = firebase().auth): AuthAdapter {
  return {
    // onIdTokenChanged, not onAuthStateChanged: linking Apple or Google to a guest keeps the uid, so
    // only the token changes, and the user must stop reading as a guest at once.
    onChange: (cb) => onIdTokenChanged(auth, (u) => cb(toUser(u))),
    completeRedirect: async () => {
      await getRedirectResult(auth);
    },
    signIn: async (p) => {
      try {
        await signInWithPopup(auth, providerFor(p));
        return true;
      } catch (err) {
        if (CANCELLED.has(codeOf(err))) return false;
        if (REDIRECT_INSTEAD.has(codeOf(err))) {
          await signInWithRedirect(auth, providerFor(p));
          return true;
        }
        throw err;
      }
    },
    continueAsGuest: async () => {
      await signInAnonymously(auth);
    },
    linkGuest: async (p): Promise<LinkResult> => {
      const user = auth.currentUser;
      if (!user?.isAnonymous) throw new Error('linkGuest: not a guest');
      try {
        await linkWithPopup(user, providerFor(p));
        return { outcome: 'linked' };
      } catch (err) {
        const code = codeOf(err);
        if (CANCELLED.has(code)) return { outcome: 'cancelled' };
        if (REDIRECT_INSTEAD.has(code)) {
          await linkWithRedirect(user, providerFor(p));
          return { outcome: 'linked' };
        }
        if (code === 'auth/credential-already-in-use') {
          const credential = p === 'google' ? GoogleAuthProvider.credentialFromError(err as never) : OAuthProvider.credentialFromError(err as never);
          if (!credential) throw err;
          return { outcome: 'conflict', switchToExisting: async () => void (await signInWithCredential(auth, credential)) };
        }
        throw err;
      }
    },
    signOut: () => signOut(auth),
    idToken: async (force) => (auth.currentUser ? auth.currentUser.getIdToken(force) : null),
    revokeApple: async () => {
      const user = auth.currentUser;
      if (!user) return false;
      try {
        const result = await reauthenticateWithPopup(user, providerFor('apple'));
        const token = OAuthProvider.credentialFromResult(result)?.accessToken;
        if (!token) throw new Error('revokeApple: Apple returned no access token');
        await revokeAccessToken(auth, token);
        return true;
      } catch (err) {
        if (CANCELLED.has(codeOf(err))) return false;
        throw err;
      }
    },
  };
}
