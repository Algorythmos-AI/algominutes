'use strict';

// Neutral internal transcript shape shared by every whole-file STT provider
// (AssemblyAI primary, Deepgram failover). Mapping a provider response to this
// shape is the ONLY provider-specific transcript logic; everything downstream
// (redaction, insertTranscriptLines, summariser, embedder) consumes the neutral
// shape and never learns which engine produced it. That is what makes a later
// AssemblyAI→Deepgram swap a client change, not a pipeline change
// (DIARISATION-PLAN §5, "map to a neutral internal transcript shape").
//
// A neutral line:
//   { speakerTag: number, startMs: number, endMs: number, text: string,
//     confidence: number|null }
//
// speakerTag is GLOBAL across the whole file — the provider diarises the entire
// recording in one pass, so "Speaker 1" means the same person from start to end.
// This is the property the old per-chunk Google path could not give and the one
// the plan says must never be cut.

// Provider speaker labels arrive in three shapes. Normalise all to a positive
// integer tag matching transcript_lines.speaker_tag and note_speakers.speaker_tag:
//   - AssemblyAI: "A", "B", "C", ...        → 1, 2, 3
//   - Deepgram:   0, 1, 2, ... (int)         → 1, 2, 3  (0-based → 1-based)
//   - numeric string "1", "2"                → 1, 2
// Anything unrecognised falls back to tag 1 rather than null, because a line
// with no speaker is worse than a line attributed to the sole/first speaker,
// and wordsToLines already treats null as 0.
function speakerLabelToTag(label) {
  if (label == null) return 1;
  if (typeof label === 'number' && Number.isFinite(label)) {
    // Deepgram is 0-based; shift to 1-based so tags line up with the "Speaker N"
    // display fallback and never collide with the 0 that wordsToLines emits for
    // untagged words.
    return Math.max(1, Math.floor(label) + 1);
  }
  const s = String(label).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    // A bare numeric string is ambiguous (0- vs 1-based). Providers that emit
    // numeric strings here (rare) are 1-based in practice; keep as-is but floor
    // at 1.
    return Math.max(1, n);
  }
  // Alphabetic label: "A" → 1, "B" → 2 ... "Z" → 26, then "AA" style is not
  // something any current provider emits, so single-letter is sufficient.
  const m = /^([A-Za-z])$/.exec(s);
  if (m) return s.toUpperCase().charCodeAt(0) - 64; // 'A' (65) → 1
  return 1;
}

// Group a flat word list (provider gives words, not turns) into same-speaker
// lines. Mirrors the Google-path wordsToLines in stt.js so both paths produce
// the same line granularity: a new line starts on a speaker change or a gap
// > 1500ms. Words carry absolute ms already (whole-file, no chunk offset).
function wordsToLines(words) {
  if (!words || !words.length) return [];
  const lines = [];
  let current = null;
  for (const w of words) {
    const tag = w.speakerTag || 1;
    if (!current || current.speakerTag !== tag || w.startMs - current.endMs > 1500) {
      if (current) lines.push(current);
      current = {
        speakerTag: tag,
        startMs: w.startMs,
        endMs: w.endMs,
        text: w.text,
        confidence: typeof w.confidence === 'number' ? w.confidence : null,
      };
    } else {
      current.endMs = w.endMs;
      current.text = current.text + (current.text.endsWith(' ') ? '' : ' ') + w.text;
      if (Number.isFinite(w.confidence)) {
        current.confidence = current.confidence == null
          ? w.confidence
          : (current.confidence + w.confidence) / 2;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function secToMs(sec) {
  const n = Number(sec);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

module.exports = { speakerLabelToTag, wordsToLines, secToMs };
