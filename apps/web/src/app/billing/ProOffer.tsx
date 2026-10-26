import { useState } from 'react';
import type { BillingPeriod, EntitlementResponse } from '@algominutes/contracts';
import { ApiError } from '../../lib/api/errors';
import { checkoutErrorMessage, managedOnTheWeb, portalErrorMessage, redirectTo } from '../../lib/billing/checkout';
import { reportCrash } from '../../lib/crashReport';
import { useApi } from '../ApiContext';

const PRODUCT: Record<BillingPeriod, string> = { monthly: 'pro_monthly', annual: 'pro_annual' };

/**
 * Pro on the web (docs/plans/RELEASE.md PR 28): Stripe Checkout for anyone without a subscription, and
 * Stripe's portal for a subscription billed here. Stripe shows the price before anyone pays; in the beta
 * it's in test mode, and nobody is charged.
 */
export function ProOffer({ ent }: { ent: EntitlementResponse }) {
  const { api } = useApi();
  const [busy, setBusy] = useState<BillingPeriod | 'portal' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const leave = async (what: BillingPeriod | 'portal') => {
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      const { url } = what === 'portal' ? await api.portal() : await api.checkout({ productId: PRODUCT[what], period: what });
      redirectTo(url);
    } catch (err) {
      setError(what === 'portal' ? portalErrorMessage(err) : checkoutErrorMessage(err));
      if (!(err instanceof ApiError)) reportCrash(what === 'portal' ? 'billing.portal' : 'billing.checkout', err);
      setBusy(null);
    }
  };

  if (managedOnTheWeb(ent)) {
    return (
      <div className="mt-4">
        <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" disabled={busy !== null} onClick={() => void leave('portal')}>
          {busy === 'portal' ? 'Opening…' : 'Manage subscription'}
        </button>
        {error && <p role="alert" className="mt-2 text-body">{error}</p>}
      </div>
    );
  }
  if (ent.source === 'subscription') return null; // billed in a store: managed there
  return (
    <div className="mt-4">
      <p className="text-body">Go Pro: 1,500 minutes a month. Stripe shows the price before you pay.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className="rounded-xl bg-accent px-4 py-2 font-semibold text-white disabled:opacity-60" disabled={busy !== null} onClick={() => void leave('monthly')}>
          {busy === 'monthly' ? 'Opening checkout…' : 'Pro, monthly'}
        </button>
        <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" disabled={busy !== null} onClick={() => void leave('annual')}>
          {busy === 'annual' ? 'Opening checkout…' : 'Pro, yearly'}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-body">{error}</p>}
    </div>
  );
}
