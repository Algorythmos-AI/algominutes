'use strict';

// Short-clip fast path: skip STT, hand the audio to Gemini, write the
// result through Postgres + Firestore mirror. Mirrors what the
// pre-Phase-3 processIntelligence Function did, but inside the Cloud
// Run service so the kickoff Function can stay thin.

const fs = require('node:fs');
const { isNoteGone } = require('./note-gone');

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

async function run({ noteId, workspaceId, type, mimeType, inputLocal, durationSec, log, deps, recordPaidWork }) {
  const { db, mirror, tasks } = deps;

  // No API key: the ladder calls Vertex AI with the service's identity (ADC),
  // in AIPLATFORM_LOCATION. A GEMINI_API_KEY gate here used to fail every clip
  // of 10 minutes or less, since nothing sets one.

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
    parts, deadlineMs: intelligence.RETRY_DEADLINE_MS, log,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: intelligence.FAST_PATH_RESPONSE_SCHEMA,
      maxOutputTokens: 16384,
    },
  });
  if (!rawText) throw error || new Error('gemini_failed_no_text');
  // What the daily spend cap counts: an answer came back, so the clip was billed
  // (usable or not). A 429/5xx outage returns none and isn't counted; retries of
  // it would otherwise trip the cap with nothing spent (handler.js recordPaidWork).
  if (recordPaidWork) await recordPaidWork('gemini_call', durationSec, 'fast-path');
  else log.warn({ noteId, workspaceId }, 'paid_work_unmetered');

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

  // Persist to Postgres: one transaction in the repo layer (pipeline-repo.cjs).
  await db.persistFastPathResult(db.pool(), {
    noteId,
    workspaceId,
    lines: redacted.map((l) => ({
      startMs: embeddings.timeStrToMs(l.time),
      text: `${l.speaker || 'Speaker'}: ${l.text || ''}`,
    })),
    summary: { gist: parsed.gist, actionItems: parsed.actionItems, keyDecisions: parsed.keyDecisions },
    model,
  }, log);

  // Postgres now holds the result and 'ready'. A retry of this task would find
  // the note finished and acknowledge it without coming back here, so a failed
  // mirror is logged, not thrown: throwing would only skip the embedder below.
  // The doc stays behind Postgres (BLOCKERS: a sweep step that re-mirrors
  // finished notes). A doc that's gone still throws, for handle() to judge.
  try {
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
  } catch (err) {
    if (isNoteGone(err)) throw err;
    log.error({ err, noteId, workspaceId }, 'fast_path_ready_mirror_failed');
  }

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
