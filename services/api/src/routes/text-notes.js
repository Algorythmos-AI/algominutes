// POST /v1/notes/text: a text note (a scanned image, a PDF, an imported file) from the text the app extracted on
// the device (plan rev 12 R12.8, S16).
//
// Postgres first, then the Firestore doc the apps read, both in notes-repo createTextNote, so the note is inside
// retention, backups, search, chat and export like every other note. It replaces the iPhone writing the doc
// itself. The note is ready at once: there is no audio, so nothing is charged. Its embedding is enqueued after the
// write; the note was claimed for it in the same transaction, so a lost enqueue is re-driven by the sweep
// (claimLostEmbeds) rather than leaving the note out of search for good.

import { getFirestore } from 'firebase-admin/firestore';
import { TextNoteCreateRequest, TEXT_NOTE_REQUEST_MAX_UNITS } from '@algominutes/contracts/schemas';
import { createTextNote, isPostgresEnabled, WorkspaceBoundaryError } from '@algominutes/db';
import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import cloudTasksModule from '@algominutes/ai/cloud-tasks.cjs';

const { isValidId } = intelligenceModule;

// `env` and `enqueueTask` are injectable for tests; the route itself is textNoteRoute below.
export function createTextNoteRoute({ env = process.env, enqueueTask = cloudTasksModule.enqueueTask } = {}) {
  return async function textNoteRoute(req, res) {
    // Past the contract's cap is a 413, not a 400: the app says the text is too long rather than "try again".
    const text = req.body?.text;
    if (typeof text === 'string' && text.length > TEXT_NOTE_REQUEST_MAX_UNITS) {
      req.log.warn({ userId: req.uid, units: text.length }, 'text_note_too_large');
      return res.status(413).json({ error: 'That text is too long to save as one note.' });
    }
    const parsed = TextNoteCreateRequest.safeParse(req.body ?? {});
    if (!parsed.success || !isValidId(parsed.data.noteId) || !isValidId(parsed.data.workspaceId)) {
      return res.status(400).json({ error: 'Missing or invalid required fields' });
    }
    const { noteId, workspaceId, title, source } = parsed.data;
    const log = req.log.child({ userId: req.uid, noteId, workspaceId });
    // A workspace is derived from the uid, as on every authed route.
    if (workspaceId !== `workspace_${req.uid}`) {
      log.warn({}, 'text_note_workspace_mismatch');
      return res.status(403).json({ error: 'Workspace mismatch' });
    }
    if (!isPostgresEnabled()) {
      log.error({}, 'text_note_postgres_unavailable');
      return res.status(503).json({ error: 'Saving is unavailable right now. Please try again shortly.' });
    }

    let result;
    try {
      result = await createTextNote(getFirestore(), {
        uid: req.uid, email: req.authEmail, name: req.authName,
        workspaceId, noteId, text: parsed.data.text, source, title, traceId: req.traceId,
      }, log);
    } catch (err) {
      if (err?.code === 'ACCOUNT_DELETED') {
        log.warn({}, 'text_note_account_deleted');
        return res.status(401).json({ error: 'account_deleted' });
      }
      if (err?.code === 'NOTE_DELETED') {
        log.warn({}, 'text_note_note_deleted');
        return res.status(404).json({ error: 'Note not found' });
      }
      if (err?.code === 'TEXT_NOTE_CONFLICT') {
        log.warn({}, 'text_note_conflict');
        return res.status(409).json({ error: 'text_note_conflict' });
      }
      if (err instanceof WorkspaceBoundaryError || err?.code === 'WORKSPACE_BOUNDARY') {
        log.warn({ err }, 'text_note_workspace_boundary');
        return res.status(403).json({ error: 'Workspace mismatch' });
      }
      log.error({ err }, 'text_note_create_failed');
      return res.status(500).json({ error: "We couldn't save that note. Please try again." });
    }

    // A replay's embedding was enqueued by the first call (or is re-driven by the sweep).
    if (!result.replay) await enqueueEmbed({ env, enqueueTask, noteId, workspaceId, uid: req.uid, traceId: req.traceId, log });
    return res.status(200).json({ noteId, status: 'ready' });
  };
}

// Never fails the request: the note is saved, and the sweep re-drives an embed that didn't go out.
async function enqueueEmbed({ env, enqueueTask, noteId, workspaceId, uid, traceId, log }) {
  if (!env.EMBEDDER_URL || !env.JOBS_SA_EMAIL || !env.TASKS_PROJECT) {
    log.error({ embedderUrl: !!env.EMBEDDER_URL, jobsSa: !!env.JOBS_SA_EMAIL, tasksProject: !!env.TASKS_PROJECT }, 'text_note_embed_unconfigured');
    return;
  }
  try {
    await enqueueTask({
      projectId: env.TASKS_PROJECT,
      location: env.TASKS_LOCATION || 'us-central1',
      queue: env.EMBED_QUEUE || 'embed',
      targetUrl: env.EMBEDDER_URL,
      oidcServiceAccount: env.JOBS_SA_EMAIL,
      payload: { noteId, workspaceId, uid },
      traceId,
      log,
    });
  } catch (err) {
    log.error({ err }, 'text_note_embed_enqueue_failed');
  }
}

export const textNoteRoute = createTextNoteRoute();
