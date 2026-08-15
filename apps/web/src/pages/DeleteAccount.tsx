import { useState, type CSSProperties } from 'react';
import { ChevronLeft, AlertTriangle, Loader2 } from 'lucide-react';
import { requestAccountDeletion } from '../lib/compliance';
import { reportCrash } from '../lib/crashReport';

interface Props {
  // A permanent (non-anonymous) account is present and can delete in place.
  isSignedIn: boolean;
  email?: string | null;
  // Auth may not have resolved yet on a cold hit to /delete-account.
  authResolved: boolean;
  onBack?: () => void;
  // Host tears down the session (signOut) and routes home after deletion.
  onDeleted: () => Promise<void> | void;
}

const CONTACT_EMAIL = 'skalaliya@gmail.com';
const REQUIRED_PHRASE = 'DELETE';

/**
 * A10 #3 — web-accessible account-deletion request page.
 *
 * Google Play requires a publicly reachable URL where a user can request
 * deletion of their account and data WITHOUT having to navigate deep into the
 * app. This lives at the stable path /delete-account and renders before the
 * auth gate, so a Play reviewer (who is not signed in) lands on it directly.
 *
 * - Signed-in real account: an in-page confirmation triggers the same server
 *   deletion as Settings → Delete my account.
 * - Signed-out / guest visitor: instructions for requesting deletion by email
 *   and via the in-app path.
 */
export default function DeleteAccount({ isSignedIn, email, authResolved, onBack, onDeleted }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleBack = () => {
    if (onBack) return onBack();
    if (typeof window !== 'undefined') {
      if (window.history.length > 1) window.history.back();
      else window.location.href = '/';
    }
  };

  const ready = acknowledged && phrase.trim().toUpperCase() === REQUIRED_PHRASE && !busy;

  const handleConfirm = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await requestAccountDeletion();
      setDone(true);
      await onDeleted();
    } catch (err) {
      reportCrash('delete_account_page_failed', err);
      setError('Could not delete your account. Please try again or contact support.');
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen overflow-y-auto" style={pageStyle}>
      <div className="max-w-2xl mx-auto px-6 pt-6">
        <button onClick={handleBack} className="flex items-center gap-1 mb-6 px-2 py-1 -ml-2 rounded-md" style={backStyle} aria-label="Back">
          <ChevronLeft size={20} />
          Back
        </button>

        <h1 style={h1Style}>Delete your account</h1>
        <p style={{ color: '#8C8684', fontSize: '0.9rem', marginBottom: '1.75rem' }}>
          Request permanent deletion of your AlgoMinutes account and all associated data.
        </p>

        <section className="mb-6">
          <h2 style={sectionHeading}>What deletion removes</h2>
          <ul style={listStyle}>
            <li>Your account and sign-in identity.</li>
            <li>Every recording, uploaded file, and generated transcript.</li>
            <li>Every summary, note, tag, and chat/search history.</li>
            <li>All search index entries derived from your content.</li>
          </ul>
          <p style={{ marginTop: '0.5rem' }}>
            Deletion is permanent and cannot be undone. Content is removed from our
            live systems immediately and purged from routine backups within
            ordinary retention windows. Export anything you want to keep first.
          </p>
        </section>

        {done ? (
          <div style={noticeStyle}>
            <p style={{ color: '#E5E0DF' }}>
              Your account deletion has been requested and your data is being removed.
              You have been signed out.
            </p>
          </div>
        ) : !authResolved ? (
          <div style={noticeStyle}>
            <p style={{ color: '#8C8684' }}>Checking your sign-in status…</p>
          </div>
        ) : isSignedIn ? (
          <section>
            <div style={warnBox}>
              <AlertTriangle size={16} color="#EF4444" className="shrink-0 mt-0.5" />
              <p style={{ color: '#FCA5A5', fontSize: '0.85rem', lineHeight: 1.5, margin: 0 }}>
                You are signed in{email ? ` as ${email}` : ''}. Deleting here removes this
                account immediately.
              </p>
            </div>

            <button
              onClick={() => setAcknowledged((v) => !v)}
              disabled={busy}
              className="w-full flex items-start gap-3 p-3 rounded-2xl text-left"
              style={{
                background: acknowledged ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.03)',
                border: acknowledged ? '1px solid rgba(239,68,68,0.45)' : '1px solid rgba(78,78,78,0.45)',
                marginBottom: '1rem',
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
              aria-checked={acknowledged}
              role="checkbox"
            >
              <span
                className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5"
                style={{
                  background: acknowledged ? '#EF4444' : 'transparent',
                  border: acknowledged ? 'none' : '1.5px solid rgba(78,78,78,0.6)',
                }}
              >
                {acknowledged && <span style={{ color: '#0a0a0a', fontWeight: 'bold', fontSize: 12, lineHeight: 1 }}>✓</span>}
              </span>
              <span style={{ color: acknowledged ? '#FFFFFF' : '#8C8684', fontSize: '0.85rem', lineHeight: 1.5 }}>
                I understand this is permanent and I have exported anything I want to keep.
              </span>
            </button>

            <label style={{ color: '#8C8684', fontSize: '0.8rem', display: 'block', marginBottom: '0.5rem' }}>
              Type <span style={{ color: '#EF4444', fontWeight: 700 }}>{REQUIRED_PHRASE}</span> to confirm:
            </label>
            <input
              type="text"
              value={phrase}
              onChange={(e) => { setPhrase(e.target.value); if (error) setError(null); }}
              disabled={busy}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              placeholder={REQUIRED_PHRASE}
              aria-label="Type DELETE to confirm account deletion"
              className="w-full px-4 py-3 rounded-2xl text-sm"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(78,78,78,0.45)', color: '#FFFFFF', marginBottom: '1rem' }}
            />

            {error && <p style={{ color: '#FCA5A5', fontSize: '0.85rem', marginBottom: '1rem' }}>{error}</p>}

            <button
              onClick={handleConfirm}
              disabled={!ready}
              className="w-full py-3.5 rounded-2xl text-sm font-bold flex items-center justify-center gap-2"
              style={{
                background: ready ? '#EF4444' : 'rgba(239,68,68,0.25)',
                color: ready ? '#FFFFFF' : 'rgba(255,255,255,0.4)',
                fontFamily: 'Rajdhani, sans-serif',
                cursor: ready ? 'pointer' : 'not-allowed',
              }}
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {busy ? 'Deleting…' : 'Delete my account forever'}
            </button>
          </section>
        ) : (
          <section>
            <h2 style={sectionHeading}>How to request deletion</h2>
            <p>
              You are not signed in on this device. To delete your account and data,
              choose either option:
            </p>
            <ul style={listStyle}>
              <li>
                <strong>In the app:</strong> sign in, then go to Settings &rarr;{' '}
                <em>Delete my account</em> and confirm. You can also{' '}
                <a href="/" style={linkStyle}>open the app</a> and sign in to delete here.
              </li>
              <li>
                <strong>By email:</strong> write to{' '}
                <a href={`mailto:${CONTACT_EMAIL}?subject=Account%20deletion%20request`} style={linkStyle}>
                  {CONTACT_EMAIL}
                </a>{' '}
                from the address on your account and we will process the deletion.
              </li>
            </ul>
          </section>
        )}

        <p style={{ color: '#5C5856', fontSize: '0.8rem', marginTop: '2rem', lineHeight: 1.5 }}>
          Questions about deletion?{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} style={linkStyle}>{CONTACT_EMAIL}</a>
        </p>
      </div>
    </div>
  );
}

