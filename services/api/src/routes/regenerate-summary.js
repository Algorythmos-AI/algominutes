// POST /v1/notes/regenerate-summary — re-run the summarizer over an existing
// transcript, optionally with a different template.
//
// Ported from functions/index.js `exports.regenerateSummary` (BUILD-PLAN §3.1).
// Does NOT touch claimSummarizerEnqueue: that column is the exactly-once gate
// for the chunked path's stt-poll replays, and clearing it would break replay
// idempotency. This uses its own conditional UPDATE, which doubles as the
// double-tap guard — a second tap cannot match because the first flipped
// status.
//
// Repointed: the local pg-pool factory → @algominutes/db pg-query.cjs `pool()`
// (the claim/probe/unclaim SQL has no repo function and stays here, but runs on
// the SHARED pool); enqueueTask → @algominutes/ai cloud-tasks.cjs; intelligence
// + summary-templates helpers → @algominutes/ai. SUMMARIZER_URL / JOBS_SA_EMAIL
// / TASKS_* Firebase params become Cloud Run env vars (same defaults).

import { getFirestore } from 'firebase-admin/firestore';

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import summaryTemplatesModule from '@algominutes/ai/summary-templates.cjs';
import cloudTasksModule from '@algominutes/ai/cloud-tasks.cjs';
import pgQueryModule from '@algominutes/ai/pg-query.cjs';

const { isValidId, enforceUsageBudget } = intelligenceModule;
const { isValidTemplateId } = summaryTemplatesModule;
const { enqueueTask } = cloudTasksModule;
const { pool, postgresEnabled } = pgQueryModule;

export async function regenerateSummaryRoute(req, res) {
  const baseLog = req.log;
  const uid = req.uid;

  const { noteId, workspaceId, template, confirmOverwrite } = req.body || {};
  if (!isValidId(noteId) || !isValidId(workspaceId)) {
    return res.status(400).json({ error: 'Missing or invalid required fields' });
  }
  if (workspaceId !== `workspace_${uid}`) {
    return res.status(403).json({ error: 'Workspace mismatch' });
  }
  if (template !== undefined && template !== null && !isValidTemplateId(String(template))) {
    return res.status(400).json({ error: 'Unknown template' });
  }

  const log = baseLog.child({ uid, userId: uid, noteId, workspaceId });
  if (!postgresEnabled()) {
    return res.status(503).json({ error: 'Regenerate is unavailable until Postgres is provisioned.' });
  }

  const summarizerUrl = process.env.SUMMARIZER_URL || '';
  const jobsSa = process.env.JOBS_SA_EMAIL || '';
  if (!summarizerUrl || !jobsSa) {
    log.error({ summarizerUrl: !!summarizerUrl, jobsSa: !!jobsSa }, 'regenerate_misconfigured');
    return res.status(503).json({ error: 'Service is being upgraded. Please try again shortly.' });
  }

  const db = getFirestore();

  // A Gemini call costs money; consume one of the caller's hourly slots.
  // Zero bytes — this re-reads a transcript that is already stored.
  try {
    await enforceUsageBudget(db, uid, 0);
  } catch (err) {
    if (err && err.code === 429) return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    throw err;
  }

  const client = await pool().connect();
  let claimed;
  try {
    // One conditional UPDATE is both the claim and the double-tap guard.
    // The 15-minute arm is stale-lock takeover, so a summarizer that dies
    // mid-run cannot strand the note in 'summarizing' forever.
    const { rows } = await client.query(
      `UPDATE notes
          SET summary_generation = summary_generation + 1,
              summary_template = COALESCE($3, summary_template),
              summary_requested_at = NOW(),
              status = 'summarizing',
              updated_at = NOW()
        WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
          AND (status IN ('ready', 'error')
               OR (status = 'summarizing'
                   AND summary_requested_at < NOW() - INTERVAL '15 minutes'))
          AND ($4::boolean IS TRUE OR summary_manually_edited_at IS NULL)
        RETURNING summary_generation, summary_template, summary_manually_edited_at`,
      [noteId, workspaceId, template ? String(template) : null, confirmOverwrite === true],
    );
    claimed = rows[0];
  } finally {
    client.release();
  }

  if (!claimed) {
    // Distinguish the two reasons the claim failed, so the client can offer
    // the right next step rather than a generic error.
    const probe = await pool().query(
      `SELECT status, summary_manually_edited_at FROM notes
        WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [noteId, workspaceId],
    );
    const row = probe.rows[0];
    if (!row) {
      log.info({}, 'regenerate_summary_not_found');
      return res.status(404).json({ error: 'Note not found' });
    }
    if (row.summary_manually_edited_at && confirmOverwrite !== true) {
      log.info({ editedAt: row.summary_manually_edited_at }, 'regenerate_summary_manual_edits');
      return res.status(409).json({
        error: 'manual_edits_present',
        editedAt: row.summary_manually_edited_at,
      });
    }
    log.info({ status: row.status }, 'regenerate_summary_conflict');
    return res.status(409).json({ error: 'already_regenerating', status: row.status });
  }

  // Enqueue AFTER the claim commits — Cloud Tasks is not transactional, and
  // a task that arrives before the row is updated would read a stale
  // generation and decline to write.
  try {
    await enqueueTask({
      projectId: process.env.TASKS_PROJECT || '',
      location: process.env.TASKS_LOCATION || 'us-central1',
      queue: process.env.SUMMARIZE_QUEUE || process.env.TASKS_QUEUE || 'summarize',
      targetUrl: summarizerUrl,
      oidcServiceAccount: jobsSa,
      payload: {
        noteId,
        workspaceId,
        summaryGeneration: claimed.summary_generation,
        template: claimed.summary_template,
      },
      log,
    });
  } catch (err) {
    log.error({ err }, 'regenerate_summary_enqueue_failed');
    // Hand the note back rather than leaving it stuck in 'summarizing'
    // waiting for a task that will never arrive.
    await pool().query(
      `UPDATE notes SET status = 'ready', updated_at = NOW() WHERE id = $1 AND status = 'summarizing'`,
      [noteId],
    ).catch((rbErr) => log.error({ err: rbErr }, 'regenerate_summary_unclaim_failed'));
    return res.status(500).json({ error: "Couldn't queue the summary. Please try again." });
  }

  await db.doc(`workspaces/${workspaceId}/notes/${noteId}`)
    .set({ status: 'summarizing', updatedAt: new Date().toISOString() }, { merge: true })
    .catch((err) => log.error({ err }, 'firestore_write_failed:regenerate'));

  log.info(
    { generation: claimed.summary_generation, template: claimed.summary_template },
    'regenerate_summary_requested',
  );
  return res.status(200).json({
    ok: true, noteId, status: 'summarizing',
    generation: claimed.summary_generation, template: claimed.summary_template,
  });
}
