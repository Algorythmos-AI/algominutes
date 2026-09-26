// POST /v1/notes/audio-url: a short-lived signed URL to play a note's audio
// (services/api/src/routes/note-audio.js). Clients never read the recordings
// bucket directly: the api checks workspace membership, then signs a GET for
// the note's own object only.
import { z } from './zod';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const NoteAudioUrlRequest = z
  .object({ noteId: Id, workspaceId: Id })
  .openapi('NoteAudioUrlRequest');

/** `url` is a V4 signed GET, valid until `expiresAt` (ISO). Don't log or persist it. */
export const NoteAudioUrlResponse = z
  .object({ url: z.string(), expiresAt: z.string() })
  .openapi('NoteAudioUrlResponse');

export type NoteAudioUrlRequest = z.infer<typeof NoteAudioUrlRequest>;
export type NoteAudioUrlResponse = z.infer<typeof NoteAudioUrlResponse>;
