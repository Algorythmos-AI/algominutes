'use strict';

// The actual job logic, separated from the express server so unit
// tests can drive it directly. Handlers receive `deps` so the test
// suite can swap out pg / GCS / STT / cloud-tasks with fakes.

const path = require('node:path');
const fs = require('node:fs');

const route = require('./route');
const sttProvider = require('./stt-provider');

// Content types for the whole-file providers when we hand them the original
// upload untouched (no per-chunk FLAC transcode on the whole-file path). Both
// AssemblyAI and Deepgram sniff most formats, but Deepgram's byte-body API wants
// a Content-Type; default to a permissive audio type when the ext is unknown.
const AUDIO_CONTENT_TYPES = {
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.webm': 'audio/webm',
};
function audioContentType(localPath, mimeType) {
  if (mimeType && /^audio\//.test(mimeType)) return mimeType;
  const ext = path.extname(localPath || '').toLowerCase();
  return AUDIO_CONTENT_TYPES[ext] || 'audio/*';
}

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}
const noteTerminal = loadShared('note-terminal.cjs');
const { NoteGoneError, isNoteGone } = require('./note-gone');

const KICKOFF = 'kickoff';
const STT_POLL = 'stt-poll';

async function handle(payload, deps) {
  if (!payload || typeof payload !== 'object') throw new Error('handle: empty payload');
  const kind = payload.kind;
  try {
    if (kind === KICKOFF) return await handleKickoff(payload, deps);
    if (kind === STT_POLL) return await handleSttPoll(payload, deps);
  } catch (err) {
    // A missing Firestore doc alone doesn't prove the note is gone: Firestore
    // answers NOT_FOUND for a wrong project or database too, and a half-failed
    // account deletion removes docs first. Ask Postgres, the source of truth.
    // If the note is still there, this is a real failure, so retry and let it
    // dead-letter visibly rather than drop a live note.
    if (isNoteGone(err) && err.where === 'firestore') {
      const c = await deps.db.pool().connect();
      let live;
      try { live = await deps.db.noteExists(c, { noteId: payload.noteId, workspaceId: payload.workspaceId }); }
      finally { c.release(); }
      if (live) {
        deps.log.error({ noteId: payload.noteId, workspaceId: payload.workspaceId }, 'transcoder_mirror_doc_missing');
        throw new Error('mirror_doc_missing_for_live_note');
      }
    }
    // Deleted (or not in the task's workspace) while we worked: acknowledge.
    // Retrying would re-create nothing useful, and the terminal path would
    // dead-letter it and push "note failed" about a note the user deleted.
    if (isNoteGone(err)) {
      // `constraint` names the foreign key for a 23503, so a misclassified
      // failure (some other FK) is visible in the log.
      deps.log.warn(
        { noteId: payload.noteId, workspaceId: payload.workspaceId, reason: err.code, constraint: err.constraint },
        'transcoder_note_gone',
      );
      return undefined;
    }
    throw err;
  }
  throw new Error(`handle: unknown kind ${kind}`);
}

// A kickoff replayed by Cloud Tasks (after a crash or a timeout) resumes only a
// note still being transcribed. One that moved on (summarizing, ready, error) is
// acknowledged: rewriting its status would drag a finished note backwards.
const KICKOFF_RESUMABLE = new Set(['queued', 'chunking', 'transcribing']);

// Poll tasks carry a deterministic id, so a replayed kickoff or a duplicate poll
// chain collapses into the running one instead of polling twice (cloud-tasks.cjs).
function pollTaskId(chunkId, poll) {
  return `${chunkId}-stt-poll-${poll}`;
}

