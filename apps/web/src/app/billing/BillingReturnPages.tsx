import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { EntitlementResponse } from '@algominutes/contracts';
import { ApiError } from '../../lib/api/errors';
import { reportCrash } from '../../lib/crashReport';
import { useApi } from '../ApiContext';

/**
 * Where Stripe sends a buyer back (docs/plans/RELEASE.md PR 28). The plan changes when Stripe's webhook
 * reaches billing, usually within seconds, so this page reads the entitlement until it's a subscription,
 * and says so plainly if that takes longer.
 */
export function BillingSuccessPage({ intervalMs = 2000, tries = 15 }: { intervalMs?: number; tries?: number }) {
  const { api } = useApi();
  const [state, setState] = useState<'waiting' | 'done' | 'slow'>('waiting');
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async (left: number) => {
      let ent: EntitlementResponse | null = null;
      try {
        ent = await api.entitlement();
      } catch (err) {
        // silent-catch-ok: a failed read is tried again on the next poll (and the page ends in `slow`); anything
        // but an API error is reported
        if (!(err instanceof ApiError)) reportCrash('billing.success', err);
      }
      if (cancelled) return;
      if (ent?.source === 'subscription') return setState('done');
      if (left <= 1) return setState('slow');
      timer = setTimeout(() => void check(left - 1), intervalMs);
    };
    void check(tries);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [api, intervalMs, tries]);

  return (
    <section className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold text-heading">{state === 'done' ? 'You’re on Pro' : 'Thanks for subscribing'}</h1>
      {state === 'waiting' && <p role="status" className="mt-3 text-body">Confirming your subscription…</p>}
      {state === 'done' && <p role="status" className="mt-3 text-body">Your subscription is confirmed. Your minutes are in Settings.</p>}
      {state === 'slow' && (
        <p role="status" className="mt-3 text-body">Your payment went through. Your plan updates in a minute or two; Settings shows it when it has.</p>
      )}
      <p className="mt-6">
        <Link to="/settings" className="underline">Settings</Link> · <Link to="/" className="underline">Your notes</Link>
      </p>
    </section>
  );
}

/** Checkout was left without paying. */
export function BillingCancelPage() {
  return (
    <section className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-bold text-heading">Checkout cancelled</h1>
      <p className="mt-3 text-body">Nothing was charged. You can go Pro any time from Settings.</p>
      <p className="mt-6">
        <Link to="/settings" className="underline">Settings</Link> · <Link to="/" className="underline">Your notes</Link>
      </p>
    </section>
  );
}
