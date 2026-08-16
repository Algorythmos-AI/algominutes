# Diarisation plan — Bug 17 / ADR 0005 (scoping, no code)

**Status:** plan only. **Do not implement until Sam decides.** This touches the chunked STT pipeline —
the most expensive §5 asset — so the blast radius is mapped before anything moves. Any §5 change is argued
here, per the constraint.

**One-line recommendation:** switch the long-audio transcription **engine** to a third-party with native
whole-file diarisation (**AssemblyAI**, Deepgram as the alternate), keeping the Gemini fast-path for short
clips. It fixes diarisation, removes the cross-chunk speaker problem, and — critically — cuts the single
biggest COGS line enough for the A9.3 pricing to survive. The pure "migrate to STT v1" option (ADR 0005's
assumption) fixes diarisation but leaves both the cost and the cross-chunk problems. Full reasoning in §5.

---

## 1. What actually blocks it

**The corpus fact:** 0 of 4,253 transcript lines carry a `speaker_tag` (Bug 17). Every chunked-path note
(audio > 10 min) is stored as unattributed lines.

**Why the current path can't diarise** (`services/transcoder/src/stt.js`):
- The pipeline uses **STT v2 `batchRecognize`** with `model=long` (system recognizer) + `enableWordTimeOffsets`.
- **Bug 18:** the `long` model returns `INVALID_ARGUMENT: Diarization is not currently supported` when
  `diarizationConfig` is set, so the config is omitted. `wordsToLines` then coalesces null-tagged words.
- The pipeline **requires word-level time offsets** — for tap-to-seek playback, the per-chunk `offsetMs`
  math (`handler.js:270`), and the overlap-dedup between chunks. Diarisation must coexist with word timings.

**What v1 requires that v2 doesn't:** STT **v1** `SpeakerDiarizationConfig` works with
`longRunningRecognize` and returns `speaker_tag` on each `WordInfo` **together with** word timings — the
combination the pipeline needs. That is why ADR 0005 concluded "v1 migration, not a config change."

**Has the constraint changed since ADR 0005 (2026-08-13)? Partly — checked current Google docs (2026-08-16):**
- **Chirp 3** (STT **v2**) now supports diarisation in `BatchRecognize`. This is new since the ADRs. BUT the
  Chirp 3 doc states diarisation **cannot be combined with word-level timestamps** (word timestamps are only
  available up to ~20 min, and "not supported" with diarisation for long audio), and Chirp 3 is GA in **`us`
  / `eu` multi-region only — not `australia-southeast1`** (our infra region).
- **Net:** Chirp 3 does NOT rescue this pipeline — it can't give diarisation **+ word timings** on long
  audio, and it would force audio out of the AU region. **ADR 0005's core conclusion holds:** within Google,
  only **v1** gives long-audio + diarisation + word-timings together. What's new is that third-party engines
  (below) now do the same thing more cheaply and with global (not per-chunk) diarisation.

