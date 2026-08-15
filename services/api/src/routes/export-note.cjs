'use strict';

/**
 * /v1/export — server-rendered DOCX.
 *
 * DOCX is the only format rendered server-side. TXT is a string join and PDF
 * has a working client renderer on both iOS (CoreText) and web (jsPDF);
 * moving either to the server would add cost and an egress surface for
 * nothing. DOCX has no credible Swift OOXML writer, and bundling a JS one
 * into the SPA costs ~500 KB for a rare action — so one server
 * implementation serves web, iOS, and any future Android client.
 *
 * Returns raw bytes, not a signed URL. A signed URL would be a second
 * unauthenticated egress surface with an independent lifetime, for a file the
 * caller is already authenticated for. Bytes mean no exports/ prefix, no
 * lifecycle policy, and no orphaned meeting transcripts sitting in a bucket.
 *
 * Everything here is already PII-redacted — the transcoder redacts transcript
 * text before storage — so the document carries <<REDACTED:…>> markers and
 * there is no clean copy. The rendered file says so on its last page.
 *
 * Consolidated into services/api (BUILD-PLAN §3.1) from functions/export-note.cjs.
 * The ONLY change from the source is the shared-lib import path: pg-query comes
 * from @algominutes/db, the intelligence helpers from @algominutes/ai.
 */

const { withQueryTimeout, isQueryTimeout, postgresEnabled } = require('@algominutes/ai/pg-query.cjs');
const { isValidId } = require('@algominutes/ai/intelligence.cjs');

const TIMEOUT_MS = 10000;

/**
 * Above this the render stops being worth doing synchronously — a 20k-line
 * transcript is far past any real meeting (a 2-hour one is 3-6k), so hitting
 * this means something is wrong, and the client falls back to TXT rather
 * than waiting on a request that will time out anyway.
 */
const MAX_LINES = 20000;

const SCOPES = new Set(['summary', 'transcript', 'both']);

const REDACTION_NOTICE =
  'Detected card numbers, IDs and contact details are masked. AlgoMinutes never stored the originals.';

// ── data ──────────────────────────────────────────────────────────────

/**
 * Authorization inlined into every query, not enforced by control flow.
 *
 * Only the note-meta query carried the membership join; the five that follow
 * filtered on note_id alone and were gated solely by an early `return null`
 * above them. That is not exploitable as written, but it is one `Promise.all`
 * hoist or one early-return refactor away from being so — and it is exactly the
 * pattern functions/note-read.cjs argues against, where the predicate is
 * repeated in every query precisely so a refactor cannot lose it.
 *
 * Takes $1 = noteId, $2 = uid, $3 = workspaceId, and aliases the subject table
 * as `s`.
 */
const MEMBERSHIP_JOIN = `
  JOIN notes n ON n.id = s.note_id
  JOIN workspace_members wm ON wm.workspace_id = n.workspace_id
 WHERE s.note_id = $1 AND wm.uid = $2 AND n.workspace_id = $3
   AND n.deleted_at IS NULL`;

