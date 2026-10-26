/**
 * Beta invite codes (migration 025, docs/plans/RELEASE.md PR 2). A tester enters
 * the code from their invitation; redeeming it gives them a time-limited Pro
 * grant (entitlement_grants, 019) and, when the invite says so, the notetaker
 * (notetaker_testers, 024).
 *
 * Only a code's SHA-256 is stored. Codes are `BETA-XXXXX-XXXXX-XXXXX` in
 * Crockford base32 (75 random bits, scripts/new-invite-code.sh), so the hash
 * can't be reversed by guessing. Nothing here logs a code.
 */
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { monthlyIncludedMinutes } from '@algominutes/contracts';
import { getPool, isPostgresEnabled, withTx } from './db.js';
import { ensureUser } from './workspace-access.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Crockford base32: no I, L, O or U.
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{15}$/;

/**
 * The canonical form of what a tester typed or pasted, or null if it can't be a
 * code. Case, spaces and any kind of dash are ignored, and the letters people
 * confuse with digits are read as those digits (O → 0, I and L → 1).
 */
export function normaliseInviteCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const compact = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!compact.startsWith('BETA')) return null;
  const body = compact.slice(4).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!CROCKFORD.test(body)) return null;
  return `BETA-${body.slice(0, 5)}-${body.slice(5, 10)}-${body.slice(10)}`;
}

