// Create, revoke or list beta invite codes (beta_invites, migration 025;
// docs/plans/RELEASE.md PR 2). The owner makes a code on their own machine with
// scripts/new-invite-code.sh, which prints the code (for the tester) and its
// SHA-256 (for this job). Only the hash is passed here: the plaintext never
// reaches GCP, so it's not in the job's env overrides, the audit log, the
// application logs or the database.
//
//   gcloud run jobs execute db-job --wait --update-env-vars \
//     JOB_NAME=beta-invite,INVITE_CODE_SHA256=<hash>,INVITE_LABEL="cohort 1",INVITE_USES=25
//
// Optional: INVITE_DAYS (the grant's length, default 30), INVITE_MINUTES
// (default: Pro's monthly minutes), INVITE_NOTETAKER=true (also allowlist the
// notetaker), INVITE_EXPIRES_DAYS (the code stops working after that many
// days; default never). MODE=revoke with INVITE_ID (from MODE=list) or
// INVITE_CODE_SHA256 stops a code; MODE=list logs every invite's use count.
'use strict';

const loadRepo = () => require('@algominutes/db');
const DAY_MS = 24 * 60 * 60 * 1000;

function wholeNumber(env, name, fallback) {
  const raw = env[name];
  // Unset or blank means the default: a blank must never silently mean something else.
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number of at least 1`);
  return n;
}

async function run({ log, env, repo = loadRepo(), now = new Date() }) {
  const mode = env.MODE || 'create';

  if (mode === 'list') {
    const invites = await repo.listInvites();
    for (const i of invites) {
      log.info({
        inviteId: i.id, label: i.label, redemptions: i.redemptions, maxRedemptions: i.maxRedemptions,
        grantDays: i.grantDays, includedMinutes: i.includedMinutes, notetaker: i.notetaker,
        expiresAt: i.expiresAt, revokedAt: i.revokedAt,
      }, 'beta_invite_listed');
    }
    return { count: invites.length };
  }

  // A plaintext code here would already be in the execution's env overrides:
  // refuse it, so the mistake is seen (and the code replaced) rather than stored.
  if (env.INVITE_CODE) {
    throw new Error('pass INVITE_CODE_SHA256, never the code itself (scripts/new-invite-code.sh prints both); make a new code, this one was exposed');
  }
  const codeHash = env.INVITE_CODE_SHA256 ? String(env.INVITE_CODE_SHA256).trim().toLowerCase() : undefined;

  if (mode === 'revoke') {
    if (!env.INVITE_ID && !codeHash) throw new Error('set INVITE_ID (from MODE=list) or INVITE_CODE_SHA256');
    const { id, revoked } = await repo.revokeInvite({ id: env.INVITE_ID || undefined, codeHash });
    log.info({ inviteId: id, revoked }, 'beta_invite_revoked');
    return { id, revoked };
  }

  if (mode !== 'create') throw new Error(`MODE must be create, revoke or list, not ${mode}`);
  if (!codeHash) throw new Error('set INVITE_CODE_SHA256 to the hash scripts/new-invite-code.sh printed');
  if (!env.INVITE_LABEL || !env.INVITE_LABEL.trim()) throw new Error('set INVITE_LABEL (e.g. "cohort 1")');
  const expiresDays = wholeNumber(env, 'INVITE_EXPIRES_DAYS', null);
  const invite = await repo.createInvite({
    codeHash,
    label: env.INVITE_LABEL,
    grantDays: wholeNumber(env, 'INVITE_DAYS', 30),
    maxRedemptions: wholeNumber(env, 'INVITE_USES', 1),
    includedMinutes: wholeNumber(env, 'INVITE_MINUTES', null),
    notetaker: String(env.INVITE_NOTETAKER || '').toLowerCase() === 'true',
    expiresAt: expiresDays == null ? null : new Date(now.getTime() + expiresDays * DAY_MS),
  });
  // The id, never the hash (it's as good as the code for finding the invite).
  log.info({
    inviteId: invite.id, label: invite.label, maxRedemptions: invite.maxRedemptions, grantDays: invite.grantDays,
    includedMinutes: invite.includedMinutes, notetaker: invite.notetaker, expiresAt: invite.expiresAt,
  }, 'beta_invite_created');
  return { id: invite.id };
}

module.exports = { run };