const pageStyle: CSSProperties = {
  background: 'linear-gradient(180deg,#050505,#0a0a0a 40%,#050505)',
  color: '#E5E0DF',
  fontFamily: 'Titillium Web, sans-serif',
  paddingTop: 'calc(env(safe-area-inset-top, 0px))',
  paddingBottom: 'calc(2rem + env(safe-area-inset-bottom, 0px))',
};

const backStyle: CSSProperties = {
  color: '#FFFFFF', fontFamily: 'Rajdhani, sans-serif', fontSize: '0.95rem', fontWeight: 600,
};

const h1Style: CSSProperties = {
  fontFamily: 'Rajdhani, sans-serif', fontWeight: 800, fontSize: '2rem', color: '#FFFFFF', marginBottom: '0.5rem',
};

const sectionHeading: CSSProperties = {
  fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '1.05rem', color: '#FFFFFF', marginBottom: '0.5rem',
};

const listStyle: CSSProperties = {
  listStyleType: 'disc', paddingLeft: '1.25rem', marginTop: '0.5rem', marginBottom: '0.75rem', lineHeight: 1.65,
};

const linkStyle: CSSProperties = { color: '#FFFFFF', textDecoration: 'underline' };

const noticeStyle: CSSProperties = {
  padding: '1rem', borderRadius: '1rem', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(78,78,78,0.45)',
};

const warnBox: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.75rem',
  borderRadius: '1rem', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)',
  marginBottom: '1rem',
};
