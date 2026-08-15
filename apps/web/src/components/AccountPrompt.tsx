import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { UserPlus, X } from 'lucide-react';

interface Props {
  open: boolean;
  platform: string;
  onDismiss: () => void;
  // Upgrade the anonymous guest to a permanent account, preserving the uid.
  // Provided by the host so the link-not-replace logic lives in one place.
  onUpgradeGoogle: () => Promise<void>;
  onUpgradeApple: () => Promise<void>;
  onShowTerms: () => void;
  onShowPrivacy: () => void;
}

/**
 * A6.3 guest → account prompt. Shown AFTER the first summary, never at launch.
 * The guest already has their work saved under an anonymous uid; upgrading links
 * a Google/Apple identity to that SAME uid so nothing is lost. Dismissable —
 * guest mode continues if they skip.
 */
export default function AccountPrompt({
  open,
  platform,
  onDismiss,
  onUpgradeGoogle,
  onUpgradeApple,
  onShowTerms,
  onShowPrivacy,
}: Props) {
  const [busy, setBusy] = useState<null | 'google' | 'apple'>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: 'google' | 'apple', fn: () => Promise<void>) => {
    setBusy(which);
    setError(null);
    try {
      await fn();
      // On success the host observes onAuthStateChanged (user no longer
      // anonymous) and closes this prompt.
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      setError(
        code === 'auth/credential-already-in-use'
          ? 'That account is already registered. Sign out and sign back in with it to continue.'
          : 'Could not create your account. Please try again.',
      );
      setBusy(null);
    }
  };

  const showApple = platform === 'ios' || platform === 'web';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={onDismiss}
        >
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            className="w-full max-w-md rounded-t-3xl p-6 space-y-5"
            style={{
              background: 'linear-gradient(175deg,#131313,#050505)',
              border: '1px solid rgba(78,78,78,0.45)',
              borderBottom: 'none',
              paddingBottom: 'calc(2rem + env(safe-area-inset-bottom, 0px))',
            }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Save your work"
          >
            <div className="w-10 h-1 rounded-full mx-auto" style={{ background: 'rgba(255,255,255,0.16)' }} />

            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.35)' }}>
                  <UserPlus size={20} color="#FFFFFF" />
                </div>
                <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '1.15rem' }}>
                  Save your work
                </h2>
              </div>
              <button onClick={onDismiss} aria-label="Not now" className="p-2 rounded-xl hover:bg-white/5 transition-colors" style={{ color: '#8C8684' }}>
                <X size={20} />
              </button>
            </div>

            <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem', lineHeight: 1.55 }}>
              Create a free account to keep this summary and sync it across your devices. Your current notes come with you — nothing is lost.
            </p>

            {/* A10 #7 — the web reverse-trial only starts once an account email
                is on file (server-enforced). Continuing with Google or Apple
                below attaches your email, which unlocks the free trial; we keep
                the UX honest rather than implying a card-free trial with no
                account. */}
            <div
              className="flex items-start gap-2 p-3 rounded-2xl"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(78,78,78,0.45)' }}
            >
              <span style={{ fontSize: '1rem', lineHeight: 1.2 }} aria-hidden="true">✨</span>
              <p style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.82rem', lineHeight: 1.5, margin: 0 }}>
                Adding your email unlocks your free trial — no card required. Continue with Apple or Google below and we&rsquo;ll use that account&rsquo;s email.
              </p>
            </div>

            <div className="w-full flex flex-col gap-3">
              {showApple && (
                <button
                  onClick={() => run('apple', onUpgradeApple)}
                  disabled={busy !== null}
                  className="w-full py-4 rounded-2xl text-sm font-bold flex items-center justify-center gap-3 disabled:opacity-60"
                  style={{ background: '#FFFFFF', color: '#000000', fontFamily: 'Rajdhani, sans-serif' }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                  </svg>
                  {busy === 'apple' ? 'Creating account…' : 'Continue with Apple'}
                </button>
              )}
              <button
                onClick={() => run('google', onUpgradeGoogle)}
                disabled={busy !== null}
                className="w-full py-4 rounded-2xl text-sm font-bold flex items-center justify-center gap-3 disabled:opacity-60"
                style={{ background: '#1A1A1A', color: '#FFFFFF', border: '1px solid #2A2A2A', fontFamily: 'Rajdhani, sans-serif' }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                {busy === 'google' ? 'Creating account…' : 'Continue with Google'}
              </button>
            </div>

            {error && (
              <p role="alert" style={{ color: '#EF4444', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.82rem' }}>
                {error}
              </p>
            )}

            <button
              onClick={onDismiss}
              className="w-full text-center"
              style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.85rem', background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              Not now
            </button>

            <p style={{ color: '#5C5856', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.72rem', lineHeight: 1.5, textAlign: 'center' }}>
              By continuing you agree to our{' '}
              <button type="button" onClick={onShowTerms} style={{ color: '#E5E0DF', textDecoration: 'underline', background: 'transparent', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}>
                Terms
              </button>{' '}
              &amp;{' '}
              <button type="button" onClick={onShowPrivacy} style={{ color: '#E5E0DF', textDecoration: 'underline', background: 'transparent', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}>
                Privacy Policy
              </button>
              .
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
