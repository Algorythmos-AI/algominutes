// POST /v1/notes/feedback — a transcription-quality rating, one per user per
// note.
//
// Ported from functions/index.js `exports.noteFeedback` (BUILD-PLAN §3.1).
// The free-text comment is PII-redacted before it is stored. It never reaches
// Gemini, but a human will read it and it would otherwise leak into any future
// eval corpus.
//
// Repointed: the local pg-pool factory → @algominutes/db pg-query.cjs `pool()`
// (the membership check + feedback insert run on the SHARED pool, inside one
// transaction as in the source); sanitizeFeedback / writeFeedbackWithinTx and
// redactPII → @algominutes/ai.

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import noteFeedbackModule from '@algominutes/ai/note-feedback.cjs';
import redactionModule from '@algominutes/ai/redaction.cjs';
import pgQueryModule from '@algominutes/ai/pg-query.cjs';

const { isValidId } = intelligenceModule;
const { sanitizeFeedback, writeFeedbackWithinTx } = noteFeedbackModule;
const { redactPII } = redactionModule;
const { pool, postgresEnabled } = pgQueryModule;

export async function noteFeedbackRoute(req, res) {
  const baseLog = req.log;
  const uid = req.uid;

  const { noteId, workspaceId } = req.body || {};
  if (!isValidId(noteId) || !isValidId(workspaceId)) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  if (workspaceId !== `workspace_${uid}`) {
    return res.status(403).json({ error: 'Workspace mismatch' });
  }

  let feedback;
  try {
    feedback = sanitizeFeedback(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Invalid feedback' });
  }

  const log = baseLog.child({ uid, userId: uid, noteId, workspaceId });
  if (!postgresEnabled()) {
    return res.status(503).json({ error: 'Feedback is unavailable until Postgres is provisioned.' });
  }

  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    // Membership check in the same transaction as the write, so a rating
    // cannot be attached to a note the caller cannot reach.
    const owned = await client.query(
      `SELECT n.id FROM notes n
         JOIN workspace_members wm ON wm.workspace_id = n.workspace_id
        WHERE n.id = $1 AND wm.uid = $2 AND n.workspace_id = $3
          AND n.deleted_at IS NULL`,
      [noteId, uid, workspaceId],
    );
    if (owned.rows.length === 0) {
      await client.query('ROLLBACK');
      log.info({}, 'note_feedback_not_found');
      // 404 for both "no such note" and "not yours", matching /api/note.
      return res.status(404).json({ error: 'Note not found' });
    }

    const result = await writeFeedbackWithinTx(
      client,
      { noteId, uid, rating: feedback.rating, kind: feedback.kind, comment: feedback.comment },
      redactPII,
    );
    await client.query('COMMIT');
    log.info(
      { rating: feedback.rating, kind: feedback.kind, inserted: result.inserted,
        redactionCounts: result.redactionCounts },
      'note_feedback_saved',
    );
    return res.status(200).json({ ok: true, noteId, rating: feedback.rating });
  } catch (err) {
    await client.query('ROLLBACK').catch((rbErr) =>
      log.error({ err: rbErr }, 'note_feedback_rollback_failed'));
    log.error({ err }, 'note_feedback_failed');
    return res.status(500).json({ error: 'Could not save your rating' });
  } finally {
    client.release();
  }
}
