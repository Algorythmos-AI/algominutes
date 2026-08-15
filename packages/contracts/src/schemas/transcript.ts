// Wire transcript-line shapes. Two endpoints emit transcript lines and they
// differ, so both are modelled.
//
// Note on SpeakerLabel / TranscriptTime: those iOS types
// (apps/ios/AlgoMinutes/Models/SpeakerLabel.swift, TranscriptTime.swift) are pure
// CLIENT logic — reconciling an embedded "Speaker 1:" prefix, parsing a
// display timestamp back into seconds. They carry no wire fields, so there is
// no schema for them; they consume the fields defined here. The server does
// the equivalent split itself (splitEmbeddedSpeaker in note-read.cjs) before
// emitting `speaker`.
import { z } from './zod';

/**
 * A transcript line from `/v1/note` (functions/note-read.cjs
 * fetchTranscriptPage). The server reconciles both write paths into one shape:
 * `speaker` is resolved (speaker_name, or the embedded fast-path prefix, or
 * `Speaker <tag>`) or null; `startMs`/`endMs` are always numbers (0 fallback).
 *
 * TODO(contracts): the iOS decoder (NoteReadResponse.swift `Line`) models
 * `startMs`/`endMs` as optional Doubles for tolerance, but the server always
 * emits a number — modelled as a required number here to match what is sent.
 */
export const TranscriptLine = z
  .object({
    id: z.string(),
    speaker: z.string().nullable(),
    speakerTag: z.number().int().nullable(),
    startMs: z.number(),
    endMs: z.number(),
    text: z.string(),
    confidence: z.number().nullable(),
  })
  .openapi('TranscriptLine');

/**
 * The transcript envelope on `/v1/note`. First page carries `totalLines`;
 * cursor pages omit it (re-counting per page is wasteful). `nextCursor` is a
 * keyset cursor, null at the end. Source: note-read.cjs handler return.
 */
export const TranscriptPage = z
  .object({
    lines: z.array(TranscriptLine),
    totalLines: z.number().int().optional(),
    nextCursor: z.string().nullable(),
    truncated: z.boolean(),
  })
  .openapi('TranscriptPage');

/**
 * A transcript line on the PUBLIC share view (`/v1/shared-note`). A different,
 * smaller shape than `TranscriptLine`: `id` is a positional integer, the
 * speaker is split into `speakerTag`/`speakerName`, there is no `endMs` or
 * `confidence`, and `startMs` may be null. Source: functions/shared-note.cjs
 * fetchShareView, and src/lib/apiSchemas.ts `SharedLineSchema`.
 */
export const SharedTranscriptLine = z
  .object({
    id: z.number().int(),
    speakerTag: z.number().int().nullable(),
    speakerName: z.string().nullable(),
    startMs: z.number().nullable(),
    text: z.string(),
  })
  .openapi('SharedTranscriptLine');

export type TranscriptLine = z.infer<typeof TranscriptLine>;
export type TranscriptPage = z.infer<typeof TranscriptPage>;
export type SharedTranscriptLine = z.infer<typeof SharedTranscriptLine>;
