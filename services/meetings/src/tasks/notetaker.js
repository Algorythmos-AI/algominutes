// The notetaker's Cloud Tasks (docs/plans/MEETINGS.md): create a Recall bot,
// cancel one, and act on a stored webhook. Every one is idempotent (Cloud Tasks
// replays are normal) and carries the ids only; nothing here holds a meeting
// link except in memory, decrypted just before Recall needs it.
import * as db from '@algominutes/db';
import noteTerminalModule from '@algominutes/db/note-terminal.cjs';
import { RecallError, botCreateParams } from '../lib/recall-client.js';
import { actionFor, FAILURE_MESSAGES } from '../lib/recall-events.js';
import { botNameFor, noticeFor } from '../lib/notice.js';
import loggerModule from '@algominutes/ai/logger.cjs';

const { isFinalAttempt } = noteTerminalModule;
const { traceIdFromTask } = loggerModule;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

// Every line about a bot carries the trace of the request that sent it, so one
// recording is followable end to end (CLAUDE.md); a task started elsewhere (a
// webhook) keeps its own trace alongside. Validated like every other worker's.
function childLog(req, bot, extra = {}) {
  const carried = traceIdFromTask(req.body, req.headers);
  const traceId = bot?.traceId || carried;
  return req.log.child({
    traceId, ...(carried !== traceId ? { taskTraceId: carried } : {}),
    meetingBotId: bot?.id, userId: bot?.uid, workspaceId: bot?.workspaceId, noteId: bot?.noteId, ...extra,
  });
}

// Before a bot is found: the task's own trace, and its id only if it is one.
function taskLog(req) {
  return req.log.child({ traceId: traceIdFromTask(req.body, req.headers) });
}
const loggableId = (id) => (typeof id === 'string' && UUID_RE.test(id) ? id : 'invalid');

// The note's words for how a bot ended.
export const messageFor = (status, reason) =>
  FAILURE_MESSAGES[status === 'cancelled' ? 'cancelled' : reason] || FAILURE_MESSAGES.error;

/**
 * The bot ended without a recording. The repo does the whole of it in one
 * transaction (bot terminal, note failed, Recall's copy queued for deletion),
 * then the mirror; run again on a bot already failed, it only finishes the
 * mirror. Nothing is charged.
 */
export async function failBot({ repo, firestore, bot, reason, log }) {
  const status = reason === 'cancelled' ? 'cancelled' : 'failed';
  const { changed, bot: final } = await repo.failNotetaker(firestore, {
    botId: bot.id, status, failureReason: status === 'failed' ? reason : null, messageFor,
  }, log);
  if (changed) log.warn({ reason }, status === 'cancelled' ? 'notetaker_cancelled' : 'notetaker_failed');
  else log.info({ status: final?.status, failureReason: final?.failureReason }, 'notetaker_end_already_recorded');
}

const ENDED_WITHOUT_RECORDING = new Set(['failed', 'cancelled']);

/**
 * Whether Recall made a recording, from Recall itself: webhooks arrive in any
 * order (and a redelivery can be hours late), so an ending that arrives before
 * the recording event mustn't be read as "never recorded".
 */
export function recordedAtRecall(recallBot) {
  const recordings = Array.isArray(recallBot?.recordings) ? recallBot.recordings : [];
  const changes = Array.isArray(recallBot?.status_changes) ? recallBot.status_changes : [];
  const startedAt = recordings.map((x) => x?.started_at).find(Boolean) || changes.find((c) => c?.code === 'in_call_recording')?.created_at;
  const recorded = recordings.length > 0 || changes.some((c) => c?.code === 'in_call_recording');
  const at = startedAt ? new Date(startedAt) : null;
  return { recorded, startedAt: at && !Number.isNaN(at.getTime()) ? at : null };
}

// Recall's answers that mean the bot is already where we want it. Anything
// else non-transient (401/403: our key or region; 422: a request we got wrong)
// is a fault, logged and retried, never taken for "gone". Confirmed against
// the live API in the M0 spike (docs/plans/MEETINGS.md).
const GONE_ON_DELETE = new Set([404]);         // no such bot
const DISPATCHED_ON_DELETE = new Set([405]);   // already joining: it must leave instead
const GONE_ON_LEAVE = new Set([400, 404]);     // not in a call (any more), or no such bot

function recallFault(err, log, recallBotId, event) {
  const auth = err instanceof RecallError && (err.status === 401 || err.status === 403);
  log.error({ err, recallBotId, status: err?.status }, auth ? 'recall_auth_failed' : event);
  return err;
}

