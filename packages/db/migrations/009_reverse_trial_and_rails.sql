-- 009: reverse-trial state machine + dual-rail identifiers (A9.3 / A9.4). Expand-only.
--
-- ONE entitlement row per user (subscriptions, keyed by uid). Each billing rail
-- records its durable id here; the resolved entitlement is derived server-side
-- from these fields + server time (never from a client-reported purchase).
--
-- Entitlement state machine (A9.3):  trialing → active | expired → free_floor
--   trialing   : within the 7-day reverse trial (no card). Full features.
--   active     : a paid subscription is current (any rail).
--   expired    : trial elapsed, no purchase (transient; resolves to free_floor).
--   free_floor : thin post-trial floor (FREE_FLOOR_MINUTES — config, UNSET; fails safe to 0).
-- Derived on read so it is correct even before the expiry sweep runs.

-- entitlement_state cache (authoritative derivation is in code; this is for admin/queries)
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS entitlement_state TEXT NOT NULL DEFAULT 'trialing';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_started_at   TIMESTAMPTZ;
-- trial_end (added in 007) is the trial's end instant. trial_started_at pairs with it.

-- Durable per-rail subscription identifiers (cross-rail dedup + receipt validation).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS apple_original_transaction_id TEXT; -- StoreKit 2 originalTransactionId
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS google_purchase_token         TEXT; -- Play Billing purchase token
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id            TEXT;
-- stripe_subscription_id already exists (001_init).

-- Anti-abuse SEAM (NOT enforced — see BLOCKERS): binds a trial to a durable device
-- signal so a reinstall with a fresh anonymous uid cannot restart the 7 days.
-- Populate from iOS DeviceCheck/App Attest or Android Play Integrity when decided.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_device_hash TEXT;

-- One rail id maps to at most one user (a Play/Apple/Stripe subscription can't
-- back two accounts). Partial unique indexes; NULLs are ignored.
CREATE UNIQUE INDEX IF NOT EXISTS subs_apple_txn_uq
  ON subscriptions(apple_original_transaction_id) WHERE apple_original_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subs_google_token_uq
  ON subscriptions(google_purchase_token) WHERE google_purchase_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS subs_stripe_sub_uq
  ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
-- Seam for device-bound anti-abuse (not enforced yet — nullable, non-unique for now):
CREATE INDEX IF NOT EXISTS subs_trial_device_idx
  ON subscriptions(trial_device_hash) WHERE trial_device_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS subs_state_idx ON subscriptions(entitlement_state);
