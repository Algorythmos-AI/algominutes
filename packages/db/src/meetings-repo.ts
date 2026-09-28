/**
 * The online-meeting notetaker's data (docs/plans/MEETINGS.md, migration 023).
 *
 * Every write to meeting_bots, recall_events, meeting_participants,
 * meeting_speaker_segments, meeting_consents and recall_purges goes through
 * here. The rules the tables and these functions enforce together:
 *   - one bot gives one note in one workspace, owned by the user who sent it;
 *   - a bot's status only moves forward, and a terminal one never changes, so
 *     Recall's webhooks can arrive in any order and any number of times;
 *   - a webhook is stored once, by its id;
 *   - notetaker minutes are reserved when a bot is sent, under a per-workspace
 *     lock, so two parallel requests can't both spend the last of them.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, isPostgresEnabled, withTx } from './db.js';

type Log = { error: (o: any, m?: string) => void };

/** Server-side bot states, in the order they can happen. */
export const BOT_STATUS_RANK = Object.freeze({
  requested: 0,
  scheduled: 10,
  joining: 20,
  waiting_room: 30,
  in_call: 40,
  recording: 50,
  call_ended: 60,
  processing: 70,
  done: 100,
  failed: 100,
  cancelled: 100,
} as const);
export type BotStatus = keyof typeof BOT_STATUS_RANK;
export const TERMINAL_BOT_STATUSES: readonly BotStatus[] = ['done', 'failed', 'cancelled'];
const TERMINAL_SQL = `('done', 'failed', 'cancelled')`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The contract's NotetakerStatus for a server status (schemas/meetings.ts):
 * the client-facing names, fewer of them.
 */
export function toNotetakerStatus(status: BotStatus): string {
  if (status === 'requested') return 'scheduled';
  if (status === 'call_ended') return 'processing';
  return status;
}

/** At most this many live bots per user (plan: quota and concurrency). */
export const MAX_ACTIVE_BOTS_PER_USER = 2;
/** A bot is only sent with at least this many notetaker minutes left. */
export const MIN_RESERVE_MINUTES = 15;

export interface MeetingBot {
  id: string;
  uid: string;
  workspaceId: string;
  noteId: string | null;
  recallBotId: string | null;
  platform: string;
  status: BotStatus;
  failureReason: string | null;
  cancelRequested: boolean;
  reservedMinutes: number;
  billableSeconds: number | null;
  audioReady: boolean;
  participantsReady: boolean;
  ingestedAt: string | null;
  traceId: string | null;
}

function toBot(r: any): MeetingBot {
  return {
    id: r.id,
    uid: r.uid,
    workspaceId: r.workspace_id,
    noteId: r.note_id ?? null,
    recallBotId: r.recall_bot_id ?? null,
    platform: r.platform,
    status: r.status,
    failureReason: r.failure_reason ?? null,
    cancelRequested: Boolean(r.cancel_requested),
    reservedMinutes: Number(r.reserved_minutes ?? 0),
    billableSeconds: r.billable_seconds == null ? null : Number(r.billable_seconds),
    audioReady: r.audio_ready_at != null,
    participantsReady: r.participants_ready_at != null,
    ingestedAt: r.ingested_at ? new Date(r.ingested_at).toISOString() : null,
    traceId: r.trace_id ?? null,
  };
}

/**
 * The URL's identity for de-duplication: scheme, host and path, lower-cased,
 * without the query (Zoom's pwd=, tracking params) or a trailing slash. Hashed,
 * so it's safe to store in the clear and to log.
 */
export function meetingUrlHash(meetingUrl: string): string {
  const u = new URL(meetingUrl);
  const norm = `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '').toLowerCase()}`;
  return createHash('sha256').update(norm).digest('hex');
}

/** Our note id for a bot's recording: deterministic, so a replay converges on one note. */
export function noteIdForBot(botId: string): string {
  return `mtg_${botId.replace(/-/g, '')}`;
}

