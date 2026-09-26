import { beforeEach, describe, expect, it, vi } from 'vitest';

// firebase/auth, mocked: the adapter's decisions (popup or redirect, cancel,
// the already-in-use conflict) without a real Firebase project.
const m = vi.hoisted(() => ({
  signInWithPopup: vi.fn(),
  signInWithRedirect: vi.fn(),
  linkWithPopup: vi.fn(),
  linkWithRedirect: vi.fn(),
  signInWithCredential: vi.fn(),
  signInAnonymously: vi.fn(),
  getRedirectResult: vi.fn(),
  onIdTokenChanged: vi.fn(),
  signOut: vi.fn(),
  credentialFromError: vi.fn(),
  credentialFromResult: vi.fn(),
  reauthenticateWithPopup: vi.fn(),
  revokeAccessToken: vi.fn(),
}));

vi.mock('firebase/auth', () => {
  class GoogleAuthProvider {
    static credentialFromError = m.credentialFromError;
  }
  class OAuthProvider {
    constructor(public providerId: string) {}
    addScope() {}
    static credentialFromError = m.credentialFromError;
    static credentialFromResult = m.credentialFromResult;
  }
  const fns = Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'credentialFromError' && k !== 'credentialFromResult'));
  return { ...fns, GoogleAuthProvider, OAuthProvider };
});
vi.mock('../../firebase', () => ({ firebase: () => ({ auth: {} }) }));

import { firebaseAdapter } from './firebaseAdapter';

const err = (code: string) => Object.assign(new Error(code), { code });
const guestAuth = () => ({ currentUser: { uid: 'g', isAnonymous: true, getIdToken: vi.fn(async (f: boolean) => (f ? 'fresh' : 'cached')) } });

beforeEach(() => vi.clearAllMocks());

describe('firebaseAdapter', () => {
  it('signs in with a popup', async () => {
    m.signInWithPopup.mockResolvedValue({});
    expect(await firebaseAdapter({} as never).signIn('google')).toBe(true);
    expect(m.signInWithRedirect).not.toHaveBeenCalled();
  });

  it('falls back to a redirect when the browser blocks popups', async () => {
    m.signInWithPopup.mockRejectedValue(err('auth/popup-blocked'));
    expect(await firebaseAdapter({} as never).signIn('apple')).toBe(true);
    expect(m.signInWithRedirect).toHaveBeenCalledTimes(1);
    expect(m.signInWithRedirect.mock.calls[0][1]).toMatchObject({ providerId: 'apple.com' });
  });

  it('a closed popup is not an error', async () => {
    m.signInWithPopup.mockRejectedValue(err('auth/popup-closed-by-user'));
    expect(await firebaseAdapter({} as never).signIn('google')).toBe(false);
  });

  it('any other failure reaches the caller', async () => {
    m.signInWithPopup.mockRejectedValue(err('auth/unauthorized-domain'));
    await expect(firebaseAdapter({} as never).signIn('google')).rejects.toMatchObject({ code: 'auth/unauthorized-domain' });
  });

  it("links a guest in place, and offers the existing account when it's already in use", async () => {
    const auth = guestAuth();
    m.linkWithPopup.mockResolvedValueOnce({});
    expect(await firebaseAdapter(auth as never).linkGuest('google')).toEqual({ outcome: 'linked' });
    expect(m.linkWithPopup.mock.calls[0][0]).toBe(auth.currentUser);

    m.linkWithPopup.mockRejectedValueOnce(err('auth/credential-already-in-use'));
    m.credentialFromError.mockReturnValueOnce({ cred: 1 });
    const r = await firebaseAdapter(auth as never).linkGuest('apple');
    expect(r.outcome).toBe('conflict');
    expect(m.signInWithCredential).not.toHaveBeenCalled();
    if (r.outcome === 'conflict') await r.switchToExisting();
    expect(m.signInWithCredential).toHaveBeenCalledWith(auth, { cred: 1 });
  });

  it('refuses to link an account that is not a guest', async () => {
    await expect(firebaseAdapter({ currentUser: { isAnonymous: false } } as never).linkGuest('google')).rejects.toThrow(/not a guest/);
  });

  it('idToken passes forceRefresh through, and is null when nobody is signed in', async () => {
    const auth = guestAuth();
    expect(await firebaseAdapter(auth as never).idToken(true)).toBe('fresh');
    expect(await firebaseAdapter({ currentUser: null } as never).idToken(false)).toBeNull();
  });

  it('follows the ID token, so a guest who links an account stops being a guest at once', () => {
    const cb = vi.fn();
    m.onIdTokenChanged.mockImplementation((_a, listener: (u: unknown) => void) => {
      listener({ uid: 'g', isAnonymous: false, email: 'e@x.test', displayName: null, providerData: [{ providerId: 'google.com' }] });
      return () => {};
    });
    firebaseAdapter({} as never).onChange(cb);
    expect(m.onIdTokenChanged).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ uid: 'g', isAnonymous: false, email: 'e@x.test', displayName: null, providers: ['google.com'] });
  });

  it("before deleting, revokes the app's Apple token after signing in with Apple again (App Store 5.1.1(v))", async () => {
    const auth = { currentUser: { uid: 'u' } };
    m.reauthenticateWithPopup.mockResolvedValueOnce({ r: 1 });
    m.credentialFromResult.mockReturnValueOnce({ accessToken: 'apple-token' });
    expect(await firebaseAdapter(auth as never).revokeApple()).toBe(true);
    expect(m.reauthenticateWithPopup.mock.calls[0][1]).toMatchObject({ providerId: 'apple.com' });
    expect(m.revokeAccessToken).toHaveBeenCalledWith(auth, 'apple-token');

    m.reauthenticateWithPopup.mockRejectedValueOnce(err('auth/popup-closed-by-user'));
    expect(await firebaseAdapter(auth as never).revokeApple()).toBe(false);
  });
});