/** Make a Recall bot leave the call; true if it did or already had. */
async function leaveCall(recall, recallBotId, log) {
  try {
    await recall.leaveCall(recallBotId);
  } catch (err) {
    if (!(err instanceof RecallError) || !GONE_ON_LEAVE.has(err.status)) throw recallFault(err, log, recallBotId, 'recall_leave_failed');
    log.info({ recallBotId, status: err.status }, 'recall_leave_already_gone');
  }
}

// A Recall bot we must not keep: delete it if it hasn't been dispatched, or
// make it leave. A duplicate a replay made also has anything it recorded
// queued for deletion (purge); our own bot's is queued by failNotetaker.
async function removeRecallBot({ recall, repo, recallBotId, traceId, log, purge = true }) {
  try {
    await recall.deleteBot(recallBotId);
  } catch (err) {
    // silent-catch-ok: a dispatched bot is made to leave instead, and one already gone is what was wanted; recall_extra_bot_removed logs both below
    if (err instanceof RecallError && DISPATCHED_ON_DELETE.has(err.status)) {
      await leaveCall(recall, recallBotId, log);
      if (purge) await repo.enqueueRecallPurge(null, { recallBotId, reason: 'failed', traceId });
    } else if (!(err instanceof RecallError) || !GONE_ON_DELETE.has(err.status)) {
      throw recallFault(err, log, recallBotId, 'recall_delete_bot_failed');
    }
  }
  log.warn({ recallBotId }, 'recall_extra_bot_removed');
}

const attemptOf = (req) => Number(req.headers?.['x-cloudtasks-taskretrycount'] ?? 0);

/** One ingest per bot: a second event (or a replay) that finds both media ready is dropped by the task's name. */
export const ingestTaskId = (botId) => `ingest-${botId}`;

