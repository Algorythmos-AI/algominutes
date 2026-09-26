// services/db-job/src/handlers/vertex-smoke.js — prove, from inside the VPC,
// that every model the app depends on answers in THIS environment's region with
// the app's real call shape (plan PR-10).
//
//   gcloud run jobs execute db-job --wait \
//     --update-env-vars JOB_NAME=vertex-smoke,TRACE_ID=<uuid>
//
// The deploy runs it after migrate and before rollout: a model that was retired,
// isn't served in the region, rejects our response schema, or truncates the
// summary (finishReason MAX_TOKENS) fails the deploy while every service is
// still on its previous image. Each rung also gets the transcoder fast path's
// call: inline audio (a 2-second synthetic tone, generated here, no user data)
// with the fast path's schema, so a model that stops taking audio fails here
// rather than on every clip of 10 minutes or less. Cost: one summary-sized call
// and one tiny audio call per active ladder rung, plus one embedding call.
//
// The transcript is synthetic (no user data), and still goes through
// redactPII, exactly as the summarizer does (CLAUDE.md §1: every text that
// reaches Gemini is scrubbed first).

'use strict';

const { callGeminiWithLadder } = require('@algominutes/ai/gemini-call.cjs');
const { activeLadder, REGION, EMBED_MODEL } = require('@algominutes/ai/models.cjs');
const { redactPII } = require('@algominutes/ai/redaction.cjs');
const { getTemplate, DEFAULT_TEMPLATE_ID } = require('@algominutes/ai/summary-templates.cjs');
const {
  parseSummaryJson, salvageGeminiJson, buildPromptText, FAST_PATH_RESPONSE_SCHEMA, RETRY_DEADLINE_MS,
} = require('@algominutes/ai/intelligence.cjs');
const { embedChunks } = require('@algominutes/ai/embeddings.cjs');

// ~40 minutes of a planning meeting: long enough that thinking + output must
// fit the summarizer's maxOutputTokens, short enough to cost cents.
function syntheticTranscript(lines = 240) {
  const speakers = ['Priya', 'Tom', 'Aroha', 'Ben'];
  const topics = [
    'the Q3 onboarding revamp and its launch checklist',
    'whether to move the beta date by one week',
    'the support backlog and who owns triage',
    'pricing page copy and the annual plan discount',
    'the analytics dashboard missing weekly retention',
    'hiring a second iOS engineer before November',
  ];
  const out = [];
  for (let i = 0; i < lines; i++) {
    const t = Math.floor((i * 10) / 60);
    const time = `${String(t).padStart(2, '0')}:${String((i * 10) % 60).padStart(2, '0')}`;
    const topic = topics[Math.floor(i / 40) % topics.length];
    const who = speakers[i % speakers.length];
    const kind = i % 7 === 0 ? `Decision: we agree on ${topic}.` : i % 5 === 0 ? `Action: ${who} will follow up on ${topic} by Friday.` : `On ${topic}, I think we should look at the numbers again before committing.`;
    out.push(`[${time}] ${who}: ${redactPII(kind).text}`);
  }
  return out.join('\n');
}

async function smokeModel({ model, location, log }) {
  const template = getTemplate(DEFAULT_TEMPLATE_ID);
  const started = Date.now();
  const { rawText, finishReason, error } = await callGeminiWithLadder({
    modelLadder: [model], // one rung at a time: each must work on its own
    parts: [{ text: template.promptBody }, { text: `\n\nTranscript:\n${syntheticTranscript()}\n` }],
    deadlineMs: RETRY_DEADLINE_MS,
    log,
    location,
    generationConfig: {
      // Exactly the summarizer's config (services/summarizer/src/handler.js).
      responseMimeType: 'application/json',
      responseSchema: template.responseSchema,
      maxOutputTokens: 16384,
    },
  });
  if (error || !rawText) throw new Error(`${model}: ${error ? error.message : 'empty response'}`);
  if (finishReason !== 'STOP') throw new Error(`${model}: finishReason ${finishReason} (truncated or blocked)`);
  const parsed = parseSummaryJson(rawText);
  if (!parsed.gist || !Array.isArray(parsed.actionItems) || !Array.isArray(parsed.keyDecisions)) {
    throw new Error(`${model}: summary does not match the response schema`);
  }
  log.info(
    { model, location, finishReason, wallMs: Date.now() - started, actionItems: parsed.actionItems.length },
    'vertex_smoke_model_ok',
  );
}

// 16 kHz mono 16-bit PCM WAV of a quiet tone. Proves the model takes inline
// audio in this region; what it hears in a tone doesn't matter.
function syntheticWav({ seconds = 2, sampleRate = 16000, hz = 440 } = {}) {
  const samples = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 3000), 44 + i * 2);
  }
  return buf;
}

async function smokeAudio({ model, location, log, call = callGeminiWithLadder }) {
  const started = Date.now();
  const { rawText, finishReason, error } = await call({
    modelLadder: [model],
    // Exactly the fast path's call (services/transcoder/src/fast-path.js).
    parts: [
      { inlineData: { mimeType: 'audio/wav', data: syntheticWav().toString('base64') } },
      { text: buildPromptText('recording') },
    ],
    deadlineMs: RETRY_DEADLINE_MS,
    log,
    location,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: FAST_PATH_RESPONSE_SCHEMA,
      maxOutputTokens: 16384,
    },
  });
  if (error || !rawText) throw new Error(`${model} (audio): ${error ? error.message : 'empty response'}`);
  if (finishReason !== 'STOP') throw new Error(`${model} (audio): finishReason ${finishReason} (truncated or blocked)`);
  const { result, partial } = salvageGeminiJson(rawText);
  if (partial || !Array.isArray(result.transcript)) {
    throw new Error(`${model} (audio): output does not match the fast path's schema`);
  }
  log.info(
    { model, location, finishReason, wallMs: Date.now() - started, transcriptLines: result.transcript.length },
    'vertex_smoke_audio_ok',
  );
}

async function run({ log, env }) {
  const location = env.AIPLATFORM_LOCATION;
  // Data residency: smoke (and therefore deploy) only in the region the models
  // were chosen for. A different AIPLATFORM_LOCATION is config drift, not a test.
  if (location !== REGION) {
    throw new Error(`AIPLATFORM_LOCATION is ${location || 'unset'}; models.cjs is verified for ${REGION}`);
  }
  for (const model of activeLadder()) {
    await smokeModel({ model, location, log });
    await smokeAudio({ model, location, log });
  }

  const [vector] = await embedChunks({ chunks: [{ text: 'Vertex smoke: embedding check.' }], log, location });
  log.info({ model: EMBED_MODEL, location, dims: vector.length }, 'vertex_smoke_embedding_ok');
}

module.exports = { run, syntheticTranscript, syntheticWav, smokeAudio };
