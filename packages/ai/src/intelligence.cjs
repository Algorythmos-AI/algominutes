'use strict';

// Phase 3 long-audio: imports up to 500 MB, hourly bytes raised to 1 GB
// so a single 500 MB import doesn't blow the budget on first try.
const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
const RATE_LIMIT_PER_HOUR = 20;
const MAX_BYTES_PER_HOUR = 1024 * 1024 * 1024;
const RETRY_DEADLINE_MS = 240_000;
// Model ids live in models.cjs (lifecycle + region facts); this re-export keeps
// existing importers working.
const MODEL_LADDER = require('./models.cjs').LADDER;

function resolveGeminiAudioMime(hint, storagePath) {
  const raw = (hint || '').toLowerCase();
  if (raw.startsWith('audio/ogg')) return 'audio/ogg';
  if (raw.startsWith('audio/mp4') || raw.startsWith('audio/m4a') || raw.startsWith('audio/aac')) return 'audio/mp4';
  if (raw.startsWith('audio/mp3') || raw.startsWith('audio/mpeg')) return 'audio/mp3';
  if (raw.startsWith('audio/wav') || raw.startsWith('audio/x-wav')) return 'audio/wav';
  if (raw.startsWith('audio/flac')) return 'audio/flac';
  if (raw.startsWith('audio/webm')) return 'audio/ogg';
  if (storagePath) {
    if (storagePath.endsWith('.ogg')) return 'audio/ogg';
    if (storagePath.endsWith('.m4a') || storagePath.endsWith('.mp4') || storagePath.endsWith('.aac')) return 'audio/mp4';
    if (storagePath.endsWith('.mp3')) return 'audio/mp3';
    if (storagePath.endsWith('.wav')) return 'audio/wav';
    if (storagePath.endsWith('.flac')) return 'audio/flac';
  }
  return 'audio/ogg';
}

function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[a-zA-Z0-9_\-]+$/.test(id);
}

function publicErrorFor(err) {
  const msg = (err && err.message) || '';
  if (/BYTES_BUDGET/.test(msg)) return "You've hit your hourly upload limit. Please try again later.";
  if (/RATE_LIMIT/.test(msg)) return "You've hit the hourly processing limit. Please try again later.";
  if (/TOO_LARGE/.test(msg)) return 'That recording is too large. The current limit is 500 MB.';
  if (/TIME_BUDGET/.test(msg)) return 'The AI service took too long to respond. Please try again.';
  if (/503|UNAVAILABLE|overloaded|high demand|RESOURCE_EXHAUSTED/i.test(msg)) return 'The AI service is temporarily busy. Please try again in a minute.';
  if (/INVALID_JSON|unexpected schema|did not return valid JSON/i.test(msg)) return 'The AI returned an unexpected response. Please try again.';
  return "We couldn't analyse this recording. Please try again.";
}

function validateSummaryShape(result) {
  return (
    result &&
    typeof result.gist === 'string' &&
    Array.isArray(result.actionItems) &&
    Array.isArray(result.keyDecisions) &&
    Array.isArray(result.transcript)
  );
}

function isTransientError(err) {
  const msg = (err && err.message) || '';
  return /\b(503|429|UNAVAILABLE|overloaded|high demand|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|INTERNAL|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed)\b/i.test(msg);
}

function contextLineFor(type) {
  if (type === 'recording' || type === 'import_audio' || type === 'online_meeting') {
    return 'Transcribe this audio recording then produce a meeting summary.';
  }
  if (type === 'import_pdf') return 'Analyse this document and summarise its key points.';
  if (type === 'youtube') return 'Analyse this video content and summarise the key takeaways.';
  if (type === 'scan_text') return 'Organise and summarise this OCR-extracted text.';
  return '';
}

function buildPromptText(type, content) {
  const ctx = contextLineFor(type);
  const trimmed = content ? `${ctx}\n\nAdditional context:\n${String(content).substring(0, 3000)}` : ctx;
  return `You are an elite meeting intelligence assistant. ${trimmed}

Return ONLY valid JSON with this exact structure — no markdown, no backticks:
{
  "gist": "1-2 sentence executive overview",
  "actionItems": ["action 1", "action 2", "action 3"],
  "keyDecisions": ["decision 1", "decision 2"],
  "transcript": [
    { "speaker": "Speaker 1", "text": "what they said", "time": "00:00" }
  ]
}`;
}

function parseGeminiJson(rawText) {
  const cleaned = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_err) {
    // Not err.message: Node quotes the model's output there, and this error
    // reaches logs and the dead letter (summary-output.cjs does the same).
    throw new Error(`INVALID_JSON: unparseable model output (${cleaned.length} chars)`);
  }
  if (!validateSummaryShape(parsed)) {
    throw new Error('Model returned unexpected schema');
  }
  return parsed;
}

// Summarizer-only path. The chunked pipeline already has the transcript
// in Postgres before it calls Gemini, so asking the model to echo it
// back inflates output, blows past Gemini's default maxOutputTokens, and
// truncates mid-JSON on chatty long-form recordings (bug 14). This
// prompt + schema + parser pair drops the transcript echo entirely.
function buildSummaryPrompt() {
  return `You are an elite meeting intelligence assistant. The transcript is provided below. Produce a structured meeting summary.

Return ONLY valid JSON with this exact structure — no markdown, no backticks:
{
  "gist": "1-2 sentence executive overview",
  "actionItems": ["action 1", "action 2"],
  "keyDecisions": ["decision 1", "decision 2"]
}`;
}

