// Online meetings: the Recall.ai notetaker (docs/plans/MEETINGS.md, DECISIONS
// "Online meetings are captured by a Recall.ai notetaker bot first").
//
// Forward compatibility: the enum-like fields below are OPEN strings. Builds in
// the field must keep working when the server adds a value, so clients map an
// unknown value to a generic state instead of rejecting the note (the web drops
// a note whose `status` or `type` fails its schema, so a notetaker note uses the
// existing `status: recording` and `type: online_meeting`, and everything new
// lives in these optional fields).
import { z } from './zod';
import { Id } from './common';

/** Where the meeting runs. Known: google_meet, zoom, teams, webex, other. */
export const MeetingPlatform = z
  .string()
  .min(1)
  .max(32)
  .openapi('MeetingPlatform', {
    description: 'google_meet | zoom | teams | webex | other. Clients must accept values they do not know.',
    example: 'google_meet',
  });

/**
 * The notetaker's progress. Known: scheduled, joining, waiting_room, in_call,
 * recording, processing, done, failed, cancelled.
 */
export const NotetakerStatus = z
  .string()
  .min(1)
  .max(32)
  .openapi('NotetakerStatus', {
    description:
      'scheduled | joining | waiting_room | in_call | recording | processing | done | failed | cancelled. Clients must accept values they do not know (show them as "in progress").',
    example: 'recording',
  });

/**
 * Why a notetaker ended without a recording. Known: not_admitted,
 * permission_denied, bot_blocked, meeting_not_found, busy, quota_exhausted,
 * too_long, cancelled, error.
 */
export const NotetakerFailureReason = z
  .string()
  .min(1)
  .max(40)
  .openapi('NotetakerFailureReason', {
    description:
      'not_admitted | permission_denied | bot_blocked | meeting_not_found | busy | quota_exhausted | too_long | cancelled | error. Clients must accept values they do not know.',
    example: 'not_admitted',
  });

/** How a note's audio arrived. Known: device, upload, bot, extension, cloud_import. */
export const NoteSourceKind = z
  .string()
  .min(1)
  .max(32)
  .openapi('NoteSourceKind', {
    description: 'device | upload | bot | extension | cloud_import. Clients must accept values they do not know.',
    example: 'bot',
  });

/** The notetaker on a note (the Firestore mirror and the note read). Optional everywhere. */
export const NoteNotetaker = z
  .object({
    botId: Id,
    status: NotetakerStatus,
    failureReason: NotetakerFailureReason.optional(),
    platform: MeetingPlatform,
  })
  .openapi('NoteNotetaker');

/**
 * POST /v1/meetings/bots: send the notetaker to a meeting now.
 * `requestId` is the client's idempotency key: the same id returns the same bot.
 */
export const CreateMeetingBotRequest = z
  .object({
    meetingUrl: z.string().url().max(2048),
    title: z.string().trim().min(1).max(200).optional(),
    requestId: z.string().min(8).max(64),
  })
  .openapi('CreateMeetingBotRequest', {
    example: { meetingUrl: 'https://meet.google.com/abc-defg-hij', title: 'Weekly sync', requestId: '6f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b' },
  });

export const MeetingBotResponse = z
  .object({
    botId: Id,
    noteId: Id,
    status: NotetakerStatus,
  })
  .openapi('MeetingBotResponse');

/** POST /v1/meetings/bots/{botId}/cancel: no body. */
export const CancelMeetingBotResponse = z
  .object({
    botId: Id,
    status: NotetakerStatus,
  })
  .openapi('CancelMeetingBotResponse');

/** 503 when the notetaker switch is off (GET /v1/config `notetaker`). */
export const FeatureDisabledError = z
  .object({
    error: z.string(),
    code: z.literal('feature_disabled'),
  })
  .openapi('FeatureDisabledError', {
    example: { error: "The notetaker isn't available yet.", code: 'feature_disabled' },
  });

/**
 * The notetaker surfaces the server has switched on. Absent (an older server)
 * means every one is off.
 */
export const NotetakerSwitches = z
  .object({
    bot: z.boolean(),
    calendar: z.boolean(),
    zoomImport: z.boolean(),
    extension: z.boolean(),
  })
  .openapi('NotetakerSwitches');

export type MeetingPlatform = z.infer<typeof MeetingPlatform>;
export type NotetakerStatus = z.infer<typeof NotetakerStatus>;
export type NotetakerFailureReason = z.infer<typeof NotetakerFailureReason>;
export type NoteSourceKind = z.infer<typeof NoteSourceKind>;
export type NoteNotetaker = z.infer<typeof NoteNotetaker>;
export type CreateMeetingBotRequest = z.infer<typeof CreateMeetingBotRequest>;
export type MeetingBotResponse = z.infer<typeof MeetingBotResponse>;
export type CancelMeetingBotResponse = z.infer<typeof CancelMeetingBotResponse>;
export type FeatureDisabledError = z.infer<typeof FeatureDisabledError>;
export type NotetakerSwitches = z.infer<typeof NotetakerSwitches>;
