'use strict';

// /tasks/* on a public service (meetings, billing) is called only by Cloud Tasks or Cloud Scheduler, as
// run-jobs, with an OIDC token.
//
// Public services run with Cloud Run's invoker check off (cloud-run.tf invoker_iam_disabled), because
// webhooks must reach them. So the app checks the token itself: Google-signed, for exactly this URL
// (enqueueTask and each scheduler job set the audience to the target URL), issued to the jobs service
// account, with a verified email.

// Why a token was refused, as a fixed label: google-auth-library's messages quote the token or its decoded
// claims ("Invalid token signature: <jwt>"), and anyone can send any header to a public /tasks URL.
const REASONS = [
  [/^Wrong number of segments|^Can't parse token envelope|^No pem found/, 'malformed'],
  [/^Invalid token signature/, 'bad_signature'],
  [/^Token used too (early|late)|^Expiration time too far|^No expiration time|^No issue time/, 'expired'],
  [/^Wrong recipient/, 'wrong_audience'],
  [/^Invalid issuer/, 'wrong_issuer'],
];
function refusalReason(err) {
  const message = String(err?.message || '');
  const hit = REASONS.find(([re]) => re.test(message));
  return hit ? hit[1] : 'other';
}

// A service account's email names a workload and helps find a misconfigured caller; anything else could be a
// person's, which isn't logged.
const loggableEmail = (email) => (/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(String(email || '')) ? email : null);

function createTaskAuth({ baseUrl, serviceAccountEmail, client }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let verifier = client;
  return async function taskAuth(req, res, next) {
    // Parsed without a regex over the header (no backtracking on crafted input).
    const header = String(req.headers.authorization || '');
    const token = header.slice(0, 7).toLowerCase() === 'bearer ' ? header.slice(7).trim() : '';
    if (!base || !serviceAccountEmail) {
      req.log.error({ baseUrl: !!base, serviceAccountEmail: !!serviceAccountEmail }, 'task_auth_misconfigured');
      return res.status(503).json({ error: 'Not configured' });
    }
    if (!token) {
      req.log.warn({}, 'task_auth_missing_token');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const audience = `${base}${req.originalUrl.split('?')[0]}`;
    try {
      if (!verifier) {
        const { OAuth2Client } = require('google-auth-library');
        verifier = new OAuth2Client();
      }
      const ticket = await verifier.verifyIdToken({ idToken: token, audience });
      const p = ticket.getPayload() || {};
      if (p.email !== serviceAccountEmail || p.email_verified !== true) {
        req.log.warn({ email: loggableEmail(p.email), emailVerified: p.email_verified === true }, 'task_auth_wrong_identity');
        return res.status(403).json({ error: 'Forbidden' });
      }
      return next();
    } catch (err) {
      // Never `err` itself: its message can quote the token (REASONS).
      req.log.warn({ reason: refusalReason(err), audience }, 'task_auth_invalid_token');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

module.exports = { createTaskAuth, refusalReason };
