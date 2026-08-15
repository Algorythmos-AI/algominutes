'use strict';

/**
 * /v1/notes/read — full-note read from Postgres.
 *
 * Firestore mirrors only the first 200 transcript lines
 * (services/transcoder/src/firestore-mirror.js), so the complete transcript
 * has never been reachable from a client. Export, transcript-scoped search,
 * and tap-to-seek playback all depend on this endpoint.
 *
 * Framework-agnostic on purpose: handleNoteRead({ uid, body, log }) returns
 * { status, body } so a single mount serves every client.
 *
 * Consolidated into services/api (BUILD-PLAN §3.1) from functions/note-read.cjs.
 * The ONLY change from the source is where the shared libs come from: the
 * per-file `loadShared('./shared/*')` shim is replaced by imports from the
 * workspace packages (@algominutes/db owns pg-query, @algominutes/ai owns the
 * intelligence helpers). Behaviour is otherwise identical.
 *
 * Everything returned here is already PII-redacted — the transcoder redacts
 * transcript text before it is stored (services/transcoder/src/db.js and
 * fast-path.js), so `<<REDACTED:…>>` markers are expected in the output and
 * there is no un-redacted copy anywhere in the system. `redaction.applied`
 * makes that explicit to clients so they can disclose it in export UI rather
 * than surprising the user with it in a forwarded document.
 */

const { withQueryTimeout, isQueryTimeout, postgresEnabled } = require('@algominutes/ai/pg-query.cjs');
const { isValidId } = require('@algominutes/ai/intelligence.cjs');

// A 2-hour chunked meeting is roughly 3-6k transcript lines. 1000 lines is
// ~200 KB of JSON, comfortably inside response limits, and keeps the first
// paint fast; a client that wants everything follows nextCursor.
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 2000;

// Query budgets. The function timeout is 60s; the worst case here is
// 3 + 5 + 10 = 18s, leaving ample headroom for cold start and render.
const TIMEOUT_NOTE_MS = 3000;
const TIMEOUT_SUMMARY_MS = 5000;
const TIMEOUT_TRANSCRIPT_MS = 10000;

// ── cursor ────────────────────────────────────────────────────────────
// Keyset, not OFFSET: later pages of a long transcript degrade badly under
// OFFSET. The tiebreak on id is load-bearing for correctness, not just
// ordering — the fast path writes start_ms = 0 for every line whose
// model-supplied timestamp failed to parse, so start_ms alone is not a
// total order and pages would skip and duplicate rows.

function encodeCursor(startMs, id) {
  return Buffer.from(`${startMs}:${id}`, 'utf8').toString('base64url');
}

// Returns { startMs, id } or null when absent. Throws on malformed input so
// the caller can answer 400 rather than silently restarting from page 1 —
// a silently-reset cursor would make a client's pagination loop infinite.
function decodeCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 128) throw new Error('bad_cursor');
  // No try/catch around the decode: Buffer.from(_, 'base64url') is lenient
  // and silently drops invalid characters rather than throwing, so a catch
  // here would be dead code implying a defence it does not provide. Garbage
  // decodes to something the regex below rejects, which is the real guard.
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const m = /^(\d+):(\d+)$/.exec(decoded);
  if (!m) throw new Error('bad_cursor');
  const startMs = Number(m[1]);
  const id = Number(m[2]);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(id)) throw new Error('bad_cursor');
  return { startMs, id };
}

// ── speaker normalisation ─────────────────────────────────────────────
// The two write paths store speakers differently and a client should not
// have to know which produced a given note:
//
//   chunked (chunk_id IS NOT NULL) — speaker_tag column, bare text
//   fast    (chunk_id IS NULL)     — speaker folded into text as
//                                    `${speaker}: ${text}` by fast-path.js
//
// chunk_id is a reliable discriminator, so the split below is applied only
// to fast-path rows and is never a guess about arbitrary prose.
//
// Conservative by construction: the speaker segment may not contain a colon
// or newline and is length-capped, so a redacted speaker (which contains a
// colon, e.g. `<<REDACTED:EMAIL>>`) simply fails to match and the text is
// returned untouched. Losing a speaker label is acceptable; corrupting a
// transcript line is not.
const EMBEDDED_SPEAKER_RE = /^([^:\n]{1,40}): ([\s\S]*)$/;

