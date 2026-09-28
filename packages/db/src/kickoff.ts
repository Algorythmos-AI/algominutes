// queueNoteRun: the one kickoff every source shares (docs/plans/MEETINGS.md).
//
// Extracted from services/api/src/routes/process-intelligence.js so the api
// (a client's upload) and the meetings service (a notetaker's recording) queue
// a note run the same way: the queue-state check, the size and usage budgets,
// the trial and quota gate, markQueued (Postgres, the ingest debit, then the
// Firestore mirror), and the transcode task. It returns a typed result; the
// api maps it to HTTP and a worker maps it to note and bot state. HTTP concerns
// (the caller's own Firestore doc, the storage probe, request headers) stay in
// the route.
import type { Firestore } from 'firebase-admin/firestore';
import intelligenceModule from '@algominutes/ai/intelligence.cjs';
import cloudTasksModule from '@algominutes/ai/cloud-tasks.cjs';
import { getNoteQueueState, markQueued, markError, markKickoffRejected } from './notes-repo';
import { assertCanMeter, QuotaExceededError } from './entitlements';
import { ensureTrial } from './subscriptions-repo';
import { WorkspaceBoundaryError } from './workspace-access';
import type { Entitlement } from './entitlements';

// The .cjs modules are untyped (types/cjs-modules.d.ts): name the shapes used here.
const { MAX_AUDIO_BYTES, publicErrorFor, enforceUsageBudget } = intelligenceModule as {
  MAX_AUDIO_BYTES: number;
  publicErrorFor: (err: unknown) => string;
  enforceUsageBudget: (db: Firestore, uid: string, bytes: number) => Promise<void>;
};
const { enqueueTask } = cloudTasksModule as {
  enqueueTask: (args: {
    projectId: string; location: string; queue: string; targetUrl: string; oidcServiceAccount: string;
    payload: Record<string, unknown>; traceId?: string; log: unknown;
  }) => Promise<unknown>;
};

type Log = {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
};

export interface KickoffInput {
  /** The Firestore instance the mirror and the usage budget write to. */
  firestore: Firestore;
  noteId: string;
  workspaceId: string;
  uid: string;
  email?: string | null;
  name?: string | null;
  type: string;
  storagePath?: string;
  sourceUrl?: string;
  mimeType?: string;
  /**
   * Measures the audio's size (the api reads its GCS metadata). Run after the
   * queue-state check, so a duplicate kickoff costs nothing; a throw means the
   * audio isn't there. The size is checked against MAX_AUDIO_BYTES and the bytes
   * budget. Omitted: size 0 (a server-side fetch measures it later).
   */
  probeSize?: () => Promise<number>;
  /** The duration estimate that meters the run (partial minutes round up). */
  durationSec?: number;
  /** Count this run against the caller's hourly usage budget (default true). */
  usageBudget?: boolean;
  /**
   * Start the caller's trial and check their minutes before queueing (default
   * true). A notetaker reserves its minutes before it joins, so its ingest
   * passes false and is never refused a meeting that was already recorded.
   */
  quota?: boolean;
  /** For the trial's anti-abuse gate. */
  trial?: { deviceHash?: string; platform?: 'ios' | 'android' | 'web'; emailPresent?: boolean };
  /**
   * A note still 'recording' has nothing to process yet: a client kickoff is
   * refused. The notetaker's own ingest, which ends the recording, passes true.
   */
  allowRecording?: boolean;
  traceId?: string;
  log: Log;
  env?: NodeJS.ProcessEnv;
}

export type KickoffResult =
  | { kind: 'queued'; jobId: string }
  | { kind: 'in_flight'; status: string | null }
  | { kind: 'not_found' }
  | { kind: 'recording' }
  | { kind: 'audio_missing' }
  | { kind: 'too_large'; message: string }
  | { kind: 'rate_limited'; message: string }
  | { kind: 'quota_exceeded'; entitlement: Entitlement | null }
  | { kind: 'account_deleted' }
  | { kind: 'misconfigured'; message: string }
  | { kind: 'failed'; message: string };

const TRY_AGAIN = "We couldn't queue your audio. Please try again.";

// Past markQueued the run was charged and never started: fail the note and
// refund in the failure's own transaction (net-guarded, so a note never charged
// gets nothing back). Never throws: the caller is already on an error path.
async function failNote(input: KickoffInput, userMsg: string, event: string): Promise<void> {
  const { firestore, noteId, workspaceId, log } = input;
  const refund = { reason: 'refund:enqueue_failed', idempotencyKey: `${noteId}:refund:enqueue` };
  await markError(firestore, { noteId, workspaceId, errorMessage: userMsg, refund }, log).catch((err: unknown) =>
    log.error({ err, event }, 'mark_error_failed'),
  );
}

