// POST /v1/notes/delete: the single deletion path for one note.
//
// Postgres first (the note's rows and, by cascade, everything derived from it,
// so search and chat stop returning it), then the Firestore mirror, both in
// notes-repo deleteNote. Then the note's audio is purged from Cloud Storage.
// The purge was recorded in the same transaction as the delete, so if it fails
// here it's retried later (storage_purges, drained by the PR-15 sweeper), never
// lost. It replaces clients deleting the Firestore doc and relying on the
// functions/ onNoteDeleted trigger, which the new pipeline never deploys.

import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { DeleteNoteRequest } from '@algominutes/contracts/schemas';
import { deleteNote, getStoragePurge, runStoragePurge } from '@algominutes/db';

export async function deleteNoteRoute(req, res) {
  const parsed = DeleteNoteRequest.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid noteId / workspaceId' });
  const { noteId, workspaceId } = parsed.data;
  const log = req.log.child({ userId: req.uid, noteId, workspaceId });

  let result;
  try {
    result = await deleteNote(getFirestore(), { noteId, workspaceId, uid: req.uid, traceId: req.traceId }, log);
  } catch (err) {
    log.error({ err }, 'delete_note_failed');
    return res.status(500).json({ error: 'Delete failed. Please try again.' });
  }
  if (!result.allowed) {
    log.warn({}, 'delete_note_not_member');
    return res.status(404).json({ error: 'Note not found' });
  }

  // The note is gone from Postgres and Firestore. Purging its audio now is
  // best-effort: runStoragePurge never throws, and a failure stays queued.
  const purge = await getStoragePurge(result.purgeId).catch((err) => {
    log.error({ err, purgeId: result.purgeId }, 'delete_note_purge_lookup_failed');
    return null;
  });
  const purged = purge ? await runStoragePurge(getStorage().bucket(), purge, log) : false;

  log.info({ deleted: result.deleted, purgeId: result.purgeId, purged }, 'delete_note_ok');
  return res.status(200).json({ ok: true, noteId, deleted: result.deleted });
}
