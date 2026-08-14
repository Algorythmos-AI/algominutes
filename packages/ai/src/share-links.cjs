'use strict';

// Share links: token minting, hashing, and the SQL for mint / revoke / read.
//
// SQL lives here rather than in the Cloud Function so a dev-server twin is a
// thin wrapper if one is ever needed — the note-edit.cjs / note-feedback.cjs
// pattern.
//
// DATA + SQL ONLY. No model client, no HTTP. Copied into every function bundle
// by scripts/copy-functions-shared.cjs.
//
// Reused by:
//   - functions/index.js  exports.shareCreate / shareRevoke / sharedNote
//
// The security posture, in one place so it is not re-derived per call site:
//
//   * The raw token exists exactly once, in the mint response. Only
//     sha256(token) is stored, so a database read — a dump, a backup, a
//     compromised replica — never yields a working link.
//   * Lookup is BY HASH. The caller's token is hashed and matched; we never
//     select by anything the caller controls in plaintext.
//   * Every miss answers the same way. Expired, revoked, deleted and
//     never-existed are indistinguishable to the caller, so the endpoint
//     cannot be used to probe which note IDs are real.
//   * 256 bits of entropy. Guessing is not a threat model at that size, which
//     is what lets the link be the whole credential.

const crypto = require('crypto');

const DEFAULT_TTL_HOURS = 168; // 7 days
const MAX_TTL_HOURS = 720; // 30 days
const SCOPES = new Set(['summary', 'transcript', 'both']);

/**
 * Mint a link token.
 *
 * base64url of 32 random bytes — 256 bits. Returned to the caller once and
 * never stored; only `hashToken` output is persisted.
 */
function mintToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** sha256, hex. The only form of a token that is ever written down. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Hash an IP for the access log.
 *
 * Salted with the note id so the same visitor is correlatable *within* one
 * note — enough to recognise enumeration — but not across notes, which would
 * amount to a movement history for whoever a clinician shared a consult with.
 * Truncated because 16 bytes is ample for that and less to leak.
 */
function hashIp(ip, salt) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

/**
 * Validate a mint request. Throws Error(publicMessage) so the caller answers
 * 400; returns the normalised values.
 */
function sanitizeShareRequest(body) {
  const b = body || {};
  const scope = b.scope === undefined || b.scope === null ? 'both' : String(b.scope);
  if (!SCOPES.has(scope)) {
    throw new Error('scope must be summary, transcript, or both');
  }

  let hours = DEFAULT_TTL_HOURS;
  if (b.expiresInHours !== undefined && b.expiresInHours !== null) {
    // Type-check before coercing: Number(true) is 1, which would silently
    // mint a one-hour link instead of rejecting the request.
    if (typeof b.expiresInHours !== 'number' && typeof b.expiresInHours !== 'string') {
      throw new Error('expiresInHours must be a whole number of hours');
    }
    hours = Number(b.expiresInHours);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_TTL_HOURS) {
      throw new Error(`expiresInHours must be between 1 and ${MAX_TTL_HOURS}`);
    }
  }
  return { scope, hours };
}

/**
 * Create a share row. Returns { id, expiresAt } — the caller pairs it with the
 * raw token, which this function never sees written anywhere.
 */
async function createShareWithinTx(client, { noteId, uid, tokenHash, scope, hours }) {
  const { rows } = await client.query(
    `INSERT INTO shares (note_id, token_hash, permission, scope, expires_at, created_by_uid)
       VALUES ($1, $2, 'view', $3, NOW() + ($4 || ' hours')::interval, $5)
     RETURNING id, expires_at`,
    [noteId, tokenHash, scope, String(hours), uid],
  );
  return { id: rows[0].id, expiresAt: rows[0].expires_at };
}

/**
 * Revoke one link, scoped to its creator's workspace.
 *
 * Idempotent by design: `revoked_at IS NULL` means revoking twice touches 0
 * rows the second time, and the caller treats that as success. A revoke that
 * errors on a second click would push people toward "delete the note", which
 * is a much bigger hammer.
 */