async function handleKickoff(payload, deps) {
  const { noteId, workspaceId, type, storagePath, sourceUrl, mimeType } = payload;
  const { db, storage, ffmpeg, youtube, stt, fastPath, mirror, tasks, log, env, traceId, terminalHooks } = deps;

  // Postgres first: a note deleted between kickoff and now must not be touched
  // (the mirror below would otherwise be the first write, to a deleted note),
  // and the mirror only ever shows a status Postgres holds.
  const pre = await db.pool().connect();
  let status;
  try {
    status = await db.noteStatus(pre, { noteId, workspaceId });
    if (KICKOFF_RESUMABLE.has(status)) await db.upsertNoteStatus(pre, { noteId, workspaceId, status: 'chunking' });
  } finally { pre.release(); }
  if (status == null) throw new NoteGoneError('postgres');
  if (!KICKOFF_RESUMABLE.has(status)) {
    log.info({ noteId, workspaceId, status }, 'kickoff_replay_after_progress');
    return;
  }

  await mirror.mirrorStatus({ workspaceId, noteId, status: 'chunking' });

  const tmpDir = ffmpeg.ensureTempDir(noteId);
  let inputLocal = null;

  try {
    if (type === 'youtube') {
      try {
        inputLocal = await youtube.fetchAudio({ url: sourceUrl, outDir: tmpDir, log });
      } catch (err) {
        if (err.isPermanent) {
          log.error({ err, noteId }, 'youtube_permanent_failure');
          // Postgres first, then the mirror (note-terminal). A Firestore-only
          // error mirror left Postgres at 'queued', so the idempotent kickoff
          // saw the note as still in flight and refused a retry for 3 h.
          await noteTerminal.markNoteFailed({
            pool: db.pool(),
            firestore: mirror.db(),
            noteId,
            workspaceId,
            message: err.publicMessage || 'YouTube download failed. This video may be restricted or YouTube has updated its protections. Please try again later or upload the file directly.',
            log,
            event: 'youtube_permanent_failure',
          });
          // A7.4 tail for a permanent (non-retryable) terminal failure — DLQ +
          // refund + notify. Best-effort; never throws (guarded when the hooks
          // aren't wired into deps).
          if (terminalHooks) {
            await terminalHooks.onTranscodeTerminalFailure({
              pool: db.pool(), noteId, workspaceId, err, attempts: null, traceId,
              payload: { kind: 'kickoff', type, noteId, workspaceId, sourceUrl },
              log,
            });
          }
          return; // Stop retries
        }
        throw err;
      }
    } else if (storagePath) {
      inputLocal = path.join(tmpDir, 'input' + path.extname(storagePath || '.bin'));
      await storage.downloadToLocal(storagePath, inputLocal);
    } else {
      throw new Error('kickoff: neither storagePath nor sourceUrl provided');
    }

    let durationSec;
    try {
      durationSec = await ffmpeg.probeDuration(inputLocal);
    } catch (err) {
      // Permanent: the same bytes won't have a length on a retry, and guessing
      // one would send a long recording down the single-call fast path.
      log.error({ err, noteId, workspaceId }, 'duration_unreadable');
      await noteTerminal.markNoteFailed({
        pool: db.pool(),
        firestore: mirror.db(),
        noteId,
        workspaceId,
        message: "We couldn't read this recording's length, so it may be damaged. Please record or upload it again.",
        log,
        event: 'duration_unreadable',
      });
      if (terminalHooks) {
        await terminalHooks.onTranscodeTerminalFailure({
          pool: db.pool(), noteId, workspaceId, err, attempts: null, traceId,
          payload: { kind: 'kickoff', type, noteId, workspaceId, storagePath },
          log,
        });
      }
      return;
    }
    const decision = route.routeForDuration(durationSec);
    log.info({ noteId, durationSec, decision }, 'transcoder_routed');

    const client = await db.pool().connect();
    try {
      await db.upsertNoteStatus(client, {
        noteId,
        workspaceId,
        status: decision === 'fast' ? 'transcribing' : 'chunking',
        durationSecProbed: durationSec,
      });
    } finally {
      client.release();
    }

    if (decision === 'fast') {
      await fastPath.run({
        noteId, workspaceId, type, mimeType, inputLocal, durationSec, log, deps,
      });
    } else {
      // Long path. STT_PROVIDER decides the engine: Google (null) keeps the
      // legacy per-chunk pipeline; AssemblyAI/Deepgram diarise the WHOLE file in
      // one pass (globally-consistent speaker tags, no chunk-boundary problem —
      // DIARISATION-PLAN §3). Fast-path for short clips is unaffected.
      const provider = sttProvider.getProvider(env);
      if (provider) {
        await runWholeFilePath({
          noteId, workspaceId, inputLocal, durationSec, mimeType, provider, log, env, deps,
        });
      } else {
        await runChunkedPath({
          noteId, workspaceId, inputLocal, durationSec, tmpDir, log, env, deps,
        });
      }
    }
  } catch (err) {
    // A vanished note is acknowledged by handle(). Mirroring an error to it
    // is exactly the write that must not happen.
    if (isNoteGone(err)) throw err;
    log.error({ err, noteId }, 'kickoff_failed');
    await mirror.mirrorError({ workspaceId, noteId, errorMessage: 'Processing failed.' });
    throw err;
  } finally {
    // Best-effort cleanup. Do not fail the task on cleanup errors.
    try { ffmpeg.cleanupTempDir(noteId); }
    catch (cleanupErr) { log.warn({ err: cleanupErr, noteId, workspaceId }, 'tmp_cleanup_failed'); }
  }
}

