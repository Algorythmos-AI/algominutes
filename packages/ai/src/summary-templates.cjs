'use strict';

// Summary templates — prompt variants for the summarizer.
//
// DATA ONLY. This module must never import a model client; it is copied into
// every function bundle by scripts/copy-functions-shared.cjs, and
// scripts/check-no-genai-import.sh gates on it.
//
// The hard rule every template obeys:
//
//   required: ['gist', 'actionItems', 'keyDecisions']
//   properties are flat — STRING or ARRAY<STRING>, nothing nested
//
// Anything outside that shape is silently dropped downstream: parseSummaryJson
// validates it, redactSummaryOutput walks it, the summaries / action_items /
// key_decisions tables have nowhere to put it, and the Swift `Summary` model
// decodes only those keys. A template that adds a field would appear to work
// in the Gemini response and then vanish without an error anywhere. The
// schema-compat test in tests/summary-templates.test.ts is the guardrail —
// not this comment.
//
// Flat also matters for the model ladder: shared/gemini-call.cjs falls back to
// gemini-1.5-flash, which handles deeply nested response schemas poorly.

const BASE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    gist: { type: 'STRING' },
    actionItems: { type: 'ARRAY', items: { type: 'STRING' } },
    keyDecisions: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['gist', 'actionItems', 'keyDecisions'],
};

const JSON_CONTRACT = `Return ONLY valid JSON with this exact structure — no markdown, no backticks:
{
  "gist": "1-2 sentence executive overview",
  "actionItems": ["action 1", "action 2"],
  "keyDecisions": ["decision 1", "decision 2"]
}`;

const TEMPLATES = {
  // Byte-identical to buildSummaryPrompt() in shared/intelligence.cjs. A note
  // summarised with the default template must produce exactly what it
  // produced before templates existed — otherwise shipping this changes every
  // summary in the product, which is not what a template picker is for.
  general: {
    id: 'general',
    label: 'General meeting',
    version: 1,
    promptBody: `You are an elite meeting intelligence assistant. The transcript is provided below. Produce a structured meeting summary.

${JSON_CONTRACT}`,
    responseSchema: BASE_SCHEMA,
  },

  // Slater is the clinical alpha user. The explicit prohibition matters: a
  // summariser that infers a diagnosis from a conversation is worse than one
  // that summarises badly, because the output looks authoritative.
  clinical: {
    id: 'clinical',
    label: 'Clinical consult',
    version: 1,
    promptBody: `You are a clinical documentation assistant. The transcript of a consultation or case discussion is provided below. Produce a structured summary for the clinician's own records.

Rules:
- Record only what was actually said. Do NOT infer, suggest or imply a diagnosis, dosage or treatment that was not stated aloud.
- Attribute clinical claims to the speaker where the transcript makes that clear.
- Put follow-ups, referrals, tests to order and callbacks in actionItems.
- Put agreed clinical decisions and management plans in keyDecisions.
- If something was ambiguous or inaudible, say so in the gist rather than guessing.

${JSON_CONTRACT}`,
    responseSchema: BASE_SCHEMA,
  },

  // For someone who wants the to-do list and nothing else. gist stays required
  // by the schema, so it is asked for explicitly but kept to one line.
  actions_only: {
    id: 'actions_only',
    label: 'Action items only',
    version: 1,
    promptBody: `You are a meeting assistant. The transcript is provided below. Extract what has to happen next and little else.

Rules:
- gist: ONE short sentence naming what the meeting was about. No detail.
- actionItems: every commitment, task or follow-up, phrased so it reads as an instruction. Include who owns it when the transcript says.
- keyDecisions: only decisions that change what someone does. Omit discussion.

${JSON_CONTRACT}`,
    responseSchema: BASE_SCHEMA,
  },
};

const DEFAULT_TEMPLATE_ID = 'general';

/**
 * Look up a template, falling back to `general`.
 *
 * Never throws. An unknown id means stale client state or a rolled-back
 * template, and producing the default summary is a better outcome than
 * failing a job that has already paid for transcription.
 */
function getTemplate(id) {
  // hasOwnProperty, not a bare lookup: TEMPLATES['toString'] resolves to the
  // inherited Object.prototype method, which is truthy, so `||` would return
  // a function instead of a template and every field would read undefined.
  // Same for '__proto__' and 'constructor'.
  return isValidTemplateId(id) ? TEMPLATES[id] : TEMPLATES[DEFAULT_TEMPLATE_ID];
}

function isValidTemplateId(id) {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, id);
}

function templateIds() {
  return Object.keys(TEMPLATES);
}

module.exports = {
  TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  BASE_SCHEMA,
  getTemplate,
  isValidTemplateId,
  templateIds,
};
