// POST /v1/notes/text — a text note (a scanned image, a PDF, an imported file) made from the text the app
// extracted on the device, written to Postgres like every other note (plan rev 12 R12.8, S16). It replaces the
// iPhone writing the note straight into Firestore, which left it outside retention, backups, search and export.
import { z } from './zod';

/**
 * The most text a request carries, in UTF-16 units (JavaScript string length): at 3 bytes a unit at worst it
 * stays under the api's 1 MB JSON body limit. The server's builder keeps the first 180,000 characters
 * (graphemes, as the iPhone counts them) and marks the note truncated, as the iPhone did.
 */
export const TEXT_NOTE_REQUEST_MAX_UNITS = 300_000;

/** Where the text came from; it names the note's lines ("Scanned image", "PDF document", "Imported document"). */
export const TextNoteSource = z.enum(['scanned_image', 'pdf', 'imported']).openapi('TextNoteSource');

/**
 * `noteId` is the client's (as for a recording), so a retry is the same note. `title` is the app's fallback (a
 * file's name); the server prefers the text's own first line, as the iPhone did.
 */
export const TextNoteCreateRequest = z
  .object({
    noteId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    title: z.string().max(300).optional(),
    text: z.string().max(TEXT_NOTE_REQUEST_MAX_UNITS),
    source: TextNoteSource,
  })
  .openapi('TextNoteCreateRequest');

/** The note is ready at once: there is nothing to process. */
export const TextNoteResponse = z
  .object({
    noteId: z.string(),
    status: z.literal('ready'),
  })
  .openapi('TextNoteResponse');

export type TextNoteSource = z.infer<typeof TextNoteSource>;
export type TextNoteCreateRequest = z.infer<typeof TextNoteCreateRequest>;
export type TextNoteResponse = z.infer<typeof TextNoteResponse>;
