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
import { ensureUser, ensureWorkspaceAccess } from './workspace-access';
import { lockNoteId } from './note-lock';

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
  statusRank: number;
  failureReason: string | null;
  cancelRequested: boolean;
  reservedMinutes: number;
  billableSeconds: number | null;
  audioReady: boolean;
  participantsReady: boolean;
  ingestedAt: string | null;
  traceId: string | null;
}

/** A meeting_bots row as a MeetingBot (for the repo's own transactions). */
export function botFromRow(r: any): MeetingBot {
  return toBot(r);
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
    statusRank: Number(r.status_rank ?? 0),
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
// Query keys that name the meeting itself on some platforms (Webex's
// j.php?MTID=...); every other key (Zoom's pwd=, tracking) is dropped.
const IDENTIFYING_QUERY_KEYS = new Set(['mtid', 'meetingid', 'confno', 'id']);

export function meetingUrlHash(meetingUrl: string): string {
  const u = new URL(meetingUrl);
  const keep = [...u.searchParams.entries()]
    .filter(([k]) => IDENTIFYING_QUERY_KEYS.has(k.toLowerCase()))
    .map(([k, v]) => `${k.toLowerCase()}=${v}`)
    .sort();
  // http and https name the same meeting.
  const norm = `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '').toLowerCase()}${keep.length ? `?${keep.join('&')}` : ''}`;
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
    email?: string | null;
    name?: string | null;
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
    // The caller must be a member of this workspace (CLAUDE.md multi-tenancy):
    // the same guard markQueued uses. Throws WorkspaceBoundaryError otherwise,
    // before anything about the workspace is read.
    await ensureUser(client, { uid: input.uid, email: input.email, name: input.name });
    await ensureWorkspaceAccess(client, input.workspaceId, input.uid, input.name ? `${input.name}'s Workspace` : 'My Workspace');

    const same = await client.query(
      'SELECT * FROM meeting_bots WHERE workspace_id = $1 AND client_request_id = $2 AND uid = $3',
      [input.workspaceId, input.requestId, input.uid],
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

    // Minutes this period: a recording counts its length (however the bot then
    // ended), a live bot its reservation, and a bot that ended without a
    // recording nothing (released).
    const { rows: [used] } = await client.query(
      `SELECT COALESCE(SUM(CASE
                WHEN billable_seconds IS NOT NULL THEN CEIL(billable_seconds / 60.0)
                WHEN status IN ${TERMINAL_SQL} THEN 0
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

/** The bot, if it's in this workspace and the caller is a member of it (never another tenant's). */
export async function getMeetingBot(botId: string, workspaceId: string, uid: string): Promise<MeetingBot | null> {
  if (!isPostgresEnabled()) return null;
  const { rows } = await getPool().query(
    `SELECT b.* FROM meeting_bots b
       JOIN workspace_members m ON m.workspace_id = b.workspace_id AND m.uid = $3
      WHERE b.id = $1 AND b.workspace_id = $2`,
    [botId, workspaceId, uid],
  );
  return rows[0] ? toBot(rows[0]) : null;
}

/** The bot by our id alone: for workers, which carry it in their task. */
export async function getMeetingBotById(botId: string): Promise<MeetingBot | null> {
  // A task body is ours, but a malformed id is "no such bot", not a type error
  // that retries into the dead letters.
  if (!isPostgresEnabled() || !UUID_RE.test(botId)) return null;
  const { rows } = await getPool().query('SELECT * FROM meeting_bots WHERE id = $1', [botId]);
  return rows[0] ? toBot(rows[0]) : null;
}

/**
 * Record Recall's id for our bot (first create, or adopting one a replay
 * finds). attached=false means the bot already has a DIFFERENT Recall bot: the
 * caller must remove the extra one (it would join the meeting untracked).
 */
export async function attachRecallBot(botId: string, recallBotId: string): Promise<{ attached: boolean; recallBotId: string | null }> {
  const { rows } = await getPool().query(
    `UPDATE meeting_bots SET recall_bot_id = $2, updated_at = NOW()
      WHERE id = $1 AND (recall_bot_id IS NULL OR recall_bot_id = $2)
      RETURNING recall_bot_id`,
    [botId, recallBotId],
  );
  if (!rows[0]) {
    const current = await getMeetingBotById(botId);
    return { attached: false, recallBotId: current?.recallBotId ?? null };
  }
  await advanceBotStatus(botId, 'scheduled');
  return { attached: true, recallBotId };
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

/**
 * Ask a live bot to cancel (the create task or the reconcile honours it). Only
 * the user who sent it, or an owner or admin of its workspace, may: the same
 * rule as deleting a note. Returns null when the caller may not see the bot.
 */
export async function requestBotCancel(botId: string, workspaceId: string, uid: string): Promise<MeetingBot | null> {
  const { rows } = await getPool().query(
    `UPDATE meeting_bots b SET cancel_requested = TRUE, updated_at = NOW()
       FROM workspace_members m
      WHERE b.id = $1 AND b.workspace_id = $2 AND b.status NOT IN ${TERMINAL_SQL}
        AND m.workspace_id = b.workspace_id AND m.uid = $3
        AND (b.uid = $3 OR m.role IN ('owner', 'admin'))
      RETURNING b.*`,
    [botId, workspaceId, uid],
  );
  return rows[0] ? toBot(rows[0]) : getMeetingBot(botId, workspaceId, uid);
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
}): Promise<{ inserted: boolean; id: number | null; processed: boolean }> {
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
  if (rows[0]) return { inserted: true, id: Number(rows[0].id), processed: false };
  // A redelivery. If the first delivery was never processed (its handler
  // crashed after the insert), say so, so the caller re-drives it.
  const { rows: [prior] } = await getPool().query(
    'SELECT id, processed_at FROM recall_events WHERE webhook_id = $1',
    [input.webhookId],
  );
  return { inserted: false, id: prior ? Number(prior.id) : null, processed: Boolean(prior?.processed_at) };
}

/** The stored event's work is done. */
export async function markRecallEventProcessed(id: number): Promise<void> {
  await getPool().query('UPDATE recall_events SET processed_at = COALESCE(processed_at, NOW()) WHERE id = $1', [id]);
}

/** Events stored but not processed after olderThanMs: the reconcile re-drives them. */
export async function listUnprocessedRecallEvents(olderThanMs: number, limit = 100): Promise<Array<{ id: number; meetingBotId: string | null; recallBotId: string | null; event: string }>> {
  const { rows } = await getPool().query(
    `SELECT id, meeting_bot_id, recall_bot_id, event FROM recall_events
      WHERE processed_at IS NULL AND received_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
      ORDER BY received_at LIMIT $2`,
    [olderThanMs, limit],
  );
  return rows.map((r) => ({ id: Number(r.id), meetingBotId: r.meeting_bot_id, recallBotId: r.recall_bot_id, event: r.event }));
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
): Promise<{ gone: true } | { gone: false; tags: Map<string, number> }> {
  return withTx(async (client): Promise<{ gone: true } | { gone: false; tags: Map<string, number> }> => {
    // The note's lock first, as deleteNote takes it: the two can't deadlock.
    await lockNoteId(client, input.noteId);
    const { rows: [bot] } = await client.query(
      'SELECT ingested_at FROM meeting_bots WHERE id = $1 AND note_id = $2 FOR UPDATE',
      [input.botId, input.noteId],
    );
    // The note was deleted mid-meeting (note_id went NULL): nothing to save.
    if (!bot) return { gone: true };

    const names = new Map(input.participants.map((p) => [p.recallParticipantId, p.displayName]));
    // Recall's timeline is data we don't control: drop anything that isn't a
    // finite time, and never let an end come before its start (a poison row would
    // fail every replay of the ingest).
    const ordered = input.segments
      .filter((s) => s && typeof s.recallParticipantId === 'string' && Number.isFinite(s.startMs) && Number.isFinite(s.endMs))
      .map((s) => {
        const startMs = Math.max(0, Math.round(s.startMs));
        return { ...s, startMs, endMs: Math.max(startMs, Math.round(s.endMs)) };
      })
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
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
        [input.noteId, seq++, s.startMs, s.endMs, tags.get(s.recallParticipantId)],
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
    return { gone: false, tags };
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
            -- Denied is final: the bot leaves 30 s later, so a late "allowed" can't undo it.
            recording_permission = CASE WHEN recording_permission = 'denied' THEN 'denied'
                                        ELSE COALESCE($4, recording_permission) END
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
           -- A new request re-arms a purge that gave up; a confirmed one stays done.
           attempts = CASE WHEN recall_purges.confirmed_at IS NULL THEN 0 ELSE recall_purges.attempts END,
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

/** Purges that ran out of attempts: for a person (the alert and the admin view count them). */
export async function listExhaustedRecallPurges(maxAttempts = 10, limit = 50): Promise<RecallPurge[]> {
  const { rows } = await getPool().query(
    `SELECT id, recall_bot_id, reason, leave_call, attempts, trace_id FROM recall_purges
      WHERE confirmed_at IS NULL AND attempts >= $1 ORDER BY requested_at LIMIT $2`,
    [maxAttempts, limit],
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

/** The bot Recall knows by this id (a webhook that didn't carry our metadata). */
export async function getMeetingBotByRecallId(recallBotId: string): Promise<MeetingBot | null> {
  if (!isPostgresEnabled() || typeof recallBotId !== 'string' || !recallBotId) return null;
  const { rows } = await getPool().query('SELECT * FROM meeting_bots WHERE recall_bot_id = $1', [recallBotId]);
  return rows[0] ? toBot(rows[0]) : null;
}

export interface StoredRecallEvent {
  id: number;
  meetingBotId: string | null;
  recallBotId: string | null;
  event: string;
  subCode: string | null;
  occurredAt: Date | null;
  processed: boolean;
}

/** A stored webhook, for the task that acts on it. */
export async function getRecallEvent(id: number): Promise<StoredRecallEvent | null> {
  if (!isPostgresEnabled() || !Number.isSafeInteger(id) || id <= 0) return null;
  const { rows: [r] } = await getPool().query(
    'SELECT id, meeting_bot_id, recall_bot_id, event, sub_code, occurred_at, processed_at FROM recall_events WHERE id = $1',
    [id],
  );
  if (!r) return null;
  return {
    id: Number(r.id), meetingBotId: r.meeting_bot_id, recallBotId: r.recall_bot_id, event: r.event,
    subCode: r.sub_code, occurredAt: r.occurred_at ? new Date(r.occurred_at) : null, processed: r.processed_at != null,
  };
}

/** The display name of the user who sent the bot: its name and its notice use their first name. */
export async function getBotOwnerName(botId: string): Promise<string | null> {
  if (!isPostgresEnabled() || !UUID_RE.test(botId)) return null;
  const { rows: [r] } = await getPool().query(
    'SELECT u.display_name FROM meeting_bots b JOIN users u ON u.uid = b.uid WHERE b.id = $1',
    [botId],
  );
  return r?.display_name ?? null;
}

/** The meeting link's KMS ciphertext, until the bot is in the call (then it's cleared). */
export async function getBotMeetingUrlCiphertext(botId: string): Promise<Buffer | null> {
  if (!isPostgresEnabled() || !UUID_RE.test(botId)) return null;
  const { rows: [r] } = await getPool().query('SELECT meeting_url_ciphertext FROM meeting_bots WHERE id = $1', [botId]);
  return r?.meeting_url_ciphertext ?? null;
}
