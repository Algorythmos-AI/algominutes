import crypto from 'node:crypto';
import { setRetentionDays, recordTermsAcceptance, createSupportRequest } from '@algominutes/db';

// A10 #5 — user-set note retention.
export async function setRetentionRoute(req, res) {
  const { retentionDays } = req.body || {};
  if (retentionDays !== null && retentionDays !== undefined && (!Number.isInteger(retentionDays) || retentionDays <= 0)) {
    return res.status(400).json({ error: 'invalid_retention' });
  }
  await setRetentionDays(req.uid, retentionDays ?? null);
  return res.status(200).json({ ok: true });
}

// A10 #3 — timestamped, versioned Terms + Privacy acceptance at signup.
export async function acceptTermsRoute(req, res) {
  const { termsVersion, privacyVersion, appVersion, platform } = req.body || {};
  if (!termsVersion || !privacyVersion) return res.status(400).json({ error: 'version_required' });
  const ipHash = req.ip
    ? crypto.createHash('sha256').update(String(req.ip)).digest('hex').slice(0, 32)
    : null;
  await recordTermsAcceptance({ uid: req.uid, termsVersion, privacyVersion, ipHash, appVersion, platform });
  return res.status(200).json({ ok: true });
}

// A10 #4 — in-app support / bad-transcript report. DIAGNOSTIC CONTEXT ONLY:
// app version, device, note id, and the user's message. We NEVER accept or store
// audio or transcript/summary content (no such field is read).
export async function supportRoute(req, res) {
  const { kind, message, noteId, appVersion, device, platform } = req.body || {};
  if (!['contact', 'bad_transcript', 'bad_summary'].includes(kind)) {
    return res.status(400).json({ error: 'invalid_kind' });
  }
  const created = await createSupportRequest({
    uid: req.uid,
    kind,
    message: typeof message === 'string' ? message.slice(0, 4000) : null,
    noteId: typeof noteId === 'string' ? noteId : null,
    appVersion,
    device,
    platform,
  });
  return res.status(201).json({ ok: true, id: created.id });
}
