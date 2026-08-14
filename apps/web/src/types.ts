// `processing` retained for back-compat with notes created pre-Phase-3.
// New states map onto the chunked pipeline:
//   queued → kickoff accepted, waiting for transcoder
//   chunking → ffmpeg slicing audio
//   transcribing → STT (or Gemini for short clips)
//   summarizing → after STT, Gemini composing summary
//   ready / error → terminal
export type NoteStatus =
  | 'recording'
  | 'processing'
  | 'queued'
  | 'chunking'
  | 'transcribing'
  | 'summarizing'
  | 'ready'
  | 'error';
export type NoteType = 'recording' | 'import_audio' | 'import_pdf' | 'youtube' | 'scan_text' | 'online_meeting';

export interface TranscriptLine {
  speaker: string;
  text: string;
  time: string;
}

export interface Summary {
  gist: string;
  actionItems: string[];
  keyDecisions: string[];
  keyPoints?: string[];
}

export interface Note {
  id: string;
  title: string;
  workspaceId: string;
  authorId: string;
  status: NoteStatus;
  type: NoteType;
  audioUrl?: string;
  fileUrl?: string;
  sourceUrl?: string;  // YouTube or meeting link
  duration?: number;
  language?: string;
  wordCount?: number;
  createdAt: string;
  updatedAt: string;
  summary?: Summary;
  transcript?: TranscriptLine[];
  transcriptTruncated?: boolean;  // long-audio notes: full transcript lives in Postgres
  rawText?: string;    // For scan/OCR results
  tags?: string[];
  errorMessage?: string;
  diagnosticCode?: string;     // backend Phase 2 will populate per-error code
  storagePath?: string;
  mimeType?: string;
  jobId?: string;
  progress?: { done: number; total: number };
  retryAttempt?: number;       // bumped each time Try Again is tapped; capped at MAX_RETRY_ATTEMPTS
  lastProgressAt?: string;     // backend Phase 2 will populate; fallback to updatedAt for now
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface AnalyticsEvent {
  userId: string;
  event: string;
  noteId?: string;
  noteType?: NoteType;
  timestamp: string;
  metadata?: Record<string, any>;
}
