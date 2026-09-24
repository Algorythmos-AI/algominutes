'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { Pool } = require('pg');

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}
// The terminal-failure write started here and now lives in shared/, because the
// transcoder needed the same thing and a second copy would have drifted.
const sharedNoteTerminal = loadShared('note-terminal.cjs');
// The final write goes through the repo layer (CLAUDE.md §1): this service
// runs under tsx, so it imports @algominutes/db's TypeScript directly.
const { markSummaryReady } = require('@algominutes/db');
const terminalHooks = require('./terminal-hooks');

let _pool = null;
function pool() {
  if (_pool) return _pool;
  // Shared connection config (TLS policy + defaults): @algominutes/ai/pg-config.cjs.
  const { buildPgConfig, attachPoolErrorLogger } = loadShared('pg-config.cjs');
  _pool = attachPoolErrorLogger(new Pool(buildPgConfig({ max: 4 })), loadShared('logger.cjs').logger, { pool: 'summarizer' });
  return _pool;
}

let _firestoreReady = false;
function firestore() {
  if (!_firestoreReady) {
    if (!getApps().length) initializeApp();
    _firestoreReady = true;
  }
  return getFirestore();
}

function fmtTime(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Move a note to a terminal 'error' state in both Postgres and Firestore.
 *
 * The summarizer had no equivalent of the transcoder's mirrorError, so every
 * failure path returned 500 → Cloud Tasks retried → and then simply dropped
 * the task (the queue has no dead-letter sink, despite what the comments used
 * to claim), leaving the note at 'summarizing' indefinitely. There is no
 * server-side sweeper, and the client watchdog only runs while the app is
 * foregrounded, so a note stuck this way could stay stuck for days.
 *
 * Best-effort and never throws: it runs on the failure path, and a failure to
 * record the failure must not mask the original error.
 */
async function markNoteFailed({ noteId, workspaceId, message, log }) {
  return sharedNoteTerminal.markNoteFailed({
    pool: pool(),
    firestore: firestore(),
    noteId, workspaceId, message, log,
    event: 'summarizer_mark_failed',
  });
}

async function handle(payload, deps) {
  const { noteId, workspaceId, summaryGeneration, template } = payload || {};
  if (!noteId || !workspaceId) throw new Error('summarizer.handle: missing noteId/workspaceId');
  const { log, env, sharedIntelligence, sharedTemplates, sharedRedaction, geminiCall, traceId } = deps;

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const client = await pool().connect();
  let lines = [];
  let noteRow = null;
  try {
    // Same checkout as the transcript read — the generation and template live
    // on notes and are needed before any Gemini spend.
    // Scoped to the task's workspace (CLAUDE.md §1). A note that is gone
    // (deleted mid-pipeline) or not in this workspace is acknowledged, not
    // retried, and nothing is spent on it.
    const noteRes = await client.query(
      `SELECT summary_generation, summary_template FROM notes
        WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
      [noteId, workspaceId],
    );
    noteRow = noteRes.rows[0] || null;
    if (!noteRow) {
      log.warn({ noteId, workspaceId }, 'summarizer_note_not_found');
      return;
    }

    const { rows } = await client.query(
      `SELECT speaker_tag AS "speakerTag", speaker_name AS "speakerName",
              start_ms AS "startMs", end_ms AS "endMs", text
         FROM transcript_lines WHERE note_id = $1 ORDER BY start_ms ASC`,
      [noteId],
    );
    lines = rows;
  } finally { client.release(); }

  if (!lines.length) {
    // Returning 200 stops Cloud Tasks retry-storming a deleted note — but it
    // used to leave the note pinned at 'summarizing' forever, which is what
    // happens whenever STT returns zero words (silence, or the proto-decode
    // fallback in stt.js). A note that will never finish must say so.
    log.warn({ noteId }, 'summarizer_no_transcript_lines');
    await markNoteFailed({ noteId, workspaceId, message: 'No speech was found in this recording.', log });
    return;
  }

  // Ordering guard. A replayed Cloud Task carries the generation it was minted
  // with; if the note has moved on, an older run must not overwrite a newer
  // summary. Returning (not throwing) means the task is acknowledged rather
  // than retried forever.
  //
  // An absent field skips the check entirely, so tasks enqueued by the
  // transcoder's own pipeline — which does not send one — behave exactly as
  // before.
  if (summaryGeneration !== undefined && summaryGeneration !== null && noteRow
      && Number(noteRow.summary_generation) !== Number(summaryGeneration)) {
    log.warn(
      { noteId, taskGeneration: summaryGeneration, currentGeneration: noteRow.summary_generation },
      'summarizer_generation_stale',
    );
    return;
  }

  // Template precedence: the task payload, then whatever the note records,
  // then the default. The note fallback is what makes a replayed task without
  // a template still produce the summary the user asked for.
  const chosen = sharedTemplates.getTemplate(
    template || (noteRow && noteRow.summary_template) || sharedTemplates.DEFAULT_TEMPLATE_ID,
  );

  const redacted = lines.map((l) => {
    const { text } = sharedRedaction.redactPII(l.text || '');
    const speaker = l.speakerName || (l.speakerTag ? `Speaker ${l.speakerTag}` : 'Speaker');
    return { speaker, text, time: fmtTime(l.startMs) };
  });

  const transcriptStr = redacted.map((l) => `[${l.time}] ${l.speaker}: ${l.text}`).join('\n');

  const parts = [
    { text: chosen.promptBody },
    { text: `\n\nTranscript:\n${transcriptStr}\n` },
  ];

  // Bug 14: chatty long-form recordings blew Gemini's default
  // maxOutputTokens because the old prompt asked the model to echo the
  // transcript back. The new prompt drops the echo; responseSchema
  // pins the shape so a degraded model can't sneak through; the
  // bumped budget gives genuinely long bullet/decision lists room.
  const { rawText, model, error } = await geminiCall.callGeminiWithLadder({
    apiKey,
    parts,
    deadlineMs: sharedIntelligence.RETRY_DEADLINE_MS,
    log,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: chosen.responseSchema,
      maxOutputTokens: 16384,
    },
  });
  if (!rawText) throw error || new Error('gemini_empty');

  const parsed = sharedIntelligence.parseSummaryJson(rawText);

  // Defense-in-depth: the transcript is scrubbed before Gemini, but redact the
  // summary OUTPUT too before persist + mirror (the model can still echo PII).
  const outRedaction = sharedRedaction.redactSummaryOutput({
    gist: parsed.gist, actionItems: parsed.actionItems, keyDecisions: parsed.keyDecisions,
  });
  if (Object.keys(outRedaction.counts).length) {
    log.info({ noteId, workspaceId, redactionCounts: outRedaction.counts }, 'summary_output_redacted');
  }
  parsed.gist = outRedaction.summary.gist;
  parsed.actionItems = outRedaction.summary.actionItems;
  parsed.keyDecisions = outRedaction.summary.keyDecisions;

  // Postgres (summary rows, 'ready', manual-edit flags cleared, all in one
  // transaction), then the Firestore mirror: notes-repo markSummaryReady.
  const { written } = await markSummaryReady(firestore(), {
    noteId,
    workspaceId,
    summary: { gist: parsed.gist, actionItems: parsed.actionItems, keyDecisions: parsed.keyDecisions },
    model,
    transcriptPreview: redacted.slice(0, 200),
    transcriptTruncated: redacted.length > 200,
  }, log);
  if (!written) {
    // Deleted (or moved) while we summarized: nothing was written anywhere,
    // and there's nobody to notify.
    log.warn({ noteId, workspaceId }, 'summarizer_note_gone_before_write');
    return;
  }

  log.info({ noteId, model, lines: lines.length }, 'summarizer_complete');

  // A7.3: the summarizer is the last pipeline stage — the note is now `ready`.
  // Notify the author (best-effort; a failed notify never rolls back the summary
  // that just landed). uid is read from the note's author_uid via the same pool.
  // Idempotency: a replayed task is already gated upstream (generation/ordering
  // guard + empty-transcript check), so reaching here means this run produced
  // the ready state; a duplicate push is cheap and harmless.
  await terminalHooks.onReady({ pool: pool(), noteId, workspaceId, traceId, log });
}

module.exports = { handle, markNoteFailed, pool };