function splitEmbeddedSpeaker(text) {
  const m = EMBEDDED_SPEAKER_RE.exec(text || '');
  if (!m) return { speaker: null, text: text || '' };
  return { speaker: m[1], text: m[2] };
}

// shared/pg-query.cjs is generic and cannot know about notes — its other
// caller (search-and-chat) spans many notes at once, so noteId is genuinely
// out of scope there. Binding the correlation fields onto a child logger
// here gives every pg_<op>_ok / _timeout / _failed line from this request
// the noteId and workspaceId you need to grep a slow read, without changing
// the shared helper's signature.
function childLog(log, fields) {
  return log && typeof log.child === 'function' ? log.child(fields) : log;
}

// ── serialisation ─────────────────────────────────────────────────────
// pg returns TIMESTAMPTZ as Date. The iOS and web clients both parse ISO-8601
// strings (the iOS client's Note model parseISO), so normalise here
// rather than relying on incidental JSON.stringify behaviour.
function iso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

// DATE columns carry no time component; keep them as plain YYYY-MM-DD so a
// timezone shift can't move a due date by a day.
function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── queries ───────────────────────────────────────────────────────────

// Every query below carries the membership predicate itself rather than
// relying on fetchNote having run first (CLAUDE.md §2). The await-ordering
// in handleNoteRead does gate them today, but authorization that lives in
// control flow is one refactor away from disappearing: the handler already
// batches sibling reads with Promise.all, and hoisting the transcript query
// into that batch would silently remove the gate. In SQL it cannot be lost
// by accident.
//
// Cost is negligible — notes is hit by primary key and workspace_members by
// its (workspace_id, uid) primary key.
const MEMBERSHIP_EXISTS = `EXISTS (
          SELECT 1 FROM notes n
            JOIN workspace_members wm ON wm.workspace_id = n.workspace_id
           WHERE n.id = $1 AND wm.uid = $2 AND n.deleted_at IS NULL)`;

// workspace_id is matched explicitly, not just validated in the handler.
// Without it the endpoint's real scope is "any note in any workspace the
// caller belongs to", so the returned note.workspaceId could differ from the
// one requested the moment workspace_members gains a non-owner row — and the
// 403 check would be claiming something the query never enforced.
async function fetchNote({ noteId, uid, workspaceId, log }) {
  const r = await withQueryTimeout({
    timeoutMs: TIMEOUT_NOTE_MS,
    text: `SELECT n.id, n.workspace_id, n.title, n.status, n.source_type,
                  n.source_url, n.storage_path, n.mime_type, n.duration_sec,
                  n.duration_sec_probed, n.language, n.word_count,
                  n.participants, n.meeting_at, n.error_message,
                  n.chunks_done, n.chunks_total, n.created_at, n.updated_at
             FROM notes n
             JOIN workspace_members wm ON wm.workspace_id = n.workspace_id
            WHERE n.id = $1 AND wm.uid = $2 AND n.workspace_id = $3
              AND n.deleted_at IS NULL`,
    values: [noteId, uid, workspaceId],
    log,
    op: 'note_read_meta',
  });
  return r.rows[0] || null;
}

