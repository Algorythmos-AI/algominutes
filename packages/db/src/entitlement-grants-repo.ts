/**
 * Manual entitlement grants (migration 019): internal testers get a paid plan
 * without paying, so a TestFlight build can process recordings. Added and
 * revoked by the owner through the db-job `grant-tester` handler, never by a
 * client. resolveEntitlement reads the live grant.
 */
import type { PlanId } from '@algominutes/contracts';
import { getPool, isPostgresEnabled } from './db';

export interface EntitlementGrant {
  uid: string;
  plan: PlanId;
  includedMinutes: number | null;
  reason: string;
  grantedAt: Date;
  expiresAt: Date | null;
}

export class GrantUserNotFoundError extends Error {
  readonly code = 'GRANT_USER_NOT_FOUND';
  constructor(who: string) {
    super(`no user ${who}: they must sign in to the app once before a grant`);
    this.name = 'GrantUserNotFoundError';
  }
}

// Only Pro: team's monthly minutes are null (unmetered), so a team grant would
// be unlimited processing cost. GRANT_MINUTES raises a tester's allowance.
const GRANTABLE: readonly string[] = ['pro'];

/** The user's grant, if one is live at `now`. */
export async function getActiveGrant(uid: string, now: Date = new Date()): Promise<EntitlementGrant | null> {
  if (!isPostgresEnabled()) return null;
  const { rows } = await getPool().query(
    `SELECT uid, plan, included_minutes, reason, granted_at, expires_at
       FROM entitlement_grants
      WHERE uid = $1 AND (expires_at IS NULL OR expires_at > $2)`,
    [uid, now],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    uid: r.uid,
    plan: r.plan as PlanId,
    includedMinutes: r.included_minutes,
    reason: r.reason,
    grantedAt: new Date(r.granted_at),
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
  };
}

async function resolveUid(who: { uid?: string; email?: string }): Promise<string> {
  if (who.uid) {
    const { rowCount } = await getPool().query('SELECT 1 FROM users WHERE uid = $1', [who.uid]);
    if (!rowCount) throw new GrantUserNotFoundError(`uid ${who.uid}`);
    return who.uid;
  }
  if (!who.email) throw new Error('a grant needs a uid or an email');
  const { rows } = await getPool().query<{ uid: string }>(
    'SELECT uid FROM users WHERE lower(email) = lower($1)',
    [who.email],
  );
  if (rows.length !== 1) throw new GrantUserNotFoundError(rows.length ? 'email matches several users' : 'with that email');
  return rows[0]!.uid;
}

/** Grant (or replace the grant of) one user. Idempotent. Returns their uid. */
export async function grantEntitlement(input: {
  uid?: string;
  email?: string;
  plan?: PlanId;
  includedMinutes?: number | null;
  reason: string;
  expiresAt?: Date | null;
}): Promise<string> {
  const plan = input.plan ?? 'pro';
  if (!GRANTABLE.includes(plan)) throw new Error(`plan ${plan} can't be granted`);
  if (input.includedMinutes != null && !(Number.isInteger(input.includedMinutes) && input.includedMinutes > 0)) {
    throw new Error('includedMinutes must be a positive integer');
  }
  const uid = await resolveUid(input);
  await getPool().query(
    `INSERT INTO entitlement_grants (uid, plan, included_minutes, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (uid) DO UPDATE
       SET plan = EXCLUDED.plan, included_minutes = EXCLUDED.included_minutes,
           reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, granted_at = NOW()`,
    [uid, plan, input.includedMinutes ?? null, input.reason, input.expiresAt ?? null],
  );
  return uid;
}

/** Remove a user's grant. Returns their uid, and whether a grant existed. */
export async function revokeEntitlement(who: { uid?: string; email?: string }): Promise<{ uid: string; revoked: boolean }> {
  const uid = await resolveUid(who);
  const { rowCount } = await getPool().query('DELETE FROM entitlement_grants WHERE uid = $1', [uid]);
  return { uid, revoked: (rowCount ?? 0) > 0 };
}
