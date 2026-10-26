import crypto from 'node:crypto';
import { setRetentionDays, getRetentionDays, recordTermsAcceptance, createSupportRequest, trackEvent } from '@algominutes/db';
import { SetRetentionRequest, AcceptTermsRequest, SupportRequest } from '@algominutes/contracts/schemas';

// Bodies are validated with the published contract schemas (packages/contracts),
// so what the generated clients send and what the server accepts can't drift.

// Server-observed analytics (ServerAnalyticsEvent): recorded after the action
// succeeded, and never allowed to fail it.
function recordEvent(req, event, props) {
  return trackEvent({ uid: req.uid, event, props })
    .catch((err) => req.log.warn({ err, event }, 'analytics_write_failed'));
}

/** A note id's shape (as the note routes' contracts require). */
const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// A10 #5 — user-set note retention.
export async function setRetentionRoute(req, res) {
  const parsed = SetRetentionRequest.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_retention' });
  await setRetentionDays(req.uid, parsed.data.retentionDays);
  await recordEvent(req, 'retention_set', { days: parsed.data.retentionDays ?? 'keep' });
  return res.status(200).json({ ok: true });
}

// The account's retention, so every device shows the choice made on any of them (RELEASE.md PR 12b).
// Only the caller's own row: the uid comes from the verified token.
export async function getRetentionRoute(req, res) {
  const retentionDays = await getRetentionDays(req.uid);
  return res.status(200).json({ retentionDays });
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
  await recordEvent(req, 'terms_accepted', { termsVersion, privacyVersion, ...(platform ? { platform } : {}) });
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
  await recordEvent(req, 'support_requested', { kind, ...(platform ? { platform } : {}) });
  // The alert that tells the owner someone asked for help (alerting.tf, RELEASE.md PR 15b). The id finds the
  // request; the message stays in Postgres, never in a log line. The note id is the client's, unchecked by the
  // contract: logged only when it has an id's shape, so no free text rides in with it.
  const loggedNoteId = typeof noteId === 'string' && NOTE_ID.test(noteId) ? noteId : null;
  req.log.info({ supportId: created.id, kind, platform: platform ?? null, noteId: loggedNoteId }, 'support_request_created');
  return res.status(201).json({ ok: true, id: created.id });
}