async function runChunkedPath({ noteId, workspaceId, inputLocal, durationSec, tmpDir, log, env, deps }) {
  const { db, storage, ffmpeg, stt, mirror, tasks } = deps;

  const plan = route.planChunks(durationSec);
  log.info({ noteId, chunks: plan.length }, 'chunk_plan');

  const client = await db.pool().connect();
  try {
    await db.upsertNoteStatus(client, { noteId, workspaceId, status: 'transcribing', chunksTotal: plan.length });
  } finally {
    client.release();
  }
  await mirror.mirrorStatus({ workspaceId, noteId, status: 'transcribing' });
  await mirror.mirrorProgress({ workspaceId, noteId, done: 0, total: plan.length });

  for (const slice of plan) {
    const gcsPath = `transcoder/${noteId}/chunk-${slice.idx}.flac`;

    // The row first (an upsert: a replay gets the same one), so a replayed
    // kickoff can see how far the last attempt got.
    let chunkId;
    let row;
    const c = await db.pool().connect();
    try {
      chunkId = await db.insertAudioChunkRow(c, {
        noteId, idx: slice.idx, startSec: slice.startSec, endSec: slice.endSec,
        storagePath: gcsPath,
      });
      row = await db.getChunkRow(c, chunkId);
    } finally {
      c.release();
    }
    if (row && row.status === 'done') {
      log.info({ noteId, workspaceId, chunkIdx: slice.idx }, 'chunk_already_done');
      continue;
    }
    if (row && row.sttOperationId) {
      // Its speech job is already running (and paid for): don't start another.
      // Poll it; the task id folds this into the live poll chain when recent.
      log.info({ noteId, workspaceId, chunkIdx: slice.idx }, 'chunk_already_started');
      await tasks.enqueue({ kind: STT_POLL, jobId: payloadJobId(), chunkId, noteId, workspaceId }, 60, pollTaskId(chunkId, 0));
      continue;
    }

    const localChunk = path.join(tmpDir, `chunk-${slice.idx}.flac`);
    await ffmpeg.extractChunk({
      inputPath: inputLocal,
      startSec: slice.startSec,
      endSec: slice.endSec,
      outputPath: localChunk,
    });
    const gcsUri = await storage.uploadFromLocal(localChunk, gcsPath, 'audio/flac');
    fs.rmSync(localChunk, { force: true });

    const operationName = await stt.startLongRunning({
      recognizer: env.STT_RECOGNIZER || null,
      gcsUri,
      languageCodes: (env.LANGUAGE_CODES || 'en-US').split(',').map((s) => s.trim()).filter(Boolean),
      log,
    });

    const c2 = await db.pool().connect();
    try { await db.setChunkOperation(c2, { chunkId, operationName }); }
    finally { c2.release(); }

    await tasks.enqueue({
      kind: STT_POLL,
      jobId: payloadJobId(),
      chunkId, noteId, workspaceId,
    }, 60, pollTaskId(chunkId, 0));
  }
}

function payloadJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A 2-hour chunk transcribes well inside an hour; 120 polls at 60s is a wide
// margin over that, and a bound the queue's own --max-attempts cannot provide
// because each poll mints a NEW task rather than retrying the old one.
const MAX_STT_POLLS = 120;

