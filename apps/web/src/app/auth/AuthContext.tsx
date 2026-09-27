import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
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
  /** Runs a conflict's switchToExisting, surfacing any failure like a sign-in's. */
  switchAccount(go: () => Promise<void>): Promise<void>;
  signOut(): Promise<void>;
  idToken(forceRefresh: boolean): Promise<string | null>;
  revokeApple(): Promise<boolean>;
}

const AuthContext = createContext<AuthValue | null>(null);

/** A sign-in window closed without a result: nothing on screen, but in the crash log with its provider. */
function reportCancelled(provider: Provider) {
  reportCrash('auth.signInCancelled', new Error('The sign-in window closed without a result'), { source: provider });
}

export function AuthProvider({ adapter, children }: { adapter: AuthAdapter; children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    adapter.completeRedirect().catch((err) => {
      setError(signInErrorMessage(err, 'guest'));
      reportCrash('auth.redirectResult', err);
    });
    return adapter.onChange((u) => {
      setUser(u);
      setStatus(u ? 'signed-in' : 'signed-out');
    });
  }, [adapter]);

  // One identity for the adapter's lifetime: the api client is built on it, and rebuilding it on every
  // busy or error change re-ran everything keyed on the client (the Terms acceptance posted twice).
  const idToken = useCallback((force: boolean) => adapter.idToken(force), [adapter]);

  const value = useMemo<AuthValue>(() => {
    const run = async <T,>(provider: Provider | 'guest', fn: () => Promise<T>): Promise<T | undefined> => {
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
      // A window closed without a result is shown as nothing (people close it on purpose), but it's also what a
      // blocked or hung flow looks like, so it's reported: a failed sign-in never leaves no trace.
      signIn: async (p) => {
        if ((await run(p, () => adapter.signIn(p))) === false) reportCancelled(p);
      },
      continueAsGuest: async () => void (await run('guest', () => adapter.continueAsGuest())),
      linkGuest: async (p) => {
        const result = (await run(p, () => adapter.linkGuest(p))) ?? { outcome: 'cancelled' as const };
        if (result.outcome === 'cancelled') reportCancelled(p);
        return result;
      },
      signOut: async () => {
        try {
          await adapter.signOut();
        } catch (err) {
          setError('Signing out didn’t complete. Try again.');
          reportCrash('auth.signOut', err);
        }
      },
      switchAccount: async (go) => void (await run('guest', go)),
      revokeApple: () => adapter.revokeApple(),
      idToken,
    };
  }, [adapter, status, user, error, busy, idToken]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