// Serialises reservations: per workspace (its quota and its duplicate check),
// and globally (the MAX_ACTIVE_BOTS cap). Transaction-scoped, so a crash frees them.
async function lockForReservation(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('meeting_bots:global'))`);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`meeting_bots:ws:${workspaceId}`]);
}

export type ReserveResult =
  | { kind: 'reserved'; bot: MeetingBot }
  | { kind: 'existing'; bot: MeetingBot }           // the same client request, again
  | { kind: 'duplicate_active'; bot: MeetingBot }   // a live bot is already on this meeting
  | { kind: 'too_many' }                            // this user has MAX_ACTIVE_BOTS_PER_USER live
  | { kind: 'busy' }                                // the global cap is reached
  | { kind: 'quota_exhausted'; remainingMinutes: number };

/**
 * Reserve a notetaker for one meeting, in one transaction under the workspace's
 * lock: the idempotency check, the duplicate check, the per-user and global
 * concurrency caps, and the notetaker-minutes reservation. The caller creates
 * the note and enqueues the create task afterwards; a replay of the same
 * request (same requestId) finds this row and resumes.
 */
export async function reserveMeetingBot(
  input: {
    botId: string;
    uid: string;
    workspaceId: string;
    requestId: string;
    platform: string;
    meetingUrl: string;
    meetingUrlCiphertext?: Buffer | null;
    /** The user's notetaker allowance for the current period, and when that period began. */
    allowanceMinutes: number;
    periodStart: Date;
    /** How long a meeting may run: the most this reservation can hold. */
    maxMeetingMinutes: number;
    maxActiveGlobal: number;
    noticeVersion: string;
    traceId?: string;
  },
  log?: Log,
): Promise<ReserveResult> {
  if (!isPostgresEnabled()) throw new Error('reserveMeetingBot: Postgres is not enabled');
  const urlHash = meetingUrlHash(input.meetingUrl);
  return withTx(async (client) => {
    await lockForReservation(client, input.workspaceId);

    const same = await client.query(
      'SELECT * FROM meeting_bots WHERE workspace_id = $1 AND client_request_id = $2',
      [input.workspaceId, input.requestId],
    );
    if (same.rowCount) return { kind: 'existing', bot: toBot(same.rows[0]) };

    const live = await client.query(
      `SELECT * FROM meeting_bots
        WHERE workspace_id = $1 AND meeting_url_hash = $2 AND status NOT IN ${TERMINAL_SQL}`,
      [input.workspaceId, urlHash],
    );
    if (live.rowCount) return { kind: 'duplicate_active', bot: toBot(live.rows[0]) };

    const { rows: [mine] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM meeting_bots WHERE uid = $1 AND status NOT IN ${TERMINAL_SQL}`,
      [input.uid],
    );
    if (mine.n >= MAX_ACTIVE_BOTS_PER_USER) return { kind: 'too_many' };

    const { rows: [all] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM meeting_bots WHERE status NOT IN ${TERMINAL_SQL}`,
    );
    if (all.n >= input.maxActiveGlobal) return { kind: 'busy' };

    // Minutes this period: settled bots count their recording, live ones their
    // reservation, and failed or cancelled ones nothing (released).
    const { rows: [used] } = await client.query(
      `SELECT COALESCE(SUM(CASE
                WHEN status IN ('failed', 'cancelled') THEN 0
                WHEN billable_seconds IS NOT NULL THEN CEIL(billable_seconds / 60.0)
                ELSE reserved_minutes END), 0)::int AS minutes
         FROM meeting_bots WHERE uid = $1 AND created_at >= $2`,
      [input.uid, input.periodStart],
    );
    const remaining = Math.max(0, input.allowanceMinutes - used.minutes);
    if (remaining < MIN_RESERVE_MINUTES) return { kind: 'quota_exhausted', remainingMinutes: remaining };
    const reserve = Math.min(remaining, input.maxMeetingMinutes);

    const { rows: [row] } = await client.query(
      `INSERT INTO meeting_bots (id, uid, workspace_id, client_request_id, platform, meeting_url_hash,
                                 meeting_url_ciphertext, reserved_minutes, trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [input.botId, input.uid, input.workspaceId, input.requestId, input.platform, urlHash,
        input.meetingUrlCiphertext ?? null, reserve, input.traceId ?? null],
    );
    await client.query(
      'INSERT INTO meeting_consents (meeting_bot_id, notice_version) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [input.botId, input.noticeVersion],
    );
    return { kind: 'reserved', bot: toBot(row) };
  }, { log, fields: { workspaceId: input.workspaceId, userId: input.uid } });
}