async function fetchSummary({ noteId, uid, log }) {
  const [summaryRes, itemsRes, decisionsRes] = await Promise.all([
    withQueryTimeout({
      timeoutMs: TIMEOUT_SUMMARY_MS,
      // `topics` is deliberately not selected: both writers store the
      // action-items array in it (fast-path.js, summarizer/handler.js) and
      // /api/update-note never refreshes it, so it is stale by design.
      // action_items is the real source. long_summary is always NULL today.
      text: `SELECT gist, model, generated_at FROM summaries
              WHERE note_id = $1 AND ${MEMBERSHIP_EXISTS}`,
      values: [noteId, uid],
      log,
      op: 'note_read_summary',
    }),
    withQueryTimeout({
      timeoutMs: TIMEOUT_SUMMARY_MS,
      text: `SELECT id, text, status, assignee_name, due_date
               FROM action_items
              WHERE note_id = $1 AND ${MEMBERSHIP_EXISTS}
              ORDER BY created_at ASC, id ASC`,
      values: [noteId, uid],
      log,
      op: 'note_read_action_items',
    }),
    withQueryTimeout({
      timeoutMs: TIMEOUT_SUMMARY_MS,
      text: `SELECT id, text FROM key_decisions
              WHERE note_id = $1 AND ${MEMBERSHIP_EXISTS}
              ORDER BY created_at ASC, id ASC`,
      values: [noteId, uid],
      log,
      op: 'note_read_key_decisions',
    }),
  ]);

  const row = summaryRes.rows[0];
  if (!row && itemsRes.rows.length === 0 && decisionsRes.rows.length === 0) return null;

  return {
    gist: (row && row.gist) || '',
    model: (row && row.model) || null,
    generatedAt: iso(row && row.generated_at),
    actionItems: itemsRes.rows.map((r) => ({
      id: r.id,
      text: r.text,
      status: r.status || 'open',
      assigneeName: r.assignee_name || null,
      dueDate: dateOnly(r.due_date),
    })),
    keyDecisions: decisionsRes.rows.map((r) => ({ id: r.id, text: r.text })),
  };
}

async function fetchTranscriptPage({ noteId, uid, cursor, limit, log }) {
  // $1 = noteId and $2 = uid in both shapes so MEMBERSHIP_EXISTS drops in
  // unchanged; only the cursor and limit placeholders shift.
  //
  // Row-wise comparison is index-friendly against
  // transcript_lines_note_keyset_idx (note_id, start_ms, id). Explicit casts
  // because start_ms is INTEGER and id is BIGINT.
  const where = cursor
    ? `WHERE note_id = $1 AND ${MEMBERSHIP_EXISTS}
              AND (start_ms, id) > ($3::int, $4::bigint)`
    : `WHERE note_id = $1 AND ${MEMBERSHIP_EXISTS}`;
  const values = cursor
    ? [noteId, uid, cursor.startMs, cursor.id, limit]
    : [noteId, uid, limit];
  const limitParam = cursor ? '$5' : '$3';

  const r = await withQueryTimeout({
    timeoutMs: TIMEOUT_TRANSCRIPT_MS,
    text: `SELECT id, chunk_id, speaker_tag, speaker_name, start_ms, end_ms,
                  text, confidence
             FROM transcript_lines
            ${where}
            ORDER BY start_ms ASC, id ASC
            LIMIT ${limitParam}`,
    values,
    log,
    op: 'note_read_transcript',
  });

  return r.rows.map((row) => {
    // Fast-path rows (chunk_id IS NULL) carry the speaker inside text.
    const embedded = row.chunk_id === null || row.chunk_id === undefined;
    const split = embedded ? splitEmbeddedSpeaker(row.text) : { speaker: null, text: row.text || '' };
    const speaker = row.speaker_name
      || split.speaker
      || (row.speaker_tag !== null && row.speaker_tag !== undefined ? `Speaker ${row.speaker_tag}` : null);
    return {
      id: String(row.id),
      speaker,
      speakerTag: row.speaker_tag === null || row.speaker_tag === undefined ? null : Number(row.speaker_tag),
      startMs: num(row.start_ms) || 0,
      endMs: num(row.end_ms) || 0,
      text: split.text,
      confidence: num(row.confidence),
    };
  });
}

async function countTranscriptLines({ noteId, uid, log }) {
  const r = await withQueryTimeout({
    timeoutMs: TIMEOUT_SUMMARY_MS,
    text: `SELECT COUNT(*)::int AS total FROM transcript_lines
            WHERE note_id = $1 AND ${MEMBERSHIP_EXISTS}`,
    values: [noteId, uid],
    log,
    op: 'note_read_count',
  });
  return (r.rows[0] && r.rows[0].total) || 0;
}

// ── handler ───────────────────────────────────────────────────────────

