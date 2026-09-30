'use strict';
// Whether a verified Firebase ID token's session is still good (RELEASE.md PR 40, S3-PR11). The auth
// middlewares (services/api, services/billing) verify a token's signature and expiry, which is what
// verifyIdToken does; a token then stays valid for up to an hour even after its account is disabled (abuse)
// or its sessions are revoked (revokeRefreshTokens). This asks Firebase Auth about the user, as
// verifyIdToken(token, true) would, but remembers the answer per user for a minute, so it's one lookup a
// minute per active user rather than one per request: a disabled or revoked account is refused within a
// minute everywhere.
//
// Firebase's own rule: a token is revoked when it was issued (auth_time) before the user's
// tokensValidAfterTime. A deleted Firebase user (auth/user-not-found) counts as revoked.

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX = 10_000;

/**
 * @param {{ getUser: (uid: string) => Promise<{ disabled?: boolean, tokensValidAfterTime?: string }>,
 *           ttlMs?: number, max?: number, now?: () => number }} opts
 * @returns {(decoded: { uid: string, auth_time?: number }) => Promise<'ok' | 'disabled' | 'revoked'>}
 *   Throws when Firebase Auth can't be asked: the caller decides what that means.
 */
function createSessionCheck(opts) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const max = opts.max ?? DEFAULT_MAX;
  const now = opts.now ?? Date.now;
  const cache = new Map();

  async function lookup(uid) {
    const hit = cache.get(uid);
    if (hit && now() - hit.at < ttlMs) return hit;
    let entry;
    try {
      const user = await opts.getUser(uid);
      const validAfter = user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : 0;
      entry = { at: now(), disabled: !!user.disabled, validAfterMs: Number.isFinite(validAfter) ? validAfter : 0, gone: false };
    } catch (err) {
      // silent-catch-ok: a Firebase user that no longer exists is the answer 'revoked'; any other failure is rethrown
      if (err?.code !== 'auth/user-not-found') throw err;
      entry = { at: now(), disabled: false, validAfterMs: 0, gone: true };
    }
    if (cache.size >= max) cache.clear();
    cache.set(uid, entry);
    return entry;
  }

  return async function check(decoded) {
    const e = await lookup(decoded.uid);
    if (e.gone) return 'revoked';
    if (e.disabled) return 'disabled';
    const issuedAtMs = Number(decoded.auth_time) * 1000;
    if (e.validAfterMs && (!Number.isFinite(issuedAtMs) || issuedAtMs < e.validAfterMs)) return 'revoked';
    return 'ok';
  };
}

module.exports = { createSessionCheck, DEFAULT_TTL_MS };
