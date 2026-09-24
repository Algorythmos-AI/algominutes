// Request/response contracts for the api routes that were served but missing
// from the spec (reconciled before the iOS /v1 client, plan PR-17). Every shape
// here was extracted from the handler code, not from comments. The routes live
// in services/api/src/routes/.
import { z } from './zod';
import { NoteType } from './note';
import { SummaryTemplateId } from './summaryTemplate';
import { EntitlementResponse, DeadLetterEntry } from './async';

// ── Generic acknowledgements ─────────────────────────────────────────────────
export const OkResponse = z.object({ ok: z.literal(true) }).openapi('OkResponse');

// ── POST /v1/process — async kickoff (process-intelligence.js) ───────────────
export const ProcessRequest = z
  .object({
    noteId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), // must be workspace_<uid>
    type: NoteType,
    storagePath: z.string().max(512).optional(), // required unless type === 'youtube'
    sourceUrl: z.string().max(1024).optional(), // youtube only: youtube.com / youtu.be hosts
    mimeType: z.string().optional(),
    durationSec: z.number().nonnegative().optional(), // client estimate; billed as ceil(min)
  })
  .openapi('ProcessRequest');

export const ProcessQueuedResponse = z
  .object({ success: z.literal(true), noteId: z.string(), jobId: z.string(), status: z.literal('queued') })
  .openapi('ProcessQueuedResponse');

export const ProcessCachedResponse = z
  .object({ success: z.literal(true), noteId: z.string(), cached: z.literal(true) })
  .openapi('ProcessCachedResponse');

/** A duplicate kickoff of a note already being processed: nothing was changed. */
export const ProcessInFlightResponse = z
  .object({
    success: z.literal(true),
    noteId: z.string(),
    status: z.enum(['queued', 'chunking', 'transcribing', 'summarizing']).nullable(),
    inFlight: z.literal(true),
  })
  .openapi('ProcessInFlightResponse');

export const QuotaExceededResponse = z
  .object({
    error: z.literal('quota_exceeded'),
    message: z.string(),
    entitlement: EntitlementResponse.nullable(),
  })
  .openapi('QuotaExceededResponse');

// ── POST /v1/notes/feedback (note-feedback.js) ───────────────────────────────
export const NoteFeedbackRequest = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
    rating: z.number().int().min(1).max(5),
    kind: z.enum(['transcription', 'summary']).optional(), // default 'transcription'
    comment: z.string().nullable().optional().openapi({ description: 'Trimmed; the server keeps 2000 characters.' }),
  })
  .openapi('NoteFeedbackRequest');

export const NoteFeedbackResponse = z
  .object({ ok: z.literal(true), noteId: z.string(), rating: z.number().int() })
  .openapi('NoteFeedbackResponse');

// ── POST /v1/notes/regenerate-summary (regenerate-summary.js) ────────────────
export const RegenerateSummaryRequest = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
    template: SummaryTemplateId.nullable().optional(),
    confirmOverwrite: z.boolean().optional(), // required to overwrite manual edits
  })
  .openapi('RegenerateSummaryRequest');

export const RegenerateSummaryResponse = z
  .object({
    ok: z.literal(true),
    noteId: z.string(),
    status: z.literal('summarizing'),
    generation: z.number().int(),
    template: z.string(),
  })
  .openapi('RegenerateSummaryResponse');

export const RegenerateConflict = z
  .union([
    z.object({ error: z.literal('manual_edits_present'), editedAt: z.string() }),
    z.object({ error: z.literal('already_regenerating'), status: z.string() }),
  ])
  .openapi('RegenerateConflict');

// ── POST /v1/support (compliance.js) ─────────────────────────────────────────
export const SupportCreatedResponse = z
  .object({ ok: z.literal(true), id: z.string().optional() }) // BIGSERIAL as a string
  .openapi('SupportCreatedResponse');

// ── POST /v1/client-error (client-error.js) — public crash beacon ────────────
export const ClientErrorReport = z
  .object({
    kind: z.string().optional(),
    name: z.string().optional(),
    message: z.string().optional(),
    stack: z.string().optional(),
    url: z.string().optional(),
    userAgent: z.string().optional(),
    componentStack: z.string().optional(),
    source: z.string().optional(),
  })
  .openapi('ClientErrorReport', { description: 'All fields optional; each string is length-capped server-side.' });

// ── Admin dead letters (admin-dead-letters.js) ───────────────────────────────
export const DeadLettersResponse = z
  .object({ deadLetters: z.array(DeadLetterEntry) })
  .openapi('DeadLettersResponse');

export const ResolveDeadLetterResponse = z
  .object({ ok: z.literal(true), id: z.number().int() })
  .openapi('ResolveDeadLetterResponse');

export type ProcessRequest = z.infer<typeof ProcessRequest>;
export type NoteFeedbackRequest = z.infer<typeof NoteFeedbackRequest>;
export type RegenerateSummaryRequest = z.infer<typeof RegenerateSummaryRequest>;