async function handleSttPoll(payload, deps) {
  const { chunkId, noteId, workspaceId, jobId, poll = 0 } = payload;
  const { db, stt, tasks, mirror, log, storage, traceId, terminalHooks } = deps;

  const c = await db.pool().connect();
  let chunkRow;
  try { chunkRow = await db.getChunkRow(c, chunkId); }
  finally { c.release(); }

  if (!chunkRow) {
    log.warn({ chunkId }, 'stt_poll_chunk_missing');
    return;
  }
  if (chunkRow.status === 'done') {
    log.info({ chunkId }, 'stt_poll_already_done');
    return;
  }

  // Whole-file provider jobs store a provider-prefixed operation id
  // (`assemblyai:<id>`). Route those to the whole-file poll; Google's opaque LRO
  // names fall through to the legacy per-chunk path below.
  const decoded = sttProvider.decodeOperationId(chunkRow.sttOperationId);
  if (decoded.provider) {
    return handleWholeFilePoll({ decoded, chunkRow, payload, deps });
  }

  const op = await stt.checkOperation(chunkRow.sttOperationId);

  if (!op.done) {
    // Bounded, because this loop re-enqueues rather than retries: Cloud Tasks'
    // --max-attempts=5 applies to a task being retried, and every poll here
    // creates a fresh one. Without a counter an LRO that never resolves polls
    // every 60s forever, per chunk, at cost, with the note pinned at
    // 'transcribing' and nothing anywhere reporting a problem.
    if (poll >= MAX_STT_POLLS) {
      log.error({ chunkId, noteId, polls: poll }, 'stt_poll_exhausted');
      const c2 = await db.pool().connect();
      try {
        await db.markChunkError(c2, chunkId);
      } finally { c2.release(); }
      // Terminal, and decided here rather than by a retry count — this loop
      // re-enqueues, so Cloud Tasks never sees a final attempt. mirrorError
      // alone left Postgres at 'transcribing' forever.
      await noteTerminal.markNoteFailed({
        pool: db.pool(),
        firestore: mirror.db(),
        noteId, workspaceId,
        message: 'Transcription took too long and was stopped.',
        log,
        event: 'stt_poll_exhausted',
      });
      // A7.4 tail: this loop re-enqueues rather than retries, so Cloud Tasks
      // never sees a final attempt here — DLQ/refund/notify must be driven from
      // this terminal decision, not from the index.js final-attempt branch.
      if (terminalHooks) {
        await terminalHooks.onTranscodeTerminalFailure({
          pool: db.pool(), noteId, workspaceId, err: new Error('stt_poll_exhausted'),
          attempts: poll, traceId,
          payload: { kind: 'stt-poll', reason: 'stt_poll_exhausted', chunkId, noteId, workspaceId, polls: poll },
          log,
        });
      }
      return;
    }
    // jobId is carried through so the whole poll chain stays attributable in
    // logs; the previous version dropped it after the first hop.
    await tasks.enqueue(
      { kind: STT_POLL, jobId, chunkId, noteId, workspaceId, poll: poll + 1 },
      60,
      pollTaskId(chunkId, poll + 1),
    );
    return;
  }

  if (op.error) {
    log.error({ chunkId, opErr: op.error }, 'stt_operation_errored');
    const c2 = await db.pool().connect();
    try {
      await db.markChunkError(c2, chunkId);
    } finally { c2.release(); }
    await noteTerminal.markNoteFailed({
      pool: db.pool(),
      firestore: mirror.db(),
      noteId, workspaceId,
      message: 'Transcription failed for part of this recording.',
      log,
      event: 'stt_operation_errored',
    });
    // A7.4 tail — same rationale as stt_poll_exhausted: terminal, decided here.
    if (terminalHooks) {
      await terminalHooks.onTranscodeTerminalFailure({
        pool: db.pool(), noteId, workspaceId,
        err: new Error(`stt_operation_errored: ${op.error && op.error.message ? op.error.message : 'unknown'}`),
        attempts: poll, traceId,
        payload: { kind: 'stt-poll', reason: 'stt_operation_errored', chunkId, noteId, workspaceId },
        log,
      });
    }
    return;
  }

  const words = stt.flattenWords(op.result || op);
  // shift word timestamps by chunk start (they're relative to the chunk file)
  const offsetMs = Math.round((chunkRow.startSec || 0) * 1000);
  const absWords = words.map((w) => ({
    ...w,
    startMs: w.startMs + offsetMs,
    endMs: w.endMs + offsetMs,
  }));

  // Overlap dedup with the prior chunk.
  //
  // planChunks emits FORWARD overlap: chunk N spans [N*600, N*600+630] and
  // chunk N+1 begins at (N+1)*600, so the first `overlapMs` of every chunk
  // after the first is audio the previous chunk already transcribed.
  //
  // This used to be a no-op, twice over:
  //
  //   1. chunkBoundaryMs was set to offsetMs, and dedupOverlap breaks on
  //      `w.startMs >= chunkBoundaryMs`. The first word of the chunk sits at
  //      ~offsetMs, so the loop broke immediately and nothing was ever
  //      examined. Every boundary duplicated ~30s of speech.
  //   2. Even with the boundary right, the comparison could not succeed:
  //      fetchTailWords reads `transcript_lines`, which wordsToLines has
  //      already coalesced into ~146-character lines, and dedupOverlap
  //      compares them to single words via similarText. A 146-char line never
  //      matches a 5-char word under `tolerance = longer.length / 4`.
  //
  // The unit test passed throughout because its fixture used BACKWARD overlap
  // — new words *before* the boundary — which is not a shape planChunks emits.
  //
  // Deduping by time instead of text, because time is what we actually know:
  // the prior chunk's coverage is a fact recorded in audio_chunks, not
  // something to infer from string similarity. Everything before its end_sec
  // has already been written.
  const overlapMs = 30_000;
  let kept = absWords;
  if (chunkRow.idx > 0) {
    const c3 = await db.pool().connect();
    try {
      const priorEndMs = await db.fetchPriorChunkEndMs(c3, {
        noteId, idx: chunkRow.idx,
      });
      if (priorEndMs != null) {
        const before = kept.length;
        kept = absWords.filter((w) => w.startMs >= priorEndMs);
        log.info(
          { noteId, chunkIdx: chunkRow.idx, priorEndMs, dropped: before - kept.length },
          'chunk_overlap_deduped',
        );
      } else {
        // No prior chunk row — it errored, or rows were purged by a retry.
        // Keep everything: duplicated speech is a nuisance, dropped speech in
        // a meeting transcript is not.
        log.warn({ noteId, chunkIdx: chunkRow.idx }, 'chunk_overlap_no_prior');
      }
    } finally { c3.release(); }
  }

  const lines = stt.wordsToLines(kept);
  await completeChunkAndAdvance({ noteId, workspaceId, chunkId, lines, deps });
}

