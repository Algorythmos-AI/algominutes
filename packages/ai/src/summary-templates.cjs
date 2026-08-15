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

  // ── General-audience meeting types (A6.1). Each tailors the PROMPT only; the
  // response shape stays the flat BASE_SCHEMA so nothing is dropped downstream.

  standup: {
    id: 'standup',
    label: 'Standup',
    version: 1,
    promptBody: `You are a meeting assistant. The transcript is a team standup. Produce a structured summary.

Rules:
- gist: one line on overall progress and any theme (e.g. a shared blocker).
- actionItems: each person's next steps and every blocker that needs unblocking, phrased as instructions with the owner when stated.
- keyDecisions: any scope, priority or ownership changes agreed on the call.

${JSON_CONTRACT}`,
    responseSchema: BASE_SCHEMA,
  },

  interview: {
    id: 'interview',
    label: 'Interview',
    version: 1,
    promptBody: `You are a hiring assistant. The transcript is a candidate interview. Produce a structured summary for the interviewer's notes.

Rules:
- Record only what was actually said; do NOT infer a hire/no-hire recommendation that was not stated.
- gist: what role/topic the interview covered and the candidate's headline signal.
- actionItems: follow-ups — references to check, a take-home to send, a next round to schedule.
- keyDecisions: any evaluation decisions or agreed next steps stated aloud.

${JSON_CONTRACT}`,
    responseSchema: BASE_SCHEMA,
  },

  sales_call: {
    id: 'sales_call',
    label: 'Sales call',
    version: 1,
    promptBody: `You are a sales assistant. The transcript is a sales call. Produce a structured summary.

Rules:
- gist: the prospect's need and where the deal stands in one or two sentences.
- actionItems: every follow-up, quote to send, objection to answer or introduction to make, with the owner when stated.
- keyDecisions: pricing, scope, timeline or go/no-go decisions the parties agreed.

${JSON_CONTRACT}`,
    responseSchema: BASE_SCHEMA,
  },

  lecture: {
    id: 'lecture',
    label: 'Lecture',
    version: 1,
    promptBody: `You are a study assistant. The transcript is a lecture or talk. Produce a structured summary for later study.

Rules:
- gist: the subject and the main thesis or takeaway.
- actionItems: readings, assignments, exam dates or exercises the speaker set, as instructions.
- keyDecisions: the key points or conclusions worth remembering (use this for the core learnings, not literal "decisions").

${JSON_CONTRACT}`,
    responseSchema: BASE_SCHEMA,
  },

  one_on_one: {
    id: 'one_on_one',
    label: 'One-on-one',
    version: 1,
    promptBody: `You are a meeting assistant. The transcript is a one-on-one (e.g. manager and report). Produce a structured summary.

Rules:
- gist: what was discussed and the overall tone in one or two sentences.
- actionItems: every follow-up and commitment either person made, with the owner.
- keyDecisions: decisions about goals, growth, scope or ways of working that were agreed.

${JSON_CONTRACT}`,
    responseSchema: BASE_SCHEMA,
  },

  board_meeting: {
    id: 'board_meeting',
    label: 'Board meeting',
    version: 1,
    promptBody: `You are a governance assistant. The transcript is a board or committee meeting. Produce a structured summary suitable for minutes.

Rules:
- gist: the meeting's purpose and the headline outcomes.
- actionItems: action owners and their tasks, plus any items tabled for next time.
- keyDecisions: resolutions passed, approvals granted and formal decisions — attribute to the body, not a guess.

${JSON_CONTRACT}`,
    responseSchema: BASE_SCHEMA,
  },

  client_meeting: {
    id: 'client_meeting',
    label: 'Client meeting',
    version: 1,
    promptBody: `You are a client-services assistant. The transcript is a meeting with a client. Produce a structured summary.

Rules:
- gist: what the client wants and where things stand in one or two sentences.
- actionItems: every commitment made to the client and every follow-up owed, with the owner.
- keyDecisions: scope, timeline, budget or approach decisions the parties agreed.

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
