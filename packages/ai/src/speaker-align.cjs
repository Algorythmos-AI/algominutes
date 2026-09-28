'use strict';

// Speaker names from the meeting itself (docs/plans/MEETINGS.md). The
// notetaker's recording comes with a speaker timeline (who was talking when,
// from the meeting platform); speech-to-text gives each word a time. This
// assigns every word the speaker whose turn it falls in, so one STT pass over
// the mixed audio yields named speakers, with no per-participant tracks to pay
// for.
//
//   words:    [{ startMs, endMs, ... }]   (absolute ms from the recording's start)
//   segments: [{ startMs, endMs, speakerTag }]   (speakerTag 1..N)
//
// Rules:
//   - the segment overlapping the word most wins (a word spanning a hand-over
//     goes to whoever spoke more of it);
//   - the timeline and the audio may disagree by a little (SKEW_MS), so a word
//     just outside a segment still belongs to it;
//   - a word in a short silence between turns keeps the previous word's
//     speaker (GAP_CARRY_MS);
//   - anything else is 0: unknown ("Speaker N" in the transcript), never a guess.
// Linear in words + segments; the inputs needn't be sorted.

const SKEW_MS = 250;
const GAP_CARRY_MS = 2000;

function overlap(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function validSegments(segments) {
  return (segments || [])
    .filter((s) => s && Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && Number.isInteger(s.speakerTag) && s.speakerTag >= 1)
    .map((s) => ({ startMs: s.startMs, endMs: Math.max(s.startMs, s.endMs), speakerTag: s.speakerTag }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** Returns new word objects with speakerTag set (the input is not modified). */
function alignWords(words, segments, { skewMs = SKEW_MS, gapCarryMs = GAP_CARRY_MS } = {}) {
  const segs = validSegments(segments);
  const order = (words || []).map((w, i) => ({ w, i })).sort((a, b) => (a.w.startMs - b.w.startMs) || (a.i - b.i));
  const out = new Array(order.length);
  let first = 0;          // no segment before this index can reach later words
  let prevTag = 0;
  let prevEnd = -Infinity;
  for (const { w, i } of order) {
    const start = Number(w.startMs);
    const end = Math.max(start, Number(w.endMs));
    let tag = 0;
    if (Number.isFinite(start) && segs.length) {
      while (first < segs.length && segs[first].endMs + skewMs < start) first++;
      let best = 0;
      for (let j = first; j < segs.length && segs[j].startMs - skewMs <= end; j++) {
        const s = segs[j];
        // Point-like words (start == end) still overlap a segment they sit in.
        const o = overlap(start, end === start ? start + 1 : end, s.startMs - skewMs, s.endMs + skewMs);
        if (o > best) { best = o; tag = s.speakerTag; }
      }
      if (!tag && prevTag && start - prevEnd <= gapCarryMs) tag = prevTag;
    }
    out[i] = { ...w, speakerTag: tag };
    if (Number.isFinite(end)) {
      prevTag = tag;
      prevEnd = end;
    }
  }
  return out;
}

module.exports = { alignWords, SKEW_MS, GAP_CARRY_MS };
