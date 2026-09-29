// A notetaker's recording, made ours (docs/plans/MEETINGS.md "Webhooks and ingest"; RELEASE.md PR 19): once
// Recall has both the mixed audio and the participant events, the ingest task
//   1. re-reads the bot from Recall, for download URLs fresh at that moment (never stored);
//   2. reads who was there and who spoke when, and streams the audio to the note's fixed object;
//   3. stores the participants and the speaker timeline (names seed the note's speakers once), and settles the
//      bot's minutes to the recording's length;
//   4. queues the note's run (queueNoteRun), once per bot: Postgres records it with the run (markQueued);
//   5. has Recall delete its copy (queued first, so the purge worker finishes it if this attempt can't);
//   6. ends the bot ('done'), so it no longer counts against the user's active notetakers.
// Idempotent: a replay overwrites the same object, saves the same rows, is told the run was already queued
// (however long ago), and re-queues a purge already queued. A bot already ingested skips straight to 4.
// A note deleted before or during ingest takes its meeting with it: Recall's copy, and every version of the
// audio. On its last attempt, a recording that never became ours fails the note and queues Recall's purge.
import * as db from '@algominutes/db';
import loggerModule from '@algominutes/ai/logger.cjs';
import noteTerminalModule from '@algominutes/db/note-terminal.cjs';
import { RecallError } from '../lib/recall-client.js';
import { failBot } from './notetaker.js';
import { recordMeetingsDeadLetter } from '../lib/dead-letters.js';
import { mediaHosts, openMedia, readJsonMedia } from '../lib/media-download.js';
import { createRecordingsStore } from '../lib/recordings-store.js';

const { traceIdFromTask } = loggerModule;
const { isFinalAttempt } = noteTerminalModule;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const loggableId = (id) => (typeof id === 'string' && UUID_RE.test(id) ? id : 'invalid');
const attemptOf = (req) => Number(req.headers?.['x-cloudtasks-taskretrycount'] ?? 0);

/** A meeting's recording is capped like an import (packages/ai intelligence.cjs MAX_AUDIO_BYTES). */
export const MAX_RECORDING_BYTES = 500 * 1024 * 1024;
/** The participants and the speaker timeline are small JSON files. */
export const MAX_TIMELINE_BYTES = 20 * 1024 * 1024;
/** How many purges the worker tries per run, and how many attempts before one is a person's. */
const PURGE_BATCH = 50;
const PURGE_MAX_ATTEMPTS = 10;

const shortcutDone = (r, name) => r?.media_shortcuts?.[name]?.status?.code === 'done';

/**
 * The recording to ingest: the last one whose mixed audio and participant events are both done (the two
 * webhooks that start ingest). A bot records once (it never pauses); more than one is flagged, since the
 * speaker timeline is timed from the latest.
 */
export function pickRecording(recallBot) {
  const recordings = (Array.isArray(recallBot?.recordings) ? recallBot.recordings : [])
    .filter((r) => shortcutDone(r, 'audio_mixed') && r.media_shortcuts.audio_mixed.data?.download_url && shortcutDone(r, 'participant_events'));
  return { recording: recordings[recordings.length - 1] ?? null, count: recordings.length };
}

// Recall's bot statuses after which it holds nothing new: it has left, failed, or its media expired.
const RECALL_BOT_ENDED = new Set(['done', 'fatal', 'media_expired']);

/**
 * Whether Recall holds nothing of this bot's any more: it has ended, and every recording it made is deleted
 * (a bot that never recorded has none). Such a purge is confirmed here, since no `recording.deleted` webhook
 * will come for a recording that never was.
 */
export function nothingLeftAtRecall(recallBot) {
  const changes = Array.isArray(recallBot?.status_changes) ? recallBot.status_changes : [];
  const last = changes[changes.length - 1]?.code;
  const recordings = Array.isArray(recallBot?.recordings) ? recallBot.recordings : [];
  return RECALL_BOT_ENDED.has(last) && recordings.every((r) => r?.status?.code === 'deleted');
}

