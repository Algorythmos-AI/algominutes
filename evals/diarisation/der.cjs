'use strict';

// Diarisation scoring: DER + speaker-boundary correctness + chunk-seam
// integrity. Pure functions, no I/O — the db-job handler (eval-diarisation.js)
// and the unit tests both call these. See evals/diarisation/README.md.
//
// Why these three metrics (DIARISATION-PLAN §3, §4):
//   - DER (Diarization Error Rate): the standard overall accuracy number —
//     missed speech + false alarm + speaker confusion, over reference speech
//     time, under the optimal reference↔hypothesis speaker mapping.
//   - boundaryRecall: did the hypothesis put a speaker change where the
//     reference has one (within a tolerance)? Turn boundaries are what make a
//     transcript readable ("who said what").
//   - seamIntegrity: the specific failure the whole engine swap targets — a
//     single reference turn that SPANS an old 600s chunk seam must keep ONE
//     speaker tag across it. The old per-chunk Google path relabels across
//     seams; a whole-file diariser must not. A violation here reintroduces
//     Bug 17's boundary problem.

// Reference/hypothesis segments are { speaker|speakerTag, startMs, endMs }.
function segSpeaker(seg) {
  const v = seg.speaker != null ? seg.speaker : seg.speakerTag;
  return Number(v) || 0;
}

// Speaker label active at time t (ms). 0 = silence. Last matching segment wins
// on overlap (synthetic fixtures are non-overlapping; this is just defensive).
function speakerAt(segments, t) {
  let label = 0;
  for (const s of segments) {
    if (t >= s.startMs && t < s.endMs) label = segSpeaker(s);
  }
  return label;
}

function uniqueSpeakers(segments) {
  const set = new Set();
  for (const s of segments) {
    const spk = segSpeaker(s);
    if (spk !== 0) set.add(spk);
  }
  return [...set].sort((a, b) => a - b);
}

function durationOf(...segmentLists) {
  let max = 0;
  for (const list of segmentLists) {
    for (const s of list) if (s.endMs > max) max = s.endMs;
  }
  return max;
}

// All injective mappings from `from` (smaller) onto `to` — used to find the
// speaker labelling that best aligns hypothesis speakers to reference speakers.
function injectiveMappings(from, to) {
  const results = [];
  const used = new Array(to.length).fill(false);
  const current = {};
  (function recurse(i) {
    if (i === from.length) { results.push({ ...current }); return; }
    for (let j = 0; j < to.length; j++) {
      if (used[j]) continue;
      used[j] = true; current[from[i]] = to[j];
      recurse(i + 1);
      used[j] = false; delete current[from[i]];
    }
  })(0);
  return results.length ? results : [{}];
}

/**
 * Frame-based DER (collar 0). Samples the timeline every `frameMs` and, under
 * the hyp→ref speaker mapping that maximises agreement, tallies missed / false
 * alarm / confusion frames.
 */
function computeDER(reference, hypothesis, opts = {}) {
  const frameMs = opts.frameMs || 10;
  const durationMs = opts.durationMs || durationOf(reference, hypothesis);
  const refSpk = uniqueSpeakers(reference);
  const hypSpk = uniqueSpeakers(hypothesis);

  const nFrames = Math.max(1, Math.ceil(durationMs / frameMs));
  const refFrames = new Array(nFrames);
  const hypFrames = new Array(nFrames);
  let totalRef = 0;
  for (let i = 0; i < nFrames; i++) {
    const t = i * frameMs + frameMs / 2;
    refFrames[i] = speakerAt(reference, t);
    hypFrames[i] = speakerAt(hypothesis, t);
    if (refFrames[i] !== 0) totalRef++;
  }

  // Choose the mapping (map the smaller speaker set onto the larger) that
  // maximises frames where a speaking ref frame is matched by its mapped hyp.
  const mapSmallToLarge = hypSpk.length <= refSpk.length;
  const from = mapSmallToLarge ? hypSpk : refSpk;
  const to = mapSmallToLarge ? refSpk : hypSpk;
  const candidates = injectiveMappings(from, to);

  let best = null;
  for (const m of candidates) {
    // Normalise to hyp→ref regardless of which way we enumerated.
    const hypToRef = {};
    if (mapSmallToLarge) Object.assign(hypToRef, m);
    else for (const [refS, hypS] of Object.entries(m)) hypToRef[hypS] = Number(refS);

    let missed = 0, falseAlarm = 0, confusion = 0;
    for (let i = 0; i < nFrames; i++) {
      const r = refFrames[i], h = hypFrames[i];
      if (r === 0 && h === 0) continue;
      if (r !== 0 && h === 0) { missed++; continue; }
      if (r === 0 && h !== 0) { falseAlarm++; continue; }
      if (hypToRef[h] !== r) confusion++;
    }
    const errFrames = missed + falseAlarm + confusion;
    if (!best || errFrames < best.errFrames) {
      best = { missed, falseAlarm, confusion, errFrames, hypToRef };
    }
  }

  const der = totalRef > 0 ? best.errFrames / totalRef : (best.errFrames > 0 ? 1 : 0);
  return {
    der: round(der),
    missedMs: best.missed * frameMs,
    falseAlarmMs: best.falseAlarm * frameMs,
    confusionMs: best.confusion * frameMs,
    totalRefMs: totalRef * frameMs,
    mapping: best.hypToRef,
  };
}