Sources: Google [Chirp 3 model doc](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3),
[STT release notes](https://docs.cloud.google.com/speech-to-text/docs/release-notes).

---

## 2. Options, costed

Cost figures are list prices (USD/min) with an approximate AUD conversion (÷ ~0.66). **A11 must measure
actuals** — but the relative ordering is the decision driver. Current app assumption:
`costs.ts sttPerAudioMinute = A$0.024/min`.

| Option | Eng effort | Cost/min (USD → AUD) | Accuracy | Effect on chunking + idempotent replay |
|---|---|---|---|---|
| **(a) Migrate chunked path to STT v1** | Medium–High: new v1 client, request/response shapes, `longRunningRecognize` LRO polling, re-verify Bugs 13–18. Two sub-variants below. | v1 ≈ **$0.016–0.024** → **A$0.024–0.036** (most expensive; diarisation included) | Google diarisation ~ok, weaker than pyannote/AssemblyAI in benchmarks | **a1 (whole-file):** drop STT chunking → one LRO, global speaker tags, replay = re-poll one op. **a2 (per-chunk):** keep chunking → per-chunk tags need reconciliation (see §3). |
| **(b) Keep v2, diarise separately (pyannote 2nd pass)** | High: stand up a **GPU** service, run pyannote on the whole file, align speaker segments to v2 word timings, new infra + ops (cold starts, GPU cost, on-call). | v2 text ≈ $0.016 + pyannote GPU compute (amortised ~$0.002–0.01/min depending on GPU utilisation) → **A$0.027–0.04+** | pyannote is SOTA diarisation; alignment adds error | v2 text stays chunked as today; pyannote runs whole-file → global tags, but a **new** align-back-to-chunks step and a second async job to make idempotent. |
| **(c) Switch long-path engine to AssemblyAI / Deepgram** ⭐ | Medium–High: new SDK, async job submit + poll, response→`transcript_lines` mapping, vendor DPA + audio-egress review, re-verify. But **one** async call returns text + word timings + **global** diarisation for multi-hour files. | **AssemblyAI** ≈ $0.0025–0.0035 + $0.0003 diar ≈ **$0.003** → **A$0.005**. **Deepgram** Nova-3 ≈ $0.0043 + $0.002 diar ≈ **$0.0063** → **A$0.0096**. | AssemblyAI/Deepgram diarisation benchmarks ≥ Google; native, global | **Removes STT chunking** for the long path (provider handles long audio). Idempotency = the provider job id (poll to completion; re-poll on replay). Simpler than per-chunk. |

⚠️ **Cost is the headline (A9.4).** At the app's current **A$0.024/min** Google assumption, the Pro tier
(1,500 min for A$14.99, ~A$12.75 net) costs **~A$36 in STT alone** — the plan loses money at the cap. STT
v1 (option a) is the *most* expensive tier. **AssemblyAI (~A$0.005/min → ~A$7.50 at 1,500 min) or Deepgram
(~A$0.0096 → ~A$14.40) are the only options under which the A9.3 pricing survives** once Gemini + storage
are added. This is not a tie-breaker; it is close to the whole decision.

Sources: [AssemblyAI pricing](https://www.assemblyai.com/blog/speech-to-text-api-pricing),
[Deepgram pricing](https://deepgram.com/pricing).

---

## 3. What breaks

**The hard problem — chunk boundary vs speaker continuity.** Today STT runs **per chunk**; diarisation
labels are assigned *within one recognize call*, so chunk A's "Speaker 1" is unrelated to chunk B's
"Speaker 1", and a turn spanning the A/B boundary splits into two lines with possibly-different tags.
- **(a1) v1 whole-file / (b) pyannote whole-file / (c) provider whole-file:** diarise the entire file in one
  pass → **globally consistent** speaker tags, boundary problem solved by construction. This is the strongest
  argument against keeping per-chunk STT.
- **(a2) v1 per-chunk:** does NOT solve it — needs a cross-chunk **speaker-reconciliation** step (voice-embedding
  clustering across boundaries), which is essentially re-implementing pyannote. Not recommended.
- The existing **overlap-dedup** (`handler.js` fetchTailWords / dedupOverlap) still applies to a1's chunk
  boundaries; for (c)/whole-file it becomes unnecessary (no STT chunk seams).

**Transcript schema:** no change needed for tags — `transcript_lines.speaker_tag` + `speaker_name` already
exist (`001_init.sql:91-92`), and the contract (`transcript.ts`) already carries `speakerTag`/`speakerName`.
A `note_speakers(note_id, speaker_tag, name)` mapping table is the clean home for renames (see §4).

**Embeddings / chunking downstream:** the embedder chunks `transcript_lines` **text** — speaker tags don't
change chunk boundaries. Optional enhancement: prefix embedded chunks with the speaker so "who owns the
follow-up" style queries (see `evals/queries.jsonl` q-synth-2) retrieve better. Not required for v1.

**Summariser prompt:** **already speaker-aware** — `handler.js:151-155` builds `[time] speaker: text` using
`speaker_name || 'Speaker N'`. Today every line is "Speaker" (tags null); diarisation just *populates* it.
**No prompt shape change** — strictly better input. Low risk.

**Eval harness:** yes, needs new fixtures — multi-speaker synthetic recordings with known speaker turns to
measure diarisation accuracy (DER) and, specifically, **speaker-boundary correctness across the old chunk
seams**. Add a diarisation gate alongside recall@10.

**Fast path (short < 10 min):** Gemini already returns a speaker per line and **must not regress** — leave
it untouched. Diarisation work is the long path only.

---

## 4. Speaker naming

"Speaker 1" is half the feature. Plan:
- **Persistence:** a new `note_speakers(note_id, speaker_tag, name, updated_at)` table; `transcript_lines`
  keeps `speaker_tag`, and display resolves `name` via the map (falling back to "Speaker N"). Cleaner than
  updating `speaker_name` on every line. `note-read` joins it; the summariser reads it (already does via
  `speaker_name` — repoint to the map).
- **Rename UX:** in the transcript view, tapping a speaker chip opens a rename field; renaming updates the
  one map row → all that speaker's lines re-label. iOS: extend `TranscriptPane`/`NoteDetailView`; web:
  the transcript tab. New endpoint `POST /v1/notes/:id/speakers` (name a tag).
- **Cross-note learned names (decision to flag, not build v1):** a user-level speaker profile (voice
  fingerprint → remembered name) is a real feature but needs voice embeddings + a privacy stance (storing a
  voiceprint). **v1 = per-note names only.** Learned-across-notes is a fast-follow with its own privacy note.

---

## 5. Recommendation

**Adopt option (c): move the long-audio path to a third-party engine with native whole-file diarisation —
AssemblyAI as the primary (cheapest, clean diarisation+timestamps async API), Deepgram as the backup
(fastest, still cheap). Keep the Gemini fast-path for short clips unchanged.**

**Why (c) over (a) — the case for changing this §5 asset:**
1. **Cost decides it.** STT is the biggest COGS line and Google (v1 especially) is 3–8× the third parties.
   At Google rates the A9.3 pricing loses money at the Pro cap; at AssemblyAI/Deepgram it clears with margin.
   This is a business-model constraint, not a taste "modernisation" — which is the §5 bar for changing it.
2. **Correctness.** A whole-file engine gives globally-consistent speaker tags, eliminating the chunk-boundary
   problem that (a2) can't solve and that (a1) only solves by abandoning chunking anyway.
3. **Feature fit.** It returns diarisation **+ word timings** in one async call — the exact combination
   Chirp 3 can't (word-timestamp conflict) and v1 can but expensively.
4. **Effort parity.** (a1) already means "drop STT chunking + re-verify"; (c) is comparable effort for a
   strictly better cost/accuracy outcome. The extra work in (c) is the vendor DPA + audio-egress review.

**What this costs us / risks (state them):**
- **New audio egress to a third party.** Audio already leaves the app to Google STT today; (c) changes the
  vendor → needs a DPA and a Privacy Policy / Data-Safety update (ties into A10). The redaction-before-store
  invariant is unaffected (redaction runs on the returned text, before Gemini/embedder/store).
- It **replaces the STT engine in the most-hardened pipeline.** Mitigation: keep the fast-path untouched;
  put the new engine behind the existing `STT_*`-style seam; run both old-Google and new-provider in a
  shadow eval before cutover; the idempotency model gets *simpler* (one provider job id).
- Provider lock-in / outage: mitigate by mapping to a neutral internal transcript shape (both AssemblyAI and
  Deepgram map cleanly), so a swap between them later is a client change, not a pipeline change.

**Phased build (when approved):**
1. Spike (gate): one AssemblyAI async call on a real 2-speaker >30-min file → confirm global diarisation +
   word timings + acceptable DER; map to `transcript_lines` shape. If it fails, fall back to option (a1).
2. Integrate behind the seam; long-path routing swaps Google→provider; fast-path untouched; keep redaction.
3. `note_speakers` table + rename endpoint + iOS/web rename UX.
4. Eval fixtures (multi-speaker) + a DER/boundary gate; shadow-compare vs the old path.
5. Cutover + remove STT chunking for the long path (or keep chunking only if the provider needs it).

**If it runs long — what to cut (in order):**
1. **Cross-note learned speaker names** — ship per-note names only.
2. **Speaker rename UX** — ship raw "Speaker 1/2…" first (diarisation itself is the P0; renaming is the
   completer). This is the single biggest time-saver.
3. **Embedding speaker-prefix enhancement** — retrieval works without it.
Do NOT cut: the whole-file/global-diarisation property (cutting it reintroduces the chunk-boundary bug) or
the shadow eval before cutover.

**Fallback if the vendor path is rejected (privacy/procurement):** option **(a1) STT v1 whole-file**
`longRunningRecognize` — fixes diarisation + boundary problem, but leaves the COGS problem, which then
forces a **lower Pro included-minutes cap** than 1,500 to stay profitable (a pricing change to bring back to
Sam).

---

### Open decisions for Sam
- Approve engine swap (c: AssemblyAI/Deepgram) vs Google v1 (a1)? (c) is my recommendation; (a1) is the
  Google-only fallback with a pricing consequence.
- Vendor DPA + Privacy/Data-Safety update acceptable (audio to AssemblyAI/Deepgram)?
- Per-note speaker names for v1, learned-across-notes deferred — OK?
- A11 must measure real blended COGS/min before the Pro cap (1,500 min) and `FREE_FLOOR_MINUTES` are fixed
  (A9.4 / A9.3 open items) — this plan's cost figures are list prices, not measured.

*No code written. Nothing in §5 changed. Source repo untouched.*
