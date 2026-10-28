-- Plan rev 12 S8 (docs/plans/RELEASE.md R12.3): an iPhone kickoff that came without a DeviceCheck token wrote
-- the account onto the free floor for good, so a later kickoff with a valid token never got the trial. The
-- account still opens on the free floor, but marked as waiting for its device: the next kickoff with a token
-- asks Apple, and starts the trial (or settles the free floor) and clears the mark.
-- expand-only: a new column with a default. An old image never reads or writes it (it SELECTs * into a row
-- type and ignores extra fields), and a rollback leaves only a flag nothing reads.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_device_pending BOOLEAN NOT NULL DEFAULT FALSE;
