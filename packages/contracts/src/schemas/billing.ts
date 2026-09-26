// Billing rails contract (A9.4) + analytics events (A9.6). ONE source for iOS
// (StoreKit 2), Android (Play Billing — B2 client), web (Stripe), and services/billing.
// Entitlement is granted ONLY from a server-validated receipt/webhook — these
// request shapes carry the proof the server verifies; never a client "I'm Pro" flag.
import { z } from './zod';

export const BillingRail = z
  .enum(['apple_storekit', 'google_play', 'stripe'])
  .openapi('BillingRail');

export const BillingPeriod = z.enum(['monthly', 'annual']).openapi('BillingPeriod');
export type BillingPeriod = z.infer<typeof BillingPeriod>;

/** A purchasable product, shown on the paywall. Store/Stripe prices are the source
 * of truth for charging; `priceDisplay` is for UI and must be kept in sync. */
export const Product = z
  .object({
    id: z.string(), // e.g. 'pro_monthly' | 'pro_annual'
    plan: z.literal('pro'),
    period: BillingPeriod,
    priceDisplay: z.string(), // e.g. 'A$14.99'
    appleProductId: z.string().optional(),
    googleProductId: z.string().optional(),
    stripePriceId: z.string().optional(),
  })
  .openapi('Product');

// ── Client → server purchase verification (StoreKit 2 / Play) ────────────────
// Apple: the StoreKit 2 signed transaction (JWS). Google: the purchase token +
// product id (server verifies via the Play Developer API). Server validates, then
// activates entitlement keyed to the user.
export const VerifyPurchaseRequest = z
  .object({
    rail: z.enum(['apple_storekit', 'google_play']),
    // apple
    jwsRepresentation: z.string().optional(),
    // google
    purchaseToken: z.string().optional(),
    productId: z.string().optional(),
  })
  .openapi('VerifyPurchaseRequest');

export const VerifyPurchaseResponse = z
  .object({ ok: z.boolean(), entitlementState: z.enum(['active', 'trialing', 'free_floor']) })
  .openapi('VerifyPurchaseResponse');

// ── Web (Stripe) ─────────────────────────────────────────────────────────────
export const CheckoutSessionRequest = z
  .object({ productId: z.string(), period: BillingPeriod })
  .openapi('CheckoutSessionRequest');
export const CheckoutSessionResponse = z.object({ url: z.string() }).openapi('CheckoutSessionResponse');
export const PortalSessionResponse = z.object({ url: z.string() }).openapi('PortalSessionResponse');

// ── A9.6 analytics funnel ────────────────────────────────────────────────────
// The trial-end → paywall-viewed → purchase funnel is what tells us if 7 days is right.
export const AnalyticsEvent = z
  .enum([
    'signup',
    'first_recording',
    'first_summary_viewed',
    'trial_started',
    'trial_day7', // trial expiry moment
    'quota_hit',
    'paywall_viewed',
    'purchase',
    'cancellation',
  ])
  .openapi('AnalyticsEvent');

/**
 * Events the SERVER records when it sees the fact happen (terms accepted,
 * retention set, a support request, an account deleted). Kept out of
 * AnalyticsEvent, so a client can't post them to /v1/events.
 */
export const ServerAnalyticsEvent = z
  .enum(['terms_accepted', 'retention_set', 'support_requested', 'account_deleted'])
  .openapi('ServerAnalyticsEvent');
export type ServerAnalyticsEvent = z.infer<typeof ServerAnalyticsEvent>;

export const TrackEventRequest = z
  .object({
    event: AnalyticsEvent,
    props: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    occurredAt: z.string().optional(), // ISO; server stamps if absent
  })
  .openapi('TrackEventRequest');

export type BillingRail = z.infer<typeof BillingRail>;
export type Product = z.infer<typeof Product>;
export type VerifyPurchaseRequest = z.infer<typeof VerifyPurchaseRequest>;
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;
export type TrackEventRequest = z.infer<typeof TrackEventRequest>;
