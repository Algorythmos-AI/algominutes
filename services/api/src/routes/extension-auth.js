// Signing the browser extension in (docs/plans/RELEASE.md PR 34,
// docs/decisions/0002-chrome-extension.md §3). The extension never asks for a
// password or runs its own OAuth:
//   1. POST /v1/auth/extension-link (signed in, from the web app): a one-time
//      code bound to the user, the extension's id and the SHA-256 of a verifier
//      only the extension holds.
//   2. POST /v1/auth/extension-token (public, from the extension): the code and
//      the verifier, for a Firebase custom token as the same user.
//
// Which extensions may sign in: the chrome-extension:// origins in
// ALLOWED_ORIGINS, the allowlist CORS already uses (Apply C adds Chrome's and
// Edge's), so an extension may sign in exactly when it may call the api. With
// none, both routes answer 503 feature_disabled.
//
// No code, verifier or token is ever logged.

import { getAuth } from 'firebase-admin/auth';
import { createExtensionLink, redeemExtensionLink, isAccountDeleted } from '@algominutes/db';
import { ExtensionLinkRequest, ExtensionTokenRequest } from '@algominutes/contracts/schemas';
import { buildAllowedOriginSet } from '../middleware/cors.js';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

export function allowedExtensionIds(env = process.env) {
  const ids = new Set();
  for (const origin of buildAllowedOriginSet(env)) {
    const m = EXTENSION_ORIGIN.exec(origin);
    if (m) ids.add(m[1]);
  }
  return ids;
}

export async function extensionLinkRoute(req, res) {
  const log = req.log;
  res.set('Cache-Control', 'no-store');
  const allowed = allowedExtensionIds();
  if (allowed.size === 0) {
    log.warn({ reason: 'feature_disabled' }, 'extension_link_refused');
    return res.status(503).json({ error: 'feature_disabled' });
  }
  const parsed = ExtensionLinkRequest.safeParse(req.body ?? {});
  if (!parsed.success) {
    log.warn({ reason: 'invalid' }, 'extension_link_refused');
    return res.status(400).json({ error: 'extension_link_invalid' });
  }
  const { extensionId, verifierHash } = parsed.data;
  if (!allowed.has(extensionId)) {
    log.warn({ reason: 'extension_unknown', extensionId }, 'extension_link_refused');
    return res.status(400).json({ error: 'extension_unknown' });
  }
  const { code, expiresAt } = await createExtensionLink({ uid: req.uid, extensionId, verifierHash });
  log.info({ extensionId, expiresAt: expiresAt.toISOString() }, 'extension_link_created');
  return res.json({ code, expiresAt: expiresAt.toISOString() });
}

export async function extensionTokenRoute(req, res) {
  const log = req.log;
  res.set('Cache-Control', 'no-store');
  const allowed = allowedExtensionIds();
  if (allowed.size === 0) {
    log.warn({ reason: 'feature_disabled' }, 'extension_token_refused');
    return res.status(503).json({ error: 'feature_disabled' });
  }
  const parsed = ExtensionTokenRequest.safeParse(req.body ?? {});
  if (!parsed.success) {
    log.warn({ reason: 'invalid' }, 'extension_token_refused');
    return res.status(400).json({ error: 'extension_link_invalid' });
  }
  const { code, verifier, extensionId } = parsed.data;

  // Spent first, whatever follows: a code anyone else tried is dead.
  const result = await redeemExtensionLink({ code, verifier, extensionId });
  const refuse = (reason, userId = null) => {
    log.warn({ reason, extensionId, userId }, 'extension_token_refused');
    return res.status(400).json({ error: 'extension_link_invalid' });
  };
  if (result.kind !== 'ok') return refuse(result.kind, result.uid ?? null);
  // The code is spent: if anything below throws, the error line (app.js) must still name the user.
  req.log = log.child({ uid: result.uid, userId: result.uid });
  // Taken off the allowlist since the code was made.
  if (!allowed.has(extensionId)) return refuse('extension_unknown', result.uid);
  // A browser always says who is calling, so a web page can't trade a code, even one it saw.
  const origin = req.headers?.origin;
  if (origin !== undefined && origin !== `chrome-extension://${extensionId}`) return refuse('origin', result.uid);
  // Deleted since the code was made: signing in with a custom token would re-create the Firebase user.
  if (await isAccountDeleted(result.uid)) {
    log.warn({ reason: 'account_deleted', extensionId, userId: result.uid }, 'extension_token_refused');
    return res.status(401).json({ error: 'account_deleted' });
  }

  const customToken = await getAuth().createCustomToken(result.uid);
  log.info({ extensionId, userId: result.uid }, 'extension_token_issued');
  return res.json({ customToken });
}