// Shared completion tail for BOTH the Google per-chunk path and the whole-file
// provider path: write lines (redacted inside the repo), run the atomic
// completion gate, mirror progress, and — once every chunk is done — enqueue the
// summariser + embedder and clean up intermediate GCS audio. Factored out so the
// idempotency guarantees (markChunkDone, claim* exactly-once, ON CONFLICT line
// writes) are identical no matter which engine produced the lines.
async function completeChunkAndAdvance({ noteId, workspaceId, chunkId, lines, deps }) {
  const { db, mirror, tasks, storage, log } = deps;

  const c4 = await db.pool().connect();
  try {
    await db.insertTranscriptLines(c4, { noteId, chunkId, lines, log });
  } finally { c4.release(); }

  // Atomic completion gate.
  const c5 = await db.pool().connect();
  let allDone = false;
  let summarizerClaimed = false;
  let embedderClaimed = false;
  try {
    allDone = await db.markChunkDone(c5, { chunkId, noteId });
    if (allDone) {
      summarizerClaimed = await db.claimSummarizerEnqueue(c5, noteId);
      embedderClaimed = await db.claimEmbedderEnqueue(c5, noteId);
      // Postgres holds 'summarizing' before the mirror shows it (below).
      if (summarizerClaimed) await db.upsertNoteStatus(c5, { noteId, workspaceId, status: 'summarizing' });
    }
  } finally { c5.release(); }

  // Mirror progress.
  const c6 = await db.pool().connect();
  try {
    const progress = await db.chunkProgress(c6, { noteId, workspaceId });
    if (progress) await mirror.mirrorProgress({ workspaceId, noteId, done: progress.done || 0, total: progress.total || 0 });
  } finally { c6.release(); }

  if (allDone && summarizerClaimed) {
    await mirror.mirrorStatus({ workspaceId, noteId, status: 'summarizing' });
    await tasks.enqueueSummarizer({ noteId, workspaceId });
  }
  if (allDone && embedderClaimed) {
    await tasks.enqueueEmbedder({ noteId, workspaceId });
  }

  // Every chunk is transcribed, so the intermediate FLAC files have served
  // their purpose — the transcript is in Postgres and nothing downstream reads
  // them again. The summarizer and embedder both work from transcript_lines,
  // and a re-transcription would start from the original upload under
  // recordings/, not from these.
  //
  // They were never deleted by anything. Raw meeting audio for every
  // recording over ten minutes accumulated in the bucket indefinitely,
  // outliving both note deletion and account deletion.
  //
  // Gated on allDone rather than per-chunk so a retry of one chunk still has
  // its input, and deliberately after the enqueues: losing the cleanup is
  // recoverable, losing the summarizer task is not.
  if (allDone) {
    await storage.deletePrefix(`transcoder/${noteId}/`, log);
  }
}

