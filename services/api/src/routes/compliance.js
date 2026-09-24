import crypto from 'node:crypto';
import { setRetentionDays, recordTermsAcceptance, createSupportRequest } from '@algominutes/db';
import { SetRetentionRequest, AcceptTermsRequest, SupportRequest } from '@algominutes/contracts/schemas';

// Bodies are validated with the published contract schemas (packages/contracts),
// so what the generated clients send and what the server accepts can't drift.

// A10 #5 — user-set note retention.
export async function setRetentionRoute(req, res) {
  const parsed = SetRetentionRequest.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_retention' });
  await setRetentionDays(req.uid, parsed.data.retentionDays);
  return res.status(200).json({ ok: true });
}

// A10 #3 — timestamped, versioned Terms + Privacy acceptance at signup.
export async function acceptTermsRoute(req, res) {
  const parsed = AcceptTermsRequest.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'version_required' });
  const { termsVersion, privacyVersion, appVersion, platform } = parsed.data;
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
  const parsed = SupportRequest.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_kind' });
  const { kind, message, noteId, appVersion, device, platform } = parsed.data;
  const created = await createSupportRequest({
    uid: req.uid,
    kind,
    message: message !== undefined ? message.slice(0, 4000) : null,
    noteId: noteId ?? null,
    appVersion,
    device,
    platform,
  });
  return res.status(201).json({ ok: true, id: created.id });
}