export function hashInviteCode(normalised: string): string {
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

export class InviteCodeError extends Error {
  constructor(
    readonly code: 'INVITE_CODE_INVALID' | 'INVITE_CODE_EXISTS' | 'INVITE_NOT_FOUND',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'InviteCodeError';
  }
}

export interface BetaInvite {
  id: string;
  label: string;
  includedMinutes: number | null;
  grantDays: number;
  maxRedemptions: number;
  redemptions: number;
  notetaker: boolean;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const toInvite = (r: any): BetaInvite => ({
  id: r.id,
  label: r.label,
  includedMinutes: r.included_minutes,
  grantDays: r.grant_days,
  maxRedemptions: r.max_redemptions,
  redemptions: r.redemptions,
  notetaker: r.notetaker,
  expiresAt: r.expires_at ? new Date(r.expires_at) : null,
  revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
  createdAt: new Date(r.created_at),
});

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Store a new invite from its code's hash (hashInviteCode of the canonical
 * code). The plaintext never reaches the server: scripts/new-invite-code.sh
 * prints both, and only the hash is passed to the db-job.
 */
export async function createInvite(input: {
  codeHash: string;
  label: string;
  includedMinutes?: number | null;
  grantDays: number;
  maxRedemptions: number;
  notetaker?: boolean;
  expiresAt?: Date | null;
}): Promise<BetaInvite> {
  if (!SHA256_HEX.test(input.codeHash)) {
    throw new InviteCodeError('INVITE_CODE_INVALID', "codeHash must be the code's SHA-256, 64 lowercase hex digits");
  }
  if (!input.label.trim()) throw new Error('an invite needs a label');
  try {
    const { rows } = await getPool().query(
      `INSERT INTO beta_invites (code_hash, label, included_minutes, grant_days, max_redemptions, notetaker, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.codeHash, input.label.trim(), input.includedMinutes ?? null, input.grantDays,
        input.maxRedemptions, input.notetaker === true, input.expiresAt ?? null,
      ],
    );
    return toInvite(rows[0]);
  } catch (err: any) {
    if (err?.code === '23505') throw new InviteCodeError('INVITE_CODE_EXISTS', 'that code is already an invite', { cause: err });
    throw err;
  }
}

/** Stop a code working. Redemptions already made keep their grants. */
export async function revokeInvite(who: { id?: string; codeHash?: string }): Promise<{ id: string; revoked: boolean }> {
  let where: string;
  let param: string;
  if (who.id) {
    where = 'id = $1';
    param = who.id;
  } else {
    if (!who.codeHash || !SHA256_HEX.test(who.codeHash)) {
      throw new InviteCodeError('INVITE_CODE_INVALID', "codeHash must be the code's SHA-256, 64 lowercase hex digits");
    }
    where = 'code_hash = $1';
    param = who.codeHash;
  }
  const { rows } = await getPool().query(
    `UPDATE beta_invites SET revoked_at = NOW() WHERE ${where} AND revoked_at IS NULL RETURNING id`,
    [param],
  );
  if (rows[0]) return { id: rows[0].id, revoked: true };
  const existing = await getPool().query(`SELECT id FROM beta_invites WHERE ${where}`, [param]);
  if (!existing.rows[0]) throw new InviteCodeError('INVITE_NOT_FOUND', 'no such invite');
  return { id: existing.rows[0].id, revoked: false }; // already revoked
}

export async function listInvites(): Promise<BetaInvite[]> {
  const { rows } = await getPool().query('SELECT * FROM beta_invites ORDER BY created_at DESC');
  return rows.map(toInvite);
}

export type RedeemResult =
  | { kind: 'redeemed'; inviteId: string; replay: boolean; grantEndsAt: Date | null; notetaker: boolean }
  | { kind: 'invalid' }
  | { kind: 'expired'; inviteId: string }
  | { kind: 'used_up'; inviteId: string };

// The minutes a grant gives: NULL means Pro's monthly minutes.
const effectiveMinutes = (m: number | null) => m ?? monthlyIncludedMinutes('pro') ?? 0;
// When a grant ends, as a number: NULL (until revoked) is later than any date.
const endOf = (d: Date | null) => (d === null ? Infinity : d.getTime());

/**
 * Give the invite's grant, never taking anything from a live one. The invite
 * replaces a live grant only when it's at least as good on both counts (ends no
 * sooner, and has no fewer minutes); otherwise the live grant stays exactly as
 * it is. Two grants are never mixed into one that's bigger than either. Returns
 * when the user's grant now ends (null = until revoked).
 */
async function applyGrant(
  client: PoolClient,
  uid: string,
  invite: { id: string; includedMinutes: number | null },
  inviteEndsAt: Date,
  now: Date,
): Promise<Date | null> {
  const reason = `invite:${invite.id}`;
  const { rows } = await client.query(
    `SELECT included_minutes, expires_at FROM entitlement_grants WHERE uid = $1 FOR UPDATE`,
    [uid],
  );
  const current = rows[0] as { included_minutes: number | null; expires_at: Date | null } | undefined;
  const currentEnd = current?.expires_at == null ? null : new Date(current.expires_at);
  const live = !!current && (currentEnd === null || currentEnd > now);

  if (live) {
    const inviteIsAsGood = endOf(inviteEndsAt) >= endOf(currentEnd)
      && effectiveMinutes(invite.includedMinutes) >= effectiveMinutes(current!.included_minutes);
    if (!inviteIsAsGood) return currentEnd;
    await client.query(
      `UPDATE entitlement_grants SET included_minutes = $2, expires_at = $3, reason = $4, granted_at = NOW() WHERE uid = $1`,
      [uid, invite.includedMinutes, inviteEndsAt, reason],
    );
    return inviteEndsAt;
  }

  // No live grant. The conflict branch replaces only a grant that has ended: if
  // the owner's grant-tester committed a live one meanwhile (it doesn't take the
  // users row lock), it's left alone, and it's what the user has.
  const written = await client.query(
    `INSERT INTO entitlement_grants (uid, plan, included_minutes, reason, expires_at)
       VALUES ($1, 'pro', $2, $3, $4)
     ON CONFLICT (uid) DO UPDATE
       SET plan = 'pro', included_minutes = EXCLUDED.included_minutes, reason = EXCLUDED.reason,
           expires_at = EXCLUDED.expires_at, granted_at = NOW()
       WHERE entitlement_grants.expires_at IS NOT NULL AND entitlement_grants.expires_at <= $5`,
    [uid, invite.includedMinutes, reason, inviteEndsAt, now],
  );
  if (written.rowCount) return inviteEndsAt;
  const raced = await client.query(`SELECT expires_at FROM entitlement_grants WHERE uid = $1`, [uid]);
  return raced.rows[0]?.expires_at == null ? null : new Date(raced.rows[0].expires_at);
}

/**
 * Redeem a code for one user, in one transaction. The invite row is locked, so
 * its last use can't be taken twice. The same user redeeming again is a replay:
 * the same answer, no second use, no change.
 */
export async function redeemInvite(input: {
  uid: string;
  code: unknown;
  /** The caller's claims: the user row is created from them if this is their first write. */
  user?: { email?: string | null; name?: string | null };
  now?: Date;
  log?: { error: (o: any, m?: string) => void };
}): Promise<RedeemResult> {
  const normalised = normaliseInviteCode(input.code);
  if (!normalised || !isPostgresEnabled()) return { kind: 'invalid' };
  const now = input.now ?? new Date();
  return withTx(async (client) => {
    // A new guest's first write can be this; ensureUser also refuses a deleted account.
    await ensureUser(client, { uid: input.uid, email: input.user?.email, name: input.user?.name });
    const { rows } = await client.query(`SELECT * FROM beta_invites WHERE code_hash = $1 FOR UPDATE`, [
      hashInviteCode(normalised),
    ]);
    if (!rows[0]) return { kind: 'invalid' } as const;
    const invite = toInvite(rows[0]);

    const prior = await client.query(
      `SELECT 1 FROM beta_invite_redemptions WHERE invite_id = $1 AND uid = $2`,
      [invite.id, input.uid],
    );
    if (prior.rowCount) {
      // A replay answers with what the user has now: the live grant, and the
      // notetaker only while it's allowed. Once the grant has ended (or the owner
      // revoked it), the code is spent for this user.
      const grant = await client.query(
        `SELECT expires_at FROM entitlement_grants WHERE uid = $1 AND (expires_at IS NULL OR expires_at > $2)`,
        [input.uid, now],
      );
      if (!grant.rows[0]) return { kind: 'used_up', inviteId: invite.id } as const;
      const notetaker = await client.query(
        `SELECT 1 FROM notetaker_testers WHERE uid = $1 AND (expires_at IS NULL OR expires_at > $2)`,
        [input.uid, now],
      );
      const end = grant.rows[0].expires_at ? new Date(grant.rows[0].expires_at) : null;
      return { kind: 'redeemed', inviteId: invite.id, replay: true, grantEndsAt: end, notetaker: (notetaker.rowCount ?? 0) > 0 } as const;
    }
    // A revoked code reads as unknown: it tells a guesser nothing.
    if (invite.revokedAt) return { kind: 'invalid' } as const;
    if (invite.expiresAt && invite.expiresAt <= now) return { kind: 'expired', inviteId: invite.id } as const;
    if (invite.redemptions >= invite.maxRedemptions) return { kind: 'used_up', inviteId: invite.id } as const;

    await client.query(`INSERT INTO beta_invite_redemptions (invite_id, uid, redeemed_at) VALUES ($1, $2, $3)`, [
      invite.id, input.uid, now,
    ]);
    await client.query(`UPDATE beta_invites SET redemptions = redemptions + 1 WHERE id = $1`, [invite.id]);
    const inviteEndsAt = new Date(now.getTime() + invite.grantDays * DAY_MS);
    const grantEndsAt = await applyGrant(client, input.uid, invite, inviteEndsAt, now);
    if (invite.notetaker) {
      // The notetaker follows the invite's own window, never a longer manual grant's.
      await client.query(
        `INSERT INTO notetaker_testers (uid, reason, expires_at) VALUES ($1, $2, $3)
         ON CONFLICT (uid) DO UPDATE SET
           expires_at = CASE
             WHEN notetaker_testers.expires_at IS NULL THEN NULL
             ELSE GREATEST(notetaker_testers.expires_at, EXCLUDED.expires_at)
           END`,
        [input.uid, `invite:${invite.id}`, inviteEndsAt],
      );
    }
    return { kind: 'redeemed', inviteId: invite.id, replay: false, grantEndsAt, notetaker: invite.notetaker } as const;
  }, { log: input.log, fields: { userId: input.uid } });
}
