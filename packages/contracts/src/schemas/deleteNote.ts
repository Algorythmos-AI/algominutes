// POST /v1/notes/delete: the single deletion path for one note
// (services/api/src/routes/delete-note.js -> notes-repo deleteNote). It
// replaces clients deleting the Firestore doc and relying on the functions/
// onNoteDeleted trigger, which the new pipeline never deploys.
import { z } from './zod';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

export const DeleteNoteRequest = z
  .object({ noteId: Id, workspaceId: Id })
  .openapi('DeleteNoteRequest');

/**
 * `deleted` is false when there was no Postgres row to delete: a retry of an
 * earlier delete, or a note that never reached processing. Either way the note
 * is gone once this returns 200, and its audio is queued for purge. Safe to
 * retry.
 */
export const DeleteNoteResponse = z
  .object({ ok: z.literal(true), noteId: z.string(), deleted: z.boolean() })
  .openapi('DeleteNoteResponse');

export type DeleteNoteRequest = z.infer<typeof DeleteNoteRequest>;
export type DeleteNoteResponse = z.infer<typeof DeleteNoteResponse>;