export function createNotetakerTasks({ getRecall, getCrypto, getFirestore, enqueue, env = process.env, repo = db }) {
  // Recall bots made for one of ours that we never attached (found by our id).
  async function removeStrays({ bot, log }) {
    const recall = await getRecall(log);
    for (const stray of await recall.findBotsByMetadata('meeting_bot_id', bot.id)) {
      await removeRecallBot({ recall, repo, recallBotId: stray.id, traceId: bot.traceId, log });
    }
  }

  // ── create_bot: adopt-or-create, because Recall's Idempotency-Key only lasts an hour ──
  async function createBot(req, res) {
    const bot = await repo.getMeetingBotById(String(req.body?.meetingBotId || ''));
    if (!bot) {
      taskLog(req).warn({ meetingBotId: loggableId(req.body?.meetingBotId) }, 'create_bot_unknown');
      return res.status(200).json({ ok: true });
    }
    const log = childLog(req, bot);
    const firestore = getFirestore();
    if (TERMINAL.has(bot.status)) {
      log.info({ status: bot.status }, 'create_bot_already_terminal');
      if (ENDED_WITHOUT_RECORDING.has(bot.status)) {
        // An earlier attempt may have ended it without finishing the mirror,
        // or made a Recall bot and crashed before attaching it: find and
        // remove any, so nothing joins a meeting for a bot that has ended.
        await failBot({ repo, firestore, bot, reason: bot.failureReason || bot.status, log });
        if (!bot.recallBotId) await removeStrays({ bot, log });
      }
      return res.status(200).json({ ok: true });
    }
    if (!bot.noteId) {
      // The api creates the note before it queues this task, so no note here
      // means it was deleted: nothing may record into it.
      log.warn({}, 'create_bot_note_gone');
      if (bot.recallBotId) await cancelWithRecall({ recall: await getRecall(log), bot, firestore, log });
      else await failBot({ repo, firestore, bot, reason: 'cancelled', log });
      return res.status(200).json({ ok: true });
    }
    try {
      const recall = await getRecall(log);
      let recallBotId = bot.recallBotId;
      if (!recallBotId) {
        // A replay after Recall made the bot (the key lapsed, or we crashed
        // before saving its id): find it by our own id, and keep only one.
        const found = await recall.findBotsByMetadata('meeting_bot_id', bot.id);
        if (found.length) {
          recallBotId = found[0].id;
          for (const extra of found.slice(1)) await removeRecallBot({ recall, repo, recallBotId: extra.id, traceId: bot.traceId, log });
          log.info({ recallBotId }, 'recall_bot_adopted');
        }
      }
      if (!recallBotId) {
        if (bot.cancelRequested) {
          await failBot({ repo, firestore, bot, reason: 'cancelled', log });
          return res.status(200).json({ ok: true });
        }
        const ciphertext = await repo.getBotMeetingUrlCiphertext(bot.id);
        if (!ciphertext) {
          log.error({}, 'create_bot_no_meeting_link');
          await failBot({ repo, firestore, bot, reason: 'error', log });
          return res.status(200).json({ ok: true });
        }
        const meetingUrl = await getCrypto().decrypt(ciphertext, bot.id);
        const owner = await repo.getBotOwnerName(bot.id);
        try {
          const created = await recall.createBot(botCreateParams({
            meetingUrl,
            botName: botNameFor(owner),
            meetingBotId: bot.id,
            workspaceId: bot.workspaceId,
            env: env.ALGOMINUTES_ENV,
            reservedMinutes: bot.reservedMinutes,
            notice: noticeFor(owner),
          }), bot.id);
          recallBotId = created.id;
          log.info({ recallBotId }, 'recall_bot_created');
        } catch (err) {
          const auth = err instanceof RecallError && (err.status === 401 || err.status === 403);
          if (err instanceof RecallError && !err.transient && !auth) {
            // Recall refused the request itself (400: a link it can't join): no
            // retry changes that. Our key or region being wrong (401/403) is
            // ours to fix, so that is retried, and alerts, instead. The error's
            // message is its method and path only; never its body, which (for a
            // refused link) is the reply most likely to quote the link.
            log.warn({ err, status: err.status, platform: bot.platform }, 'recall_bot_refused');
            await failBot({ repo, firestore, bot, reason: err.status === 400 ? 'meeting_not_found' : 'error', log });
            return res.status(200).json({ ok: true });
          }
          if (auth) log.error({ err, status: err.status }, 'recall_auth_failed');
          throw err;
        }
      }
      const attach = await repo.attachRecallBot(bot.id, recallBotId);
      if (!attach.attached && attach.recallBotId !== recallBotId) {
        // Ours already has a different Recall bot, or ended while Recall made
        // this one (a cancel): this one would join untracked. Remove it, and
        // anything it recorded.
        await removeRecallBot({ recall, repo, recallBotId, traceId: bot.traceId, log });
      }
      if (attach.terminal) {
        log.info({ recallBotId }, 'create_bot_ended_meanwhile');
        return res.status(200).json({ ok: true });
      }
      await repo.advanceNotetaker(firestore, { botId: bot.id, status: 'scheduled' }, log);
      // A cancel that arrived while this ran.
      const now = await repo.getMeetingBotById(bot.id);
      if (now?.cancelRequested && !TERMINAL.has(now.status)) await cancelWithRecall({ recall, bot: now, firestore, log });
      return res.status(200).json({ ok: true });
    } catch (err) {
      if (isFinalAttempt(req.headers)) {
        // Out of retries: say so on the note rather than leave it waiting.
        log.error({ err, attempt: attemptOf(req) }, 'create_bot_gave_up');
        await failBot({ repo, firestore, bot: (await repo.getMeetingBotById(bot.id)) || bot, reason: 'error', log });
        return res.status(200).json({ ok: true });
      }
      log.warn({ err, attempt: attemptOf(req) }, 'create_bot_attempt_failed');
      throw err;
    }
  }

  // Before the recording starts, a cancel removes the bot and ends the note;
  // once it's recording, the bot leaves and what it recorded becomes the note.
  async function cancelWithRecall({ recall, bot, firestore, log }) {
    if (bot.statusRank < repo.BOT_STATUS_RANK.recording) {
      await removeRecallBot({ recall, repo, recallBotId: bot.recallBotId, traceId: bot.traceId, log, purge: false });
      await failBot({ repo, firestore, bot, reason: 'cancelled', log });
    } else {
      await leaveCall(recall, bot.recallBotId, log);
      log.info({}, 'notetaker_asked_to_leave');
    }
  }

  // ── cancel_bot ──
  async function cancelBot(req, res) {
    const bot = await repo.getMeetingBotById(String(req.body?.meetingBotId || ''));
    if (!bot) {
      taskLog(req).warn({ meetingBotId: loggableId(req.body?.meetingBotId) }, 'cancel_bot_unknown');
      return res.status(200).json({ ok: true });
    }
    const log = childLog(req, bot);
    const firestore = getFirestore();
    if (TERMINAL.has(bot.status)) {
      log.info({ status: bot.status }, 'cancel_bot_already_terminal');
      if (ENDED_WITHOUT_RECORDING.has(bot.status)) await failBot({ repo, firestore, bot, reason: bot.failureReason || bot.status, log });
      return res.status(200).json({ ok: true });
    }
    try {
      if (!bot.recallBotId) {
        // create_bot hasn't made it yet: it sees cancel_requested and stops there.
        // (If create_bot has given up, the bot is already terminal.)
        await failBot({ repo, firestore, bot, reason: 'cancelled', log });
        return res.status(200).json({ ok: true });
      }
      await cancelWithRecall({ recall: await getRecall(log), bot, firestore, log });
      return res.status(200).json({ ok: true });
    } catch (err) {
      log.warn({ err, attempt: attemptOf(req) }, 'cancel_bot_attempt_failed');
      throw err;
    }
  }

  // ── process_event: act on one stored Recall webhook ──
  async function processEvent(req, res) {
    const ev = await repo.getRecallEvent(Number(req.body?.recallEventId));
    if (!ev || ev.processed) return res.status(200).json({ ok: true });
    const bot = (ev.meetingBotId && (await repo.getMeetingBotById(ev.meetingBotId)))
      || (ev.recallBotId && (await repo.getMeetingBotByRecallId(ev.recallBotId)))
      || null;
    if (!bot) {
      taskLog(req).warn({ recallEventId: ev.id, event: ev.event, recallBotId: ev.recallBotId, meetingBotId: ev.meetingBotId }, 'recall_event_unknown_bot');
      await repo.markRecallEventProcessed(ev.id);
      return res.status(200).json({ ok: true });
    }
    const log = childLog(req, bot, { recallEventId: ev.id, event: ev.event });
    try {
      const firestore = getFirestore();
      let action = actionFor(ev, bot);
      if (action.kind === 'fail' && action.unlessRecorded && bot.recallBotId) {
        const { recorded, startedAt } = recordedAtRecall(await (await getRecall(log)).getBot(bot.recallBotId));
        if (recorded) {
          // The recording's own event is late: this is the normal end, and ingest follows.
          log.warn({}, 'notetaker_recorded_out_of_order');
          action = ev.event === 'bot.call_ended'
            ? { kind: 'advance', status: 'call_ended', recordingStartedAt: startedAt ?? undefined, recordingEndedAt: ev.occurredAt ?? undefined }
            : { kind: 'ignore' };
        }
      }
      if (action.consent) await repo.recordConsentEvent(bot.id, action.consent);
      switch (action.kind) {
        case 'advance':
          await repo.advanceNotetaker(firestore, {
            botId: bot.id, status: action.status,
            recordingStartedAt: action.recordingStartedAt, recordingEndedAt: action.recordingEndedAt,
          }, log);
          break;
        case 'fail':
          // A bot already failed only has its mirror finished; one that recorded is left alone.
          if (bot.status !== 'done') await failBot({ repo, firestore, bot, reason: action.reason, log });
          break;
        case 'media_ready': {
          const now = await repo.markBotMediaReady(bot.id, action.what);
          log.info({ what: action.what, audioReady: now?.audioReady, participantsReady: now?.participantsReady }, 'notetaker_media_ready');
          // Ingest starts once both are ready (tasks/ingest.js). The two events can be processed at once; each
          // one's update waits for the other's, so the later always sees both.
          if (now?.audioReady && now?.participantsReady && !now.ingestedAt) {
            await enqueue('ingest', { meetingBotId: bot.id }, { traceId: bot.traceId || undefined, log, taskId: ingestTaskId(bot.id) });
            log.info({}, 'notetaker_ingest_enqueued');
          }
          break;
        }
        case 'media_failed':
          if (bot.status !== 'done') await failBot({ repo, firestore, bot, reason: 'error', log });
          break;
        case 'media_deleted':
          if (bot.recallBotId) await repo.confirmRecallPurge(bot.recallBotId);
          break;
        default:
          break;
      }
      await repo.markRecallEventProcessed(ev.id);
      log.info({ action: action.kind }, 'recall_event_processed');
    } catch (err) {
      log.warn({ err, attempt: attemptOf(req) }, 'process_event_attempt_failed');
      throw err;
    }
    return res.status(200).json({ ok: true });
  }

  return { create_bot: createBot, cancel_bot: cancelBot, process_event: processEvent };
}