const SUMMARY_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    gist: { type: 'STRING' },
    actionItems: { type: 'ARRAY', items: { type: 'STRING' } },
    keyDecisions: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['gist', 'actionItems', 'keyDecisions'],
};

// Fast-path schema: short clips skip STT and ask Gemini to produce the
// transcript AND the summary in one call. Closes PR-C from PROJECT.md —
// the same Bug-14 truncation surface as summarizer (now fixed via
// SUMMARY_RESPONSE_SCHEMA + maxOutputTokens=16384).
const FAST_PATH_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    gist: { type: 'STRING' },
    actionItems: { type: 'ARRAY', items: { type: 'STRING' } },
    keyDecisions: { type: 'ARRAY', items: { type: 'STRING' } },
    transcript: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          speaker: { type: 'STRING' },
          text: { type: 'STRING' },
          time: { type: 'STRING' },
        },
        required: ['speaker', 'text', 'time'],
      },
    },
  },
  required: ['gist', 'actionItems', 'keyDecisions', 'transcript'],
};

// Salvage a truncated/partial Gemini response. Strict parseGeminiJson()
// throws on any malformed JSON. With responseSchema + 16K tokens
// truncation should be rare, but if it happens we'd rather show the
// user *something* (transcript so far + empty summary fields) than throw
// the whole thing away. Walks the buffer back to the last balanced `}`
// at depth 0 and parses that. Fills missing required fields with empty
// defaults.
function salvageGeminiJson(rawText) {
  try {
    return { result: parseGeminiJson(rawText), partial: false };
  } catch (firstErr) {
    const cleaned = String(rawText || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    let depth = 0;
    let lastValidEnd = -1;
    let inString = false;
    let escape = false;
    for (let i = 0; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) lastValidEnd = i; }
    }
    if (lastValidEnd > -1) {
      const truncated = cleaned.slice(0, lastValidEnd + 1);
      try {
        const parsed = JSON.parse(truncated);
        return {
          result: {
            gist: typeof parsed.gist === 'string' ? parsed.gist : '',
            actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
            keyDecisions: Array.isArray(parsed.keyDecisions) ? parsed.keyDecisions : [],
            transcript: Array.isArray(parsed.transcript) ? parsed.transcript : [],
          },
          partial: true,
        };
      } catch { /* silent-catch-ok: salvage failed; the original parse error is rethrown below */ }
    }
    throw firstErr;
  }
}

function validateSummaryOnlyShape(r) {
  return (
    r &&
    typeof r.gist === 'string' &&
    Array.isArray(r.actionItems) &&
    Array.isArray(r.keyDecisions)
  );
}

function parseSummaryJson(rawText) {
  const cleaned = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_err) {
    // Not err.message: Node quotes the model's output there, and this error
    // reaches logs and the dead letter (summary-output.cjs does the same).
    throw new Error(`INVALID_JSON: unparseable model output (${cleaned.length} chars)`);
  }
  if (!validateSummaryOnlyShape(parsed)) {
    throw new Error('Model returned unexpected schema');
  }
  return parsed;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt) {
  return 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
}

/**
 * Atomically checks both the per-hour call count and the per-hour byte
 * budget for a uid, then increments both. Throws RATE_LIMIT (count)
 * or BYTES_BUDGET (bytes) on denial. `bytes` may be 0 for non-audio
 * jobs.
 *
 * Doc shape: rateLimits/{uid} = { count, bytes, windowStart }
 */
async function enforceUsageBudget(db, uid, bytes) {
  const limitRef = db.doc(`rateLimits/${uid}`);
  const windowMs = 60 * 60 * 1000;
  const addBytes = Math.max(0, Number(bytes) || 0);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(limitRef);
    const now = Date.now();
    const data = snap.exists ? snap.data() : {};
    let count = Number(data.count) || 0;
    let usedBytes = Number(data.bytes) || 0;
    let windowStart = Number(data.windowStart) || now;
    if (now - windowStart > windowMs) {
      count = 0;
      usedBytes = 0;
      windowStart = now;
    }
    if (count >= RATE_LIMIT_PER_HOUR) {
      const err = new Error('RATE_LIMIT');
      err.code = 429;
      throw err;
    }
    if (usedBytes + addBytes > MAX_BYTES_PER_HOUR) {
      const err = new Error('BYTES_BUDGET');
      err.code = 429;
      throw err;
    }
    // firestore-write-ok: the per-uid rate-limit counter (rateLimits/{uid}), not a note
    tx.set(limitRef, {
      count: count + 1,
      bytes: usedBytes + addBytes,
      windowStart,
    });
  });
}

module.exports = {
  MAX_AUDIO_BYTES,
  RATE_LIMIT_PER_HOUR,
  MAX_BYTES_PER_HOUR,
  RETRY_DEADLINE_MS,
  MODEL_LADDER,
  resolveGeminiAudioMime,
  isValidId,
  publicErrorFor,
  validateSummaryShape,
  isTransientError,
  contextLineFor,
  buildPromptText,
  parseGeminiJson,
  buildSummaryPrompt,
  SUMMARY_RESPONSE_SCHEMA,
  FAST_PATH_RESPONSE_SCHEMA,
  salvageGeminiJson,
  validateSummaryOnlyShape,
  parseSummaryJson,
  sleep,
  backoffMs,
  enforceUsageBudget,
};
