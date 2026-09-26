'use strict';

// The summarizer's output handling: chapter validation, and recovering a
// summary from JSON the model stopped writing mid-way (maxOutputTokens).
// No model client here (check-no-genai-import): pure functions.

const MAX_CHAPTERS = 40;
const MAX_TITLE = 120;
const MAX_CHAPTER_SUMMARY = 600;

/** "1:02:03", "02:03", "[02:03]" (the transcript's own marks) → ms; null otherwise. */
function parseClock(value) {
  const m = /^\[?\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:\.\d+)?\s*\]?$/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  const hasHours = m[1] !== undefined;
  const h = Number(m[1] || 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  if (sec >= 60 || (hasHours && min >= 60)) return null;
  return ((h * 60 + min) * 60 + sec) * 1000;
}

/**
 * The model's chapters → [{ startMs, title, summary }]: each start parsed from
 * its timestamp, inside the recording, with a title; sorted, one per start,
 * at most 40. Anything else is dropped rather than shown wrong.
 */
function normalizeChapters(raw, { maxMs = Infinity } = {}) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const startMs = Number.isInteger(c.startMs) ? c.startMs : parseClock(c.start);
    const title = typeof c.title === 'string' ? c.title.trim().slice(0, MAX_TITLE) : '';
    if (startMs == null || startMs < 0 || startMs > maxMs || !title) continue;
    const summary = typeof c.summary === 'string' ? c.summary.trim().slice(0, MAX_CHAPTER_SUMMARY) : '';
    out.push({ startMs, title, summary });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out.filter((c, i) => i === 0 || c.startMs !== out[i - 1].startMs).slice(0, MAX_CHAPTERS);
}

/**
 * JSON that was cut off (the model hit its output limit) → the longest prefix
 * that ends on a complete value, with its open arrays and objects closed.
 * Returns null when nothing complete precedes the cut.
 */
function repairTruncatedJson(text) {
  const s = String(text || '');
  const stack = [];
  let inString = false;
  let escape = false;
  let cut = null; // { at, closers } for the last point after a complete value
  const snapshot = (at) => { cut = { at, closers: stack.slice().reverse().join('') }; };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) {
        // A complete document (anything after it is ignored).
        try {
          return JSON.parse(s.slice(0, i + 1));
        } catch {
          /* silent-catch-ok: unparseable means nothing was salvaged; the caller reports it without quoting the model's text */
          return null;
        }
      }
      snapshot(i + 1);
    } else if (ch === ',') snapshot(i); // everything before the comma is complete
  }
  if (!cut) return null;
  try {
    return JSON.parse(s.slice(0, cut.at) + cut.closers);
  } catch {
    /* silent-catch-ok: an unrepairable prefix means nothing was salvaged; the caller reports the parse error */
    return null;
  }
}

/**
 * The summary from the model's JSON, or from what it managed to write before
 * it was cut off. Returns { result, partial }; throws the parse error when
 * there is no gist to show. A partial result keeps the fields that were
 * complete and defaults the rest.
 */
function salvageSummaryJson(rawText) {
  const cleaned = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  let parsed;
  let partial = false;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = repairTruncatedJson(cleaned);
    partial = true;
    // Never the parser's message: it quotes the model's output, which can hold
    // what the transcript said, and this error reaches logs and the dead letter.
    if (!parsed) throw new Error(`INVALID_JSON: unparseable model output (${cleaned.length} chars)`);
  }
  if (!parsed || typeof parsed.gist !== 'string' || !parsed.gist.trim()) {
    throw new Error('Model returned unexpected schema');
  }
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  return {
    result: {
      gist: parsed.gist,
      actionItems: strings(parsed.actionItems),
      keyDecisions: strings(parsed.keyDecisions),
      chapters: Array.isArray(parsed.chapters) ? parsed.chapters : [],
    },
    partial,
  };
}

module.exports = { parseClock, normalizeChapters, repairTruncatedJson, salvageSummaryJson, MAX_CHAPTERS };
