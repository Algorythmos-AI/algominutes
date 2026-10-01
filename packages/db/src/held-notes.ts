/**
 * Held notes resume when minutes arrive (RELEASE.md rev 11, H6b).
 *
 * A recording longer than the minutes left is held ('awaiting_minutes',
 * note-terminal holdNoteForMinutes): kept, uncharged. Minutes arrive four ways
 * (an invite redeemed, a grant, a purchase, the month turning over), and each
 * shows up as headroom in resolveEntitlement, so one sweep step covers them
 * all: every held note is offered to the kickoff (queueNoteRun), oldest first
 * per user, charged its measured length then. The first one the minutes don't
 * cover stops that user's turn, so a later, shorter note never jumps an older
 * one.
 *
 * The kickoff's own checks decide, in its transaction (markQueued's meter
 * lock), so two sweeps or a sweep and a client retry can't queue a note twice
 * or overspend. In resume mode a refusal leaves the note held, and a failure
 * once queued holds it again (kickoff.ts `resume`).
 *
 * Only a note whose author is still a member of its workspace is resumed
 * (CLAUDE.md §1 multi-tenancy): anyone removed keeps nothing running there.
 * Only a note still held is queued, checked under its lock (markQueued's
 * onlyIfHeld): a client may have run it since the list was read.
 *
 * A note with no measured length (held at the kickoff, before the transcoder
 * saw it) is resumed at 0 minutes: the transcoder's settle then charges its
 * measured length, or holds it again with that length saved.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { getPool, isPostgresEnabled } from './db';
import { queueNoteRun, type KickoffInput, type KickoffResult } from './kickoff';

type Log = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
  child?: (o: object) => Log;
};

export interface HeldNote {
  noteId: string;
  workspaceId: string;
  uid: string;
  type: string;
  storagePath: string | null;
  sourceUrl: string | null;
  mimeType: string | null;
  durationSec: number | null;
}

/** Held notes whose author is still in the workspace, oldest hold first. */
export async function listHeldNotes(input: { limit: number }): Promise<HeldNote[]> {
  if (!isPostgresEnabled()) return [];
  const { rows } = await getPool().query(
    `SELECT n.id AS "noteId", n.workspace_id AS "workspaceId", n.author_uid AS uid, n.source_type AS type,
            n.storage_path AS "storagePath", n.source_url AS "sourceUrl", n.mime_type AS "mimeType",
            n.duration_sec_probed::float8 AS "durationSec"
       FROM notes n
       JOIN workspace_members m ON m.workspace_id = n.workspace_id AND m.uid = n.author_uid
      WHERE n.status = 'awaiting_minutes' AND n.deleted_at IS NULL
      ORDER BY n.updated_at, n.id
      LIMIT $1`,
    [input.limit],
  );
  return rows;
}

export interface ResumeOutcome {
  held: number;
  resumed: number;
  /** Users whose minutes don't cover their oldest held note yet. */
  waiting: number;
  /** Refused or failed for another reason: left held (or held again), for the next sweep. */
  leftHeld: number;
}

export async function resumeHeldNotes(input: {
  firestore: Firestore;
  log: Log;
  /** The sweep run's: every resume line and the kickoff it starts carry it. */
  traceId: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
  /** The kickoff; a test passes its own. */
  queue?: (k: KickoffInput) => Promise<KickoffResult>;
}): Promise<ResumeOutcome> {
  const queue = input.queue ?? queueNoteRun;
  const held = await listHeldNotes({ limit: input.limit ?? 100 });
  const out: ResumeOutcome = { held: held.length, resumed: 0, waiting: 0, leftHeld: 0 };
  const waitingUids = new Set<string>();
  for (const n of held) {
    if (waitingUids.has(n.uid)) continue; // an older note of theirs is still waiting: oldest first
    const fields = { traceId: input.traceId, userId: n.uid, noteId: n.noteId, workspaceId: n.workspaceId };
    const log = input.log.child ? input.log.child(fields) : input.log;
    let result: KickoffResult;
    try {
      result = await queue({
        firestore: input.firestore,
        noteId: n.noteId,
        workspaceId: n.workspaceId,
        uid: n.uid,
        type: n.type,
        storagePath: n.storagePath ?? undefined,
        sourceUrl: n.sourceUrl ?? undefined,
        mimeType: n.mimeType ?? undefined,
        // Charged what the transcoder measured, not the client's claim.
        durationSec: n.durationSec ?? 0,
        // Not the user's own action: their hourly budget isn't spent on it.
        usageBudget: false,
        resume: true,
        traceId: input.traceId,
        log,
        env: input.env,
      });
    } catch (err) {
      out.leftHeld += 1;
      input.log.error({ err, ...fields }, 'held_note_resume_failed');
      continue;
    }
    if (result.kind === 'queued') {
      out.resumed += 1;
      input.log.info({ ...fields, jobId: result.jobId, durationSec: n.durationSec }, 'held_note_resumed');
    } else if (result.kind === 'quota_exceeded') {
      waitingUids.add(n.uid);
      out.waiting += 1;
    } else {
      out.leftHeld += 1;
      input.log.warn({ ...fields, outcome: result.kind }, 'held_note_not_resumed');
    }
  }
  return out;
}