/** The bot, if it belongs to this workspace (a member's view: never another tenant's). */
export async function getMeetingBot(botId: string, workspaceId: string): Promise<MeetingBot | null> {
  if (!isPostgresEnabled()) return null;
  const { rows } = await getPool().query(
    'SELECT * FROM meeting_bots WHERE id = $1 AND workspace_id = $2',
    [botId, workspaceId],
  );
  return rows[0] ? toBot(rows[0]) : null;
}

/** The bot by our id alone: for workers, which carry it in their task. */
export async function getMeetingBotById(botId: string): Promise<MeetingBot | null> {
  if (!isPostgresEnabled()) return null;
  const { rows } = await getPool().query('SELECT * FROM meeting_bots WHERE id = $1', [botId]);
  return rows[0] ? toBot(rows[0]) : null;
}

/** Link the bot's note (created by createServerNote). Idempotent; never re-points a bot. */
export async function linkBotNote(botId: string, noteId: string): Promise<void> {
  await getPool().query(
    'UPDATE meeting_bots SET note_id = $2, updated_at = NOW() WHERE id = $1 AND (note_id IS NULL OR note_id = $2)',
    [botId, noteId],
  );
}

/** Record Recall's id for our bot (first create, or adopting one a replay finds). */
export async function attachRecallBot(botId: string, recallBotId: string): Promise<void> {
  await getPool().query(
    `UPDATE meeting_bots SET recall_bot_id = $2, updated_at = NOW()
      WHERE id = $1 AND (recall_bot_id IS NULL OR recall_bot_id = $2)`,
    [botId, recallBotId],
  );
  await advanceBotStatus(botId, 'scheduled');
}

/**
 * Move a bot's status forward. A lower-ranked status (an out-of-order webhook)
 * and any change to a terminal bot are ignored. Returns whether it changed.
 */
export async function advanceBotStatus(
  botId: string,
  status: BotStatus,
  opts: { failureReason?: string | null; recordingStartedAt?: Date; recordingEndedAt?: Date } = {},
): Promise<{ changed: boolean; bot: MeetingBot | null }> {
  const rank = BOT_STATUS_RANK[status];
  if (rank === undefined) throw new Error(`advanceBotStatus: unknown status ${status}`);
  const { rows } = await getPool().query(
    `UPDATE meeting_bots
        SET status = $2, status_rank = $3,
            failure_reason = COALESCE($4, failure_reason),
            recording_started_at = COALESCE(recording_started_at, $5),
            recording_ended_at = COALESCE($6, recording_ended_at),
            -- The meeting link is only needed to join: forget it once the bot is in.
            meeting_url_ciphertext = CASE WHEN $3 >= ${BOT_STATUS_RANK.in_call} THEN NULL ELSE meeting_url_ciphertext END,
            updated_at = NOW()
      WHERE id = $1 AND status NOT IN ${TERMINAL_SQL} AND status_rank < $3
      RETURNING *`,
    [botId, status, rank, opts.failureReason ?? null, opts.recordingStartedAt ?? null, opts.recordingEndedAt ?? null],
  );
  if (rows[0]) return { changed: true, bot: toBot(rows[0]) };
  return { changed: false, bot: await getMeetingBotById(botId) };
}

/** Ask a live bot to cancel (the create task or the reconcile honours it). */
export async function requestBotCancel(botId: string, workspaceId: string): Promise<MeetingBot | null> {
  const { rows } = await getPool().query(
    `UPDATE meeting_bots SET cancel_requested = TRUE, updated_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND status NOT IN ${TERMINAL_SQL}
      RETURNING *`,
    [botId, workspaceId],
  );
  return rows[0] ? toBot(rows[0]) : getMeetingBot(botId, workspaceId);
}

/**
 * Store a Recall webhook once, by its id. Returns inserted=false for a
 * redelivery. meetingBotId may be null (Recall knew the bot before we did).
 */
export async function recordRecallEvent(input: {
  webhookId: string;
  meetingBotId: string | null;
  recallBotId: string | null;
  event: string;
  subCode?: string | null;
  occurredAt?: Date | null;
  payload: unknown;
}): Promise<{ inserted: boolean; id: number | null }> {
  // Signed by Recall, but ours only if it's a UUID we could have issued.
  const botId = input.meetingBotId && UUID_RE.test(input.meetingBotId) ? input.meetingBotId : null;
  const { rows } = await getPool().query(
    `INSERT INTO recall_events (webhook_id, meeting_bot_id, recall_bot_id, event, sub_code, occurred_at, payload)
       VALUES ($1, (SELECT id FROM meeting_bots WHERE id = $2::uuid), $3, $4, $5, $6, $7)
     ON CONFLICT (webhook_id) DO NOTHING
     RETURNING id`,
    [input.webhookId, botId, input.recallBotId, input.event, input.subCode ?? null,
      input.occurredAt ?? null, JSON.stringify(input.payload ?? {})],
  );
  return rows[0] ? { inserted: true, id: Number(rows[0].id) } : { inserted: false, id: null };
}

