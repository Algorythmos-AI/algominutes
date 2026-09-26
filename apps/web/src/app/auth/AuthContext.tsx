import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthAdapter, AuthUser, LinkResult, Provider } from '../../lib/auth/adapter';
import { signInErrorMessage } from '../../lib/auth/errors';
import { reportCrash } from '../../lib/crashReport';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in';

interface AuthValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** The last sign-in failure, as a sentence to show; null when there's nothing to say. */
  error: string | null;
  busy: boolean;
  signIn(provider: Provider): Promise<void>;
  continueAsGuest(): Promise<void>;
  linkGuest(provider: Provider): Promise<LinkResult>;
  signOut(): Promise<void>;
  idToken(forceRefresh: boolean): Promise<string | null>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ adapter, children }: { adapter: AuthAdapter; children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adapter.completeRedirect().catch((err) => {
      setError(signInErrorMessage(err, 'google'));
      reportCrash('auth.redirectResult', err);
    });
    return adapter.onChange((u) => {
      setUser(u);
      setStatus(u ? 'signed-in' : 'signed-out');
    });
  }, [adapter]);

  const value = useMemo<AuthValue>(() => {
    const run = async <T,>(provider: Provider, fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn();
      } catch (err) {
        setError(signInErrorMessage(err, provider));
        reportCrash('auth.signIn', err, { source: provider });
        return undefined;
      } finally {
        setBusy(false);
      }
    };
    return {
      status,
      user,
      error,
      busy,
      signIn: async (p) => void (await run(p, () => adapter.signIn(p))),
      continueAsGuest: async () => void (await run('google', () => adapter.continueAsGuest())),
      linkGuest: async (p) => (await run(p, () => adapter.linkGuest(p))) ?? { outcome: 'cancelled' },
      signOut: () => adapter.signOut(),
      idToken: (force) => adapter.idToken(force),
    };
  }, [adapter, status, user, error, busy]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
