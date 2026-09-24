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
// Note writes (claim / probe / release / mirror) go through @algominutes/db
// notes-repo; enqueueTask → @algominutes/ai cloud-tasks.cjs; intelligence
// + summary-templates helpers → @algominutes/ai. SUMMARIZER_URL / JOBS_SA_EMAIL
// / TASKS_* Firebase params become Cloud Run env vars (same defaults).

import { getFirestore } from 'firebase-admin/firestore';

import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import summaryTemplatesModule from '@algominutes/ai/summary-templates.cjs';
import cloudTasksModule from '@algominutes/ai/cloud-tasks.cjs';
import pgQueryModule from '@algominutes/ai/pg-query.cjs';
import { claimSummaryRegeneration, releaseSummaryClaim, mirrorSummarizing } from '@algominutes/db';

const { isValidId, enforceUsageBudget } = intelligenceModule;
const { isValidTemplateId } = summaryTemplatesModule;
const { enqueueTask } = cloudTasksModule;
const { postgresEnabled } = pgQueryModule;

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

  // Claim, double-tap guard and "why not" probe: all in the repo layer
  // (CLAUDE.md §1: note mutations go through @algominutes/db).
  const claim = await claimSummaryRegeneration({ noteId, workspaceId, template, confirmOverwrite });
  if (!claim.claimed) {
    if (claim.reason === 'not_found') {
      log.info({}, 'regenerate_summary_not_found');
      return res.status(404).json({ error: 'Note not found' });
    }
    if (claim.reason === 'manual_edits_present') {
      log.info({ editedAt: claim.editedAt }, 'regenerate_summary_manual_edits');
      return res.status(409).json({ error: 'manual_edits_present', editedAt: claim.editedAt });
    }
    log.info({ status: claim.status }, 'regenerate_summary_conflict');
    return res.status(409).json({ error: 'already_regenerating', status: claim.status });
  }
  const claimed = { summary_generation: claim.generation, summary_template: claim.template };

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
    await releaseSummaryClaim({ noteId, workspaceId })
      .catch((rbErr) => log.error({ err: rbErr }, 'regenerate_summary_unclaim_failed'));
    return res.status(500).json({ error: "Couldn't queue the summary. Please try again." });
  }

  await mirrorSummarizing(db, { noteId, workspaceId })
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
