// Product catalog + plan resolution (A9.3 / A9.4).
//
// The single plan is Pro, sold monthly or annually. The store/Stripe prices are
// the SOURCE OF TRUTH for what a customer is actually charged; the display
// strings here only drive the paywall and must be kept in sync with them.
//
// Pricing figures mirror `@algominutes/contracts` PRICING (A9.3 in DECISIONS.md:
// Pro A$14.99/mo, A$149.90/yr ≈ two months free). They are duplicated as plain
// constants rather than imported so this service does not take a runtime
// dependency on the contracts package's zod/OpenAPI graph — but they are NOT a
// secret and NOT the charging authority.
//
// The per-store product identifiers ARE environment-driven (Secret Manager /
// config in prod) and must never be hardcoded.

const PRICING = { currency: 'AUD', proMonthly: 14.99, proAnnual: 149.9 };

/**
 * Catalog keyed by the wire `Product.id` (`pro_monthly` | `pro_annual`).
 * appleProductId / googleProductId / stripePriceId come from env; where a real
 * store identifier is required to charge, that is TODO(A11).
 */
export function productCatalog() {
  return [
    {
      id: 'pro_monthly',
      plan: 'pro',
      period: 'monthly',
      priceDisplay: `A$${PRICING.proMonthly}`,
      // TODO(A11): real App Store / Play / Stripe product + price ids from Secret Manager.
      appleProductId: process.env.APPLE_PRODUCT_PRO_MONTHLY || 'pro_monthly',
      googleProductId: process.env.GOOGLE_PRODUCT_PRO_MONTHLY || 'pro_monthly',
      stripePriceId: process.env.STRIPE_PRICE_PRO_MONTHLY || null,
    },
    {
      id: 'pro_annual',
      plan: 'pro',
      period: 'annual',
      priceDisplay: `A$${PRICING.proAnnual}`,
      // TODO(A11): real App Store / Play / Stripe product + price ids from Secret Manager.
      appleProductId: process.env.APPLE_PRODUCT_PRO_ANNUAL || 'pro_annual',
      googleProductId: process.env.GOOGLE_PRODUCT_PRO_ANNUAL || 'pro_annual',
      stripePriceId: process.env.STRIPE_PRICE_PRO_ANNUAL || null,
    },
  ];
}

/** Look up a catalog entry by its wire product id. */
export function productById(id) {
  return productCatalog().find((p) => p.id === id) || null;
}

/**
 * Resolve the PlanId ('pro') from a store product identifier seen on a verified
 * receipt. All current products map to 'pro'; an unknown id still resolves to
 * 'pro' (the only paid plan) but is flagged by the caller's log line, since a
 * genuinely unknown SKU means the catalog drifted from the store config.
 */
export function planFromStoreProductId(storeProductId) {
  const match = productCatalog().find(
    (p) => p.appleProductId === storeProductId || p.googleProductId === storeProductId,
  );
  return { plan: match ? match.plan : 'pro', period: match ? match.period : null, known: !!match };
}

/** Resolve the PlanId from a Stripe price id on a verified subscription. */
export function planFromStripePriceId(stripePriceId) {
  const match = productCatalog().find((p) => p.stripePriceId && p.stripePriceId === stripePriceId);
  return { plan: match ? match.plan : 'pro', period: match ? match.period : null, known: !!match };
}
