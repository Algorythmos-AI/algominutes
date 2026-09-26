import type { Note } from '../types';

/**
 * How long a note may sit in each in-progress status, since its last sign of
 * life, before the web calls it slow. Generous, to avoid false positives.
 */
export const STUCK_BUDGETS_MS: Record<string, number> = {
  processing: 90_000, // pre-kickoff client window
  queued: 90_000,
  chunking: 300_000, // 5 min: ffmpeg slicing
  transcribing: 480_000, // 8 min: the chunked STT baseline
  summarizing: 240_000, // 4 min: the Gemini ladder
};

/**
 * Only `processing` is the client's own: the web writes it before the upload
 * and the kickoff, so no server run exists to fail the note if the upload
 * dies. Every later status is the server's (Postgres first, then mirrored),
 * and writing 'error' over one from the browser left Postgres in flight: a
 * retry got "already in flight", and the note flipped back to 'error' 90 s
 * later. The server's sweep fails a stuck run itself (3.5 h), and its mirror
 * repair corrects a doc that missed the write.
 */
export function clientOwnsStatus(status: string): boolean {
  return status === 'processing';
}

/** The note has had no sign of life for longer than its status allows. */
export function isSlow(
  note: Pick<Note, 'status' | 'duration' | 'updatedAt'> & { lastProgressAt?: string },
  now: number,
): boolean {
  const budget = STUCK_BUDGETS_MS[note.status];
  if (!budget) return false;
  // A long recording's transcription legitimately takes a while: three times
  // its length (a 60-minute one can need 30 minutes).
  const effective = note.status === 'transcribing' && note.duration
    ? Math.max(budget, note.duration * 1000 * 3)
    : budget;
  const lastSignal = note.lastProgressAt || note.updatedAt;
  if (!lastSignal) return false;
  return now - new Date(lastSignal).getTime() > effective;
}

/**
 * The watchdog's verdict for one pass: notes the client may fail (its own
 * `processing` notes, past their budget) and notes only to report as slow.
 */
export function watchdogPass(
  notes: ReadonlyArray<Pick<Note, 'id' | 'status' | 'duration' | 'updatedAt'> & { lastProgressAt?: string }>,
  now: number,
): { toFail: string[]; slow: string[] } {
  const toFail: string[] = [];
  const slow: string[] = [];
  for (const note of notes) {
    if (!isSlow(note, now)) continue;
    if (clientOwnsStatus(note.status)) toFail.push(note.id);
    else slow.push(note.id);
  }
  return { toFail, slow };
}
