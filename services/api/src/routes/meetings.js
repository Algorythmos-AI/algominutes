// POST /v1/meetings/bots and POST /v1/meetings/bots/:botId/cancel — the
// online-meeting notetaker (docs/plans/MEETINGS.md, M1).
//
// The api never calls Recall: it encrypts the meeting link (Cloud KMS, bound to
// the new bot's id), reserves the notetaker (repo: idempotency, the duplicate
// check, the caps, the minutes, all under the workspace's lock), creates the
// bot's note, and enqueues services/meetings' create_bot task. A retry with the
// same requestId finds the same bot and re-ensures its note and its task, so a
// crash between those steps heals on the client's retry.
import { randomUUID } from 'node:crypto';
import { getFirestore } from 'firebase-admin/firestore';
import { CreateMeetingBotRequest } from '@algominutes/contracts/schemas';
import {
  reserveMeetingBot, createServerNote, noteIdForBot, requestBotCancel, toNotetakerStatus, WorkspaceBoundaryError,
} from '@algominutes/db';
import cloudTasksModule from '@algominutes/ai/cloud-tasks.cjs';
import meetingUrlCryptoModule from '@algominutes/ai/meeting-url-crypto.cjs';
import { notetakerFor } from './app-config.js';

const { enqueueTask } = cloudTasksModule;
const { createMeetingUrlCrypto } = meetingUrlCryptoModule;

const DISABLED = { error: "The notetaker isn't available yet.", code: 'feature_disabled' };
const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A meeting may run this long before the notetaker leaves (the plan's per-recording cap).
const MAX_MEETING_MINUTES = 240;

/** The platform a meeting link is on, or null. M1 accepts Google Meet only. */
export function platformOf(meetingUrl) {
  let u;
  try {
    u = new URL(meetingUrl);
  } catch {
    // silent-catch-ok: not a URL is the client's input error, answered 400 by the caller.
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'meet.google.com') return 'google_meet';
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) return 'zoom';
  if (host === 'teams.microsoft.com' || host === 'teams.live.com') return 'teams';
  if (host.endsWith('.webex.com')) return 'webex';
  return null;
}
export const SUPPORTED_PLATFORMS = new Set(['google_meet']);

let crypto;
const getCrypto = (env) => (crypto ??= createMeetingUrlCrypto({ keyName: env.MEETING_URL_KMS_KEY }));

