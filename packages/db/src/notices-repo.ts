/**
 * The notices outbox (note-notices.cjs, migration 022), on the shared pool: the
 * notifier claims a notice before sending it and marks it sent after, and the
 * sweep re-enqueues notices left unsent and gives up on stale ones.
 */
import { getPool, isPostgresEnabled } from './db.js';
import noteNoticesShared from '@algominutes/db/note-notices.cjs';
import type { NoteNotice } from './notes-repo.js';

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
export type ClaimResult =
  | { claimed: true; notice: NoteNotice }
  | { claimed: false; state: 'sent' | 'abandoned' | 'claimed' | 'gone' | 'superseded' };

const shared = noteNoticesShared as {
  claimNotice: (q: Queryable, id: string) => Promise<ClaimResult>;
  markNoticeSent: (q: Queryable, id: string) => Promise<void>;
  releaseNotice: (q: Queryable, id: string) => Promise<void>;
  listUnsentNotices: (q: Queryable, o?: { minAgeSeconds?: number; maxAgeHours?: number; limit?: number }) => Promise<NoteNotice[]>;
  abandonStaleNotices: (q: Queryable, o?: { maxAgeHours?: number }) => Promise<NoteNotice[]>;
  pruneOldNotices: (q: Queryable, o?: { olderThanDays?: number }) => Promise<number>;
};

/** Take notice `id` to send it; `claimed: false` says why not. */
export async function claimNotice(id: string): Promise<ClaimResult> {
  if (!isPostgresEnabled()) return { claimed: false, state: 'gone' };
  return shared.claimNotice(getPool(), id);
}

/** Sent, or there was nobody to send it to: never sent again. */
export async function markNoticeSent(id: string): Promise<void> {
  if (!isPostgresEnabled()) return;
  await shared.markNoticeSent(getPool(), id);
}

/** A send that failed: the retry may claim it at once. */
export async function releaseNotice(id: string): Promise<void> {
  if (!isPostgresEnabled()) return;
  await shared.releaseNotice(getPool(), id);
}

/** Notices for the sweep to enqueue again (unsent, older than a few minutes, younger than a day). */
export async function listUnsentNotices(
  options?: { minAgeSeconds?: number; maxAgeHours?: number; limit?: number },
): Promise<NoteNotice[]> {
  if (!isPostgresEnabled()) return [];
  return shared.listUnsentNotices(getPool(), options);
}

/** Delete notices sent or given up more than `olderThanDays` ago; returns how many. */
export async function pruneOldNotices(options?: { olderThanDays?: number }): Promise<number> {
  if (!isPostgresEnabled()) return 0;
  return shared.pruneOldNotices(getPool(), options);
}

/** Give up on notices unsent for a day; returns them, for the sweep to log. */
export async function abandonStaleNotices(options?: { maxAgeHours?: number }): Promise<NoteNotice[]> {
  if (!isPostgresEnabled()) return [];
  return shared.abandonStaleNotices(getPool(), options);
}
