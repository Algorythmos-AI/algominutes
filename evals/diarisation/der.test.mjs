// Diarisation scorer tests. `node --test` from repo root (or evals/diarisation).
// No I/O, no DB — pins the DER / boundary / seam-integrity maths and proves the
// shadow comparison surfaces the per-chunk seam-split bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const der = require('./der.cjs');
const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

test('computeDER: identical reference/hypothesis → 0', () => {
  const ref = [
    { speaker: 1, startMs: 0, endMs: 5000 },
    { speaker: 2, startMs: 5000, endMs: 10000 },
  ];
  const r = der.computeDER(ref, ref, { durationMs: 10000 });
  assert.equal(r.der, 0);
});

test('computeDER: relabelled speakers still score 0 (optimal mapping)', () => {
  const ref = [
    { speaker: 1, startMs: 0, endMs: 5000 },
    { speaker: 2, startMs: 5000, endMs: 10000 },
  ];
  // Hypothesis swaps the labels (1↔2) but the segmentation is identical.
  const hyp = [
    { speakerTag: 2, startMs: 0, endMs: 5000 },
    { speakerTag: 1, startMs: 5000, endMs: 10000 },
  ];
  const r = der.computeDER(ref, hyp, { durationMs: 10000 });
  assert.equal(r.der, 0, 'label permutation must not count as error');
  assert.equal(r.mapping[2], 1);
});

test('computeDER: a confused half-segment yields ~0.5 DER', () => {
  const ref = [
    { speaker: 1, startMs: 0, endMs: 10000 },
  ];
  const hyp = [
    { speakerTag: 1, startMs: 0, endMs: 5000 },
    { speakerTag: 2, startMs: 5000, endMs: 10000 },
  ];
  const r = der.computeDER(ref, hyp, { durationMs: 10000 });
  assert.ok(Math.abs(r.der - 0.5) < 0.02, `expected ~0.5, got ${r.der}`);
});

test('boundaryRecall: exact boundaries → 1', () => {
  const ref = [
    { speaker: 1, startMs: 0, endMs: 5000 },
    { speaker: 2, startMs: 5000, endMs: 10000 },
  ];
  const { boundaryRecall } = der.boundaryRecall(ref, ref);
  assert.equal(boundaryRecall, 1);
});

test('seamIntegrity: whole-file keeps a speaker across the seam; per-chunk splits it', () => {
  const fx = loadFixture('two-speaker-standup.json');
  const good = der.seamIntegrity(fx.reference, fx.hypotheses.assemblyai_whole_file, fx.chunkSeamsMs);
  const bad = der.seamIntegrity(fx.reference, fx.hypotheses.google_per_chunk, fx.chunkSeamsMs);
  assert.equal(good.seamsChecked, 1);
  assert.equal(good.seamIntegrity, true, 'whole-file must not split the cross-seam turn');
  assert.equal(bad.seamIntegrity, false, 'per-chunk relabels across the seam — the bug we are fixing');
  assert.equal(bad.violations.length, 1);
});

test('scoreHypothesis: whole-file passes the gate, per-chunk fails on both fixtures', () => {
  for (const name of ['two-speaker-standup.json', 'three-speaker-sales-call.json']) {
    const fx = loadFixture(name);
    const good = der.scoreHypothesis(fx, fx.hypotheses.assemblyai_whole_file);
    const bad = der.scoreHypothesis(fx, fx.hypotheses.google_per_chunk);
    assert.equal(good.pass, true, `${name}: whole-file should pass (der=${good.der}, seam=${good.passSeam})`);
    assert.equal(good.passSeam, true, `${name}: whole-file seam integrity`);
    assert.equal(bad.passSeam, false, `${name}: per-chunk must fail seam integrity`);
    assert.ok(good.der <= bad.der, `${name}: whole-file DER (${good.der}) must be ≤ per-chunk DER (${bad.der})`);
  }
});

test('three-speaker fixture exercises a 3→3 speaker mapping', () => {
  const fx = loadFixture('three-speaker-sales-call.json');
  const r = der.computeDER(fx.reference, fx.hypotheses.assemblyai_whole_file, { durationMs: fx.durationMs });
  assert.equal(der.uniqueSpeakers(fx.reference).length, 3);
  // Near-zero, not exactly zero: the hypothesis has realistic ±100ms timing
  // jitter vs the reference, so a handful of boundary frames differ.
  assert.ok(r.der < 0.02, `clean whole-file hypothesis should be near-zero DER, got ${r.der}`);
  // All three hyp speakers map to distinct ref speakers.
  assert.equal(new Set(Object.values(r.mapping)).size, 3);
});
