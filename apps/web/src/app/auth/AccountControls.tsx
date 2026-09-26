import { useState } from 'react';
import type { Provider } from '../../lib/auth/adapter';
import { useAuth } from './AuthContext';

type Dialog = null | 'create' | 'sign-out' | { conflict: Provider; switchToExisting: () => Promise<void> };

/**
 * The header's account buttons. A guest gets "Create account" (links Apple or
 * Google in place, so the notes stay), and a sign-out that asks first: a
 * guest can't get back into a guest account. Parity with iOS Settings (#185).
 */
export function AccountControls() {
  const { user, signOut, linkGuest, busy, error } = useAuth();
  const [dialog, setDialog] = useState<Dialog>(null);
  if (!user) return null;
  const guest = user.isAnonymous;

  const link = async (p: Provider) => {
    const r = await linkGuest(p);
    if (r.outcome === 'linked') setDialog(null);
    if (r.outcome === 'conflict') setDialog({ conflict: p, switchToExisting: r.switchToExisting });
  };
  const btn = 'rounded-lg px-3 py-2 text-sm';

  return (
    <div className="flex items-center gap-2">
      {guest && (
        <button type="button" className={`${btn} bg-accent font-semibold text-white`} onClick={() => setDialog('create')}>
          Create account
        </button>
      )}
      <button type="button" className={`${btn} text-body hover:text-heading`} onClick={() => (guest ? setDialog('sign-out') : void signOut())}>
        Sign out
      </button>

      {dialog && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" className="w-full max-w-sm rounded-2xl border border-border bg-card p-6">
            {dialog === 'create' && (
              <>
                <h2 id="account-dialog-title" className="mb-2 text-xl font-bold text-heading">Save your notes</h2>
                <p className="mb-4 text-body">Sign in with Apple or Google to keep your notes and use them on your other devices.</p>
                {error && <p role="alert" className="mb-3 text-danger">{error}</p>}
                <div className="flex flex-col gap-2">
                  <button type="button" disabled={busy} className="rounded-xl bg-white px-4 py-3 font-semibold text-black" onClick={() => link('apple')}>Continue with Apple</button>
                  <button type="button" disabled={busy} className="rounded-xl border border-border px-4 py-3 font-semibold text-heading" onClick={() => link('google')}>Continue with Google</button>
                  <button type="button" className="py-2 text-muted" onClick={() => setDialog(null)}>Not now</button>
                </div>
              </>
            )}
            {dialog === 'sign-out' && (
              <>
                <h2 id="account-dialog-title" className="mb-2 text-xl font-bold text-heading">Sign out of this guest account?</h2>
                <p className="mb-4 text-body">This can't be undone. You won't be able to get back into this guest account or its notes.</p>
                <div className="flex flex-col gap-2">
                  <button type="button" className="rounded-xl bg-accent px-4 py-3 font-semibold text-white" onClick={() => setDialog('create')}>Create account instead</button>
                  <button type="button" className="rounded-xl border border-danger/60 px-4 py-3 font-semibold text-danger" onClick={() => { setDialog(null); void signOut(); }}>Sign out</button>
                  <button type="button" className="py-2 text-muted" onClick={() => setDialog(null)}>Cancel</button>
                </div>
              </>
            )}
            {typeof dialog === 'object' && (
              <>
                <h2 id="account-dialog-title" className="mb-2 text-xl font-bold text-heading">That account already has AlgoMinutes</h2>
                <p className="mb-4 text-body">
                  The {dialog.conflict === 'apple' ? 'Apple' : 'Google'} account you chose already has its own AlgoMinutes notes. Switching signs you in to it, and this guest account's notes stay behind.
                </p>
                <div className="flex flex-col gap-2">
                  <button type="button" className="rounded-xl border border-border px-4 py-3 font-semibold text-heading" onClick={() => { const go = dialog.switchToExisting; setDialog(null); void go(); }}>Switch to that account</button>
                  <button type="button" className="rounded-xl bg-accent px-4 py-3 font-semibold text-white" onClick={() => setDialog(null)}>Keep using these notes</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
