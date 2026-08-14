// Cross-cutting primitives and envelopes shared by every endpoint.
//
// Field names are the WIRE names the wassup backend already emits (camelCase),
// carried over verbatim — this phase does not rename wassup identifiers.
import { z } from './zod';

/**
 * A backend id. `intelligence.isValidId` gates these server-side; here it is a
 * non-empty string. Note ids and workspace ids are both this shape, and a
 * workspace id is always `workspace_<uid>`.
 */
export const Id = z.string().min(1).openapi('Id', { example: 'note_abc123' });

/** `new Date().toISOString()` — ISO-8601 with fractional seconds. */
export const IsoDateTime = z
  .string()
  .openapi('IsoDateTime', { format: 'date-time', example: '2026-08-15T09:41:07.123Z' });

/** A DATE column with no time component; kept as `YYYY-MM-DD` so a timezone
 * shift can never move a due date by a day (see functions/note-read.cjs). */
export const DateOnly = z
  .string()
  .openapi('DateOnly', { format: 'date', example: '2026-08-20' });

/**
 * The disclosure that travels with every note-content response.
 *
 * The transcoder redacts transcript text before it is stored, so responses
 * carry `<<REDACTED:…>>` markers and there is no un-redacted copy anywhere.
 * `applied` lets clients disclose this in export UI. Source: the
 * `redaction: { applied: true, scheme: 'shared/redaction.cjs' }` block emitted
 * by note-read.cjs, export-note.cjs and shared-note.cjs.
 */
export const RedactionMeta = z
  .object({
    applied: z.boolean(),
    scheme: z.string(),
  })
  .openapi('RedactionMeta', { example: { applied: true, scheme: 'shared/redaction.cjs' } });

/**
 * The error envelope every handler returns on a non-2xx.
 *
 * Every `{ status, body: { error } }` return across the five handlers and the
 * server.ts routes uses this exact shape — a single human-readable `error`
 * string. Endpoint-specific extras (see `TooLargeError`, delete-account's
 * `summary`) widen it rather than replace it.
 */
export const ErrorEnvelope = z
  .object({
    error: z.string(),
  })
  .openapi('ErrorEnvelope', { example: { error: 'Note not found' } });

export type Id = z.infer<typeof Id>;
export type IsoDateTime = z.infer<typeof IsoDateTime>;
export type DateOnly = z.infer<typeof DateOnly>;
export type RedactionMeta = z.infer<typeof RedactionMeta>;
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
