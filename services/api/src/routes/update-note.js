// POST /v1/notes/update — persist a manual note edit to Postgres (system of
// record) + Firestore mirror.
//
// Ported from server.ts's /api/update-note route (which was the dev twin of
// the deployed updateNote Cloud Function; both go through applyNoteEdit in the
// shared repo layer). Behaviour is preserved exactly; token verification moved
// to the shared auth middleware, so this handler reads `req.uid`. Shared
// helpers are imported from the workspace packages.

import { getFirestore } from 'firebase-admin/firestore';

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import noteEditModule from '@algominutes/db/note-edit.cjs';
import { applyNoteEdit } from '@algominutes/db/notes-repo';

const { isValidId } = intelligenceModule;
const { sanitizeNoteEdit } = noteEditModule;

export async function updateNoteRoute(req, res) {
  const log = req.log;
  const uid = req.uid;

  const { noteId, workspaceId } = req.body || {};
  if (!isValidId(noteId) || !isValidId(workspaceId)) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  if (workspaceId !== `workspace_${uid}`) {
    return res.status(403).json({ error: 'Workspace mismatch' });
  }

  let edit;
  try {
    edit = sanitizeNoteEdit(req.body);
  } catch (err) {
    return res.status(400).json({ error: err?.message || 'Invalid fields' });
  }
  if (!edit.hasTitle && !edit.hasSummary) {
    return res.status(400).json({ error: 'No editable fields provided' });
  }

  const reqLog = log.child({ uid, noteId, workspaceId });
  const firestore = getFirestore();
  const noteRef = firestore.doc(`workspaces/${workspaceId}/notes/${noteId}`);
  try {
    const snap = await noteRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Note not found' });
    const note = snap.data();
    if (!note || note.authorId !== uid) return res.status(403).json({ error: 'Not your note' });
  } catch (err) {
    reqLog.error({ err }, 'update_note_authz_failed');
    return res.status(500).json({ error: 'Authorization check failed' });
  }

  try {
    const { pgWritten } = await applyNoteEdit(
      firestore,
      { noteId, workspaceId, title: edit.title, summary: edit.summary },
      reqLog,
    );
    reqLog.info({ pgWritten }, 'update_note_ok');
    return res.status(200).json({ ok: true, noteId, pgWritten });
  } catch (err) {
    reqLog.error({ err }, 'update_note_failed');
    return res.status(500).json({ error: 'Update failed' });
  }
}
