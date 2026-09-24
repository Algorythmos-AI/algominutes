// THE single Firebase ID-token verification path.
//
// The source verified tokens in eleven places — once per onRequest wrapper in
// functions/index.js and again in three server.ts routes — each re-deriving
// the Bearer token and calling verifyIdToken. This middleware is the one
// consolidated path (BUILD-PLAN §3.1 "one auth path"). Handlers behind it
// receive `req.uid` and never touch the token themselves.
//
// The public shared-note read is the ONE endpoint deliberately NOT behind this
// middleware — the share token IS the credential there. And delete-account
// self-authenticates using this same verifyIdToken primitive because it
// manages its own CORS/OPTIONS/method envelope (see its route wiring).

import { getAuth } from 'firebase-admin/auth';
import { isAccountDeleted, isPostgresEnabled } from '@algominutes/db';

function bearer(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

/**
 * Verifies the Firebase ID token, sets `req.uid` (+ email/name claims), and
 * enriches `req.log` with `uid`/`userId`. On failure it answers 401 with the
 * exact bodies the source used, and logs the reason — an expired token, a
 * forged one, client clock skew, and a Firebase JWKS outage are four different
 * incidents that otherwise collapse into an indistinguishable wall of 401s.
 */
export async function authMiddleware(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch (err) {
    if (req.log && typeof req.log.warn === 'function') {
      req.log.warn({ err }, 'auth_verify_failed');
    }
    return res.status(401).json({ error: 'Invalid token' });
  }

  // A deleted account's token verifies for up to an hour after the deletion.
  // Refuse it everywhere, not only on the write paths that could re-create it.
  if (isPostgresEnabled()) {
    let deleted;
    try {
      deleted = await isAccountDeleted(decoded.uid);
    } catch (err) {
      req.log?.error?.({ err, userId: decoded.uid }, 'auth_account_check_failed');
      return res.status(503).json({ error: 'Service unavailable. Please try again.' });
    }
    if (deleted) {
      req.log?.warn?.({ userId: decoded.uid }, 'auth_account_deleted');
      return res.status(401).json({ error: 'account_deleted' });
    }
  }

  req.uid = decoded.uid;
  // Identity claims retained for handlers that need them (e.g. the lazy-sync
  // path uses email/name when a brand-new user's first request arrives).
  req.authEmail = decoded.email || null;
  req.authName = decoded.name || null;

  if (req.log && typeof req.log.child === 'function') {
    req.log = req.log.child({ uid: decoded.uid, userId: decoded.uid });
  }
  return next();
}