async function fetchForExport({ noteId, uid, workspaceId, scope, log }) {
  // Same membership shape as /api/note: join workspace_members, and match the
  // requested workspace explicitly so the 403 check means what it claims.
  const noteRes = await withQueryTimeout({
    timeoutMs: TIMEOUT_MS,
    text: `SELECT n.id, n.title, n.created_at
             FROM notes n
             JOIN workspace_members wm ON wm.workspace_id = n.workspace_id
            WHERE n.id = $1 AND wm.uid = $2 AND n.workspace_id = $3
              AND n.deleted_at IS NULL`,
    values: [noteId, uid, workspaceId],
    log,
    op: 'export_note_meta',
  });
  if (noteRes.rows.length === 0) return null;

  const out = { note: noteRes.rows[0], summary: null, actionItems: [], keyDecisions: [], lines: [] };

  if (scope !== 'transcript') {
    // action_items is the source, not summaries.topics — both writers store
    // the items array in topics and /api/update-note never refreshes it, so
    // topics is stale by design.
    const [summary, items, decisions] = await Promise.all([
      withQueryTimeout({
        timeoutMs: TIMEOUT_MS,
        text: `SELECT s.gist FROM summaries s ${MEMBERSHIP_JOIN}`,
        values: [noteId, uid, workspaceId], log, op: 'export_note_summary',
      }),
      withQueryTimeout({
        timeoutMs: TIMEOUT_MS,
        text: `SELECT s.text FROM action_items s ${MEMBERSHIP_JOIN} ORDER BY s.created_at ASC, s.id ASC`,
        values: [noteId, uid, workspaceId], log, op: 'export_note_items',
      }),
      withQueryTimeout({
        timeoutMs: TIMEOUT_MS,
        text: `SELECT s.text FROM key_decisions s ${MEMBERSHIP_JOIN} ORDER BY s.created_at ASC, s.id ASC`,
        values: [noteId, uid, workspaceId], log, op: 'export_note_decisions',
      }),
    ]);
    out.summary = summary.rows[0] ? summary.rows[0].gist : null;
    out.actionItems = items.rows.map((r) => r.text);
    out.keyDecisions = decisions.rows.map((r) => r.text);
  }

  if (scope !== 'summary') {
    const count = await withQueryTimeout({
      timeoutMs: TIMEOUT_MS,
      text: `SELECT COUNT(*)::int AS total FROM transcript_lines s ${MEMBERSHIP_JOIN}`,
      values: [noteId, uid, workspaceId], log, op: 'export_note_count',
    });
    const total = (count.rows[0] && count.rows[0].total) || 0;
    if (total > MAX_LINES) return { tooLarge: true, totalLines: total };

    const lines = await withQueryTimeout({
      timeoutMs: TIMEOUT_MS,
      text: `SELECT s.chunk_id, s.speaker_tag, s.speaker_name, s.start_ms, s.text
               FROM transcript_lines s ${MEMBERSHIP_JOIN}
              ORDER BY s.start_ms ASC, s.id ASC`,
      values: [noteId, uid, workspaceId], log, op: 'export_note_lines',
    });
    out.lines = lines.rows;
  }

  return out;
}

// ── rendering ─────────────────────────────────────────────────────────

