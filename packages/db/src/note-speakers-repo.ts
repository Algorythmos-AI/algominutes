/**
 * Per-note speaker rename map (diarisation §4 / ADR 0005).
 *
 * Writes are the repo layer's job (CLAUDE.md §1 data plane) and are gated by
 * workspace membership: the upsert only touches rows for a note the caller can
 * actually see, via an EXISTS against notes + workspace_members. A non-member's
 * write inserts nothing and returns [], which the route turns into a 403/404 —
 * a user in workspace A can never rename a speaker in workspace B.
 *
 * Cross-note learned names (voiceprints) are deliberately NOT modelled here:
 * v1 is per-note only.
 */
import { getPool, isPostgresEnabled } from './db.js';

export interface SpeakerEntry {
  speakerTag: number;
  name: string;
}

/**
 * Upsert one or more speaker names for a note. Returns the speaker_tags that
 * were written (empty if the caller is not a member of the note's workspace, or
 * the note is deleted/absent). An empty `name` deletes that mapping (revert to
 * "Speaker N").
 */
export async function setNoteSpeakers(
  uid: string,
  noteId: string,
  entries: SpeakerEntry[],
): Promise<number[]> {
  if (!isPostgresEnabled()) return [];
  if (!entries.length) return [];

  const clean = entries
    .filter((e) => Number.isInteger(e.speakerTag) && e.speakerTag > 0)
    .map((e) => ({ speakerTag: e.speakerTag, name: (e.name ?? '').trim() }));
  if (!clean.length) return [];

  const membershipGate = `EXISTS (
    SELECT 1 FROM notes n
      JOIN workspace_members wm ON wm.workspace_id = n.workspace_id
     WHERE n.id = $1 AND wm.uid = $2 AND n.deleted_at IS NULL
  )`;

  const toDelete = clean.filter((e) => e.name === '');
  const toUpsert = clean.filter((e) => e.name !== '');
  const written: number[] = [];

  const pool = getPool();

  if (toUpsert.length) {
    // Build a VALUES list: params $1=noteId, $2=uid, then (tag, name) pairs.
    const valueRows: string[] = [];
    const params: unknown[] = [noteId, uid];
    let p = 3;
    for (const e of toUpsert) {
      valueRows.push(`($${p++}::int, $${p++}::text)`);
      params.push(e.speakerTag, e.name);
    }
    const { rows } = await pool.query(
      `INSERT INTO note_speakers (note_id, speaker_tag, display_name, updated_at)
         SELECT $1, v.tag, v.name, NOW()
           FROM (VALUES ${valueRows.join(', ')}) AS v(tag, name)
          WHERE ${membershipGate}
       ON CONFLICT (note_id, speaker_tag) DO UPDATE
         SET display_name = EXCLUDED.display_name, updated_at = NOW()
       RETURNING speaker_tag`,
      params,
    );
    for (const r of rows) written.push(Number(r.speaker_tag));
  }

  if (toDelete.length) {
    const tags = toDelete.map((e) => e.speakerTag);
    const { rows } = await pool.query(
      `DELETE FROM note_speakers
        WHERE note_id = $1 AND speaker_tag = ANY($3::int[]) AND ${membershipGate}
        RETURNING speaker_tag`,
      [noteId, uid, tags],
    );
    for (const r of rows) written.push(Number(r.speaker_tag));
  }

  return written;
}

/** Current speaker map for a note, membership-gated. */
export async function getNoteSpeakers(
  uid: string,
  noteId: string,
): Promise<SpeakerEntry[]> {
  if (!isPostgresEnabled()) return [];
  const { rows } = await getPool().query(
    `SELECT ns.speaker_tag, ns.display_name
       FROM note_speakers ns
      WHERE ns.note_id = $1
        AND EXISTS (
          SELECT 1 FROM notes n
            JOIN workspace_members wm ON wm.workspace_id = n.workspace_id
           WHERE n.id = $1 AND wm.uid = $2 AND n.deleted_at IS NULL
        )
      ORDER BY ns.speaker_tag ASC`,
    [noteId, uid],
  );
  return rows.map((r) => ({ speakerTag: Number(r.speaker_tag), name: r.display_name }));
}