async function handleNoteRead({ uid, body, log }) {
  if (!postgresEnabled()) {
    return { status: 503, body: { error: 'Notes are unavailable until Postgres is provisioned.' } };
  }

  const noteId = String((body && body.noteId) || '');
  const workspaceId = String((body && body.workspaceId) || '');
  if (!isValidId(noteId)) return { status: 400, body: { error: 'noteId is required' } };
  if (!isValidId(workspaceId)) return { status: 400, body: { error: 'workspaceId is required' } };

  // Same ownership rule as every other endpoint: a workspace is derived from
  // the uid, so a mismatch is a client bug or an attack, never a legitimate
  // cross-workspace read.
  if (workspaceId !== `workspace_${uid}`) {
    log.warn({ noteId, workspaceId }, 'note_read_workspace_mismatch');
    return { status: 403, body: { error: 'Forbidden' } };
  }

  // Every query for this request logs with noteId + workspaceId bound.
  const qlog = childLog(log, { noteId, workspaceId });

  let cursor;
  try {
    cursor = decodeCursor(body && body.cursor);
  } catch (err) {
    // A malformed cursor is a client bug, not a user error — log it so the
    // broken caller is identifiable instead of silently 400-looping.
    qlog.warn({ err }, 'note_read_bad_cursor');
    return { status: 400, body: { error: 'cursor is malformed' } };
  }

  let limit = Number((body && body.limit) || DEFAULT_LIMIT);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), MAX_LIMIT);

  try {
    const noteRow = await fetchNote({ noteId, uid, workspaceId, log: qlog });
    // 404 for both "no such note" and "not a member" — a 403 here would
    // confirm the note exists to someone who cannot read it.
    if (!noteRow) {
      qlog.info({}, 'note_read_not_found');
      return { status: 404, body: { error: 'Note not found' } };
    }

    const lines = await fetchTranscriptPage({ noteId, uid, cursor, limit, log: qlog });
    const last = lines.length ? lines[lines.length - 1] : null;
    // A short page means the end of the transcript; only advertise a cursor
    // when a further page is actually possible.
    const nextCursor = lines.length === limit && last
      ? encodeCursor(last.startMs, last.id)
      : null;

    // Cursor pages return transcript only — re-shipping metadata and the
    // summary on every page would triple the bytes for no reason.
    if (cursor) {
      return {
        status: 200,
        body: {
          transcript: { lines, nextCursor, truncated: Boolean(nextCursor) },
          redaction: { applied: true, scheme: 'shared/redaction.cjs' },
        },
      };
    }

    const [summary, totalLines] = await Promise.all([
      fetchSummary({ noteId, uid, log: qlog }),
      countTranscriptLines({ noteId, uid, log: qlog }),
    ]);

    qlog.info({ lineCount: lines.length, totalLines }, 'note_read_ok');

    return {
      status: 200,
      body: {
        note: {
          id: noteRow.id,
          workspaceId: noteRow.workspace_id,
          title: noteRow.title,
          status: noteRow.status,
          sourceType: noteRow.source_type,
          sourceUrl: noteRow.source_url || null,
          storagePath: noteRow.storage_path || null,
          mimeType: noteRow.mime_type || null,
          // duration_sec is client-supplied at creation; duration_sec_probed
          // is ffprobe's measurement and is the more trustworthy of the two.
          durationSec: num(noteRow.duration_sec_probed) ?? num(noteRow.duration_sec),
          language: noteRow.language || null,
          wordCount: num(noteRow.word_count),
          participants: noteRow.participants || null,
          meetingAt: iso(noteRow.meeting_at),
          errorMessage: noteRow.error_message || null,
          chunksDone: num(noteRow.chunks_done),
          chunksTotal: num(noteRow.chunks_total),
          createdAt: iso(noteRow.created_at),
          updatedAt: iso(noteRow.updated_at),
        },
        summary,
        transcript: { lines, totalLines, nextCursor, truncated: Boolean(nextCursor) },
        redaction: { applied: true, scheme: 'shared/redaction.cjs' },
      },
    };
  } catch (err) {
    if (isQueryTimeout(err)) {
      qlog.error({ err }, 'note_read_timeout');
      return { status: 504, body: { error: 'The note took too long to load. Please try again.' } };
    }
    qlog.error({ err }, 'note_read_failed');
    return { status: 500, body: { error: 'Could not load the note' } };
  }
}

module.exports = { handleNoteRead, encodeCursor, decodeCursor, splitEmbeddedSpeaker };