// Merge consecutive same-speaker segments into turns, then list interior
// boundary times (turn end == next turn start).
function turnBoundaries(segments) {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
  const bounds = [];
  for (let i = 1; i < sorted.length; i++) {
    if (segSpeaker(sorted[i]) !== segSpeaker(sorted[i - 1])) {
      bounds.push(sorted[i].startMs);
    }
  }
  return bounds;
}

/** Fraction of reference speaker-change boundaries matched by a hypothesis
 * boundary within ±toleranceMs. */
function boundaryRecall(reference, hypothesis, opts = {}) {
  const tol = opts.toleranceMs || 500;
  const refB = turnBoundaries(reference);
  const hypB = turnBoundaries(hypothesis);
  if (!refB.length) return { boundaryRecall: 1, matched: 0, total: 0 };
  let matched = 0;
  for (const b of refB) {
    if (hypB.some((h) => Math.abs(h - b) <= tol)) matched++;
  }
  return { boundaryRecall: round(matched / refB.length), matched, total: refB.length };
}

/**
 * Chunk-seam integrity. For each seam time that falls INSIDE a single reference
 * turn (same reference speaker just before and just after the seam), the
 * hypothesis must assign ONE consistent speaker tag across it. A violation is
 * exactly the old per-chunk relabelling bug.
 */
function seamIntegrity(reference, hypothesis, chunkSeamsMs, opts = {}) {
  const delta = opts.deltaMs || 200;
  const seams = chunkSeamsMs || [];
  const violations = [];
  let checked = 0;
  for (const s of seams) {
    const refBefore = speakerAt(reference, s - delta);
    const refAfter = speakerAt(reference, s + delta);
    // Only meaningful when the reference speaker is continuous across the seam.
    if (refBefore === 0 || refBefore !== refAfter) continue;
    checked++;
    const hypBefore = speakerAt(hypothesis, s - delta);
    const hypAfter = speakerAt(hypothesis, s + delta);
    if (hypBefore === 0 || hypAfter === 0 || hypBefore !== hypAfter) {
      violations.push({ seamMs: s, refSpeaker: refBefore, hypBefore, hypAfter });
    }
  }
  return {
    seamsChecked: checked,
    violations,
    seamIntegrity: violations.length === 0,
  };
}

// Score one hypothesis against a fixture's reference + gates.
function scoreHypothesis(fixture, hypothesis, gates = {}) {
  const durationMs = fixture.durationMs || durationOf(fixture.reference, hypothesis);
  const der = computeDER(fixture.reference, hypothesis, { durationMs });
  const bound = boundaryRecall(fixture.reference, hypothesis);
  const seam = seamIntegrity(fixture.reference, hypothesis, fixture.chunkSeamsMs || []);

  const gateDerMax = gates.gateDerMax ?? 0.15;
  const gateBoundaryMin = gates.gateBoundaryMinRecall ?? 0.80;
  const passDer = der.der <= gateDerMax;
  const passBoundary = bound.boundaryRecall >= gateBoundaryMin;
  const passSeam = seam.seamIntegrity;

  return {
    der: der.der,
    derBreakdownMs: { missed: der.missedMs, falseAlarm: der.falseAlarmMs, confusion: der.confusionMs, totalRef: der.totalRefMs },
    speakerMapping: der.mapping,
    boundaryRecall: bound.boundaryRecall,
    boundaries: { matched: bound.matched, total: bound.total },
    seamsChecked: seam.seamsChecked,
    seamViolations: seam.violations,
    passDer, passBoundary, passSeam,
    pass: passDer && passBoundary && passSeam,
  };
}

function round(n) { return Number(n.toFixed(4)); }

module.exports = {
  computeDER,
  boundaryRecall,
  seamIntegrity,
  turnBoundaries,
  scoreHypothesis,
  speakerAt,
  uniqueSpeakers,
};