/**
 * Note that one of the two artifacts ingest needs is ready (audio_mixed.done
 * or participant_events.done). Returns the bot: ingest starts once both are.
 */
export async function markBotMediaReady(botId: string, what: 'audio' | 'participants'): Promise<MeetingBot | null> {
  const column = what === 'audio' ? 'audio_ready_at' : 'participants_ready_at';
  const { rows } = await getPool().query(
    `UPDATE meeting_bots SET ${column} = COALESCE(${column}, NOW()), updated_at = NOW() WHERE id = $1 RETURNING *`,
    [botId],
  );
  return rows[0] ? toBot(rows[0]) : null;
}

export interface MeetingParticipant { recallParticipantId: string; displayName: string }
export interface SpeakerSegment { startMs: number; endMs: number; recallParticipantId: string }

/**
 * Save who was in the meeting and who spoke when, at ingest, in one
 * transaction. Participants get speaker tags 1..N in order of first speech (a
 * silent participant gets none). The names seed note_speakers only where the
 * user hasn't named that speaker (ON CONFLICT DO NOTHING), and only on the
 * first ingest, so a rename, or a cleared name, is never overwritten by a replay.
 * Returns the tag of each participant.
 */
export async function saveMeetingSpeakers(
  input: { botId: string; noteId: string; participants: MeetingParticipant[]; segments: SpeakerSegment[] },
  log?: Log,
): Promise<Map<string, number>> {
  return withTx(async (client) => {
    const { rows: [bot] } = await client.query(
      'SELECT ingested_at FROM meeting_bots WHERE id = $1 AND note_id = $2 FOR UPDATE',
      [input.botId, input.noteId],
    );
    if (!bot) throw new Error('saveMeetingSpeakers: bot and note do not match');

    const names = new Map(input.participants.map((p) => [p.recallParticipantId, p.displayName]));
    const ordered = [...input.segments].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    const tags = new Map<string, number>();
    for (const s of ordered) {
      if (!tags.has(s.recallParticipantId)) tags.set(s.recallParticipantId, tags.size + 1);
    }

    await client.query('DELETE FROM meeting_participants WHERE meeting_bot_id = $1', [input.botId]);
    for (const [pid, tag] of tags) {
      await client.query(
        `INSERT INTO meeting_participants (meeting_bot_id, recall_participant_id, speaker_tag, display_name)
           VALUES ($1, $2, $3, $4)`,
        [input.botId, pid, tag, (names.get(pid) || `Speaker ${tag}`).slice(0, 80)],
      );
    }
    await client.query('DELETE FROM meeting_speaker_segments WHERE note_id = $1', [input.noteId]);
    let seq = 0;
    for (const s of ordered) {
      await client.query(
        `INSERT INTO meeting_speaker_segments (note_id, seq, start_ms, end_ms, speaker_tag) VALUES ($1, $2, $3, $4, $5)`,
        [input.noteId, seq++, Math.max(0, Math.round(s.startMs)), Math.max(0, Math.round(s.endMs)), tags.get(s.recallParticipantId)],
      );
    }
    if (!bot.ingested_at) {
      for (const [pid, tag] of tags) {
        const name = names.get(pid);
        if (!name) continue;
        await client.query(
          `INSERT INTO note_speakers (note_id, speaker_tag, display_name) VALUES ($1, $2, $3)
           ON CONFLICT (note_id, speaker_tag) DO NOTHING`,
          [input.noteId, tag, name.slice(0, 80)],
        );
      }
    }
    return tags;
  }, { log, fields: { noteId: input.noteId } });
}

