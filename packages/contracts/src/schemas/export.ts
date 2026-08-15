// POST /v1/export-note — server-rendered DOCX (functions/export-note.cjs).
//
// DOCX is the only server-rendered format; TXT and PDF are owned by the
// clients. On success the response is raw DOCX bytes (not JSON), so it has no
// response schema — only the request and the error variants are modelled.
import { z } from './zod';

/**
 * How much of a note a share/export carries. Source: the `SCOPES` set in
 * export-note.cjs and shared/share-links.cjs (`summary`/`transcript`/`both`),
 * and apps/ios/AlgoMinutes/Models/ExportScope.swift. Shared by export and share.
 */
export const ExportScope = z.enum(['summary', 'transcript', 'both']).openapi('ExportScope');

/**
 * Request body. `scope` defaults to `both`; `format` must be `docx` (the only
 * server-rendered format). Source: handleExportNote body parse.
 */
export const ExportNoteRequest = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
    scope: ExportScope.optional(),
    format: z.literal('docx').optional(),
  })
  .openapi('ExportNoteRequest');

/**
 * The 413 body when the transcript is past MAX_LINES (20000) and DOCX render is
 * declined — the client falls back to TXT. Source: the `413` return in
 * handleExportNote. Widens `ErrorEnvelope` with `totalLines`.
 */
export const ExportTooLargeError = z
  .object({
    error: z.literal('transcript_too_large_for_docx'),
    totalLines: z.number().int(),
  })
  .openapi('ExportTooLargeError');

export type ExportScope = z.infer<typeof ExportScope>;
export type ExportNoteRequest = z.infer<typeof ExportNoteRequest>;
export type ExportTooLargeError = z.infer<typeof ExportTooLargeError>;
