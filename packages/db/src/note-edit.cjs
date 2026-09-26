'use strict';

// Shared note-edit writer + input sanitizer.
//
// Single source of truth for how a user's manual note edit (title +
// executive summary + action items + key decisions) lands in Postgres.
// Postgres is the system of record (CLAUDE.md §2); the Firestore mirror is
// written by the caller — functions/index.js for the deployed endpoint and
// lib/notes-repo.ts for the dev server — because those are the allowlisted
// Firestore-writing sites. Keeping the SQL here, and nowhere else, avoids the
// write-path duplication the summarizer + notes-repo copies already carry.
//
// Reused by:
//   - functions/index.js  exports.updateNote  (production Cloud Function)
//   - lib/notes-repo.ts   applyNoteEdit       (dev Express server / e2e)

const MAX_TITLE = 300;
const MAX_GIST = 20000;
const MAX_LIST_ITEMS = 200;
const MAX_ITEM = 2000;

// Validate + normalise the editable fields from an untrusted request body.
// Returns { hasTitle, title, hasSummary, summary }; when present, summary is a
// clean { gist, actionItems[], keyDecisions[], keyPoints? }. Throws
// Error(publicMessage) on malformed input so the caller can respond 400.
function sanitizeNoteEdit(body) {
  const b = body || {};
  const out = { hasTitle: false, title: undefined, hasSummary: false, summary: undefined };

  if (b.title !== undefined && b.title !== null) {
    if (typeof b.title !== 'string') throw new Error('title must be a string');
    const t = b.title.trim();
    if (!t) throw new Error('Title cannot be empty.');
    if (t.length > MAX_TITLE) throw new Error('Title is too long.');
    out.hasTitle = true;
    out.title = t;
  }

  if (b.summary !== undefined && b.summary !== null) {
    if (typeof b.summary !== 'object' || Array.isArray(b.summary)) {
      throw new Error('summary must be an object');
    }
    const gist = typeof b.summary.gist === 'string' ? b.summary.gist.trim() : '';
    if (gist.length > MAX_GIST) throw new Error('Summary is too long.');

    const cleanList = (arr, label) => {
      if (arr === undefined || arr === null) return [];
      if (!Array.isArray(arr)) throw new Error(`${label} must be an array`);
      if (arr.length > MAX_LIST_ITEMS) throw new Error(`Too many ${label}.`);
      const cleaned = [];
      for (const raw of arr) {
        const s = String(raw).trim();
        if (!s) continue;
        if (s.length > MAX_ITEM) throw new Error(`A ${label} entry is too long.`);
        cleaned.push(s);
      }
      return cleaned;
    };

    const summary = {
      gist,
      actionItems: cleanList(b.summary.actionItems, 'action items'),
      keyDecisions: cleanList(b.summary.keyDecisions, 'key decisions'),
    };
    // keyPoints is a Firestore-only field (no Postgres column). Preserve it
    // for the mirror when the client sends it so a partial write never drops it.
    if (Array.isArray(b.summary.keyPoints)) {
      summary.keyPoints = b.summary.keyPoints.map((x) => String(x)).slice(0, MAX_LIST_ITEMS);
    }
    out.hasSummary = true;
    out.summary = summary;
  }

  return out;
}

// Apply an edit to Postgres within the caller's transaction (`client` is a
// connected pg client already inside BEGIN). Idempotent: a replay produces the
// same rows — summaries via ON CONFLICT upsert, action_items / key_decisions
// via delete-then-insert (no natural unique key). Only the fields present in
// `edit` are touched.
//
// Returns { pgRowPresent } — false when the note has no Postgres row yet
// (legacy or not-yet-processed note). The caller then relies on the Firestore
// mirror alone and skips the child-table writes that would FK-violate.
async function writeNoteEditWithinTx(client, edit) {
  const { noteId, workspaceId, title, summary } = edit;
  // CLAUDE.md §1 multi-tenancy: the UPDATE is scoped to the caller's workspace,
  // so an id from another workspace matches no row (pgRowPresent: false)
  // instead of being edited. Required — an unscoped edit is never valid.
  if (!workspaceId) throw new Error('writeNoteEditWithinTx: workspaceId is required');
  const hasTitle = typeof title === 'string';

  // summary_manually_edited_at is stamped here and nowhere else, so both
  // callers of this writer (/api/update-note and lib/notes-repo.ts) mark the
  // note identically. /api/regenerate-summary refuses to overwrite a non-null
  // value without explicit confirmation — reprocessing silently wiping manual
  // edits is the reason /api/update-note exists at all. Only a summary edit
  // sets it; renaming a note is not an edit to the summary.
  const hasSummary = summary && typeof summary === 'object';
  const upd = hasTitle
    ? await client.query(
        hasSummary
          ? 'UPDATE notes SET title = $3, summary_manually_edited_at = NOW(), updated_at = NOW() WHERE id = $1 AND workspace_id = $2'
          : 'UPDATE notes SET title = $3, updated_at = NOW() WHERE id = $1 AND workspace_id = $2',
        [noteId, workspaceId, title],
      )
    : await client.query(
        hasSummary
          ? 'UPDATE notes SET summary_manually_edited_at = NOW(), updated_at = NOW() WHERE id = $1 AND workspace_id = $2'
          : 'UPDATE notes SET updated_at = NOW() WHERE id = $1 AND workspace_id = $2',
        [noteId, workspaceId],
      );

  if (!upd.rowCount) return { pgRowPresent: false };

  if (summary) {
    await client.query(
      `INSERT INTO summaries (note_id, gist, generated_at)
         VALUES ($1, $2, NOW())
       ON CONFLICT (note_id) DO UPDATE
         SET gist = EXCLUDED.gist, generated_at = NOW()`,
      [noteId, summary.gist || ''],
    );
    await client.query('DELETE FROM action_items WHERE note_id = $1', [noteId]);
    for (const text of summary.actionItems || []) {
      await client.query('INSERT INTO action_items (note_id, text) VALUES ($1, $2)', [noteId, text]);
    }
    await client.query('DELETE FROM key_decisions WHERE note_id = $1', [noteId]);
    for (const text of summary.keyDecisions || []) {
      await client.query('INSERT INTO key_decisions (note_id, text) VALUES ($1, $2)', [noteId, text]);
    }
  }

  return { pgRowPresent: true };
}

module.exports = { sanitizeNoteEdit, writeNoteEditWithinTx };
