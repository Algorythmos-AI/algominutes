// POST /v1/push/register — register/refresh a device push token (A7.3).
//
// Validates the RegisterPushTokenRequest contract, then upserts through the
// @algominutes/db push_tokens repo, keyed on the token (a device that moves to a
// new account re-homes the token to the current uid). services/notifier reads
// these rows to fan out FCM. Device tokens only — no PII.

import { RegisterPushTokenRequest } from '@algominutes/contracts/schemas';
import { registerPushToken } from '@algominutes/db';

export async function registerPushTokenRoute(req, res) {
  const parsed = RegisterPushTokenRequest.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  const { token, platform, appVersion } = parsed.data;

  // uid comes from the verified ID token (req.uid), never from the client body.
  await registerPushToken({ token, uid: req.uid, platform, appVersion: appVersion ?? null });
  req.log.info({ platform }, 'push_token_registered');
  return res.json({ ok: true });
}
