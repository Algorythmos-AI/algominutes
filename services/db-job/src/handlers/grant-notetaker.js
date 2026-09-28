// Allow (or stop) one tester using the online-meeting notetaker
// (notetaker_testers, migration 024). The notetaker is for allowlisted testers
// until the legal opinion (docs/CONSENT.md §2.4). The owner runs it; tester
// emails never go into git:
//
//   gcloud run jobs execute db-job --wait --update-env-vars \
//     JOB_NAME=grant-notetaker,GRANT_EMAIL=tester@example.com
//
// GRANT_EMAIL or GRANT_UID picks the user (they must have signed in once).
// Optional: GRANT_DAYS (default 30; 0 = no expiry), GRANT_REASON, and
// MODE=revoke to remove them. The api also needs NOTETAKER=bot switched on.
'use strict';

const loadRepo = () => require('@algominutes/db');

async function run({ log, env, repo = loadRepo(), now = new Date() }) {
  const who = { uid: env.GRANT_UID || undefined, email: env.GRANT_EMAIL || undefined };
  if (!who.uid && !who.email) throw new Error('set GRANT_EMAIL or GRANT_UID');

  if (env.MODE === 'revoke') {
    const { uid, revoked } = await repo.revokeNotetaker(who);
    log.info({ userId: uid, revoked }, 'notetaker_tester_revoked');
    return { uid, revoked };
  }

  // Unset or blank means the default: a blank must not silently mean "never expires".
  const days = env.GRANT_DAYS === undefined || env.GRANT_DAYS.trim() === '' ? 30 : Number(env.GRANT_DAYS);
  if (!Number.isInteger(days) || days < 0) throw new Error('GRANT_DAYS must be a whole number of days');
  const expiresAt = days === 0 ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const uid = await repo.grantNotetaker({ ...who, reason: env.GRANT_REASON || 'notetaker_tester', expiresAt });
  // The uid, not the email: logs carry ids, and the email stays out of them.
  log.info({ userId: uid, expiresAt }, 'notetaker_tester_granted');
  return { uid, expiresAt };
}

module.exports = { run };
