// The Note domain: status/type enums, the summary, and the Firestore note doc.
//
// Source shapes:
//   - NoteStatus / NoteType / Summary / Note  ← src/types.ts (the Firestore
//     document the web app renders) reconciled with
//     ios-native/Wassup/Models/Note.swift (the client model that reads a
//     subset of the same document).
//
// The Firestore `Note` is delivered to clients via the Firestore listener, not
// a REST body, but it is the canonical domain object every surface shares, so
// it is defined here once. src/types.ts is the superset; the Swift model reads
// a subset of these fields — where they diverge, a `// TODO(contracts):` note
// records it.
import { z } from './zod';

/**
 * `processing` is retained for back-compat with notes created pre-Phase-3.
 * The chunked pipeline maps onto: queued → chunking → transcribing →
 * summarizing → ready / error. Source: src/types.ts `NoteStatus` and
 * Note.swift `NoteStatus` (identical set).
 */
export const NoteStatus = z
  .enum([
    'recording',
    'processing',
    'queued',
    'chunking',
    'transcribing',
    'summarizing',
    'ready',
    'error',
  ])
  .openapi('NoteStatus');

/** Source: src/types.ts `NoteType` / Note.swift `NoteType` (raw values). */
export const NoteType = z
  .enum(['recording', 'import_audio', 'import_pdf', 'youtube', 'scan_text', 'online_meeting'])
  .openapi('NoteType');

/**
 * The structured summary. `keyPoints` is a Firestore-only field with no
 * Postgres column (see shared/note-edit.cjs) — optional here for that reason.
 * Source: src/types.ts `Summary` and Note.swift `Summary`.
 */
export const Summary = z
  .object({
    gist: z.string(),
    actionItems: z.array(z.string()),
    keyDecisions: z.array(z.string()),
    keyPoints: z.array(z.string()).optional(),
  })
  .openapi('Summary');

/**
 * A transcript line as mirrored into the Firestore note doc (first ~200 lines,
 * ordered by start_ms). Carries only the display string `time`; the exact
 * `start_ms` lives in Postgres and arrives via `/v1/note`. Source:
 * src/types.ts `TranscriptLine`. (Note.swift adds a positional `index` and an
 * optional `startMs` client-side; those are client concerns, not wire fields.)
 */
export const FirestoreTranscriptLine = z
  .object({
    speaker: z.string(),
    text: z.string(),
    time: z.string(),
  })
  .openapi('FirestoreTranscriptLine');

/** Chunk progress for the long-audio pipeline. Source: src/types.ts
 * `Note.progress` and Note.swift `NoteProgress`. */
export const NoteProgress = z
  .object({
    done: z.number().int(),
    total: z.number().int(),
  })
  .openapi('NoteProgress');

/**
 * The Firestore note document. Superset from src/types.ts.
 *
 * TODO(contracts): Note.swift omits `audioUrl`, `fileUrl`, `language`, `tags`
 * and reads `progress`/`diagnosticCode`; the web `src/types.ts` is the
 * superset and is used as canonical. No field is renamed. Optional fields are
 * modelled `.optional()` to match the TS `?:` — the Firestore doc genuinely
 * omits them at different lifecycle points rather than sending null.
 */
export const Note = z
  .object({
    id: z.string(),
    title: z.string(),
    workspaceId: z.string(),
    authorId: z.string(),
    status: NoteStatus,
    type: NoteType,
    audioUrl: z.string().optional(),
    fileUrl: z.string().optional(),
    sourceUrl: z.string().optional(), // YouTube or meeting link
    duration: z.number().optional(),
    language: z.string().optional(),
    wordCount: z.number().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    summary: Summary.optional(),
    transcript: z.array(FirestoreTranscriptLine).optional(),
    transcriptTruncated: z.boolean().optional(), // full transcript lives in Postgres
    rawText: z.string().optional(), // scan / OCR results
    tags: z.array(z.string()).optional(),
    errorMessage: z.string().optional(),
    diagnosticCode: z.string().optional(),
    storagePath: z.string().optional(),
    mimeType: z.string().optional(),
    jobId: z.string().optional(),
    progress: NoteProgress.optional(),
    retryAttempt: z.number().int().optional(),
    lastProgressAt: z.string().optional(),
  })
  .openapi('Note');

export type NoteStatus = z.infer<typeof NoteStatus>;
export type NoteType = z.infer<typeof NoteType>;
export type Summary = z.infer<typeof Summary>;
export type FirestoreTranscriptLine = z.infer<typeof FirestoreTranscriptLine>;
export type NoteProgress = z.infer<typeof NoteProgress>;
export type Note = z.infer<typeof Note>;
