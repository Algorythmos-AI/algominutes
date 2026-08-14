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

let _pool = null;
function pool() {
  if (_pool) return _pool;
  // Cloud SQL pg_hba.conf rejects unencrypted connections from the VPC
  // connector range. Same fix as services/transcoder/src/db.js:35.
  // Without this the summarizer fails every chunked-path task with
  // "pg_hba.conf rejects connection ... no encryption". Latent for the
  // current corpus (we run almost everything through fast-path) but
  // would break a long clinical case discussion (>10 min) for Slater.
  const ssl = { rejectUnauthorized: false };
  _pool = new Pool(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, ssl, max: 4, idleTimeoutMillis: 30000 }
      : {
          host: process.env.PGHOST,
          port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
          database: process.env.PGDATABASE || 'postgres',
          user: process.env.PGUSER || 'postgres',
          password: process.env.PGPASSWORD,
          ssl,
          max: 4,
          idleTimeoutMillis: 30000,
        },
  );
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
  const { log, env, sharedIntelligence, sharedTemplates, sharedRedaction, geminiCall } = deps;

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const client = await pool().connect();
  let lines = [];
  let noteRow = null;
  try {
    // Same checkout as the transcript read — the generation and template live
    // on notes and are needed before any Gemini spend.
    const noteRes = await client.query(
      `SELECT summary_generation, summary_template FROM notes WHERE id = $1`,
      [noteId],
    );
    noteRow = noteRes.rows[0] || null;

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

  const c2 = await pool().connect();
  try {
    await c2.query('BEGIN');
    await c2.query(
      `INSERT INTO summaries (note_id, gist, long_summary, topics, model)
         VALUES ($1, $2, NULL, $3, $4)
       ON CONFLICT (note_id) DO UPDATE
         SET gist = EXCLUDED.gist, topics = EXCLUDED.topics,
             model = EXCLUDED.model, generated_at = NOW()`,
      [noteId, parsed.gist || '', JSON.stringify(parsed.actionItems || []), model || null],
    );
    await c2.query('DELETE FROM action_items WHERE note_id = $1', [noteId]);
    for (const item of parsed.actionItems || []) {
      await c2.query('INSERT INTO action_items (note_id, text) VALUES ($1, $2)', [noteId, item]);
    }
    await c2.query('DELETE FROM key_decisions WHERE note_id = $1', [noteId]);
    for (const dec of parsed.keyDecisions || []) {
      await c2.query('INSERT INTO key_decisions (note_id, text) VALUES ($1, $2)', [noteId, dec]);
    }
    // Clearing summary_manually_edited_at is what keeps the regenerate
    // confirmation meaningful. The summary that existed a moment ago was
    // hand-edited; the one just written is not, so the note is no longer in
    // an edited state. Leaving the flag set makes every future rewrite
    // re-prompt about edits that no longer exist, and a warning that always
    // fires is one people learn to dismiss — which defeats the guard on the
    // one occasion it matters.
    //
    // summary_requested_at clears with it: same statement, same reasoning.
    // It is currently harmless only because the stale-lock takeover arm in
    // /api/regenerate-summary is gated on status = 'summarizing'.
    //
    // Inside the open transaction, so the flag cannot clear unless the
    // summary it refers to actually landed.
    await c2.query(
      `UPDATE notes
          SET status = 'ready',
              summary_manually_edited_at = NULL,
              summary_requested_at = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [noteId],
    );
    await c2.query('COMMIT');
  } catch (err) {
    await c2.query('ROLLBACK').catch((rollbackErr) => log.error({ rollbackErr, noteId }, 'summarizer_rollback_failed'));
    throw err;
  } finally { c2.release(); }

  // Firestore mirror.
  await firestore().doc(`workspaces/${workspaceId}/notes/${noteId}`).set({
    status: 'ready',
    updatedAt: new Date().toISOString(),
    summary: {
      gist: parsed.gist || '',
      actionItems: parsed.actionItems || [],
      keyDecisions: parsed.keyDecisions || [],
    },
    transcript: redacted.slice(0, 200),
    transcriptTruncated: redacted.length > 200,
  }, { merge: true });

  log.info({ noteId, model, lines: lines.length }, 'summarizer_complete');
}

module.exports = { handle, markNoteFailed };
