import { vi } from 'vitest';
import type { AuthAdapter, AuthUser, LinkResult, Provider } from '../lib/auth/adapter';

/** An in-memory AuthAdapter: tests set the user and script each call's outcome. */
export function fakeAuth(initial: AuthUser | null = null) {
  let user = initial;
  const listeners = new Set<(u: AuthUser | null) => void>();
  const set = (u: AuthUser | null) => {
    user = u;
    for (const l of listeners) l(u);
  };
  const adapter = {
    onChange: vi.fn((cb: (u: AuthUser | null) => void) => {
      listeners.add(cb);
      cb(user);
      return () => listeners.delete(cb);
    }),
    completeRedirect: vi.fn(async () => {}),
    signIn: vi.fn(async (p: Provider) => {
      set({ uid: `${p}-uid`, isAnonymous: false, email: `${p}@example.test`, displayName: null });
      return true;
    }),
    continueAsGuest: vi.fn(async () => set({ uid: 'guest-uid', isAnonymous: true, email: null, displayName: null })),
    linkGuest: vi.fn(async (): Promise<LinkResult> => {
      set({ ...user!, isAnonymous: false });
      return { outcome: 'linked' };
    }),
    signOut: vi.fn(async () => set(null)),
    idToken: vi.fn(async () => (user ? `token-for-${user.uid}` : null)),
  } satisfies AuthAdapter;
  return { adapter, set, get user() { return user; } };
}

export const PERMANENT: AuthUser = { uid: 'u1', isAnonymous: false, email: 'a@example.test', displayName: 'A' };
export const GUEST: AuthUser = { uid: 'g1', isAnonymous: true, email: null, displayName: null };
