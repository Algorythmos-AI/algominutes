-- RELEASE.md PR 28b: a Stripe subscription whose account was deleted, to be cancelled with Stripe. Account
-- deletion removes the subscriptions row, and nothing else would ever stop the charges. The deletion (or a
-- checkout webhook that arrives after it) records the subscription here, in its own transaction; billing's
-- cancel-stripe task cancels it with Stripe, retrying with backoff. No uid: the account is gone. Expand-only:
-- a new table.
CREATE TABLE IF NOT EXISTS stripe_cancellations (
  stripe_subscription_id TEXT PRIMARY KEY,
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts               INTEGER NOT NULL DEFAULT 0,
  next_attempt_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error             TEXT,
  cancelled_at           TIMESTAMPTZ,
  trace_id               TEXT
);
CREATE INDEX IF NOT EXISTS stripe_cancellations_due ON stripe_cancellations (next_attempt_at) WHERE cancelled_at IS NULL;
