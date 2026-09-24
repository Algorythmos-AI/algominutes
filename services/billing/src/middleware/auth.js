// Firebase ID-token verification for the AUTHED billing endpoints
// (POST /v1/purchases/verify, /v1/billing/checkout, /v1/billing/portal).
//
// Same consolidated pattern as services/api/src/middleware/auth.js: handlers
// behind this middleware receive `req.uid` and never touch the token. The
// PUBLIC webhook endpoints (/webhooks/*) are deliberately NOT behind this — a
// store/Stripe webhook has no Firebase identity; it authenticates by SIGNATURE
// instead (see src/lib/*.js), which is the whole security posture of A9.5.

import { getAuth } from 'firebase-admin/auth';
import { isAccountDeleted, isPostgresEnabled } from '@algominutes/db';

function bearer(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

export async function authMiddleware(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(token);
  } catch (err) {
    // An expired token, a forged one, client clock skew, and a Firebase JWKS
    // outage are four different incidents — log the reason rather than collapse
    // them into an indistinguishable wall of 401s.
    if (req.log && typeof req.log.warn === 'function') {
      req.log.warn({ err }, 'auth_verify_failed');
    }
    return res.status(401).json({ error: 'Invalid token' });
  }

  // A deleted account's token verifies for up to an hour after the deletion
  // (account_deletions). Refuse it here too, as the api does.
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
  req.authEmail = decoded.email || null;
  req.authName = decoded.name || null;

  if (req.log && typeof req.log.child === 'function') {
    req.log = req.log.child({ uid: decoded.uid, userId: decoded.uid });
  }
  return next();
}
