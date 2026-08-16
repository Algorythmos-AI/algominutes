// POST /v1/notes/:id/speakers — name the diarised speakers of a note
// (diarisation §4 / ADR 0005). Whole-file diarisation gives each turn a
// globally-consistent speaker_tag; this endpoint maps a tag to a display name
// (note_speakers table). Per-note only for v1.
import { z } from './zod';

/** One speaker mapping: tag (1, 2, …) → display name. An empty `name` clears the
 * mapping (revert to "Speaker N"). Source: services/api set-note-speakers.js. */
export const NoteSpeaker = z
  .object({
    speakerTag: z.number().int().positive(),
    name: z.string().max(80),
  })
  .openapi('NoteSpeaker');

/**
 * Request body. Accepts a single { speakerTag, name } or a batch via `speakers`.
 * `workspaceId`, if present, must be the caller's own workspace. noteId comes
 * from the path (`/v1/notes/:id/speakers`), not the body.
 */
export const SetNoteSpeakersRequest = z
  .object({
    workspaceId: z.string().optional(),
    speakerTag: z.number().int().positive().optional(),
    name: z.string().max(80).optional(),
    speakers: z.array(NoteSpeaker).max(32).optional(),
  })
  .openapi('SetNoteSpeakersRequest');

/** `{ ok: true, noteId, speakers }` — the full, updated speaker map for the note.
 * Source: the set-note-speakers 200 body. */
export const SetNoteSpeakersResponse = z
  .object({
    ok: z.literal(true),
    noteId: z.string(),
    speakers: z.array(NoteSpeaker),
  })
  .openapi('SetNoteSpeakersResponse');

export type NoteSpeaker = z.infer<typeof NoteSpeaker>;
export type SetNoteSpeakersRequest = z.infer<typeof SetNoteSpeakersRequest>;
export type SetNoteSpeakersResponse = z.infer<typeof SetNoteSpeakersResponse>;
