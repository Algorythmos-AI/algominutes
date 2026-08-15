# services/billing — the revenue rails (A9.4 / A9.5)

`@algominutes/billing` is the **only** service that writes a paid entitlement.
It owns server-side receipt validation (Apple StoreKit 2, Google Play), the web
Stripe rail (Checkout + Billing Portal), and the **public** store/Stripe
webhooks. It runs as its **own Cloud Run service with its own scaling pool**
(BUILD-PLAN §3.2): a webhook retry-storm from Apple/Google/Stripe must never
starve authed user-request capacity in `services/api`.

> **Entitlement is granted ONLY from a server-validated receipt/webhook — never
> from a client "I'm Pro" flag.** Every grant flows through the `@algominutes/db`
> repo (`activateSubscription` / `setSubscriptionStatus`) and is keyed to a
> server-resolved `uid`. There is exactly **one entitlement row per uid** (A9.4).

## Reverse-trial model (A9.3)

Pro is the only paid plan: **A$14.99/mo**, **A$149.90/yr** (≈ two months free).
The 7-day reverse trial (no card) is materialised by `@algominutes/db`
(`ensureTrial`); this service only records **paid** state. The wire display
prices in `src/lib/plans.js` mirror `@algominutes/contracts` PRICING — the
store/Stripe prices remain the charging source of truth.

## Endpoint & webhook table

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET`  | `/healthz` | none | Liveness probe |
| `POST` | `/v1/purchases/verify` | Firebase ID token → `uid` | Verify a StoreKit 2 (`jwsRepresentation`) or Play (`purchaseToken`+`productId`) receipt server-side, then `activateSubscription`. Returns `VerifyPurchaseResponse`. |
| `POST` | `/v1/billing/checkout` | Firebase ID token → `uid` | Stripe Checkout session (subscription mode). Returns `{ url }`. |
| `POST` | `/v1/billing/portal` | Firebase ID token → `uid` | Stripe Billing Portal session. Returns `{ url }`. |
| `POST` | `/webhooks/stripe` | **public**, `Stripe-Signature` (raw body) | `checkout.session.completed`, `customer.subscription.updated\|deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`. |
| `POST` | `/webhooks/apple`  | **public**, signed JWS payload | App Store Server Notifications V2: `DID_RENEW`, `EXPIRED`, `GRACE_PERIOD_EXPIRED`, `DID_FAIL_TO_RENEW`, `REFUND`. |
| `POST` | `/webhooks/google` | **public**, Pub/Sub push + Play re-verify | Play RTDN `subscriptionNotification`: `PURCHASED`/`RENEWED`/`RESTARTED`/`RECOVERED`, `IN_GRACE_PERIOD`, `ON_HOLD`/`PAUSED`, `CANCELED`, `EXPIRED`, `REVOKED`. |

Contract shapes (`Product`, `VerifyPurchaseRequest/Response`,
`CheckoutSessionRequest/Response`, `PortalSessionResponse`) match
`packages/contracts/src/schemas/billing.ts`.

## How `uid` is resolved in each webhook

The stores/Stripe never know our Firebase `uid`; they know only the rail's
durable id. Resolution:

- **Stripe** — `checkout.session.completed` is the ONE event that carries the
  `uid` directly (`client_reference_id` + `metadata.uid`, stamped at checkout),
  because the subscription row may not exist yet. **Every other Stripe event**
  resolves via `findUidByRailId({ stripe: subscriptionId })`, falling back to
  `findUidByRailId({ stripeCustomer: customerId })`.
- **Apple** — `findUidByRailId({ apple: originalTransactionId })`, where
  `originalTransactionId` is decoded from `data.signedTransactionInfo`.
- **Google** — `findUidByRailId({ google: purchaseToken })`, where the
  `purchaseToken` comes from `subscriptionNotification`.

The binding between a rail id and a `uid` is created by
`POST /v1/purchases/verify` (Apple/Play) or `checkout.session.completed`
(Stripe). A webhook for a rail id we've never verified resolves to `null`; we
log (`*_uid_unresolved`) and **ack** — we never fabricate a grant.

## Cross-rail dedup (A9.4)

Entitlement is **one row per uid**. Two rules:

1. **Cross-rail conflict** (`/v1/purchases/verify`) — if `findUidByRailId`
   shows the incoming rail id already maps to a **different** uid, we **reject
   with 409** and log `cross_rail_conflict`. A single store subscription cannot
   back two accounts.
2. **Cross-rail duplicate** (`src/lib/dedup.js`) — if the **same** uid activates
   a **second** rail while the first is still current, we keep the single
   entitlement row (`activateSubscription` is an upsert on `uid`, so it never
   double-grants), log `cross_rail_duplicate`, and continue. **A store
   double-purchase across rails cannot be auto-refunded server-side** — Apple/
   Google refunds are initiated in their own consoles — so this is surfaced to
   **support** via the log line rather than silently reconciled.

## Android note — Play client is B2

The Play **server** side (this service's `/webhooks/google` + the verify path)
lives here. The Android **Play Billing client is B2** (separate workstream).
B2's client must, on a successful purchase, call
`POST /v1/purchases/verify` with:

```json
{ "rail": "google_play", "purchaseToken": "<Play purchase token>", "productId": "<subscription product id>" }
```

with the user's Firebase ID token in the `Authorization: Bearer` header. This
service re-verifies the token against the Play Developer API and grants the
entitlement; the client must not assume Pro until the response says so.

## Configuration (env → Secret Manager)

No secret is hardcoded — everything comes from `process.env` (Secret Manager in
prod). Required before this service can transact (each is a `TODO(A11)` in code):

| Env var | Used by |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe client |
| `STRIPE_WEBHOOK_SECRET` | `/webhooks/stripe` signature |
| `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL` | checkout line items |
| `BILLING_SUCCESS_URL`, `BILLING_CANCEL_URL`, `BILLING_PORTAL_RETURN_URL` | Stripe redirects |
| `APPLE_PRODUCT_PRO_MONTHLY`, `APPLE_PRODUCT_PRO_ANNUAL` | Apple SKU → plan mapping |
| `GOOGLE_PRODUCT_PRO_MONTHLY`, `GOOGLE_PRODUCT_PRO_ANNUAL`, `PLAY_PACKAGE_NAME` | Play SKU / package |
| `GOOGLE_CLOUD_PROJECT` | firebase-admin ADC |

## Outstanding TODOs

- **`TODO(A11)`** — every external call is stubbed against live credentials:
  Stripe (`getStripe` / `constructStripeEvent` / checkout / portal / subscription
  retrieve), Apple (`verifyAndDecodeJws`), Google (`verifyPlaySubscription` +
  Play Console SA linkage), and all store product / price ids + redirect URLs.
- **`TODO(A4-apple)`** — full StoreKit 2 / ASSN V2 JWS verification: parse the
  `x5c` chain, verify the ES256 signature, and validate the chain up to
  **Apple Root CA - G3** before trusting a decoded payload. Requires the iOS
  Firebase app + Apple root certs (not available in this environment). Today
  `src/lib/apple.js` **decodes** the JWS; it does not yet cryptographically
  verify it.

## Operating cost (BUILD-PLAN §3.3)

One Cloud Run service (own scaling pool, scale-to-zero) + three public webhook
endpoints + one dashboard/alert. Cost driver is webhook volume (low) plus Stripe
API calls on checkout/renewal.
