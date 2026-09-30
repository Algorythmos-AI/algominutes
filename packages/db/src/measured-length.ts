/**
 * The charge follows the measured length (docs/plans/RELEASE.md PR 3b).
 *
 * The kickoff charges the length the client claims (`durationSec`), and an
 * import may claim nothing: an iOS import is charged 0 minutes. Once the
 * transcoder has measured the audio (ffprobe), before any paid work, this
 * settles the run's charge to the measured length, in one transaction under the
 * note's row lock (the lock every refund and markQueued take, so a failure's
 * refund sees the adjustment whole or not at all):
 *   - longer than charged: the difference is debited, if the user's minutes
 *     cover it; if not, `over_quota`, and the transcoder fails the note with a
 *     full refund;
 *   - shorter: the difference is refunded;
 *   - longer than the plan's longest recording: `too_long`, failed the same way.
 * A replay finds the charge already equal to the measured length and writes
 * nothing (and a length already accepted isn't refused later, whatever the plan
 * is by then). A run another attempt already failed or finished is left alone.
 * A notetaker's note (online_meeting) is settled but never refused: its minutes
 * were reserved when the bot was sent, and the meeting is over.
 */
import { maxRecordingSecondsForPlan } from '@algominutes/contracts';
import { isPostgresEnabled, withTx } from './db.js';
import { resolveEntitlement, type Entitlement } from './entitlements.js';
import { usedMinutes } from './usage-repo.js';
import { withinLength, chargedMinutes } from './recording-length.js';

export type SettleResult =
  | { kind: 'settled'; chargedMinutes: number; deltaMinutes: number }
  | { kind: 'too_long'; maxSec: number }
  | { kind: 'over_quota'; entitlement: Entitlement; neededMinutes: number }
  /** Another attempt finished or failed (and refunded) the run: nothing to settle. */
  | { kind: 'moved_on'; status: string }
  | { kind: 'not_found' };

const NOT_REFUSED = new Set(['online_meeting']);
// The statuses a run is still being processed in: the transcoder's kickoff
// resumes only these (handler.js KICKOFF_RESUMABLE).
const IN_PROGRESS = new Set(['queued', 'chunking', 'transcribing']);

export async function settleMeasuredLength(input: {
  noteId: string;
  workspaceId: string;
  measuredSec: number;
  log?: { error: (o: any, m?: string) => void };
}): Promise<SettleResult> {
  if (!isPostgresEnabled()) return { kind: 'settled', chargedMinutes: 0, deltaMinutes: 0 };
  const measuredSec = Math.max(0, Number(input.measuredSec) || 0);
  const measured = Math.ceil(measuredSec / 60);
  return withTx(async (client): Promise<SettleResult> => {
    // The note's row lock, as every refund takes it (FOR NO KEY UPDATE: child
    // rows' foreign-key checks aren't blocked). A failure's refund and this
    // settle see each other whole or not at all.
    const { rows: [note] } = await client.query(
      `SELECT author_uid, source_type, status FROM notes
        WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL
        FOR NO KEY UPDATE`,
      [input.noteId, input.workspaceId],
    );
    if (!note) return { kind: 'not_found' };
    // Another attempt may have failed the run (and refunded it) or finished it
    // after this one passed the kickoff's status check: its charge is settled.
    if (!IN_PROGRESS.has(note.status)) return { kind: 'moved_on', status: note.status };

    // The run's charge so far, its anchor (the latest ingest debit), and how
    // many adjustments this run already has.
    const { rows: [led] } = await client.query(
      `SELECT COALESCE(SUM(minutes), 0)::float8 AS net,
              (SELECT row_to_json(d) FROM (
                 SELECT id, uid, workspace_id, billing_period FROM usage_ledger
                  WHERE note_id = $1 AND entry_type = 'debit' AND reason = 'ingest'
                  ORDER BY id DESC LIMIT 1) d) AS anchor
         FROM usage_ledger WHERE note_id = $1`,
      [input.noteId],
    );
    const anchor = led?.anchor as { id: number; uid: string; workspace_id: string | null; billing_period: string } | null;
    // No ingest debit: the run was never metered (nothing to settle against).
    if (!anchor) return { kind: 'settled', chargedMinutes: 0, deltaMinutes: 0 };
    const net = Number(led.net);

    let delta = measured - net;
    // Already settled (a replay), or the claim was right: this length was
    // accepted when it was charged, so a plan change since doesn't refuse it.
    if (delta === 0) return { kind: 'settled', chargedMinutes: net, deltaMinutes: 0 };

    // The user's minutes, under the per-user lock markQueued takes (after the
    // note row, as there), so a settle and a kickoff, or two settles, can't
    // both spend the same headroom.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`meter:${anchor.uid}`]);
    const refusable = !NOT_REFUSED.has(note.source_type);
    const ent = await resolveEntitlement(anchor.uid, { db: client });
    const maxSec = maxRecordingSecondsForPlan(ent.plan);
    if (refusable && !withinLength(measuredSec, maxSec)) return { kind: 'too_long', maxSec };
    // A recording that hit the limit measures a fraction over it: it's charged the limit (rev 11 LM1). A
    // notetaker's meeting isn't capped: its minutes were reserved for the whole meeting.
    if (refusable) {
      delta = chargedMinutes(measuredSec, maxSec) - net;
      if (delta === 0) return { kind: 'settled', chargedMinutes: net, deltaMinutes: 0 };
    }
    if (delta > 0 && refusable && ent.includedMinutes != null) {
      // The adjustment lands in the run's own billing month (as its refund
      // would), so that month's usage is what it must fit.
      const used = anchor.billing_period === ent.billingPeriod
        ? ent.usedMinutes
        : await usedMinutes(anchor.uid, anchor.billing_period, client);
      if (used + delta > ent.includedMinutes) return { kind: 'over_quota', entitlement: ent, neededMinutes: delta };
    }

    // One row per adjustment: a second measurement that differs (a YouTube
    // replay re-downloads the audio) gets its own key rather than colliding.
    const { rows: [{ n }] } = await client.query(
      `SELECT COUNT(*)::int AS n FROM usage_ledger
        WHERE note_id = $1 AND reason IN ('ingest:measured', 'refund:measured') AND id > $2`,
      [input.noteId, anchor.id],
    );
    await client.query(
      `INSERT INTO usage_ledger
         (uid, workspace_id, note_id, entry_type, minutes, billing_period, reason, reverses_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        anchor.uid,
        anchor.workspace_id,
        input.noteId,
        delta > 0 ? 'debit' : 'reversal',
        delta,
        anchor.billing_period,
        delta > 0 ? 'ingest:measured' : 'refund:measured',
        delta > 0 ? null : anchor.id,
        `${input.noteId}:measured:${anchor.id}:${n}`,
      ],
    );
    return { kind: 'settled', chargedMinutes: net + delta, deltaMinutes: delta };
  }, { log: input.log, fields: { noteId: input.noteId, workspaceId: input.workspaceId } });
}
