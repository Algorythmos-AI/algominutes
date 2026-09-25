// Grant (or revoke) an internal tester's entitlement (entitlement_grants,
// migration 019), so a TestFlight build can process recordings without a paid
// subscription. The owner runs it; tester emails never go into git:
//
//   gcloud run jobs execute db-job --wait --update-env-vars \
//     JOB_NAME=grant-tester,GRANT_EMAIL=tester@example.com
//
// GRANT_EMAIL or GRANT_UID picks the user (they must have signed in once).
// Optional: GRANT_PLAN (only pro), GRANT_DAYS (default 90; 0 = no
// expiry), GRANT_MINUTES (default: the plan's monthly minutes), GRANT_REASON,
// and MODE=revoke to remove the grant.
'use strict';

const loadRepo = () => require('@algominutes/db');

async function run({ log, env, repo = loadRepo(), now = new Date() }) {
  const who = { uid: env.GRANT_UID || undefined, email: env.GRANT_EMAIL || undefined };
  if (!who.uid && !who.email) throw new Error('set GRANT_EMAIL or GRANT_UID');

  if (env.MODE === 'revoke') {
    const { uid, revoked } = await repo.revokeEntitlement(who);
    log.info({ userId: uid, revoked }, 'entitlement_grant_revoked');
    return { uid, revoked };
  }

  // Unset or blank means the default: a blank must not silently mean "never expires".
  const days = env.GRANT_DAYS === undefined || env.GRANT_DAYS.trim() === '' ? 90 : Number(env.GRANT_DAYS);
  if (!Number.isInteger(days) || days < 0) throw new Error('GRANT_DAYS must be a whole number of days');
  const minutes = env.GRANT_MINUTES ? Number(env.GRANT_MINUTES) : null;
  const expiresAt = days === 0 ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const uid = await repo.grantEntitlement({
    ...who,
    plan: env.GRANT_PLAN || 'pro',
    includedMinutes: minutes,
    reason: env.GRANT_REASON || 'internal_tester',
    expiresAt,
  });
  // The uid, not the email: logs carry ids, and the email stays out of them.
  log.info({ userId: uid, plan: env.GRANT_PLAN || 'pro', expiresAt, includedMinutes: minutes }, 'entitlement_granted');
  return { uid, expiresAt };
}

module.exports = { run };