/** The recording's length in seconds, from Recall's start and end; null when it can't say. */
export function recordingSeconds(recording) {
  const start = Date.parse(recording?.started_at);
  const end = Date.parse(recording?.completed_at);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round((end - start) / 1000) : null;
}

/** Recall's participants file ([{ id, name }]) as the repo's participants. */
export function toParticipants(file) {
  return (Array.isArray(file) ? file : [])
    .filter((p) => p && (typeof p.id === 'number' || typeof p.id === 'string'))
    .map((p) => ({ recallParticipantId: String(p.id), displayName: typeof p.name === 'string' ? p.name.trim() : '' }));
}

/**
 * Recall's speaker timeline ([{ participant: { id }, start_timestamp: { relative }, end_timestamp }], seconds
 * from the recording's start) as the repo's segments, in ms. A speaker with no end speaks until the next one
 * starts (the repo clamps the rest).
 */
export function toSegments(file) {
  const rows = (Array.isArray(file) ? file : []).filter((e) => e?.participant && Number.isFinite(e?.start_timestamp?.relative));
  return rows.map((e, i) => {
    const startMs = Math.round(e.start_timestamp.relative * 1000);
    const end = Number.isFinite(e?.end_timestamp?.relative) ? e.end_timestamp.relative : rows[i + 1]?.start_timestamp?.relative;
    return { recallParticipantId: String(e.participant.id), startMs, endMs: Number.isFinite(end) ? Math.round(end * 1000) : startMs };
  });
}