/** The recording is ours: settle its minutes and mark the bot ingested (idempotent). */
export async function markBotIngested(botId: string, billableSeconds: number): Promise<void> {
  await getPool().query(
    `UPDATE meeting_bots
        SET ingested_at = COALESCE(ingested_at, NOW()),
            billable_seconds = COALESCE(billable_seconds, $2),
            updated_at = NOW()
      WHERE id = $1`,
    [botId, Math.max(0, Math.round(billableSeconds))],
  );
}

/** The speaker timeline for a note, in order: what the transcoder aligns words with. */
export async function getSpeakerSegments(noteId: string): Promise<Array<{ startMs: number; endMs: number; speakerTag: number }>> {
  if (!isPostgresEnabled()) return [];
  const { rows } = await getPool().query(
    'SELECT start_ms, end_ms, speaker_tag FROM meeting_speaker_segments WHERE note_id = $1 ORDER BY seq',
    [noteId],
  );
  return rows.map((r) => ({ startMs: Number(r.start_ms), endMs: Number(r.end_ms), speakerTag: Number(r.speaker_tag) }));
}

/** Record what the meeting was told and how it answered (docs/CONSENT.md §2.4). */
export async function recordConsentEvent(
  botId: string,
  event: { noticeSentAt?: Date; admittedAt?: Date; recordingPermission?: 'allowed' | 'denied' },
): Promise<void> {
  await getPool().query(
    `UPDATE meeting_consents
        SET notice_sent_at = COALESCE(notice_sent_at, $2),
            admitted_at = COALESCE(admitted_at, $3),
            recording_permission = COALESCE($4, recording_permission)
      WHERE meeting_bot_id = $1`,
    [botId, event.noticeSentAt ?? null, event.admittedAt ?? null, event.recordingPermission ?? null],
  );
}

/**
 * Queue deleting Recall's copy of a bot's recording. Takes a client so note and
 * account deletion write it in their own transaction. One row per Recall bot:
 * a second reason only widens it (leaving the call is never un-asked).
 */
export async function enqueueRecallPurge(
  client: PoolClient | null,
  input: { recallBotId: string; reason: 'ingested' | 'note_deleted' | 'account_deleted' | 'failed'; leaveCall?: boolean; traceId?: string },
): Promise<void> {
  const q = client ?? getPool();
  await q.query(
    `INSERT INTO recall_purges (recall_bot_id, reason, leave_call, trace_id)
       VALUES ($1, $2, $3, $4)
     ON CONFLICT (recall_bot_id) DO UPDATE
       SET leave_call = recall_purges.leave_call OR EXCLUDED.leave_call,
           updated_at = NOW()`,
    [input.recallBotId, input.reason, Boolean(input.leaveCall), input.traceId ?? null],
  );
}

export interface RecallPurge { id: number; recallBotId: string; reason: string; leaveCall: boolean; attempts: number; traceId: string | null }

/** Purges not yet confirmed and still worth retrying, oldest first. */
export async function listPendingRecallPurges(limit = 50, maxAttempts = 10): Promise<RecallPurge[]> {
  const { rows } = await getPool().query(
    `SELECT id, recall_bot_id, reason, leave_call, attempts, trace_id FROM recall_purges
      WHERE confirmed_at IS NULL AND attempts < $2 ORDER BY requested_at LIMIT $1`,
    [limit, maxAttempts],
  );
  return rows.map((r) => ({ id: Number(r.id), recallBotId: r.recall_bot_id, reason: r.reason, leaveCall: r.leave_call, attempts: Number(r.attempts), traceId: r.trace_id }));
}

/** One more attempt at a purge; lastError null when Recall accepted the delete. */
export async function recordRecallPurgeAttempt(id: number, lastError: string | null): Promise<void> {
  await getPool().query(
    `UPDATE recall_purges SET attempts = attempts + 1, last_error = $2, updated_at = NOW() WHERE id = $1`,
    [id, lastError ? lastError.slice(0, 500) : null],
  );
}

/** Recall confirmed the media is gone (recording.deleted). */
export async function confirmRecallPurge(recallBotId: string): Promise<void> {
  await getPool().query(
    `UPDATE recall_purges SET confirmed_at = COALESCE(confirmed_at, NOW()), updated_at = NOW() WHERE recall_bot_id = $1`,
    [recallBotId],
  );
  await getPool().query(
    `UPDATE meeting_bots SET recall_media_deleted_at = COALESCE(recall_media_deleted_at, NOW()), updated_at = NOW()
      WHERE recall_bot_id = $1`,
    [recallBotId],
  );
}
