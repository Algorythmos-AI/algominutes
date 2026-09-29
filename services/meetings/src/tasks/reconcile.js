// The notetaker's reconcile (docs/plans/MEETINGS.md "Failure handling"; RELEASE.md PR 21). Run every 15 minutes
// by Cloud Scheduler, like purge_media. Every step picks up work whose own task was lost, or never came:
//   1. a stored webhook still unprocessed after 30 minutes: its process_event task is enqueued again;
//   2. a bot still 'requested' after 15 minutes: its create_bot task is enqueued again;
//   3. a recorded meeting whose note never got its run, 45 minutes after it ended:
//      - both media in: the ingest was lost, and is enqueued again;
//      - otherwise Recall is asked, and a finished recording is marked ready and ingested;
//      - six hours on with no media, the note fails ("media never arrived") and Recall's copy is queued to go;
//   4. a bot sent to a meeting that hasn't moved in 3 hours and never recorded: Recall is asked how it ended.
// Each re-enqueue carries a name for this run (the step, the id, the 15-minute window), so two runs never
// double it and a later window can try again. Every task it starts is idempotent anyway.
import { createHash } from 'node:crypto';
import * as db from '@algominutes/db';
import loggerModule from '@algominutes/ai/logger.cjs';
import { failBot, recordedAtRecall, ingestTaskId } from './notetaker.js';
import { pickRecording } from './ingest.js';
import { failureReasonFor } from '../lib/recall-events.js';
import { RecallError } from '../lib/recall-client.js';

const { traceIdFromTask } = loggerModule;

export const RECONCILE_EVERY_MS = 15 * 60 * 1000;
export const EVENT_GRACE_MS = 30 * 60 * 1000;
export const REQUESTED_GRACE_MS = 15 * 60 * 1000;
export const MEDIA_WAIT_MS = 45 * 60 * 1000;
export const MEDIA_GIVE_UP_MS = 6 * 60 * 60 * 1000;
export const QUIET_BOT_MS = 3 * 60 * 60 * 1000;
// Recall statuses after which a bot does nothing more.
const RECALL_ENDED = new Set(['call_ended', 'done', 'fatal', 'media_expired']);

/** One name per step, id and 15-minute window: a hash in front, so the names don't share a prefix. */
export function reconcileTaskId(step, id, windowIndex) {
  const key = `${step}:${id}:${windowIndex}`;
  return `rc-${createHash('sha256').update(key).digest('hex').slice(0, 12)}-${step}-${String(id)}-${windowIndex}`;
}

