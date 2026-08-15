import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, X, Check, ExternalLink } from 'lucide-react';
import type { EntitlementResponse } from '@algominutes/contracts';
import {
  startCheckout,
  openBillingPortal,
  track,
  PRO_MONTHLY_PRICE_DISPLAY,
  PRO_ANNUAL_PRICE_DISPLAY,
} from '../lib/billing';

// Why the paywall is being shown — drives the headline copy and the
// paywall_viewed analytics context (A9.6). It never changes WHAT is charged.
export type PaywallContext = 'quota' | 'trial' | 'first_summary' | 'free_floor' | 'manual';

interface Props {
  open: boolean;
  context: PaywallContext;
  entitlement: EntitlementResponse | null;
  onClose: () => void;
  onShowTerms: () => void;
  onShowPrivacy: () => void;
}

const HEADLINES: Record<PaywallContext, { title: string; sub: string }> = {
  quota: {
    title: "You've used your free minutes",
    sub: 'Upgrade to AlgoMinutes Pro to keep transcribing and summarising.',
  },
  free_floor: {
    title: 'Your trial has ended',
    sub: 'Upgrade to AlgoMinutes Pro to unlock recording and summaries again.',
  },
  trial: {
    title: 'Enjoying your free trial?',
    sub: 'Upgrade any time — your card is only charged when you convert.',
  },
  first_summary: {
    title: 'Unlock the full AlgoMinutes',
    sub: 'You get every feature free for 7 days. No card required to start.',
  },
  manual: {
    title: 'AlgoMinutes Pro',
    sub: 'Unlimited meetings, transcripts and summaries.',
  },
};

const PRO_FEATURES = [
  'Unlimited recordings & imports',
  'Full transcripts and AI summaries',
  'Ask-AI across all your notes',
  'PDF export & sharing',
];

/**
 * A9.5 paywall. Renders AFTER the first successful summary and at the quota-hit
 * moment — never on first launch. Shows the price, billing period, renewal
 * terms, links to Terms & Privacy, and a Manage/Cancel button into the Stripe
 * Billing Portal. Emits `paywall_viewed` (A9.6) whenever it opens.
 */
