// POST /v1/notes (docs/plans/RELEASE.md PR 35, docs/decisions/0002-chrome-extension.md §2).
//
// The web and iOS write a new note's Firestore doc themselves, between their upload and their kickoff.
// The browser extension never writes Firestore, so it asks for its note here, naming the upload its
// recording went to: the note takes that session's id, workspace and storage path, so a caller can only
// make a note of its own finished upload. The doc is the one the clients write (notes-repo
// createClientNoteDoc); the extension then calls POST /v1/process, as they do.

import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import {
  createClientNoteDoc, getUploadSession, isAccountDeleted, isPostgresEnabled, WorkspaceBoundaryError,
} from '@algominutes/db';
import { CreateNoteRequest } from '@algominutes/contracts/schemas';

export async function createNoteRoute(req, res) {
  const parsed = CreateNoteRequest.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Missing or invalid required fields' });
  const { uploadId, title, type, mimeType, durationSec } = parsed.data;
  if (!isPostgresEnabled()) {
    req.log.error({}, 'create_note_unavailable');
    return res.status(503).json({ error: "Notes can't be created right now." });
  }

  // Unknown, someone else's and expired look the same, so a guess learns nothing.
  const session = await getUploadSession({ id: uploadId, uid: req.uid });
  if (!session) {
    req.log.warn({ uploadId }, 'create_note_upload_not_found');
    return res.status(404).json({ error: 'Upload not found' });
  }
  const { noteId, workspaceId, storagePath } = session;
  // On req.log, so an unexpected error's line (app.js) names the note too.
  req.log = req.log.child({ noteId, workspaceId, uploadId });
  const log = req.log;
  if (await isAccountDeleted(req.uid)) {
    log.warn({}, 'create_note_account_deleted');
    return res.status(401).json({ error: 'account_deleted' });
  }
  // A note for audio that isn't there would sit in 'processing' until its kickoff failed.
  let exists;
  try {
    [exists] = await getStorage().bucket().file(storagePath).exists();
  } catch (err) {
    log.error({ err, storagePath }, 'create_note_upload_check_failed');
    return res.status(502).json({ error: "We couldn't check your upload. Please try again." });
  }
  if (!exists) {
    log.warn({ storagePath }, 'create_note_upload_incomplete');
    return res.status(409).json({ error: 'Upload is not complete yet.' });
  }

  let outcome;
  try {
    outcome = await createClientNoteDoc(getFirestore(), {
      noteId, workspaceId, uid: req.uid, title, type, mimeType, storagePath, durationSec: durationSec ?? null,
    }, log);
  } catch (err) {
    if (err instanceof WorkspaceBoundaryError) {
      log.warn({ err }, 'create_note_boundary');
      return res.status(403).json({ error: 'Not your note' });
    }
    throw err;
  }
  if (outcome.deleted === 'account') {
    // Deleted while this request ran (checked above too, before the upload check).
    log.warn({}, 'create_note_account_deleted');
    return res.status(401).json({ error: 'account_deleted' });
  }
  if (outcome.deleted) {
    log.warn({}, 'create_note_deleted');
    return res.status(410).json({ error: 'This note was deleted.' });
  }
  log.info({ created: outcome.created, type }, 'note_created_for_client');
  return res.json({ noteId, workspaceId, storagePath, created: outcome.created });
}
