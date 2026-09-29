// Pro on the web (docs/plans/RELEASE.md PR 28): Stripe Checkout and the billing portal, in test mode
// through the beta (nobody is charged). The web app hands the browser to Stripe; billing sends it back to
// /app/billing/success or /app/billing/cancel on this same origin.
import type { EntitlementResponse } from '@algominutes/contracts';
import { ApiError } from '../api/errors';

/** Leave the app for Stripe's page. Its own module, so tests can stand in for the browser. */
export function redirectTo(url: string): void {
  window.location.assign(url);
}

/** Who may start a checkout: anyone without a subscription (beta minutes, the trial, the free floor). */
export function canBuyPro(ent: EntitlementResponse | null): boolean {
  return !!ent && ent.source !== 'subscription';
}

/** A subscription billed on the web: managed in Stripe's portal. */
export function managedOnTheWeb(ent: EntitlementResponse | null): boolean {
  return !!ent && ent.source === 'subscription' && ent.rail === 'stripe';
}

/** What a failed checkout says. */
export function checkoutErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      const rail = (err.body as { rail?: unknown } | null)?.rail;
      return rail === 'apple_storekit'
        ? 'You already have Pro, through the App Store. Manage it on your iPhone: Settings, your name, then Subscriptions.'
        : 'You already have Pro.';
    }
    if (err.status === 503) return 'Pro isn’t on sale yet. An invite code adds minutes meanwhile.';
    if (err.kind === 'network' || err.kind === 'timeout') return 'Checkout couldn’t be reached. Check your connection and try again.';
    if (err.kind === 'rate_limited') return 'Too many tries. Wait a minute and try again.';
  }
  return 'Checkout couldn’t start. Please try again.';
}

/** What a failed trip to the portal says. */
export function portalErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) return 'There’s no subscription billed on the web to manage.';
  if (err instanceof ApiError && (err.kind === 'network' || err.kind === 'timeout')) return 'Billing couldn’t be reached. Check your connection and try again.';
  return 'Billing couldn’t be opened. Please try again.';
}