export function createIngestTasks({
  getRecall, getFirestore, env = process.env, repo = db, queueNoteRun = db.queueNoteRun,
  store = createRecordingsStore({ bucket: env.GCS_BUCKET }), fetchImpl = globalThis.fetch,
}) {
  const hosts = mediaHosts(env);

  function botLog(req, bot) {
    const carried = traceIdFromTask(req.body, req.headers);
    const traceId = bot?.traceId || carried;
    return req.log.child({
      traceId, ...(carried !== traceId ? { taskTraceId: carried } : {}),
      meetingBotId: bot?.id, userId: bot?.uid, workspaceId: bot?.workspaceId, noteId: bot?.noteId,
    });
  }

  // Recall's copy: queued (the purge worker's to finish), then asked for now. `recording.deleted` confirms it.
  async function purgeRecallCopy({ recallBotId, reason, traceId, log }) {
    await repo.enqueueRecallPurge(null, { recallBotId, reason, traceId });
    await askRecallToDelete({ recallBotId, reason, log });
  }

  // Asked now, with the purge already queued: a refusal only leaves it to the worker.
  async function askRecallToDelete({ recallBotId, reason, log }) {
    try {
      await (await getRecall(log)).deleteMedia(recallBotId);
      log.info({ recallBotId, reason }, 'recall_media_delete_requested');
    } catch (err) {
      // The purge row stands: the worker tries again. Our key or region refused is an error, as elsewhere.
      const auth = err instanceof RecallError && (err.status === 401 || err.status === 403);
      log[auth ? 'error' : 'warn']({ err, recallBotId, status: err?.status }, auth ? 'recall_auth_failed' : 'recall_media_delete_deferred');
    }
  }

  // The bot's work is over: 'done' (a no-op on one already terminal), so it stops counting as active.
  const endBot = (bot, log) => repo.advanceNotetaker(getFirestore(), { botId: bot.id, status: 'done' }, log);

  // The note is gone (deleted, or with its account): nothing of the meeting stays. Recall's purge is queued
  // first, so a failure after it (the bucket) retries into the branch that does all of this again.
  async function forgetMeeting({ bot, noteId, reason, traceId, log }) {
    if (bot.recallBotId) await repo.enqueueRecallPurge(null, { recallBotId: bot.recallBotId, reason, traceId });
    await store.removeNote({ workspaceId: bot.workspaceId, noteId }, log);
    if (bot.recallBotId) await askRecallToDelete({ recallBotId: bot.recallBotId, reason, log });
    await endBot(bot, log);
    log.warn({ reason }, 'notetaker_ingest_note_deleted');
  }

  // Out of attempts. A recording whose run was queued has only its tail left (Recall's copy): queued for the
  // worker, and the bot ends. One that never became ours fails its note, with Recall's copy queued for
  // deletion, in one transaction (failNotetaker), rather than leave the note 'recording' for ever.
  async function giveUp(bot, log, traceId) {
    const now = (await repo.getMeetingBotById(bot.id)) || bot;
    if (now.runQueuedAt) {
      if (now.recallBotId) await repo.enqueueRecallPurge(null, { recallBotId: now.recallBotId, reason: 'ingested', traceId });
      await endBot(now, log);
    } else {
      await failBot({ repo, firestore: getFirestore(), bot: now, reason: 'error', log });
    }
  }

  // ── ingest: the recording, made ours ──
  async function ingest(req, res) {
    const bot = await repo.getMeetingBotById(String(req.body?.meetingBotId ?? ''));
    const log = botLog(req, bot);
    if (!bot) {
      // Gone with its account (the rows cascade, and the account's own purges ran).
      log.warn({ requestedBotId: loggableId(req.body?.meetingBotId) }, 'notetaker_ingest_nothing_to_do');
      return res.status(200).json({ ok: true });
    }
    // The recording's trace for everything this queues (purges, the note's run), as for its log lines.
    const traceId = bot.traceId || traceIdFromTask(req.body, req.headers);
    try {
      if (!bot.noteId) {
        // The note was deleted (its bot's note_id goes NULL), before this ran or by an earlier attempt of it.
        await forgetMeeting({ bot, noteId: db.noteIdForBot(bot.id), reason: 'note_deleted', traceId, log });
        return res.status(200).json({ ok: true });
      }
      if (!bot.recallBotId) {
        // Never sent to Recall: nothing was recorded.
        log.warn({ requestedBotId: bot.id }, 'notetaker_ingest_nothing_to_do');
        return res.status(200).json({ ok: true });
      }
      if (bot.status === 'failed' || bot.status === 'cancelled') {
        // Ended without its recording (a late media event after the reconcile gave up on it): its note says
        // so, and Recall's copy was queued with the ending. Nothing is queued now.
        log.warn({ status: bot.status }, 'notetaker_ingest_bot_ended');
        return res.status(200).json({ ok: true });
      }
      return await ingestBot(res, bot, log, traceId);
    } catch (err) {
      if (isFinalAttempt(req.headers)) {
        log.error({ err, attempt: attemptOf(req) }, 'notetaker_ingest_gave_up');
        // The dead letter first: it never throws, and giving up can (Postgres, the mirror), which would lose it.
        await recordMeetingsDeadLetter({ repo, kind: 'ingest', bot, err, attempts: attemptOf(req) + 1, traceId, log });
        await giveUp(bot, log, traceId);
        return res.status(200).json({ ok: true });
      }
      // Every failure on the recording's own trail (a download refused, the bucket, Postgres, Recall): Cloud
      // Tasks retries it, and the app's error line has only the request's trace.
      log.warn({ err, attempt: attemptOf(req) }, 'notetaker_ingest_attempt_failed');
      throw err;
    }
  }

  async function ingestBot(res, bot, log, traceId) {
    const storagePath = `recordings/${bot.workspaceId}/${bot.noteId}.mp3`;
    // A replay of a bot already ingested reads both back: the object's size, and the seconds it was settled at.
    let bytes = null;
    let seconds = bot.billableSeconds;

    if (!bot.ingestedAt) {
      const recall = await getRecall(log);
      const { recording, count } = pickRecording(await recall.getBot(bot.recallBotId));
      // Its audio isn't done yet (the event beat the recording's status): the task retries.
      if (!recording) throw new Error('notetaker_ingest_recording_not_ready');
      if (count > 1) log.warn({ recordings: count }, 'notetaker_multiple_recordings');
      const events = recording.media_shortcuts?.participant_events?.data ?? {};
      const opts = { hosts, fetchImpl, maxBytes: MAX_TIMELINE_BYTES };
      const participants = toParticipants(events.participants_download_url ? await readJsonMedia(events.participants_download_url, opts) : []);
      const segments = toSegments(events.speaker_timeline_download_url ? await readJsonMedia(events.speaker_timeline_download_url, opts) : []);

      const audio = await openMedia(recording.media_shortcuts.audio_mixed.data.download_url, { hosts, fetchImpl, maxBytes: MAX_RECORDING_BYTES });
      bytes = await store.write(storagePath, audio.body, { contentType: 'audio/mpeg', maxBytes: MAX_RECORDING_BYTES });

      const saved = await repo.saveMeetingSpeakers({ botId: bot.id, noteId: bot.noteId, participants, segments }, log);
      if (saved.gone) {
        // The note was deleted while this ran: the audio just written goes too, and Recall's copy.
        await forgetMeeting({ bot, noteId: bot.noteId, reason: 'note_deleted', traceId, log });
        return res.status(200).json({ ok: true });
      }
      seconds = recordingSeconds(recording);
      if (seconds == null) {
        // Recall didn't say how long: the reservation is the most it can have run (the bot leaves at its end).
        seconds = bot.reservedMinutes * 60;
        log.warn({ reservedMinutes: bot.reservedMinutes }, 'notetaker_recording_length_unknown');
      }
      await repo.markBotIngested(bot.id, seconds);
      log.info({ bytes, seconds, participants: participants.length, segments: segments.length }, 'notetaker_recording_ingested');
    } else if (!bot.runQueuedAt) {
      bytes = await store.size(storagePath);
      if (bytes == null) {
        // Ingested, yet the object is gone before its run was queued: something removed it. Not a replay's to guess at.
        log.error({ storagePath }, 'notetaker_ingested_audio_missing');
        throw new Error('notetaker_ingested_audio_missing');
      }
    }

    const result = await queueNoteRun({
      firestore: getFirestore(),
      noteId: bot.noteId,
      workspaceId: bot.workspaceId,
      uid: bot.uid,
      type: 'online_meeting',
      storagePath,
      mimeType: 'audio/mpeg',
      ...(seconds ? { durationSec: seconds } : {}),
      probeSize: async () => bytes ?? 0,
      // Its minutes were reserved before it joined: a recorded meeting is never refused for quota or the daily
      // spend cap (the transcoder's own gate is the backstop), and the note is 'recording' until this ends it.
      quota: false,
      usageBudget: false,
      allowRecording: true,
      // Once per bot, decided in Postgres: a replay after the run finished is answered 'in_flight', not re-run.
      meetingBotId: bot.id,
      traceId,
      log,
    });
    if (result.kind === 'failed') {
      // Couldn't queue (Postgres, the task queue): the task retries, and the run is open again (markError).
      log.error({ kind: result.kind }, 'notetaker_kickoff_failed');
      throw new Error('notetaker_kickoff_failed');
    }
    if (result.kind === 'not_found' || result.kind === 'account_deleted') {
      // Deleted while this ran (the note, or the whole account after its own purge ran): nothing of it stays.
      const reason = result.kind === 'account_deleted' ? 'account_deleted' : 'note_deleted';
      await forgetMeeting({ bot, noteId: bot.noteId, reason, traceId, log });
      return res.status(200).json({ ok: true });
    }
    if (result.kind !== 'queued' && result.kind !== 'in_flight') {
      // Refused, with the note failed and saying why (quota:false skips the plan and spend-cap checks, so this
      // is the service misconfigured). Not retried; the audio is ours, so Recall's copy still goes.
      log.error({ kind: result.kind }, 'notetaker_kickoff_refused');
    }
    await purgeRecallCopy({ recallBotId: bot.recallBotId, reason: 'ingested', traceId, log });
    await endBot(bot, log);
    log.info({ kind: result.kind }, 'notetaker_ingest_done');
    return res.status(200).json({ ok: true });
  }

  // ── purge_media: retry Recall's deletions until each is confirmed ──
  // Run every 30 minutes by Cloud Scheduler (scheduler.tf). A purge is confirmed by `recording.deleted`, or here
  // once Recall shows the bot ended with nothing left; one asked for and never confirmed runs out of attempts
  // and alerts. A bot Recall says it doesn't have (404) is never taken as deleted: a wrong region or key says
  // the same, so it counts as a failed attempt and, in the end, a person's.

  // Recall's side of one purge: 'nothing_left' or 'requested'; throws what Recall refused.
  async function purgeAtRecall(recall, p, plog) {
    if (p.leaveCall) {
      try {
        await recall.leaveCall(p.recallBotId);
      } catch (err) {
        // silent-catch-ok: a bot not in a call (400) or unknown (404) has nothing to leave; logged, and anything else is rethrown
        if (!(err instanceof RecallError) || (err.status !== 400 && err.status !== 404)) throw err;
        plog.info({ status: err.status }, 'recall_leave_already_gone');
      }
    }
    if (nothingLeftAtRecall(await recall.getBot(p.recallBotId))) return 'nothing_left';
    await recall.deleteMedia(p.recallBotId);
    return 'requested';
  }

  async function purgeMedia(req, res) {
    const taskTraceId = traceIdFromTask(req.body, req.headers);
    const log = req.log.child({ traceId: taskTraceId });
    // One run at a time (a deletion's kick can land on the schedule's): each attempt counts against a purge.
    const locked = await repo.withRecallPurgeLock(() => purgeMediaRun(log, taskTraceId), { log });
    if (!locked.ran) {
      log.info({}, 'recall_purges_skipped_overlap');
      return res.status(200).json({ ok: true, skipped: true });
    }
    return res.status(200).json({ ok: true, ...locked.value });
  }

  async function purgeMediaRun(log, taskTraceId) {
    // A purge's lines carry the recording's trace (queued with it), so its deletion is on the same trail.
    const purgeFields = (p) => ({ recallBotId: p.recallBotId, ...(p.traceId ? { traceId: p.traceId, taskTraceId } : {}) });
    const pending = await repo.listPendingRecallPurges(PURGE_BATCH, PURGE_MAX_ATTEMPTS);
    let failed = 0;
    let unrecorded = 0;
    // Our side of it, after Recall's: a Postgres failure is logged and the batch goes on (the next run redoes it).
    const record = async (write, p, plog) => {
      try {
        await write();
      } catch (err) {
        unrecorded += 1;
        plog.error({ err, purgeId: p.id }, 'recall_purge_record_failed');
      }
    };
    if (pending.length) {
      const recall = await getRecall(log);
      for (const p of pending) {
        const plog = log.child(purgeFields(p));
        let outcome;
        try {
          outcome = await purgeAtRecall(recall, p, plog);
        } catch (err) {
          failed += 1;
          plog.warn({ err, status: err?.status, reason: p.reason, attempt: p.attempts + 1 }, 'recall_media_delete_failed');
          await record(() => repo.recordRecallPurgeAttempt(p.id, String(err?.message ?? err)), p, plog);
          continue;
        }
        if (outcome === 'nothing_left') {
          plog.info({ reason: p.reason }, 'recall_purge_nothing_left');
          await record(() => repo.confirmRecallPurge(p.recallBotId), p, plog);
        } else {
          plog.info({ reason: p.reason, attempt: p.attempts + 1 }, 'recall_media_delete_requested');
          await record(() => repo.recordRecallPurgeAttempt(p.id, null), p, plog);
        }
      }
    }
    // Out of attempts: a person's (the alert counts the line), with Recall's 72-hour retention behind it.
    for (const p of await repo.listExhaustedRecallPurges(PURGE_MAX_ATTEMPTS, PURGE_BATCH)) {
      log.child(purgeFields(p)).error({ reason: p.reason, attempts: p.attempts }, 'recall_purge_exhausted');
    }
    log.info({ tried: pending.length, failed, unrecorded }, 'recall_purges_run');
    return { tried: pending.length, failed, unrecorded };
  }

  return { ingest, purge_media: purgeMedia };
}
