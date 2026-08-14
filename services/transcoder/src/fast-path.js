'use strict';

// Short-clip fast path: skip STT, hand the audio to Gemini, write the
// result through Postgres + Firestore mirror. Mirrors what the
// pre-Phase-3 processIntelligence Function did, but inside the Cloud
// Run service so the kickoff Function can stay thin.

const fs = require('node:fs');

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}

const intelligence = loadShared('intelligence.cjs');
const redaction = loadShared('redaction.cjs');
const geminiCall = loadShared('gemini-call.cjs');
const embeddings = loadShared('embeddings.cjs');

async function run({ noteId, workspaceId, type, mimeType, inputLocal, durationSec, log, deps }) {
  const { db, mirror, tasks, env } = deps;

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const buf = fs.readFileSync(inputLocal);
  const resolvedMime = intelligence.resolveGeminiAudioMime(mimeType, inputLocal);
  const parts = [
    { inlineData: { mimeType: resolvedMime, data: buf.toString('base64') } },
    { text: intelligence.buildPromptText(type) },
  ];

  // Bug 14 surface: short clips ask Gemini for transcript + summary in one
  // call. Without responseSchema + maxOutputTokens=16384, chatty content
  // truncates mid-JSON and parseGeminiJson throws. PR-C closure.
  const { rawText, model, error } = await geminiCall.callGeminiWithLadder({
    apiKey, parts, deadlineMs: intelligence.RETRY_DEADLINE_MS, log,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: intelligence.FAST_PATH_RESPONSE_SCHEMA,
      maxOutputTokens: 16384,
    },
  });
  if (!rawText) throw error || new Error('gemini_failed_no_text');

  // Use salvage parser: if Gemini still truncates despite the schema
  // (rare with maxOutputTokens=16384), recover whatever objects were
  // fully written rather than throwing the entire response away.
  const { result: parsed, partial } = intelligence.salvageGeminiJson(rawText);
  if (partial) log.warn({ noteId, model }, 'fast_path_partial_output_salvaged');
  const { lines: redacted, counts } = redaction.redactTranscriptLines(parsed.transcript || []);
  if (Object.keys(counts || {}).length) log.info({ noteId, redactionCounts: counts }, 'transcript_redacted');

  // The fast path sends raw AUDIO to Gemini, so spoken PII can surface in the
  // summary output — scrub gist/action items/key decisions before persist +
  // mirror, not just the transcript.
  const outRedaction = redaction.redactSummaryOutput({
    gist: parsed.gist, actionItems: parsed.actionItems, keyDecisions: parsed.keyDecisions,
  });
  if (Object.keys(outRedaction.counts).length) {
    log.info({ noteId, workspaceId, redactionCounts: outRedaction.counts }, 'summary_output_redacted');
  }
  parsed.gist = outRedaction.summary.gist;
  parsed.actionItems = outRedaction.summary.actionItems;
  parsed.keyDecisions = outRedaction.summary.keyDecisions;

  // Persist to Postgres.
  const client = await db.pool().connect();
  try {
    await client.query('BEGIN');
    await db.upsertNoteStatus(client, { noteId, status: 'ready' });
    await db.deleteTranscriptLinesForNote(client, noteId);
    for (let i = 0; i < redacted.length; i++) {
      const l = redacted[i];
      const startMs = intelligence.MODEL_LADDER && embeddings.timeStrToMs(l.time);
      await client.query(
        `INSERT INTO transcript_lines (note_id, speaker_tag, start_ms, end_ms, text, confidence)
           VALUES ($1, NULL, $2, $2, $3, NULL)`,
        [noteId, startMs || 0, `${l.speaker || 'Speaker'}: ${l.text || ''}`],
      );
    }
    await client.query(
      `INSERT INTO summaries (note_id, gist, long_summary, topics, model)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (note_id) DO UPDATE
         SET gist = EXCLUDED.gist, long_summary = EXCLUDED.long_summary,
             topics = EXCLUDED.topics, model = EXCLUDED.model,
             generated_at = NOW()`,
      [noteId, parsed.gist || '', null, JSON.stringify(parsed.actionItems || []), model || null],
    );
    await client.query('DELETE FROM action_items WHERE note_id = $1', [noteId]);
    for (const item of parsed.actionItems || []) {
      await client.query(`INSERT INTO action_items (note_id, text) VALUES ($1, $2)`, [noteId, item]);
    }
    await client.query('DELETE FROM key_decisions WHERE note_id = $1', [noteId]);
    for (const dec of parsed.keyDecisions || []) {
      await client.query(`INSERT INTO key_decisions (note_id, text) VALUES ($1, $2)`, [noteId, dec]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch((rollbackErr) => log.error({ rollbackErr, noteId }, 'fast_path_rollback_failed'));
    throw err;
  } finally {
    client.release();
  }

  await mirror.mirrorReady({
    workspaceId,
    noteId,
    summary: {
      gist: parsed.gist || '',
      actionItems: parsed.actionItems || [],
      keyDecisions: parsed.keyDecisions || [],
    },
    transcriptPreview: redacted,
  });

  // Best-effort embedder enqueue (claim is exactly-once).
  const c2 = await db.pool().connect();
  let claimed = false;
  try {
    claimed = await db.claimEmbedderEnqueue(c2, noteId);
  } finally { c2.release(); }
  if (claimed) {
    await tasks.enqueueEmbedder({ noteId, workspaceId });
  }
}

module.exports = { run };
