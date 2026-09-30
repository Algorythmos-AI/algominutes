/**
 * One-time codes that sign the browser extension in (migration 035,
 * docs/plans/RELEASE.md PR 34, docs/decisions/0002-chrome-extension.md §3).
 *
 * The signed-in web app asks for a code bound to the user, the extension's id
 * and the SHA-256 of a verifier only the extension holds; the extension trades
 * the code and the verifier for a Firebase custom token. Only the code's hash is
 * stored. A code lives 60 seconds and is spent by the first attempt to trade it,
 * right or wrong. Nothing here logs a code or a verifier.
 */
import crypto from 'node:crypto';
import { getPool } from './db.js';

export const EXTENSION_LINK_TTL_MS = 60_000;

const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');
/** PKCE's S256: base64url(SHA-256(verifier)), no padding. */
export const extensionVerifierHash = (verifier: string) =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

/**
 * A new code for this user and extension: 256 random bits, base64url. The
 * user's own spent and expired codes are cleared on the way.
 */
export async function createExtensionLink(input: {
  uid: string;
  extensionId: string;
  verifierHash: string;
  now?: Date;
}): Promise<{ code: string; expiresAt: Date }> {
  const code = crypto.randomBytes(32).toString('base64url');
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + EXTENSION_LINK_TTL_MS);
  await getPool().query(
    `WITH cleared AS (
       DELETE FROM extension_links WHERE uid = $2 AND (used_at IS NOT NULL OR expires_at <= $6)
     )
     INSERT INTO extension_links (code_hash, uid, extension_id, verifier_hash, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashCode(code), input.uid, input.extensionId, input.verifierHash, expiresAt, now],
  );
  return { code, expiresAt };
}

export type ExtensionLinkRedemption =
  | { kind: 'ok'; uid: string }
  // No such code, or it was already tried: the two look the same to a caller.
  | { kind: 'unknown' }
  | { kind: 'expired'; uid: string }
  // Traded by another extension than the one it was made for, or with the wrong verifier.
  | { kind: 'mismatch'; uid: string };

/**
 * Trade a code: it's spent whatever the outcome, in the same statement that
 * reads it, so two attempts can't both succeed.
 */
export async function redeemExtensionLink(input: {
  code: string;
  verifier: string;
  extensionId: string;
  now?: Date;
}): Promise<ExtensionLinkRedemption> {
  const now = input.now ?? new Date();
  const { rows } = await getPool().query<{ uid: string; extension_id: string; verifier_hash: string; live: boolean }>(
    `UPDATE extension_links SET used_at = $2
      WHERE code_hash = $1 AND used_at IS NULL
      RETURNING uid, extension_id, verifier_hash, expires_at > $2 AS live`,
    [hashCode(input.code), now],
  );
  const row = rows[0];
  if (!row) return { kind: 'unknown' };
  if (!row.live) return { kind: 'expired', uid: row.uid };
  const sent = Buffer.from(extensionVerifierHash(input.verifier));
  const bound = Buffer.from(row.verifier_hash);
  const verifierOk = sent.length === bound.length && crypto.timingSafeEqual(sent, bound);
  if (!verifierOk || row.extension_id !== input.extensionId) return { kind: 'mismatch', uid: row.uid };
  return { kind: 'ok', uid: row.uid };
}