async function revokeShareWithinTx(client, { shareId, noteId, uid }) {
  const { rowCount } = await client.query(
    `UPDATE shares SET revoked_at = NOW()
      WHERE id = $1 AND note_id = $2 AND created_by_uid = $3 AND revoked_at IS NULL`,
    [shareId, noteId, uid],
  );
  return rowCount > 0;
}

/**
 * Resolve a token to a live grant.
 *
 * Returns null for every failure mode — no row, expired, revoked, note gone —
 * so the caller has nothing to branch on and cannot leak which it was. The
 * reason is reported separately for the access log, never to the caller.
 */
async function findLiveShare(client, tokenHash) {
  const { rows } = await client.query(
    `SELECT s.id, s.note_id, s.scope, s.expires_at, s.revoked_at,
            n.workspace_id, n.title
       FROM shares s
       JOIN notes n ON n.id = s.note_id
      WHERE s.token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return { share: null, outcome: 'not_found' };
  if (row.revoked_at) return { share: null, outcome: 'revoked' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { share: null, outcome: 'expired' };
  return { share: row, outcome: 'ok' };
}

/** Append to the access log. Best-effort: never fail a read because of it. */
async function logShareAccess(client, { shareId, noteId, ipHash, userAgent, outcome }) {
  await client.query(
    `INSERT INTO share_access_log (share_id, note_id, ip_hash, user_agent, outcome)
       VALUES ($1, $2, $3, $4, $5)`,
    [shareId, noteId, ipHash, userAgent ? String(userAgent).slice(0, 300) : null, outcome],
  );
}

/** Bump the counters shown to the owner. Same best-effort contract. */
async function touchShareRead(client, shareId) {
  await client.query(
    `UPDATE shares SET last_read_at = NOW(), read_count = read_count + 1 WHERE id = $1`,
    [shareId],
  );
}

/**
 * Per-source rate limit for the PUBLIC read endpoint.
 *
 * enforceUsageBudget is uid-keyed and cannot protect an anonymous surface, so
 * this is a separate limiter in its own `shareRateLimits/{ipHash}` namespace
 * rather than a reuse. Keying by hashed IP means a crawled or leaked link
 * cannot become a billable loop against one note.
 *
 * Uses runTransaction + tx.set — the enforceUsageBudget idiom — because
 * scripts/check-no-direct-firestore.sh forbids `.doc(x).set(...)` outside the
 * repo layer, and a bare set would also lose the read-modify-write race that
 * makes a counter a counter.
 *
 * Throws Error with code 429 when over budget. maxInstances on the function is
 * the hard spend ceiling; this is the per-source one.
 */
async function enforceShareReadBudget(db, ipHash, { limit = 60, windowMs = 60 * 60 * 1000 } = {}) {
  if (!ipHash) return; // no address to key on: fall back to maxInstances alone
  const ref = db.doc(`shareRateLimits/${ipHash}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.exists ? snap.data() : {};
    let count = Number(data.count) || 0;
    let windowStart = Number(data.windowStart) || now;
    if (now - windowStart > windowMs) {
      count = 0;
      windowStart = now;
    }
    if (count >= limit) {
      const err = new Error('SHARE_RATE_LIMIT');
      err.code = 429;
      throw err;
    }
    tx.set(ref, { count: count + 1, windowStart, updatedAt: new Date().toISOString() }, { merge: true });
  });
}

module.exports = {
  enforceShareReadBudget,
  DEFAULT_TTL_HOURS,
  MAX_TTL_HOURS,
  SCOPES,
  mintToken,
  hashToken,
  hashIp,
  sanitizeShareRequest,
  createShareWithinTx,
  revokeShareWithinTx,
  findLiveShare,
  logShareAccess,
  touchShareRead,
};