// ── Whole-file provider path (AssemblyAI primary / Deepgram failover) ──────────
//
// One audio_chunks row (idx 0, spanning the whole file) carries the completion +
// idempotency machinery, so the atomic gate, DLQ, refund, and terminal-failure
// tails are reused unchanged. There is no ffmpeg chunking, no GCS chunk upload,
// no per-chunk offset math, and no overlap dedup — the provider diarises the
// whole file in one pass and returns absolute-ms lines with GLOBAL speaker tags.
async function runWholeFilePath({ noteId, workspaceId, inputLocal, durationSec, mimeType, provider, log, env, deps }) {
  const { db, mirror, tasks } = deps;
  // Bind correlation fields so the low-level provider client's log lines carry
  // noteId/workspaceId (CLAUDE.md §logging), which the generic client can't know.
  const plog = log.child({ noteId, workspaceId, provider: provider.name });

  const client = await db.pool().connect();
  try {
    await db.upsertNoteStatus(client, { noteId, workspaceId, status: 'transcribing', chunksTotal: 1 });
  } finally {
    client.release();
  }
  await mirror.mirrorStatus({ workspaceId, noteId, status: 'transcribing' });
  await mirror.mirrorProgress({ workspaceId, noteId, done: 0, total: 1 });

  let chunkId;
  let row;
  const c = await db.pool().connect();
  try {
    chunkId = await db.insertAudioChunkRow(c, {
      noteId, idx: 0, startSec: 0, endSec: durationSec,
      storagePath: `wholefile:${provider.name}`,
    });
    row = await db.getChunkRow(c, chunkId);
  } finally { c.release(); }
  // A replayed kickoff: the file is already transcribed, or already submitted
  // (and paid for). Don't submit it again; make sure it is polled.
  if (row && row.status === 'done') {
    plog.info({}, 'chunk_already_done');
    return;
  }
  if (row && row.sttOperationId) {
    plog.info({}, 'chunk_already_started');
    await tasks.enqueue({ kind: STT_POLL, jobId: payloadJobId(), chunkId, noteId, workspaceId }, 60, pollTaskId(chunkId, 0));
    return;
  }

  const languageCodes = (env.LANGUAGE_CODES || 'en-US')
    .split(',').map((s) => s.trim()).filter(Boolean);

  if (provider.mode === 'inline') {
    // Deepgram: synchronous API — transcribe now, while the audio is still on
    // local disk, then complete exactly like the poll path would.
    const lines = await provider.transcribeInline({
      audioPath: inputLocal,
      languageCodes,
      contentType: audioContentType(inputLocal, mimeType),
      log: plog,
    });
    await completeChunkAndAdvance({ noteId, workspaceId, chunkId, lines, deps });
    return;
  }

  // 'poll' (AssemblyAI): submit the whole file (uploads bytes to the vendor),
  // store the job id prefixed with the provider name, and hand off to the
  // existing STT poll loop. The local file is not needed after submit — the
  // vendor already holds the audio.
  const jobId = await provider.submit({ audioPath: inputLocal, languageCodes, log: plog });
  const operationName = sttProvider.encodeOperationId(provider.name, jobId);

  const c2 = await db.pool().connect();
  try { await db.setChunkOperation(c2, { chunkId, operationName }); }
  finally { c2.release(); }

  await tasks.enqueue({
    kind: STT_POLL,
    jobId: payloadJobId(),
    chunkId, noteId, workspaceId,
  }, 60, pollTaskId(chunkId, 0));
}