// A refusal before markQueued (too large, rate limit): as failNote, but a note a
// concurrent duplicate kickoff already queued is left running.
async function rejectNote(input: KickoffInput, userMsg: string, event: string): Promise<void> {
  const { firestore, noteId, workspaceId, log } = input;
  try {
    const { marked } = await markKickoffRejected(firestore, { noteId, workspaceId, errorMessage: userMsg }, log);
    if (!marked) log.info({ event }, 'kickoff_rejection_spared_in_flight_note');
  } catch (err) {
    log.error({ err, event }, 'mark_error_failed');
  }
}

const isAccountDeleted = (err: any) => err?.code === 'ACCOUNT_DELETED';

export async function queueNoteRun(input: KickoffInput): Promise<KickoffResult> {
  const { firestore, noteId, workspaceId, uid, type, log } = input;
  const env = input.env ?? process.env;

  // ── Postgres pre-check: foreign, still recording, or already in flight? ──
  // Before the budgets and metering, so a duplicate kickoff (a client retry
  // after a timeout) or a foreign note id costs nothing and changes nothing.
  // markQueued repeats the in-flight check atomically.
  let queueState;
  try {
    queueState = await getNoteQueueState({ noteId, workspaceId });
  } catch (err) {
    log.error({ err }, 'note_queue_state_failed');
    return { kind: 'failed', message: TRY_AGAIN };
  }
  if (queueState.foreign) {
    log.warn({}, 'process_note_workspace_boundary');
    return { kind: 'not_found' };
  }
  if (queueState.status === 'recording' && !input.allowRecording) {
    log.info({}, 'process_note_still_recording');
    return { kind: 'recording' };
  }
  if (queueState.inFlight) {
    log.info({ status: queueState.status }, 'process_already_in_flight');
    return { kind: 'in_flight', status: queueState.status };
  }

  // ── Size (drives the bytes budget) ──
  let sizeBytes = 0;
  if (input.probeSize) {
    try {
      sizeBytes = Number((await input.probeSize()) || 0);
    } catch (err) {
      log.error({ err, storagePath: input.storagePath }, 'storage_metadata_failed');
      return { kind: 'audio_missing' };
    }
  }
  if (sizeBytes > MAX_AUDIO_BYTES) {
    const message = publicErrorFor(new Error('TOO_LARGE'));
    await rejectNote(input, message, 'too_large');
    return { kind: 'too_large', message };
  }

  // ── Usage budget (count + bytes, atomic) ──
  if (input.usageBudget !== false) {
    try {
      await enforceUsageBudget(firestore, uid, sizeBytes);
    } catch (err: any) {
      const message = publicErrorFor(err);
      await rejectNote(input, message, 'rate_limit');
      log.warn({ reason: err?.message, bytes: sizeBytes }, 'usage_budget_exceeded');
      return { kind: 'rate_limited', message };
    }
  }

  // ── A9.2 metered-minutes gate ──
  // Enforced SERVER-SIDE before any paid transcode work is queued: refusing
  // over-quota work AFTER paying for STT is the expensive mistake. The duration
  // is the caller's estimate (the transcoder's ffprobe measures it later);
  // billing rounds partial minutes up.
  const durationSec = Number(input.durationSec ?? 0);
  const minutes = Number.isFinite(durationSec) && durationSec > 0 ? Math.ceil(durationSec / 60) : 0;
  if (input.quota !== false) {
    try {
      // A9.3 the reverse trial starts at first value (idempotent, so a reinstall
      // never restarts it). A10 #7: a device already trialled gets no fresh
      // trial; web needs an email on the account.
      await ensureTrial(uid, {
        deviceHash: input.trial?.deviceHash,
        platform: input.trial?.platform,
        emailPresent: input.trial?.emailPresent,
        user: { email: input.email, name: input.name },
        log,
      });
      await assertCanMeter(uid, minutes);
      // The debit itself is written by markQueued, in the transaction that
      // creates the note row, and only if it actually queues.
    } catch (err: any) {
      if (isAccountDeleted(err)) {
        log.warn({}, 'process_account_deleted');
        return { kind: 'account_deleted' };
      }
      // instanceof is the intent; the code check is the cross-realm fallback.
      if (err instanceof QuotaExceededError || err?.code === 'QUOTA_EXCEEDED') {
        log.warn({ minutes, plan: err.entitlement?.plan }, 'quota_exceeded');
        return { kind: 'quota_exceeded', entitlement: err.entitlement ?? null };
      }
      log.error({ err }, 'meter_ingest_failed');
      return { kind: 'failed', message: TRY_AGAIN };
    }
  }

  // ── Persist queued state: Postgres (with the ingest debit), then the mirror ──
  let queued;
  try {
    queued = await markQueued(firestore, {
      noteId, workspaceId,
      authorUid: uid, authorEmail: input.email, authorName: input.name,
      sourceType: type, storagePath: input.storagePath, sourceUrl: input.sourceUrl, mimeType: input.mimeType,
      meter: { minutes, idempotencyKey: `${noteId}:ingest` },
      allowRecording: input.allowRecording,
    }, log);
  } catch (err: any) {
    if (isAccountDeleted(err)) {
      // The account was deleted; its token is still valid for up to an hour.
      log.warn({}, 'process_account_deleted');
      return { kind: 'account_deleted' };
    }
    if (err instanceof WorkspaceBoundaryError || err?.code === 'WORKSPACE_BOUNDARY') {
      // Postgres note ids are global: this id belongs to another workspace.
      // Nothing was written; answer exactly as for a note that doesn't exist.
      log.warn({ err }, 'process_note_workspace_boundary');
      return { kind: 'not_found' };
    }
    log.error({ err }, 'mark_queued_failed');
    await failNote(input, TRY_AGAIN, 'queue');
    return { kind: 'failed', message: TRY_AGAIN };
  }
  if (queued.deleted) {
    // Deleted while this ran: it stays deleted, and nothing is queued.
    log.info({}, 'process_note_deleted');
    return { kind: 'not_found' };
  }
  if (!queued.queued && queued.status === 'recording') {
    // Became a notetaker's note between the pre-check and the lock.
    log.info({}, 'process_note_still_recording');
    return { kind: 'recording' };
  }
  if (!queued.queued) {
    // Lost the race to a concurrent duplicate that queued first: that run owns
    // the note. Don't enqueue a second kickoff.
    log.info({ status: queued.status }, 'process_already_in_flight');
    return { kind: 'in_flight', status: queued.status };
  }

  // ── Enqueue the transcode task ──
  const transcoderUrl = env.TRANSCODER_URL || '';
  const jobsSa = env.JOBS_SA_EMAIL || '';
  const tasksProject = env.TASKS_PROJECT || '';
  const tasksLocation = env.TASKS_LOCATION || 'us-central1';
  // The kickoff targets the transcoder, so it goes on the transcode queue
  // (Terraform-created name); TASKS_QUEUE kept as a legacy override.
  const tasksQueue = env.TRANSCODE_QUEUE || env.TASKS_QUEUE || 'transcode';
  if (!transcoderUrl || !jobsSa || !tasksProject) {
    log.error({ transcoderUrl: !!transcoderUrl, jobsSa: !!jobsSa, tasksProject: !!tasksProject }, 'kickoff_misconfigured');
    const message = 'Service is being upgraded. Please try again shortly.';
    await failNote(input, message, 'kickoff_misconfig');
    return { kind: 'misconfigured', message };
  }

  const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await enqueueTask({
      projectId: tasksProject,
      location: tasksLocation,
      queue: tasksQueue,
      targetUrl: transcoderUrl,
      oidcServiceAccount: jobsSa,
      payload: {
        kind: 'kickoff',
        jobId,
        noteId,
        workspaceId,
        type,
        storagePath: input.storagePath,
        sourceUrl: input.sourceUrl,
        mimeType: input.mimeType,
        // The caller, carried through every worker hop so their logs name the
        // user (CLAUDE.md §1: userId where it exists).
        uid,
      },
      traceId: input.traceId,
      log,
    });
  } catch (err) {
    log.error({ err }, 'task_enqueue_failed');
    await failNote(input, TRY_AGAIN, 'enqueue');
    return { kind: 'failed', message: TRY_AGAIN };
  }

  // The kickoff's record: this line carries traceId, userId, noteId,
  // workspaceId, the note type (`source`) and the jobId; a log-based metric
  // counts it.
  log.info({ jobId }, 'kickoff_enqueued');
  return { kind: 'queued', jobId };
}
