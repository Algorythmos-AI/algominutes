// Web billing rails (A9.4/A9.5/A9.6). The client never asserts "I'm Pro" — it
// only kicks off a Stripe Checkout/Portal redirect and reads the server-resolved
// entitlement (A9.1). Entitlement is granted from a validated Stripe webhook,
// never from anything here.
//
// A9.3 reverse trial: days 1–7 are full-featured with NO card. The card is only
// collected at conversion, via the Stripe Checkout redirect below.
import { authedFetch } from './authedFetch';
import { apiUrl } from './apiUrl';
import { auth } from '../firebase';
import { reportCrash } from './crashReport';
import type {
  EntitlementResponse,
  AnalyticsEvent,
  BillingPeriod,
} from '@algominutes/contracts';
import { readErrorText, readErrorJson } from './http';

// ── Product catalogue (A9.3 pricing) ─────────────────────────────────────────
// Stripe prices are the source of truth for charging; these ids/displays are UI
// only and must be kept in sync with packages/contracts Product + Stripe.
export const PRO_MONTHLY_PRODUCT_ID = 'pro_monthly';
export const PRO_ANNUAL_PRODUCT_ID = 'pro_annual';
export const PRO_MONTHLY_PRICE_DISPLAY = 'A$14.99';
export const PRO_ANNUAL_PRICE_DISPLAY = 'A$149.90';

function productIdFor(period: BillingPeriod): string {
  return period === 'annual' ? PRO_ANNUAL_PRODUCT_ID : PRO_MONTHLY_PRODUCT_ID;
}

function redirectTo(url: string): void {
  // Stripe Checkout / Billing Portal are hosted flows — a full-page redirect,
  // not an in-app fetch. window.location.assign works in the browser and the
  // Capacitor WKWebView alike.
  if (typeof window !== 'undefined') window.location.assign(url);
}

/**
 * Begin a Stripe Checkout session for Pro (monthly or annual) and redirect the
 * browser to the hosted Checkout page. The server creates the session keyed to
 * the signed-in (or guest) Firebase uid and returns its `url`.
 */
export async function startCheckout(period: BillingPeriod): Promise<void> {
  const resp = await authedFetch('/v1/billing/checkout', {
    productId: productIdFor(period),
    period,
  });
  if (!resp.ok) {
    const detail = await readErrorText(resp);
    reportCrash('billing_checkout_failed', new Error(`checkout_http_${resp.status}`), { detail: detail.slice(0, 200) });
    throw new Error('Could not start checkout. Please try again.');
  }
  const data = (await readErrorJson(resp)) as { url?: string };
  if (!data.url) {
    reportCrash('billing_checkout_no_url', new Error('checkout_response_missing_url'));
    throw new Error('Could not start checkout. Please try again.');
  }
  redirectTo(data.url);
}

/**
 * Open the Stripe Billing Portal (manage / cancel / update card) and redirect
 * the browser to it. Used by the paywall's Manage/Cancel affordance.
 */
export async function openBillingPortal(): Promise<void> {
  const resp = await authedFetch('/v1/billing/portal', {});
  if (!resp.ok) {
    const detail = await readErrorText(resp);
    reportCrash('billing_portal_failed', new Error(`portal_http_${resp.status}`), { detail: detail.slice(0, 200) });
    throw new Error('Could not open the billing portal. Please try again.');
  }
  const data = (await readErrorJson(resp)) as { url?: string };
  if (!data.url) {
    reportCrash('billing_portal_no_url', new Error('portal_response_missing_url'));
    throw new Error('Could not open the billing portal. Please try again.');
  }
  redirectTo(data.url);
}

/**
 * Read the server-resolved entitlement (A9.1). GET /v1/entitlement. Never trust
 * the client — this is the single source of truth for trial/quota/plan state.
 */
export async function fetchEntitlement(signal?: AbortSignal): Promise<EntitlementResponse> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const idToken = await user.getIdToken();
  const resp = await fetch(apiUrl('/v1/entitlement'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
    signal,
  });
  if (!resp.ok) throw new Error(`entitlement_http_${resp.status}`);
  return (await resp.json()) as EntitlementResponse;
}

/**
 * Emit an A9.6 funnel event. Fire-and-forget: analytics must never break the
 * UX, so a failed POST is swallowed (the crash reporter already covers real
 * faults). Returns a promise callers may ignore.
 */
export async function track(
  event: AnalyticsEvent,
  props?: Record<string, string | number | boolean>,
): Promise<void> {
  try {
    if (!auth.currentUser) return;
    await authedFetch('/v1/events', {
      event,
      ...(props ? { props } : {}),
      occurredAt: new Date().toISOString(),
    });
  } catch {
    // silent-catch-ok: a dropped analytics beacon is not worth a
    // user-visible error or a crash report.
  }
}
