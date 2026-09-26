import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { RETENTION_OPTIONS_DAYS, type EntitlementResponse } from '@algominutes/contracts';
import pkg from '../../../package.json';
import { ApiError } from '../../lib/api/errors';
import { revokeAppleErrorMessage } from '../../lib/auth/errors';
import { reportCrash } from '../../lib/crashReport';
import { useApi } from '../ApiContext';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../Modal';
import { useNotice } from '../Notice';
import { SITE_URL } from '../site';
import { usePush } from '../push/PushContext';

const retentionKey = (uid: string) => `retention_days.${uid}`;

function readRetention(uid: string): number | null | undefined {
  try {
    const v = localStorage.getItem(retentionKey(uid));
    return v === null ? undefined : v === 'keep' ? null : Number(v);
  } catch (err) {
    reportCrash('settings.readRetention', err);
    return undefined;
  }
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = `set-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-border bg-card p-5">
      <h2 id={id} className="mb-3 text-lg font-bold text-heading">{title}</h2>
      {children}
    </section>
  );
}

/** Settings, as on iOS: account, plan, data retention, help, about, and deleting the account. */
export function SettingsPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-3xl font-bold text-heading">Settings</h1>
      <AccountCard />
      <PlanCard />
      <RetentionCard uid={user.uid} />
      <NotificationsCard />
      <SupportCard />
      <Card title="About">
        <p className="text-body">AlgoMinutes for the web, version {pkg.version}.</p>
        <p className="mt-2 flex flex-wrap gap-x-4 text-body">
          <a href={`${SITE_URL}/privacy`}>Privacy Policy</a>
          <a href={`${SITE_URL}/terms`}>Terms of Service</a>
          <a href={`${SITE_URL}/support`}>Support</a>
        </p>
      </Card>
      <DeleteAccountCard />
    </div>
  );
}

function NotificationsCard() {
  const { state, enable } = usePush();
  if (state === 'off' || state === 'loading') return null;
  return (
    <Card title="Notifications">
      {state === 'granted' && <p className="text-body">On. This browser is told when a note is ready, or if one fails.</p>}
      {state === 'denied' && <p className="text-body">Blocked for this site. To turn them on, allow notifications in your browser’s site settings, then reload.</p>}
      {state === 'unsupported' && <p className="text-body">This browser can’t show notifications from AlgoMinutes.</p>}
      {state === 'default' && (
        <>
          <p className="text-body">Get told in this browser when a note is ready, or if one fails.</p>
          <button type="button" className="mt-3 rounded-xl bg-accent px-4 py-2 font-semibold text-white" onClick={() => void enable()}>Turn on notifications</button>
        </>
      )}
    </Card>
  );
}

function AccountCard() {
  const { user } = useAuth();
  const notice = useNotice();
  if (!user) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(user.uid);
      notice.show('User ID copied.');
    } catch (err) {
      reportCrash('settings.copyUid', err);
      notice.show('Copy didn’t work. Select the ID and copy it instead.');
    }
  };
  return (
    <Card title="Account">
      <p className="text-body">{user.isAnonymous ? 'Guest (not backed up). Create an account to keep your notes.' : (user.email ?? 'Signed in')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">User ID</span>
        <code className="select-all rounded bg-bg px-2 py-1 text-sm text-heading">{user.uid}</code>
        <button type="button" className="rounded-lg border border-border px-3 py-1 text-sm" onClick={() => void copy()}>Copy</button>
      </div>
      <p className="mt-2 text-sm text-muted">Support may ask for your User ID. It identifies your account, and nothing else.</p>
    </Card>
  );
}

function PlanCard() {
  const { api } = useApi();
  const [ent, setEnt] = useState<EntitlementResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.entitlement().then(
      (e) => !cancelled && setEnt(e),
      (err: unknown) => {
        if (cancelled) return;
        setFailed(true);
        if (!(err instanceof ApiError)) reportCrash('settings.entitlement', err);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  const plan = ent ? { free: 'Free', pro: 'Pro', team: 'Team' }[ent.plan] : null;
  return (
    <Card title="Plan">
      {!ent && !failed && <p role="status" className="text-muted">Loading…</p>}
      {failed && <p className="text-body">Your plan couldn’t be loaded.</p>}
      {ent && (
        <>
          <p className="text-body">
            {plan} plan{ent.state === 'trialing' ? ' (trial)' : ''}.{' '}
            {ent.includedMinutes == null ? 'Unmetered.' : `${Math.round(ent.usedMinutes)} of ${Math.round(ent.includedMinutes)} minutes used this month.`}
          </p>
          {ent.overQuota && <p className="mt-2 text-body">You’ve used this month’s minutes. They reset at the start of next month.</p>}
        </>
      )}
    </Card>
  );
}

/** Whether moving from `from` to `to` deletes notes that are kept today: a shorter (or first) limit. */
export function shortens(from: number | null | undefined, to: number | null): boolean {
  if (to === null) return false;
  return from === null || from === undefined || to < from;
}

function RetentionCard({ uid }: { uid: string }) {
  const { api } = useApi();
  const notice = useNotice();
  const [saved, setSaved] = useState<number | null | undefined>(() => readRetention(uid));
  // The radio is only a choice: moving through the group with the arrow keys checks each option, so
  // nothing is saved until Save, and a limit that deletes notes is confirmed first.
  const [choice, setChoice] = useState<number | null | undefined>(saved);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (days: number | null) => {
    setConfirming(false);
    setBusy(true);
    try {
      await api.setRetention({ retentionDays: days });
      setSaved(days);
      try {
        localStorage.setItem(retentionKey(uid), days == null ? 'keep' : String(days));
      } catch (err) {
        reportCrash('settings.saveRetention', err);
      }
      notice.show(days == null ? 'Notes are kept until you delete them.' : `Notes are deleted after ${days} days.`);
    } catch (err) {
      notice.show(err instanceof ApiError ? `That wasn’t saved. ${err.message}` : 'That wasn’t saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (choice === undefined || choice === saved) return;
    if (shortens(saved, choice)) setConfirming(true);
    else void save(choice);
  };
  const options: Array<{ days: number | null; label: string }> = [
    { days: null, label: 'Keep until I delete them' },
    ...RETENTION_OPTIONS_DAYS.map((d) => ({ days: d as number, label: `Delete after ${d} days` })),
  ];
  return (
    <Card title="Data retention">
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <fieldset aria-busy={busy}>
          <legend className="mb-2 text-body">How long notes and recordings are kept:</legend>
          <div className="flex flex-col gap-2">
            {options.map((o) => (
              <label key={String(o.days)} className="flex gap-2 text-body">
                <input type="radio" name="retention" checked={choice === o.days} onChange={() => setChoice(o.days)} />
                {o.label}
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" disabled={busy || choice === undefined || choice === saved} className="mt-3 rounded-xl bg-accent px-4 py-2 font-semibold text-white disabled:opacity-60">
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
      <p className="mt-2 text-sm text-muted">Deleted notes are removed from backups within 30 days.</p>
      {confirming && typeof choice === 'number' && (
        <Modal title={`Delete notes older than ${choice} days?`} onClose={() => setConfirming(false)}>
          <p className="text-body">
            Every note and recording older than {choice} days will be permanently deleted, starting within the hour, and so will each one as it reaches
            that age. This can’t be undone.
          </p>
          <div className="mt-4 flex gap-2">
            <button type="button" className="rounded-xl bg-danger px-4 py-2 font-semibold text-white" onClick={() => void save(choice)}>Delete after {choice} days</button>
            <button type="button" className="px-4 py-2 text-muted" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function SupportCard() {
  const { api } = useApi();
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const send = async () => {
    setState('sending');
    try {
      await api.support({ kind: 'contact', message: message.trim(), appVersion: pkg.version, platform: 'web', device: navigator.userAgent.slice(0, 200) });
      setMessage('');
      setState('sent');
    } catch (err) {
      setState('failed');
      if (!(err instanceof ApiError)) reportCrash('settings.support', err);
    }
  };
  return (
    <Card title="Help & Support">
      <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="block text-body">
          Tell us what happened, or ask a question. We reply by email.
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} className="mt-1 min-h-24 w-full rounded-lg border border-border bg-bg px-3 py-2 text-heading" />
        </label>
        <p className="mt-1 text-sm text-muted">We receive your message, app version and browser, never a recording or transcript.</p>
        <button type="submit" disabled={!message.trim() || state === 'sending'} className="mt-3 rounded-xl bg-accent px-4 py-2 font-semibold text-white disabled:opacity-60">
          {state === 'sending' ? 'Sending…' : 'Send'}
        </button>
        {state === 'sent' && <p role="status" className="mt-2 text-body">Sent. Thank you.</p>}
        {state === 'failed' && <p role="alert" className="mt-2 text-body">That didn’t send. Try again, or email support@algorythmos.com.</p>}
      </form>
    </Card>
  );
}

function DeleteAccountCard() {
  const { user, revokeApple, signOut } = useAuth();
  const { api } = useApi();
  const notice = useNotice();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user) return null;
  // Firebase's provider ids, compared whole (a provider list, not a URL).
  const apple = (user.providers ?? []).some((id) => id === 'apple.com');

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      if (apple && !(await revokeApple())) {
        setError('Sign in with Apple to confirm, then your account is deleted.');
        return;
      }
      await api.deleteAccount();
      setOpen(false);
      await signOut();
      notice.show('Your account and everything in it were deleted.');
      navigate('/sign-in');
    } catch (err) {
      setError(err instanceof ApiError ? `Your account wasn’t deleted. ${err.message}` : `Your account wasn’t deleted. ${revokeAppleErrorMessage(err) ?? 'Try again.'}`);
      reportCrash('settings.deleteAccount', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Delete your account">
      <p className="text-body">Deletes your account and every recording, transcript and summary in it. It can’t be undone.</p>
      <button type="button" className="mt-3 rounded-xl border border-danger/60 px-4 py-2 font-semibold text-danger" onClick={() => { setTyped(''); setError(null); setOpen(true); }}>
        Delete my account
      </button>
      {open && (
        <Modal title="Delete your account?" onClose={() => !busy && setOpen(false)} initialFocus="input">
          <form onSubmit={(e) => { e.preventDefault(); if (typed === 'DELETE') void remove(); }}>
            <p className="text-body">This permanently deletes your account, every recording, transcript and summary, and your search index.{apple ? ' You’ll confirm with Apple first.' : ''}</p>
            <label className="mt-3 block text-body">
              Type DELETE to confirm:
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-heading" />
            </label>
            {error && <p role="alert" className="mt-3 text-danger">{error}</p>}
            <div className="mt-4 flex gap-2">
              <button type="submit" disabled={typed !== 'DELETE' || busy} className="rounded-xl bg-danger px-4 py-2 font-semibold text-white disabled:opacity-60">{busy ? 'Deleting…' : 'Delete account'}</button>
              <button type="button" className="px-4 py-2 text-muted" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}
