// services/db-job/src/handlers/eval-diarisation.js — diarisation DER / boundary
// / seam-integrity gate + old-vs-new shadow comparison (Bug 17 / ADR 0005).
//
// Reads evals/diarisation/fixtures/*.json. Each fixture has a `reference`
// (ground-truth speaker turns) and one or more `hypotheses` (what an engine
// produced). Scores every hypothesis with evals/diarisation/der.cjs and emits a
// gate summary log, mirroring eval-recall.js's gate* + gateClosed convention.
//
// Two things this proves (the plan's two un-cuttable items):
//   1. GATE: the primary engine's whole-file hypotheses clear DER + boundary +
//      seam-integrity thresholds. `STT_PROVIDER` must not be flipped to
//      assemblyai in prod until this closes on REAL audio.
//   2. SHADOW: for every fixture it scores the new whole-file hypothesis AND the
//      old google_per_chunk hypothesis against the same reference, so the
//      seam-split regression the old path suffers is visible as data, not just
//      an assertion.
//
// Fixtures ship with representative synthetic hypotheses so the harness runs
// offline (no key, no network). To run the LIVE shadow eval, drop real engine
// outputs (same neutral line shape) into a dir and point EVAL_DIARISATION_HYP_DIR
// at it: files named <fixtureId>.<engine>.json override the baked hypotheses.
//
// Invocation:
//   gcloud run jobs execute db-job --update-env-vars JOB_NAME=eval-diarisation --wait

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The primary engine whose hypotheses the GATE is computed on. The old engine
// is scored too, but only as the shadow baseline — it is expected to fail seam
// integrity, so it must not gate.
const PRIMARY_HYP = 'assemblyai_whole_file';
const SHADOW_HYP = 'google_per_chunk';

// Gate thresholds. DER ≤ 15% is a lenient bar for a synthetic set; tighten once
// real-audio numbers exist (A11). Seam integrity is boolean and non-negotiable —
// a violation reintroduces the chunk-boundary bug.
const GATES = { gateDerMax: 0.15, gateBoundaryMinRecall: 0.80 };

function resolveDir(candidates) {
  return candidates.find((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

function loadDer() {
  const candidates = [
    path.join(__dirname, '../../evals/diarisation/der.cjs'),       // container: /app/src/handlers → /app/evals
    path.join(__dirname, '../../../evals/diarisation/der.cjs'),
    path.join(__dirname, '../../../../evals/diarisation/der.cjs'), // local repo: services/db-job/src/handlers → repo root
    '/app/evals/diarisation/der.cjs',
  ];
  const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!found) throw new Error(`evals/diarisation/der.cjs not found; checked: ${candidates.join(', ')}`);
  return require(found);
}

function loadFixtures() {
  const dir = resolveDir([
    path.join(__dirname, '../../evals/diarisation/fixtures'),
    path.join(__dirname, '../../../evals/diarisation/fixtures'),
    path.join(__dirname, '../../../../evals/diarisation/fixtures'),
    '/app/evals/diarisation/fixtures',
  ]);
  if (!dir) throw new Error('evals/diarisation/fixtures not found');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.map((f) => ({ file: f, fixture: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
}

// Optional live override: <fixtureId>.<engine>.json in EVAL_DIARISATION_HYP_DIR.
function liveHypothesis(dir, fixtureId, engine) {
  if (!dir) return null;
  const p = path.join(dir, `${fixtureId}.${engine}.json`);
  // Absent file = no override (synthetic hypothesis). A present-but-broken
  // file must fail the eval, not silently fall back to synthetic data.
  // Read directly (no stat-then-read), so there is no check/use race.
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw);
}

async function run({ log, traceId, env }) {
  const der = loadDer();
  const fixtures = loadFixtures();
  const liveDir = env.EVAL_DIARISATION_HYP_DIR || null;
  log.info({ traceId, fixtureCount: fixtures.length, liveDir: liveDir || 'none (synthetic hypotheses)' }, 'eval_diarisation_starting');

  const perFixture = [];
  let gatePass = true;

  for (const { file, fixture } of fixtures) {
    const id = fixture.id || file;

    const primaryHyp = liveHypothesis(liveDir, id, PRIMARY_HYP) || (fixture.hypotheses && fixture.hypotheses[PRIMARY_HYP]);
    const shadowHyp = liveHypothesis(liveDir, id, SHADOW_HYP) || (fixture.hypotheses && fixture.hypotheses[SHADOW_HYP]);

    if (!primaryHyp) {
      log.warn({ traceId, fixture: id }, 'eval_diarisation_no_primary_hypothesis');
      continue;
    }

    const primary = der.scoreHypothesis(fixture, primaryHyp, GATES);
    const shadow = shadowHyp ? der.scoreHypothesis(fixture, shadowHyp, GATES) : null;
    if (!primary.pass) gatePass = false;

    const row = {
      fixture: id,
      primary: {
        engine: PRIMARY_HYP,
        der: primary.der,
        boundaryRecall: primary.boundaryRecall,
        seamsChecked: primary.seamsChecked,
        seamIntegrity: primary.passSeam,
        pass: primary.pass,
      },
      shadow: shadow ? {
        engine: SHADOW_HYP,
        der: shadow.der,
        boundaryRecall: shadow.boundaryRecall,
        seamIntegrity: shadow.passSeam,
        seamViolations: shadow.seamViolations.length,
      } : null,
      // The headline shadow delta: how much worse the old per-chunk path is.
      derImprovement: shadow ? Number((shadow.der - primary.der).toFixed(4)) : null,
    };
    perFixture.push(row);
    log.info({ traceId, ...row }, 'eval_diarisation_fixture');
  }

  const evaluated = perFixture.length;
  const summary = {
    timestamp: new Date().toISOString(),
    mode: liveDir ? 'live-shadow' : 'synthetic',
    fixtures: evaluated,
    gateDerMax: GATES.gateDerMax,
    gateBoundaryMinRecall: GATES.gateBoundaryMinRecall,
    gateSeamIntegrity: true,
    // Gate closes only when every primary hypothesis passes DER + boundary +
    // seam integrity. Synthetic mode proves the harness; the REAL cutover gate
    // is this same log line with mode:'live-shadow' on labelled audio.
    gateClosed: evaluated > 0 && gatePass,
    note: liveDir ? undefined : 'synthetic hypotheses — cutover gate must run with EVAL_DIARISATION_HYP_DIR pointed at real engine outputs',
    perFixture,
  };
  log.info({ traceId, ...summary }, 'eval_diarisation_summary');
}

module.exports = { run };