export function createReconcileTasks({ getRecall, getFirestore, enqueue, repo = db, now = () => Date.now() }) {
  async function reconcile(req, res) {
    const taskTraceId = traceIdFromTask(req.body, req.headers);
    const log = req.log.child({ traceId: taskTraceId });
    const windowIndex = Math.floor(now() / RECONCILE_EVERY_MS);
    const counts = { events: 0, creates: 0, ingests: 0, mediaFound: 0, mediaNeverArrived: 0, quietEnded: 0, failed: 0 };
    let recall = null;
    const recallFor = async (l) => (recall ??= await getRecall(l));
    const botLog = (bot) => log.child({
      traceId: bot.traceId || taskTraceId, ...(bot.traceId ? { taskTraceId } : {}),
      meetingBotId: bot.id, userId: bot.uid, workspaceId: bot.workspaceId, noteId: bot.noteId,
    });
    // A step's list, then each item: either failing is logged and counted, and the run goes on.
    const each = async (step, list, fn) => {
      let items;
      try {
        items = await list();
      } catch (err) {
        counts.failed += 1;
        log.error({ err, step }, 'notetaker_reconcile_step_failed');
        return;
      }
      for (const item of items) {
        try {
          await fn(item);
        } catch (err) {
          counts.failed += 1;
          const fields = item.uid ? {} : { recallEventId: item.id, meetingBotId: item.meetingBotId ?? null, recallBotId: item.recallBotId ?? null };
          (item.uid ? botLog(item) : log).error({ err, step, ...fields }, 'notetaker_reconcile_item_failed');
        }
      }
    };

    // 1. Webhooks whose task was lost.
    await each('events', () => repo.listUnprocessedRecallEvents(EVENT_GRACE_MS, 100), async (ev) => {
      await enqueue('process_event', { recallEventId: ev.id }, { traceId: taskTraceId, log, taskId: reconcileTaskId('event', ev.id, windowIndex) });
      counts.events += 1;
    });

    // 2. Bots never sent to Recall.
    await each('requested', () => repo.listStaleRequestedBots(REQUESTED_GRACE_MS, 50), async (bot) => {
      const blog = botLog(bot);
      await enqueue('create_bot', { meetingBotId: bot.id }, { traceId: bot.traceId || taskTraceId, log: blog, taskId: reconcileTaskId('create', bot.id, windowIndex) });
      counts.creates += 1;
      blog.warn({}, 'notetaker_create_redriven');
    });

    // 3. Recorded meetings whose note never got its run.
    await each('stalled', () => repo.listStalledNotetakers(MEDIA_WAIT_MS, 50), async (bot) => {
      const blog = botLog(bot);
      // Under the ingest's own name: one still retrying isn't doubled (the name is taken until it's done),
      // and one out of attempts is taken up again once Cloud Tasks frees the name.
      const ingest = () => enqueue('ingest', { meetingBotId: bot.id }, { traceId: bot.traceId || taskTraceId, log: blog, taskId: ingestTaskId(bot.id) });
      if (!bot.noteId) {
        // Its note was deleted while it recorded: its ingest takes the meeting with it (Recall's copy, any audio)
        // and ends the bot, media or not.
        await ingest();
        counts.ingests += 1;
        blog.warn({}, 'notetaker_deleted_meeting_redriven');
        return;
      }
      if (bot.audioReady && bot.participantsReady) {
        await ingest();
        counts.ingests += 1;
        blog.warn({ endedAt: bot.endedAt }, 'notetaker_ingest_redriven');
        return;
      }
      if (Date.parse(bot.endedAt) < now() - MEDIA_GIVE_UP_MS) {
        // The recording's media never came: the note says so, Recall's copy is queued to go, nothing is charged.
        await failBot({ repo, firestore: getFirestore(), bot, reason: 'error', log: blog });
        counts.mediaNeverArrived += 1;
        blog.error({ endedAt: bot.endedAt }, 'notetaker_media_never_arrived');
        return;
      }
      const { recording } = pickRecording(await (await recallFor(blog)).getBot(bot.recallBotId));
      if (!recording) return;
      // Recall has it; its webhooks didn't reach us.
      await repo.markBotMediaReady(bot.id, 'audio');
      await repo.markBotMediaReady(bot.id, 'participants');
      await ingest();
      counts.mediaFound += 1;
      blog.warn({ endedAt: bot.endedAt }, 'notetaker_media_found_by_reconcile');
    });

    // 4. Bots in a meeting, silent for hours, that never recorded.
    await each('quiet', () => repo.listQuietLiveBots(QUIET_BOT_MS, 50), async (bot) => {
      const blog = botLog(bot);
      let recallBot;
      try {
        recallBot = await (await recallFor(blog)).getBot(bot.recallBotId);
      } catch (err) {
        // silent-catch-ok: a bot Recall has no record of (404, deleted before it joined) ended without recording; failed below and logged; anything else is rethrown
        if (!(err instanceof RecallError) || err.status !== 404) throw err;
        recallBot = { recordings: [], status_changes: [{ code: 'done', sub_code: null }] };
        blog.warn({ recallBotId: bot.recallBotId }, 'notetaker_quiet_bot_unknown_to_recall');
      }
      const changes = Array.isArray(recallBot?.status_changes) ? recallBot.status_changes : [];
      const last = changes[changes.length - 1];
      if (!RECALL_ENDED.has(last?.code)) return; // still in the meeting: its own timeout ends it
      const { recorded, startedAt } = recordedAtRecall(recallBot);
      if (recorded) {
        // It recorded after all: the recording's end is the normal one, and step 3 takes it from there.
        await repo.advanceNotetaker(getFirestore(), {
          botId: bot.id, status: 'call_ended', recordingStartedAt: startedAt ?? undefined,
          recordingEndedAt: last?.created_at ? new Date(last.created_at) : new Date(now()),
        }, blog);
      } else {
        await failBot({ repo, firestore: getFirestore(), bot, reason: failureReasonFor(last?.sub_code ?? null), log: blog });
      }
      counts.quietEnded += 1;
      blog.warn({ recallStatus: last?.code, recorded }, 'notetaker_quiet_bot_reconciled');
    });

    log.info(counts, 'notetaker_reconciled');
    // A run with failures answers 500, so Cloud Scheduler records it; the next run tries again.
    return res.status(counts.failed ? 500 : 200).json({ ok: counts.failed === 0, ...counts });
  }

  return { reconcile };
}
