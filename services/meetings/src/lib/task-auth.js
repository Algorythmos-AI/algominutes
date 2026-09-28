// /tasks/* is called only by Cloud Tasks, as run-jobs, with an OIDC token.
//
// services/meetings is public (Recall's webhooks must reach it), and public
// services run with Cloud Run's invoker check off (cloud-run.tf
// invoker_iam_disabled). So the app checks the token itself: Google-signed, for
// exactly this URL (enqueueTask sets the audience to the task's target URL),
// issued to the jobs service account, with a verified email.
import { OAuth2Client } from 'google-auth-library';

export function createTaskAuth({ baseUrl, serviceAccountEmail, client = new OAuth2Client() }) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return async function taskAuth(req, res, next) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!base || !serviceAccountEmail) {
      req.log.error({ baseUrl: !!base, serviceAccountEmail: !!serviceAccountEmail }, 'task_auth_misconfigured');
      return res.status(503).json({ error: 'Not configured' });
    }
    if (!m) {
      req.log.warn({}, 'task_auth_missing_token');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const audience = `${base}${req.originalUrl.split('?')[0]}`;
    try {
      const ticket = await client.verifyIdToken({ idToken: m[1], audience });
      const p = ticket.getPayload() || {};
      if (p.email !== serviceAccountEmail || p.email_verified !== true) {
        req.log.warn({ email: p.email || null }, 'task_auth_wrong_identity');
        return res.status(403).json({ error: 'Forbidden' });
      }
      return next();
    } catch (err) {
      req.log.warn({ err, audience }, 'task_auth_invalid_token');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
}
