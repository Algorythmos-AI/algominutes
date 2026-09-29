import { useState } from 'react';
import { Link } from 'react-router';
import type { Provider } from '../../lib/auth/adapter';
import { reportCrash } from '../../lib/crashReport';
import { keptRecordings } from '../record/unsent';
import { useAuth } from './AuthContext';

type Dialog =
  | null
  | 'create'
  | 'sign-out'
  | { conflict: Provider; switchToExisting: () => Promise<void> }
  | { unsent: string[] };

/**
 * The header's account buttons. A guest gets "Create account" (links Apple or
 * Google in place, so the notes stay), and a sign-out that asks first: a
 * guest can't get back into a guest account. Parity with iOS Settings (#185).
 *
 * Recordings this browser hasn't uploaded are the account's audio on this
 * computer: signing out says so, and deletes them from here unless they're
 * uploaded first (RELEASE.md PR 12a; iOS clears its own at sign-out too).
 */
export function AccountControls() {
  const { user, signOut, linkGuest, switchAccount, busy, error } = useAuth();
  const [dialog, setDialog] = useState<Dialog>(null);
  if (!user) return null;
  const guest = user.isAnonymous;

  const link = async (p: Provider) => {
    const r = await linkGuest(p);
    if (r.outcome === 'linked') setDialog(null);
    if (r.outcome === 'conflict') setDialog({ conflict: p, switchToExisting: r.switchToExisting });
  };
  const btn = 'rounded-lg px-3 py-2 text-sm';

  const askToSignOut = async () => {
    const env = keptRecordings();
    let unsent: string[] = [];
    try {
      // Every one of this account's, a recording still being made included: none stays behind on this computer.
      unsent = env ? (await env.store.list(user.uid)).map((r) => r.id) : [];
    } catch (err) {
      reportCrash('auth.signOutUnsent', err);
    }
    if (unsent.length > 0) setDialog({ unsent });
    else if (guest) setDialog('sign-out');
    else void signOut();
  };

  const deleteAndSignOut = async (ids: string[]) => {
    setDialog(null);
    const env = keptRecordings();
    // Each on its own: one that can't be removed doesn't keep the rest on this computer.
    for (const id of ids) {
      try {
        await env?.store.remove(id);
      } catch (err) {
        reportCrash('auth.signOutDiscard', err);
      }
    }
    await signOut();
  };

  return (
    <div className="flex items-center gap-2">
      {error && !dialog && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {guest && (
        <button type="button" className={`${btn} bg-accent font-semibold text-white`} onClick={() => setDialog('create')}>
          Create account
        </button>
      )}
      <button type="button" className={`${btn} text-body hover:text-heading`} onClick={() => void askToSignOut()}>
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
            {typeof dialog === 'object' && 'unsent' in dialog && (
              <>
                <h2 id="account-dialog-title" className="mb-2 text-xl font-bold text-heading">
                  {dialog.unsent.length === 1 ? 'A recording isn’t uploaded' : `${dialog.unsent.length} recordings aren’t uploaded`}
                </h2>
                <p className="mb-4 text-body">
                  {dialog.unsent.length === 1 ? 'It’s saved only in this browser. Signing out deletes it from here, so upload it first to keep it.' : 'They’re saved only in this browser. Signing out deletes them from here, so upload them first to keep them.'}
                  {guest && ' You also won’t be able to get back into this guest account.'}
                </p>
                <div className="flex flex-col gap-2">
                  <Link to="/record" className="rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white no-underline" onClick={() => setDialog(null)}>Upload first</Link>
                  <button type="button" className="rounded-xl border border-danger/60 px-4 py-3 font-semibold text-danger" onClick={() => void deleteAndSignOut(dialog.unsent)}>Delete and sign out</button>
                  <button type="button" className="py-2 text-muted" onClick={() => setDialog(null)}>Cancel</button>
                </div>
              </>
            )}
            {typeof dialog === 'object' && 'conflict' in dialog && (
              <>
                <h2 id="account-dialog-title" className="mb-2 text-xl font-bold text-heading">That account already has AlgoMinutes</h2>
                <p className="mb-4 text-body">
                  The {dialog.conflict === 'apple' ? 'Apple' : 'Google'} account you chose already has its own AlgoMinutes notes. Switching signs you in to it, and this guest account's notes stay behind.
                </p>
                <div className="flex flex-col gap-2">
                  <button type="button" className="rounded-xl border border-border px-4 py-3 font-semibold text-heading" onClick={() => { const go = dialog.switchToExisting; setDialog(null); void switchAccount(go); }}>Switch to that account</button>
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
