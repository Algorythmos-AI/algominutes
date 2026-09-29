-- RELEASE.md PR 26: when Apple was last asked about an App Store subscription (billing's reconcile-apple
-- task, App Store Server API). A notification Apple never delivered, or delivered out of order, would
-- otherwise leave the entitlement wrong until the stored period lapsed. The task picks subscriptions near
-- the end of their period, or not checked for a week, by this column. Expand-only: a nullable column.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS apple_checked_at TIMESTAMPTZ;