function formatTime(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Speaker for a transcript row.
 *
 * The two write paths differ and a document should not expose that: the
 * chunked path stores speaker_tag with bare text, while the fast path folds
 * "Speaker: text" into the text column with a NULL tag. chunk_id discriminates
 * them reliably. A placeholder "Speaker" is dropped rather than printed on
 * every line, since diarization is off in production and a label on every row
 * would imply an attribution the data does not support.
 */
function speakerAndText(row) {
  const embedded = row.chunk_id === null || row.chunk_id === undefined;
  let speaker = row.speaker_name || null;
  let text = row.text || '';

  if (embedded) {
    const m = /^([^:\n]{1,40}): ([\s\S]*)$/.exec(text);
    if (m) {
      if (!speaker && m[1] !== 'Speaker') speaker = m[1];
      text = m[2];
    }
  } else if (!speaker && row.speaker_tag !== null && row.speaker_tag !== undefined) {
    speaker = `Speaker ${row.speaker_tag}`;
  }
  return { speaker, text };
}

async function renderDocx(data, scope) {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
  const children = [];

  children.push(new Paragraph({ text: data.note.title, heading: HeadingLevel.TITLE }));

  if (scope !== 'transcript') {
    children.push(new Paragraph({ text: 'Executive Summary', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ text: data.summary || 'No summary.' }));

    if (data.actionItems.length) {
      children.push(new Paragraph({ text: 'Action Items', heading: HeadingLevel.HEADING_1 }));
      for (const item of data.actionItems) {
        children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
      }
    }
    if (data.keyDecisions.length) {
      children.push(new Paragraph({ text: 'Key Decisions', heading: HeadingLevel.HEADING_1 }));
      for (const decision of data.keyDecisions) {
        children.push(new Paragraph({ text: decision, bullet: { level: 0 } }));
      }
    }
  }

  if (scope !== 'summary' && data.lines.length) {
    children.push(new Paragraph({ text: 'Transcript', heading: HeadingLevel.HEADING_1 }));
    for (const row of data.lines) {
      const { speaker, text } = speakerAndText(row);
      const prefix = [formatTime(row.start_ms), speaker].filter(Boolean).join('  ');
      children.push(new Paragraph({
        children: [
          ...(prefix ? [new TextRun({ text: `[${prefix}] `, bold: true })] : []),
          new TextRun({ text }),
        ],
      }));
    }
  }

  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({
    children: [new TextRun({ text: REDACTION_NOTICE, italics: true, size: 16 })],
  }));

  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

function safeFileName(title, scope) {
  const replaced = String(title || '').replace(/[^A-Za-z0-9\-_]/g, '_').slice(0, 80);
  // A title of pure punctuation replaces to underscores, which is truthy —
  // so an emptiness check alone would ship "____.docx". Fall back unless
  // something readable survived.
  const stem = /[A-Za-z0-9]/.test(replaced) ? replaced : 'Note';
  const suffix = scope === 'summary' ? '_Summary' : scope === 'transcript' ? '_Transcript' : '_Note';
  return `${stem}${suffix}.docx`;
}

// ── handler ───────────────────────────────────────────────────────────

/**
 * Returns { status, body } for error cases, or { status, buffer, fileName }
 * on success so the caller can set the binary headers itself.
 */
async function handleExportNote({ uid, body, log }) {
  if (!postgresEnabled()) {
    return { status: 503, body: { error: 'Export is unavailable until Postgres is provisioned.' } };
  }

  const noteId = String((body && body.noteId) || '');
  const workspaceId = String((body && body.workspaceId) || '');
  const scope = String((body && body.scope) || 'both');
  const format = String((body && body.format) || 'docx');

  if (!isValidId(noteId) || !isValidId(workspaceId)) {
    return { status: 400, body: { error: 'noteId and workspaceId are required' } };
  }
  if (!SCOPES.has(scope)) {
    return { status: 400, body: { error: 'scope must be summary, transcript or both' } };
  }
  // Only DOCX is rendered here; the clients own TXT and PDF.
  if (format !== 'docx') {
    return { status: 400, body: { error: 'format must be docx' } };
  }
  if (workspaceId !== `workspace_${uid}`) {
    log.warn({ noteId, workspaceId }, 'export_note_workspace_mismatch');
    return { status: 403, body: { error: 'Forbidden' } };
  }

  try {
    const data = await fetchForExport({ noteId, uid, workspaceId, scope, log });
    if (!data) {
      log.info({ noteId, workspaceId }, 'export_note_not_found');
      // 404 for missing and non-member alike, matching /api/note.
      return { status: 404, body: { error: 'Note not found' } };
    }
    if (data.tooLarge) {
      log.warn({ noteId, totalLines: data.totalLines }, 'export_note_too_large');
      return {
        status: 413,
        body: { error: 'transcript_too_large_for_docx', totalLines: data.totalLines },
      };
    }

    const buffer = await renderDocx(data, scope);
    log.info({ noteId, workspaceId, scope, bytes: buffer.length, lines: data.lines.length },
      'note_export');
    return { status: 200, buffer, fileName: safeFileName(data.note.title, scope) };
  } catch (err) {
    if (isQueryTimeout(err)) {
      log.error({ err, noteId, workspaceId }, 'export_note_timeout');
      return { status: 504, body: { error: 'The export took too long. Please try again.' } };
    }
    log.error({ err, noteId, workspaceId }, 'export_note_failed');
    return { status: 500, body: { error: 'Could not build the export' } };
  }
}

module.exports = { handleExportNote, speakerAndText, safeFileName, MAX_LINES, REDACTION_NOTICE };
