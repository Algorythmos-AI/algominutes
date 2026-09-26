'use strict';

// The one place Vertex AI model ids live (plan PR-10). Every generative and
// embedding call site reads its model from here; tests/models.test.ts fails CI
// if a model id is hard-coded anywhere else, or if a model we depend on is
// about to retire.
//
// Facts below are from Google's official tables, checked 2026-09-24:
//   lifecycle: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions
//   regions:   https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations
// Re-check both when the tripwire fires, and update the dates here.
//
// Data residency (DECISIONS, A4): every Vertex call runs in australia-southeast1
// (Sydney), both availability AND ML processing. That rules out several newer
// models: gemini-3.6/3.7/3.8-flash and every flash-lite, including Google's
// recommended upgrade for 2.5-flash (gemini-3.1-flash-lite), are NOT served in
// Sydney. A model that is not listed for Sydney must not be added here without
// an owner decision to relax residency.
//
// Dates: `retires` is an ANNOUNCED retirement date (after it, calls 404).
// `supportedUntilAtLeast` is Google's "YYYY-MM-DD or later" floor: not a
// retirement, but the date by which to re-check the tables.

const REGION = 'australia-southeast1';

const MODELS = Object.freeze({
  // Generative
  'gemini-3.5-flash': {
    kind: 'generative',
    supportedUntilAtLeast: '2027-05-19', // GA 2026-05-19; structured output; audio input; 65,536 max output tokens
    regions: ['australia-southeast1'],
  },
  'gemini-2.5-flash': {
    kind: 'generative',
    retires: '2026-10-20', // Google's lifecycle table
    regions: ['australia-southeast1'],
  },
  // Embeddings. 768 dims (EMBED_DIM in embeddings.cjs; embeddings.embedding is vector(768)).
  // Moving to gemini-embedding-001 (Sydney, supported to >= 2028-05-20) means
  // re-embedding every row, because vectors from different models don't
  // compare. It must happen before 2027-04-01 (BLOCKERS).
  'text-embedding-004': {
    kind: 'embedding',
    retires: '2027-04-01',
    regions: ['australia-southeast1'],
  },
});

// Summaries + transcoder fast path, in order. A rung is tried when the one
// before it is overloaded (429/503) or unavailable (404). gemini-2.5-flash stays
// as the fallback until its retirement date, then drops out automatically.
const LADDER = Object.freeze(['gemini-3.5-flash', 'gemini-2.5-flash']);
const CHAT_MODEL = 'gemini-3.5-flash';
const EMBED_MODEL = 'text-embedding-004';

function dayOf(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
}

/** True once a model's ANNOUNCED retirement date has arrived (calls would 404). */
function isRetired(modelId, now = new Date()) {
  const m = MODELS[modelId];
  if (!m) throw new Error(`unknown model ${modelId}: add it to packages/ai/src/models.cjs`);
  return Boolean(m.retires && dayOf(now) >= m.retires);
}

/** The ladder minus retired models, evaluated per call so a retirement needs no deploy. */
function activeLadder(now = new Date()) {
  const ladder = LADDER.filter((id) => !isRetired(id, now));
  if (!ladder.length) throw new Error('every model in the ladder has retired: update packages/ai/src/models.cjs');
  return ladder;
}

module.exports = { REGION, MODELS, LADDER, CHAT_MODEL, EMBED_MODEL, isRetired, activeLadder };