/** A non-negative whole number from the env, or the default: "0" means none, not the default. */
export function envCount(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** The first of this UTC month: the notetaker allowance's period. */
export function periodStartOf(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Run the notetaker's purge worker now, after a deletion queued Recall purges in its own transaction (a bot
 * still in the meeting leaves, Recall's copy goes). Its 30-minute schedule is the backstop, so a failure here
 * is logged, never the deletion's.
 */
export async function runRecallPurgesSoon(env, { traceId, log }) {
  if (!env.MEETINGS_URL) {
    // Purges are queued but there's no meetings service to run them now: misconfigured, as notetaker_misconfigured.
    log.error({}, 'recall_purges_not_started');
    return false;
  }
  try {
    // One kick per 5 minutes: a run of deletions starts the worker once (it also holds a lock per run).
    await enqueueMeetingsTask(env, 'purge_media', undefined, { traceId, log, taskId: `purge-kick-${Math.floor(Date.now() / 300_000)}` });
    log.info({}, 'recall_purges_started');
    return true;
  } catch (err) {
    log.warn({ err }, 'recall_purges_start_failed');
    return false;
  }
}

function enqueueMeetingsTask(env, kind, meetingBotId, { traceId, log, taskId }) {
  return enqueueTask({
    projectId: env.TASKS_PROJECT,
    location: env.TASKS_LOCATION,
    queue: env.MEETINGS_QUEUE || 'meetings',
    targetUrl: `${String(env.MEETINGS_URL || '').replace(/\/+$/, '')}/tasks/${kind}`,
    oidcServiceAccount: env.JOBS_SA_EMAIL,
    payload: { kind, meetingBotId },
    traceId,
    log,
    taskId,
  });
}

export function createMeetingRoutes({ env = process.env, firestore = () => getFirestore(), crypto: urlCrypto, now = () => new Date(), deps = {} } = {}) {
  const repo = { reserveMeetingBot, createServerNote, requestBotCancel, ...deps };
  const allowed = async (req) => (await notetakerFor(req.uid, env, { isTester: deps.isTester, log: req.log })).bot;
  const enqueue = deps.enqueue ?? ((kind, id, o) => enqueueMeetingsTask(env, kind, id, o));
  const cryptoOf = () => urlCrypto ?? getCrypto(env);

  async function createMeetingBotRoute(req, res) {
    const uid = req.uid;
    if (!(await allowed(req))) {
      req.log.info({ route: 'create_bot' }, 'notetaker_disabled');
      return res.status(503).json(DISABLED);
    }
    if (!env.MEETINGS_URL || !env.MEETING_URL_KMS_KEY) {
      // Switched on without the service it needs: off, and loudly.
      req.log.error({ route: 'create_bot' }, 'notetaker_misconfigured');
      return res.status(503).json(DISABLED);
    }
    const parsed = CreateMeetingBotRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'A meeting link and a request id are required.' });
    const { meetingUrl, requestId } = parsed.data;
    const platform = platformOf(meetingUrl);
    if (!platform) return res.status(400).json({ error: "That doesn't look like a meeting link." });
    if (!SUPPORTED_PLATFORMS.has(platform)) return res.status(400).json({ error: 'The notetaker joins Google Meet meetings for now.' });

    // The caller's own workspace, as every note route (process-intelligence).
    // req.log already carries userId (auth middleware).
    const workspaceId = `workspace_${uid}`;
    const log = req.log.child({ workspaceId, platform });
    const botId = randomUUID();
    let ciphertext;
    try {
      ciphertext = await cryptoOf().encrypt(meetingUrl, botId);
    } catch (err) {
      log.error({ err }, 'meeting_url_encrypt_failed');
      return res.status(503).json({ error: "The notetaker isn't available right now. Please try again shortly." });
    }

    let r;
    try {
      r = await repo.reserveMeetingBot({
        botId, uid, email: req.authEmail, name: req.authName, workspaceId, requestId, platform, meetingUrl,
        meetingUrlCiphertext: ciphertext,
        allowanceMinutes: envCount(env.NOTETAKER_MONTHLY_MINUTES, 600),
        periodStart: periodStartOf(now()),
        maxMeetingMinutes: MAX_MEETING_MINUTES,
        maxActiveGlobal: envCount(env.NOTETAKER_MAX_ACTIVE, 20),
        noticeVersion: 'notice-v1',
        traceId: req.traceId,
      }, log);
    } catch (err) {
      if (err instanceof WorkspaceBoundaryError || err?.code === 'WORKSPACE_BOUNDARY') {
        log.warn({ err, meetingBotId: botId }, 'notetaker_workspace_boundary');
        return res.status(403).json({ error: 'Workspace mismatch' });
      }
      if (err?.code === 'ACCOUNT_DELETED') {
        log.warn({ meetingBotId: botId }, 'notetaker_account_deleted');
        return res.status(401).json({ error: 'account_deleted' });
      }
      log.error({ err, meetingBotId: botId }, 'notetaker_reserve_failed');
      return res.status(500).json({ error: "We couldn't send the notetaker. Please try again." });
    }
    let healed = false;
    switch (r.kind) {
      case 'duplicate_active':
        // Still 'requested' and ours: an earlier attempt (another request id)
        // stopped before its task was queued. Heal it like a retry, rather
        // than leave the user a 409 for a bot that is going nowhere.
        if (r.bot.status === 'requested' && r.bot.uid === uid) {
          healed = true;
          break;
        }
        return res.status(409).json({ error: 'A notetaker is already on its way to this meeting.', botId: r.bot.id, noteId: r.bot.noteId });
      case 'too_many':
        return res.status(429).json({ error: 'You already have two notetakers in meetings.' });
      case 'busy':
        return res.status(503).json({ error: 'The notetaker is busy right now. Please try again in a few minutes.' });
      case 'quota_exhausted':
        return res.status(402).json({ error: 'quota_exceeded', message: "You've used this month's notetaker minutes." });
      default:
        break; // 'reserved' or 'existing': ensure the note and the task below
    }

    const bot = r.bot;
    const noteId = noteIdForBot(bot.id);
    const blog = log.child({ meetingBotId: bot.id, noteId });
    // The note (Postgres, then its mirror doc) always exists before create_bot
    // is queued: a bot never joins a meeting with no note to put it in.
    let created;
    try {
      created = await repo.createServerNote(firestore(), {
        botId: bot.id, noteId, workspaceId, uid, email: req.authEmail, name: req.authName,
        title: parsed.data.title || 'Meeting notes',
        sourceType: 'online_meeting', sourceKind: 'bot', platform: bot.platform,
        notetaker: { botId: bot.id, status: toNotetakerStatus(bot.status), platform: bot.platform },
      }, blog);
    } catch (err) {
      // The bot is reserved; the client's retry (same request id) finishes this.
      blog.error({ err }, 'notetaker_note_create_failed');
      return res.status(500).json({ error: "We couldn't send the notetaker. Please try again." });
    }
    if (created.deleted) {
      // An earlier attempt may already have queued create_bot: stop the bot,
      // so nothing records into a note the user deleted.
      if (!TERMINAL.has(bot.status)) {
        try {
          await repo.requestBotCancel(bot.id, workspaceId, uid);
          await enqueue('cancel_bot', bot.id, { traceId: req.traceId, log: blog, taskId: `cancel-${bot.id}` });
        } catch (err) {
          // create_bot also refuses a bot whose note is gone.
          blog.error({ err }, 'notetaker_deleted_note_cancel_failed');
        }
      }
      return res.status(410).json({ error: "This notetaker's note was deleted." });
    }
    if (!TERMINAL.has(bot.status)) {
      try {
        await enqueue('create_bot', bot.id, { traceId: req.traceId, log: blog, taskId: `create-${bot.id}` });
      } catch (err) {
        blog.error({ err }, 'create_bot_enqueue_failed');
        return res.status(500).json({ error: "We couldn't send the notetaker. Please try again." });
      }
    }
    blog.info({ reused: r.kind === 'existing', healed }, 'notetaker_requested');
    return res.status(202).json({ botId: bot.id, noteId, status: toNotetakerStatus(bot.status) });
  }

  async function cancelMeetingBotRoute(req, res) {
    const uid = req.uid;
    if (!(await allowed(req))) {
      req.log.info({ route: 'cancel_bot' }, 'notetaker_disabled');
      return res.status(503).json(DISABLED);
    }
    const botId = String(req.params.botId || '');
    if (!UUID_RE.test(botId)) return res.status(404).json({ error: 'No such notetaker' });
    const workspaceId = `workspace_${uid}`;
    let bot;
    try {
      bot = await repo.requestBotCancel(botId, workspaceId, uid);
    } catch (err) {
      req.log.error({ err, workspaceId, meetingBotId: botId }, 'notetaker_cancel_failed');
      return res.status(500).json({ error: "We couldn't cancel the notetaker. Please try again." });
    }
    if (!bot) return res.status(404).json({ error: 'No such notetaker' });
    const log = req.log.child({ workspaceId, meetingBotId: botId, noteId: bot.noteId });
    if (!TERMINAL.has(bot.status) && bot.cancelRequested) {
      try {
        await enqueue('cancel_bot', botId, { traceId: req.traceId, log, taskId: `cancel-${botId}` });
      } catch (err) {
        // cancel_requested is set, so a create still in flight stops anyway;
        // for a bot already sent, the client's retry enqueues this again.
        log.error({ err }, 'cancel_bot_enqueue_failed');
        return res.status(500).json({ error: "We couldn't cancel the notetaker. Please try again." });
      }
      log.info({}, 'notetaker_cancel_requested');
    }
    return res.status(200).json({ botId, status: toNotetakerStatus(bot.status) });
  }

  return { createMeetingBotRoute, cancelMeetingBotRoute };
}

const routes = createMeetingRoutes();
export const createMeetingBotRoute = (req, res) => routes.createMeetingBotRoute(req, res);
export const cancelMeetingBotRoute = (req, res) => routes.cancelMeetingBotRoute(req, res);
