// POST /v1/notes (docs/plans/RELEASE.md PR 35, docs/decisions/0002-chrome-extension.md §2): a client
// that never writes Firestore (the browser extension) has its note created for it, from the upload its
// recording went to. The web and iOS keep writing their own note doc; this is the same doc.
import { z } from './zod';

export const CreateNoteRequest = z
  .object({
    // The upload session the recording went to (POST /v1/uploads). The note takes its id, workspace and
    // storage path, so a client can only make a note of its own upload.
    uploadId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    type: z.enum(['recording']),
    mimeType: z.string().regex(/^audio\/[A-Za-z0-9.+-]+(;.*)?$/).max(100).openapi({ example: 'audio/webm' }),
    // The client's measure of the recording; the transcoder measures it again.
    durationSec: z.number().nonnegative().max(24 * 60 * 60).optional(),
  })
  .openapi('CreateNoteRequest');

export const CreateNoteResponse = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
    storagePath: z.string(),
    // False when the note was already there (a repeated request, or one the server already has).
    created: z.boolean(),
  })
  .openapi('CreateNoteResponse');

export type CreateNoteRequest = z.infer<typeof CreateNoteRequest>;
export type CreateNoteResponse = z.infer<typeof CreateNoteResponse>;
