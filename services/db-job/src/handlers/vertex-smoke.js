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
// still on its previous image. Cost: one summary-sized call per active ladder
// rung plus one embedding call.
//
// The transcript is synthetic (no user data), and still goes through
// redactPII, exactly as the summarizer does (CLAUDE.md §1: every text that
// reaches Gemini is scrubbed first).

'use strict';

const { callGeminiWithLadder } = require('@algominutes/ai/gemini-call.cjs');
const { activeLadder, REGION, EMBED_MODEL } = require('@algominutes/ai/models.cjs');
const { redactPII } = require('@algominutes/ai/redaction.cjs');
const { getTemplate, DEFAULT_TEMPLATE_ID } = require('@algominutes/ai/summary-templates.cjs');
const { parseSummaryJson, RETRY_DEADLINE_MS } = require('@algominutes/ai/intelligence.cjs');
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

async function run({ log, env }) {
  const location = env.AIPLATFORM_LOCATION;
  // Data residency: smoke (and therefore deploy) only in the region the models
  // were chosen for. A different AIPLATFORM_LOCATION is config drift, not a test.
  if (location !== REGION) {
    throw new Error(`AIPLATFORM_LOCATION is ${location || 'unset'}; models.cjs is verified for ${REGION}`);
  }
  for (const model of activeLadder()) await smokeModel({ model, location, log });

  const [vector] = await embedChunks({ chunks: [{ text: 'Vertex smoke: embedding check.' }], log, location });
  log.info({ model: EMBED_MODEL, location, dims: vector.length }, 'vertex_smoke_embedding_ok');
}

module.exports = { run, syntheticTranscript };
