// POST /v1/notes/audio-url: a short-lived signed URL to play a note's audio.
//
// Clients never read the recordings bucket directly (it isn't a Firebase
// bucket, and a Storage-rules path would be a second access policy to keep in
// step). The api checks the caller's workspace membership in Postgres
// (notes-repo getNoteAudioPath, which also refuses a storage_path that isn't
// this note's own object), then signs a V4 GET for 15 minutes. Signing uses the
// service's own identity through the IAM Credentials API
// (roles/iam.serviceAccountTokenCreator on itself, Terraform).

import { getStorage } from 'firebase-admin/storage';
import { NoteAudioUrlRequest } from '@algominutes/contracts/schemas';
import { getNoteAudioPath } from '@algominutes/db';

export const AUDIO_URL_TTL_MS = 15 * 60 * 1000;

export async function noteAudioUrlRoute(req, res) {
  const parsed = NoteAudioUrlRequest.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid noteId / workspaceId' });
  const { noteId, workspaceId } = parsed.data;
  const log = req.log.child({ userId: req.uid, noteId, workspaceId });

  let storagePath;
  try {
    storagePath = await getNoteAudioPath({ noteId, workspaceId, uid: req.uid });
  } catch (err) {
    log.error({ err }, 'note_audio_lookup_failed');
    return res.status(500).json({ error: "We couldn't load this recording. Please try again." });
  }
  if (!storagePath) {
    log.warn({}, 'note_audio_not_found');
    return res.status(404).json({ error: 'Audio not found' });
  }

  const expires = Date.now() + AUDIO_URL_TTL_MS;
  let url;
  try {
    [url] = await getStorage().bucket().file(storagePath).getSignedUrl({ version: 'v4', action: 'read', expires });
  } catch (err) {
    log.error({ err, storagePath }, 'note_audio_sign_failed');
    return res.status(502).json({ error: "We couldn't load this recording. Please try again." });
  }
  // Never log the URL: it is a bearer capability until it expires.
  log.info({ storagePath }, 'note_audio_url_signed');
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ url, expiresAt: new Date(expires).toISOString() });
}
