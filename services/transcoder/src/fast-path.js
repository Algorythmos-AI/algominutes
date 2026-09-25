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
