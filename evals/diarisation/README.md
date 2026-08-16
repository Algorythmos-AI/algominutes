# Diarisation eval — DER / boundary / seam-integrity gate + shadow comparison

Guards the diarisation engine swap (Bug 17 / ADR 0005). Two jobs:

1. **Gate** — the primary engine (AssemblyAI, whole-file) must clear DER +
   speaker-boundary + chunk-seam-integrity thresholds before `STT_PROVIDER` is
   flipped to `assemblyai` in production.
2. **Shadow comparison** — score the new whole-file engine AND the old
   per-chunk Google path against the same ground truth, so the seam-split
   regression the old path suffers is visible as data (`derImprovement`,
   `seamIntegrity`), per the plan's "shadow-eval before cutover".

## Metrics (`der.cjs`)

- **DER** — frame-based (10ms, collar 0): missed speech + false alarm + speaker
  confusion over reference speech time, under the optimal reference↔hypothesis
  speaker mapping (label permutation is not penalised).
- **boundaryRecall** — fraction of reference speaker-change boundaries matched
  by a hypothesis boundary within ±500ms.
- **seamIntegrity** — for each 600s chunk seam that falls INSIDE one reference
  turn, the hypothesis must keep ONE speaker tag across it. A violation is
  exactly the per-chunk relabelling bug the whole-file engine removes. Boolean,
  non-negotiable.

Gate: `der ≤ 0.15`, `boundaryRecall ≥ 0.80`, `seamIntegrity == true` for every
primary hypothesis. (DER bar is lenient for the synthetic set — tighten on real
audio at A11.)

## Fixtures (`fixtures/*.json`)

Each fixture is a multi-speaker recording with a known `reference` (ground-truth
turns), `chunkSeamsMs` (old 600s boundaries), and `hypotheses`:
- `assemblyai_whole_file` — a representative correct whole-file output.
- `google_per_chunk` — a representative old output that relabels across a seam.

`two-speaker-standup` and `three-speaker-sales-call` each place a reference turn
ACROSS a seam — the case that separates the two engines.

## Run

Unit tests (offline, no deps):

```
node --test evals/diarisation
```

The eval job (synthetic mode, offline):

```
gcloud run jobs execute db-job --update-env-vars JOB_NAME=eval-diarisation --wait
```

Emits `eval_diarisation_summary` with `gateClosed` (mirrors eval-recall).

## Running the REAL shadow eval before cutover (required)

The baked hypotheses prove the harness; they are NOT real engine output. The
cutover gate must run on labelled real audio:

1. Get a labelled multi-speaker recording (>30 min, ≥2 speakers, known turns) —
   set its `reference` in a fixture.
2. Transcribe it through BOTH engines and save each result as the neutral line
   shape (`[{ speakerTag, startMs, endMs, text }]`) to files named
   `<fixtureId>.assemblyai_whole_file.json` and `<fixtureId>.google_per_chunk.json`.
3. Point the job at them and re-run:

```
gcloud run jobs execute db-job \
  --update-env-vars JOB_NAME=eval-diarisation,EVAL_DIARISATION_HYP_DIR=/path/to/outputs --wait
```

`mode` becomes `live-shadow`. Do NOT flip `STT_PROVIDER=assemblyai` until this
closes on real audio (see docs/BLOCKERS.md). Running it needs a live AssemblyAI
key (Secret Manager) — not available in the build session that authored this.
