// What a Recall webhook means for our bot (docs/plans/MEETINGS.md): one pure
// function from (event, sub_code, the bot's current rank) to an action, so every
// case is testable and the handler only carries it out.
//   Bot status events: https://docs.recall.ai/docs/bot-status-change-events.md
//   Media events:      https://docs.recall.ai/docs/recording-webhooks.md
// The sub-codes below are the ones Recall documents; the M0 spike's captured
// payloads (tests/fixtures/recall) confirm them. An unknown one is 'error'.
import { BOT_STATUS_RANK } from '@algominutes/db';

const RECORDING = BOT_STATUS_RANK.recording;

/** Why a bot that never recorded ended, from Recall's sub_code. */
export function failureReasonFor(subCode) {
  const s = String(subCode || '').toLowerCase();
  if (/waiting_room|kicked_from_waiting_room|not_admitted|denied_entry|join_request_denied/.test(s)) return 'not_admitted';
  if (/noone_joined|no_one_joined|everyone_left/.test(s)) return 'not_admitted';
  if (/recording_permission_denied|permission_denied/.test(s)) return 'permission_denied';
  if (/bot_blocked|bots_not_allowed|blocked/.test(s)) return 'bot_blocked';
  if (/meeting_not_found|invalid_meeting|meeting_link|not_found|meeting_ended/.test(s)) return 'meeting_not_found';
  if (/sign_in|signin|login_required|requires_login/.test(s)) return 'bot_blocked';
  return 'error';
}

/** The words the user reads on the note when the notetaker couldn't record. */
export const FAILURE_MESSAGES = Object.freeze({
  not_admitted: "The notetaker wasn't let into the meeting, so nothing was recorded.",
  permission_denied: "The host didn't allow the notetaker to record, so nothing was recorded.",
  bot_blocked: "This meeting doesn't allow notetakers, so nothing was recorded.",
  meeting_not_found: "The notetaker couldn't find this meeting. Check the link and try again.",
  cancelled: 'You cancelled the notetaker before it recorded anything.',
  error: "The notetaker couldn't record this meeting. Please try again.",
});

/**
 * @param {{ event: string, subCode?: string|null, occurredAt?: Date|null }} ev
 * @param {{ statusRank: number }} bot
 * @returns one of:
 *   { kind: 'advance', status, recordingStartedAt?, recordingEndedAt?, consent? }
 *   { kind: 'fail', reason, consent?, unlessRecorded? }
 *       (never recorded: the note fails, nothing is charged; with unlessRecorded,
 *        only once Recall confirms it made no recording: webhooks arrive in any order)
 *   { kind: 'media_ready', what: 'audio'|'participants' }
 *   { kind: 'media_failed' }                      (the recording can't be retrieved: fail, no charge)
 *   { kind: 'media_deleted' }                     (Recall confirms our purge)
 *   { kind: 'consent', consent }                  (record only)
 *   { kind: 'ignore' }
 */
export function actionFor(ev, bot) {
  const at = ev.occurredAt || new Date();
  // As far as our row knows. A failed or cancelled bot never recorded.
  const recorded = Number(bot?.statusRank ?? 0) >= RECORDING && !['failed', 'cancelled'].includes(bot?.status);
  switch (ev.event) {
    case 'bot.joining_call':
      return { kind: 'advance', status: 'joining' };
    case 'bot.in_waiting_room':
      return { kind: 'advance', status: 'waiting_room' };
    case 'bot.in_call_not_recording':
      // Admitted: the chat notice goes out as it joins (chat.on_bot_join).
      return { kind: 'advance', status: 'in_call', consent: { admittedAt: at, noticeSentAt: at } };
    case 'bot.recording_permission_allowed':
      return { kind: 'consent', consent: { recordingPermission: 'allowed' } };
    case 'bot.recording_permission_denied':
      return { kind: 'fail', reason: 'permission_denied', consent: { recordingPermission: 'denied' } };
    case 'bot.in_call_recording':
      return { kind: 'advance', status: 'recording', recordingStartedAt: at, consent: { admittedAt: at, noticeSentAt: at } };
    case 'bot.call_ended':
      // Ended before it ever recorded: it wasn't let in, nobody came, or it was
      // removed. After recording, this is the normal end, and ingest follows.
      return recorded
        ? { kind: 'advance', status: 'call_ended', recordingEndedAt: at }
        : { kind: 'fail', reason: failureReasonFor(ev.subCode), unlessRecorded: true };
    case 'bot.done':
      return recorded ? { kind: 'ignore' } : { kind: 'fail', reason: failureReasonFor(ev.subCode), unlessRecorded: true };
    case 'bot.fatal':
      return { kind: 'fail', reason: failureReasonFor(ev.subCode) };
    case 'audio_mixed.done':
      return { kind: 'media_ready', what: 'audio' };
    case 'participant_events.done':
      return { kind: 'media_ready', what: 'participants' };
    case 'audio_mixed.failed':
    case 'participant_events.failed':
      return { kind: 'media_failed' };
    case 'recording.deleted':
    case 'audio_mixed.deleted':
      return { kind: 'media_deleted' };
    default:
      return { kind: 'ignore' };
  }
}
