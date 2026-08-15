'use strict';

// The actual job logic, separated from the express server so unit
// tests can drive it directly. Handlers receive `deps` so the test
// suite can swap out pg / GCS / STT / cloud-tasks with fakes.

const path = require('node:path');
const fs = require('node:fs');

const route = require('./route');

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}
const noteTerminal = loadShared('note-terminal.cjs');

const KICKOFF = 'kickoff';
const STT_POLL = 'stt-poll';

async function handle(payload, deps) {
  if (!payload || typeof payload !== 'object') throw new Error('handle: empty payload');
  const kind = payload.kind;
  if (kind === KICKOFF) return handleKickoff(payload, deps);
  if (kind === STT_POLL) return handleSttPoll(payload, deps);
  throw new Error(`handle: unknown kind ${kind}`);
}

async function handleKickoff(payload, deps) {
  const { noteId, workspaceId, type, storagePath, sourceUrl, mimeType } = payload;
  const { db, storage, ffmpeg, youtube, stt, fastPath, mirror, tasks, log, env, traceId, terminalHooks } = deps;

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
          await mirror.mirrorError({
            workspaceId,
            noteId,
            errorMessage: err.publicMessage || 'YouTube download failed. This video may be restricted or YouTube has updated its protections. Please try again later or upload the file directly.',
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

    const durationSec = await ffmpeg.probeDuration(inputLocal);
    const decision = route.routeForDuration(durationSec);
    log.info({ noteId, durationSec, decision }, 'transcoder_routed');

    const client = await db.pool().connect();
    try {
      await db.upsertNoteStatus(client, {
        noteId,
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
      await runChunkedPath({
        noteId, workspaceId, inputLocal, durationSec, tmpDir, log, env, deps,
      });
    }
  } catch (err) {
    log.error({ err, noteId }, 'kickoff_failed');
    await mirror.mirrorError({ workspaceId, noteId, errorMessage: 'Processing failed.' });
    throw err;
  } finally {
    // Best-effort cleanup. Do not fail the task on cleanup errors.
    try { ffmpeg.cleanupTempDir(noteId); }
    catch (cleanupErr) { log.warn({ cleanupErr, noteId }, 'tmp_cleanup_failed'); }
  }
}

async function runChunkedPath({ noteId, workspaceId, inputLocal, durationSec, tmpDir, log, env, deps }) {
  const { db, storage, ffmpeg, stt, mirror, tasks } = deps;

  const plan = route.planChunks(durationSec);
  log.info({ noteId, chunks: plan.length }, 'chunk_plan');

  const client = await db.pool().connect();
  try {
    await db.upsertNoteStatus(client, { noteId, status: 'transcribing', chunksTotal: plan.length });
  } finally {
    client.release();
  }
  await mirror.mirrorStatus({ workspaceId, noteId, status: 'transcribing' });
  await mirror.mirrorProgress({ workspaceId, noteId, done: 0, total: plan.length });

  for (const slice of plan) {
    const localChunk = path.join(tmpDir, `chunk-${slice.idx}.flac`);
    await ffmpeg.extractChunk({
      inputPath: inputLocal,
      startSec: slice.startSec,
      endSec: slice.endSec,
      outputPath: localChunk,
    });

    const gcsPath = `transcoder/${noteId}/chunk-${slice.idx}.flac`;
    const gcsUri = await storage.uploadFromLocal(localChunk, gcsPath, 'audio/flac');
    fs.rmSync(localChunk, { force: true });

    let chunkId;
    const c = await db.pool().connect();
    try {
      chunkId = await db.insertAudioChunkRow(c, {
        noteId, idx: slice.idx, startSec: slice.startSec, endSec: slice.endSec,
        storagePath: gcsPath,
      });
    } finally {
      c.release();
    }

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
    }, 60);
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
        await c2.query(`UPDATE audio_chunks SET status='error' WHERE id=$1`, [chunkId]);
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
    );
    return;
  }

  if (op.error) {
    log.error({ chunkId, opErr: op.error }, 'stt_operation_errored');
    const c2 = await db.pool().connect();
    try {
      await c2.query(`UPDATE audio_chunks SET status='error' WHERE id=$1`, [chunkId]);
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
    }
  } finally { c5.release(); }

  // Mirror progress.
  const c6 = await db.pool().connect();
  try {
    const { rows } = await c6.query(
      `SELECT chunks_done AS "done", chunks_total AS "total" FROM notes WHERE id = $1`, [noteId],
    );
    if (rows[0]) await mirror.mirrorProgress({ workspaceId, noteId, done: rows[0].done || 0, total: rows[0].total || 0 });
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

module.exports = { handle, handleKickoff, handleSttPoll };
