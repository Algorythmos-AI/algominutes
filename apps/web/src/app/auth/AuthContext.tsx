import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AuthAdapter, AuthUser, LinkResult, Provider } from '../../lib/auth/adapter';
import { signInErrorMessage } from '../../lib/auth/errors';
import { reportCrash } from '../../lib/crashReport';
import { codeOf } from '../../lib/auth/adapter';
import { startTrace, traceMessage, type SignInTrace } from '../../lib/diagnostics/signInTrace';

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

/** A sign-in window closed without a result: nothing on screen, but in the crash log, with the attempt's trace. */
function reportCancelled(t: SignInTrace) {
  reportCrash('auth.signInCancelled', { name: 'SignInCancelled', message: traceMessage(t) }, { source: t.provider });
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
    // Every attempt is traced (lib/diagnostics/signInTrace.ts): a failure is reported with Firebase's code and the
    // trace; a window closed without a result (`cancelled`) is reported too, as that's also what a blocked flow
    // looks like. A success reports nothing; its trace is kept for /app/diagnostics.
    const run = async <T,>(provider: Provider | 'guest', fn: () => Promise<T>, cancelled: (r: T) => boolean = () => false, flow: SignInTrace['flow'] = 'signIn'): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      const t = startTrace(provider, flow, adapter.authDomain ?? '');
      try {
        const result = await fn();
        if (cancelled(result)) reportCancelled(t.finish('cancelled'));
        else t.finish('ok');
        return result;
      } catch (err) {
        const trace = t.finish('error', codeOf(err) || undefined);
        setError(signInErrorMessage(err, provider));
        const e = err as { name?: unknown; message?: unknown; stack?: unknown } | null;
        reportCrash('auth.signIn', { name: e?.name, message: `${String(e?.message ?? err)} ${traceMessage(trace, 300)}`, stack: e?.stack }, { source: provider });
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
      signIn: async (p) => void (await run(p, () => adapter.signIn(p), (ok) => ok === false)),
      continueAsGuest: async () => void (await run('guest', () => adapter.continueAsGuest())),
      linkGuest: async (p) => (await run(p, () => adapter.linkGuest(p), (r) => r.outcome === 'cancelled', 'link')) ?? { outcome: 'cancelled' },
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