export default function Paywall({ open, context, entitlement, onClose, onShowTerms, onShowPrivacy }: Props) {
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly');
  const [busy, setBusy] = useState<null | 'checkout' | 'portal'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      void track('paywall_viewed', { context, state: entitlement?.state ?? 'unknown' });
      setError(null);
    }
  }, [open, context, entitlement?.state]);

  // Someone already on Pro sees "manage" rather than "subscribe" — the paywall
  // doubles as the billing management surface (A9.5 Manage/Cancel).
  const isActive = entitlement?.state === 'active';

  const price = period === 'annual' ? PRO_ANNUAL_PRICE_DISPLAY : PRO_MONTHLY_PRICE_DISPLAY;
  const renewalTerms = useMemo(
    () =>
      period === 'annual'
        ? `Billed ${PRO_ANNUAL_PRICE_DISPLAY} per year and renews automatically each year until cancelled. Cancel any time in the billing portal.`
        : `Billed ${PRO_MONTHLY_PRICE_DISPLAY} per month and renews automatically each month until cancelled. Cancel any time in the billing portal.`,
    [period],
  );

  const { title, sub } = HEADLINES[context];

  const handleSubscribe = async () => {
    setBusy('checkout');
    setError(null);
    try {
      await startCheckout(period); // redirects to Stripe Checkout
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start checkout. Please try again.');
      setBusy(null);
    }
  };

  const handleManage = async () => {
    setBusy('portal');
    setError(null);
    try {
      await openBillingPortal(); // redirects to Stripe Billing Portal
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the billing portal. Please try again.');
      setBusy(null);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)' }}
          onClick={onClose}
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
            aria-label="AlgoMinutes Pro"
          >
            <div className="w-10 h-1 rounded-full mx-auto" style={{ background: 'rgba(255,255,255,0.16)' }} />

            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded-2xl flex items-center justify-center"
                  style={{ background: 'linear-gradient(135deg,#F2F7FF 0%,#DCEAFF 100%)', boxShadow: '0 6px 24px rgba(91,103,240,0.45)' }}
                >
                  <Sparkles size={20} color="#5B67F0" />
                </div>
                <div>
                  <h2 style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '1.15rem' }}>
                    {title}
                  </h2>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-2 rounded-xl hover:bg-white/5 transition-colors"
                style={{ color: '#8C8684' }}
              >
                <X size={20} />
              </button>
            </div>

            <p style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem', lineHeight: 1.55 }}>
              {sub}
            </p>

            {/* ── Billing period toggle ── */}
            <div className="flex gap-2 p-1 rounded-2xl" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(78,78,78,0.45)' }}>
              {([
                { id: 'monthly' as const, label: 'Monthly' },
                { id: 'annual' as const, label: 'Annual · save ~17%' },
              ]).map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setPeriod(id)}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold transition-all"
                  aria-pressed={period === id}
                  style={{
                    fontFamily: 'Rajdhani, sans-serif',
                    background: period === id ? 'rgba(255,255,255,0.15)' : 'transparent',
                    border: period === id ? '1px solid rgba(255,255,255,0.35)' : '1px solid transparent',
                    color: period === id ? '#FFFFFF' : '#8C8684',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* ── Price ── */}
            <div className="flex items-baseline gap-2">
              <span style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 800, color: '#FFFFFF', fontSize: '2.2rem', letterSpacing: '-0.01em' }}>
                {price}
              </span>
              <span style={{ color: '#8C8684', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem' }}>
                {period === 'annual' ? '/ year' : '/ month'}
              </span>
            </div>

            {/* ── Features ── */}
            <ul className="space-y-2.5">
              {PRO_FEATURES.map((feat) => (
                <li key={feat} className="flex items-center gap-3" style={{ color: '#E5E0DF', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.9rem' }}>
                  <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.3)' }}>
                    <Check size={13} color="#FFFFFF" strokeWidth={3} />
                  </div>
                  {feat}
                </li>
              ))}
            </ul>

            {error && (
              <p role="alert" style={{ color: '#EF4444', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.82rem' }}>
                {error}
              </p>
            )}

            {/* ── Primary action ── */}
            {isActive ? (
              <button
                onClick={handleManage}
                disabled={busy !== null}
                className="w-full py-4 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ background: '#FFFFFF', color: '#0a0a0a', fontFamily: 'Rajdhani, sans-serif' }}
              >
                {busy === 'portal' ? 'Opening…' : 'Manage subscription'}
                <ExternalLink size={16} />
              </button>
            ) : (
              <button
                onClick={handleSubscribe}
                disabled={busy !== null}
                className="w-full py-4 rounded-2xl text-sm font-bold disabled:opacity-60"
                style={{ background: 'linear-gradient(135deg,#F2F7FF 0%,#DCEAFF 100%)', color: '#0a0a0a', fontFamily: 'Rajdhani, sans-serif', boxShadow: '0 6px 24px rgba(91,103,240,0.45)' }}
              >
                {busy === 'checkout' ? 'Redirecting to checkout…' : 'Upgrade to Pro'}
              </button>
            )}

            {/* ── Manage / Cancel (always available so an existing subscriber
                 can reach the portal regardless of resolved state) ── */}
            {!isActive && (
              <button
                onClick={handleManage}
                disabled={busy !== null}
                className="w-full py-3 rounded-2xl text-sm font-bold disabled:opacity-60"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(78,78,78,0.45)', color: '#E5E0DF', fontFamily: 'Rajdhani, sans-serif' }}
              >
                {busy === 'portal' ? 'Opening…' : 'Manage or cancel existing plan'}
              </button>
            )}

            {/* ── Renewal terms + legal (App Store / Play auto-renew disclosure) ── */}
            <p style={{ color: '#5C5856', fontFamily: 'Titillium Web, sans-serif', fontSize: '0.72rem', lineHeight: 1.5 }}>
              {renewalTerms}{' '}
              By subscribing you agree to our{' '}
              <button
                type="button"
                onClick={onShowTerms}
                style={{ color: '#E5E0DF', textDecoration: 'underline', background: 'transparent', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}
              >
                Terms
              </button>{' '}
              &amp;{' '}
              <button
                type="button"
                onClick={onShowPrivacy}
                style={{ color: '#E5E0DF', textDecoration: 'underline', background: 'transparent', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}
              >
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

// ── A9.3 reverse-trial banner ────────────────────────────────────────────────
// Shown while state==='trialing'. Counts down from entitlement.trialEndsAt so
// the user knows how long the no-card full-feature window lasts before the thin
// free floor kicks in.
function trialTimeLeft(trialEndsAt: string | null | undefined): string | null {
  if (!trialEndsAt) return null;
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return 'ending today';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'} left`;
  const hours = Math.max(1, Math.ceil(ms / 3_600_000));
  return `${hours} hour${hours === 1 ? '' : 's'} left`;
}

export function TrialBanner({
  entitlement,
  onUpgrade,
}: {
  entitlement: EntitlementResponse | null;
  onUpgrade: () => void;
}) {
  if (!entitlement || entitlement.state !== 'trialing') return null;
  const left = trialTimeLeft(entitlement.trialEndsAt);

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-5 mb-3 p-4 rounded-2xl flex items-center justify-between gap-3"
      style={{ background: 'rgba(91,103,240,0.12)', border: '1px solid rgba(91,103,240,0.4)' }}
    >
      <div className="flex items-center gap-3">
        <Sparkles size={18} color="#AEB8FF" />
        <div>
          <p style={{ fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, color: '#FFFFFF', fontSize: '0.9rem' }}>
            Pro trial{left ? ` — ${left}` : ''}
          </p>
          <p style={{ color: '#8C8684', fontSize: '0.75rem', fontFamily: 'Titillium Web, sans-serif' }}>
            Every feature is unlocked. No card until you convert.
          </p>
        </div>
      </div>
      <button
        onClick={onUpgrade}
        className="px-4 py-2 rounded-xl text-xs font-bold shrink-0"
        style={{ background: 'rgba(255,255,255,0.9)', color: '#0a0a0a', fontFamily: 'Rajdhani, sans-serif' }}
      >
        Upgrade
      </button>
    </motion.div>
  );
}