// Poll a whole-file provider job (AssemblyAI). Mirrors the Google poll loop's
// bounded re-enqueue + terminal-failure handling, but the "done" branch maps the
// provider's neutral lines straight through — no offset shift, no overlap dedup
// (single whole-file chunk, globally-consistent tags) — then reuses
// completeChunkAndAdvance.
async function handleWholeFilePoll({ decoded, chunkRow, payload, deps }) {
  const { chunkId, noteId, workspaceId, jobId, poll = 0 } = payload;
  const { db, tasks, mirror, log, env, traceId, terminalHooks } = deps;
  const provider = sttProvider.getProvider(env);
  const plog = log.child({ noteId, workspaceId, chunkId, provider: provider && provider.name });

  // Env changed out from under an in-flight job (STT_PROVIDER flipped): the
  // operation id still names its origin provider, so fail loudly rather than
  // poll the wrong engine.
  if (!provider || provider.name !== decoded.provider) {
    plog.error({ expected: decoded.provider, current: provider && provider.name }, 'stt_provider_mismatch');
    throw new Error(`stt_provider_mismatch: op=${decoded.provider} current=${provider && provider.name}`);
  }

  const op = await provider.poll({ jobId: decoded.jobId, log: plog });

  if (!op.done) {
    if (poll >= MAX_STT_POLLS) {
      plog.error({ polls: poll }, 'stt_poll_exhausted');
      const c2 = await db.pool().connect();
      try { await db.markChunkError(c2, chunkId); }
      finally { c2.release(); }
      await noteTerminal.markNoteFailed({
        pool: db.pool(), firestore: mirror.db(), noteId, workspaceId,
        message: 'Transcription took too long and was stopped.',
        log, event: 'stt_poll_exhausted',
      });
      if (terminalHooks) {
        await terminalHooks.onTranscodeTerminalFailure({
          pool: db.pool(), noteId, workspaceId, err: new Error('stt_poll_exhausted'),
          attempts: poll, traceId,
          payload: { kind: 'stt-poll', reason: 'stt_poll_exhausted', chunkId, noteId, workspaceId, polls: poll, provider: provider.name },
          log,
        });
      }
      return;
    }
    await tasks.enqueue(
      { kind: STT_POLL, jobId, chunkId, noteId, workspaceId, poll: poll + 1 },
      60,
      pollTaskId(chunkId, poll + 1),
    );
    return;
  }

  if (op.error) {
    plog.error({ opErr: { message: op.error.message } }, 'stt_operation_errored');
    const c2 = await db.pool().connect();
    try { await db.markChunkError(c2, chunkId); }
    finally { c2.release(); }
    await noteTerminal.markNoteFailed({
      pool: db.pool(), firestore: mirror.db(), noteId, workspaceId,
      message: 'Transcription failed for this recording.',
      log, event: 'stt_operation_errored',
    });
    if (terminalHooks) {
      await terminalHooks.onTranscodeTerminalFailure({
        pool: db.pool(), noteId, workspaceId,
        err: new Error(`stt_operation_errored: ${op.error.message || 'unknown'}`),
        attempts: poll, traceId,
        payload: { kind: 'stt-poll', reason: 'stt_operation_errored', chunkId, noteId, workspaceId, provider: provider.name },
        log,
      });
    }
    return;
  }

  await completeChunkAndAdvance({ noteId, workspaceId, chunkId, lines: op.lines, deps });

  // The transcript is safe in Postgres; ask the vendor to drop its copy now
  // rather than waiting out its retention TTL. Best-effort — never throws.
  if (provider.deleteRemote) {
    await provider.deleteRemote({ jobId: decoded.jobId, log: plog });
  }
}

module.exports = { handle, handleKickoff, handleSttPoll, completeChunkAndAdvance, runWholeFilePath, pollTaskId };
