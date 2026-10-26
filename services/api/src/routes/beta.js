// POST /v1/beta/redeem: a tester redeems the code from their invitation
// (docs/plans/RELEASE.md, PR 2). Redeeming gives a time-limited Pro grant, plus
// the notetaker when the invite includes it, through @algominutes/db.
//
// The code is never logged: it's a bearer of minutes. Logs carry the invite id.

import { getFirestore } from 'firebase-admin/firestore';
import { redeemInvite, resolveEntitlement, resumeHeldNotes } from '@algominutes/db';
import { RedeemInviteRequest } from '@algominutes/contracts/schemas';
import { toEntitlementResponse } from './entitlement.js';

const REFUSALS = {
  invalid: { status: 400, error: 'invite_invalid' },
  expired: { status: 410, error: 'invite_expired' },
  used_up: { status: 409, error: 'invite_used_up' },
};

export async function redeemInviteRoute(req, res) {
  const log = req.log;
  const parsed = RedeemInviteRequest.safeParse(req.body ?? {});
  if (!parsed.success) {
    log.warn({ reason: 'invalid' }, 'beta_invite_refused');
    return res.status(400).json({ error: 'invite_invalid' });
  }

  let result;
  try {
    result = await redeemInvite({
      uid: req.uid,
      code: parsed.data.code,
      user: { email: req.authEmail ?? null, name: req.authName ?? null },
      log,
    });
  } catch (err) {
    if (err?.code === 'ACCOUNT_DELETED') {
      log.warn({}, 'beta_invite_account_deleted');
      return res.status(401).json({ error: 'account_deleted' });
    }
    throw err;
  }

  if (result.kind !== 'redeemed') {
    const refusal = REFUSALS[result.kind];
    log.warn({ reason: result.kind, inviteId: result.inviteId ?? null }, 'beta_invite_refused');
    return res.status(refusal.status).json({ error: refusal.error });
  }

  // Recordings held for minutes (RELEASE.md rev 11, H6) go now, not at the next sweep. Never fails the redeem:
  // the sweep resumes whatever this couldn't.
  try {
    const resumed = await resumeHeldNotes({ firestore: getFirestore(), log, traceId: req.traceId, uid: req.uid, limit: 20 });
    if (resumed.held) log.info({ ...resumed }, 'beta_invite_resumed_held_notes');
  } catch (err) {
    log.error({ err }, 'beta_invite_resume_failed');
  }

  const ent = await resolveEntitlement(req.uid);
  log.info(
    { inviteId: result.inviteId, replay: result.replay, grantEndsAt: result.grantEndsAt, notetaker: result.notetaker },
    'beta_invite_redeemed',
  );
  return res.json({
    entitlement: toEntitlementResponse(ent),
    grantEndsAt: result.grantEndsAt ? result.grantEndsAt.toISOString() : null,
    notetaker: result.notetaker,
  });
}
