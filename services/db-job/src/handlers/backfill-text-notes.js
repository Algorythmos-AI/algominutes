// Backfill the text notes the iPhone wrote straight into Firestore before it saved them through the server (plan
// rev 12 R12.8 PR 5, S16): each `scan_text` doc with no Postgres row is created through notes-repo createTextNote,
// from the doc's own text, keeping its id, its title and its time, so it is inside retention, backups, search and
// export like every other note. The doc is left as it is (createTextNote never overwrites one). Each note is claimed
// for embedding with it, so the sweep's lost-embed redrive indexes it (within its window, a few each run).
//
//   gcloud run jobs execute db-job --wait --update-env-vars JOB_NAME=backfill-text-notes,MODE=dry-run
//   gcloud run jobs execute db-job --wait --update-env-vars JOB_NAME=backfill-text-notes,MODE=run
//
// MODE: dry-run (the default) counts; run writes. BACKFILL_LIMIT (default 500) bounds the notes one run looks at;
// a run that reaches it says so, and the next run carries on (the done ones are skipped). BACKFILL_PAGE (default
// 200) is the Firestore page size. Logs carry ids and counts, never a note's text.
//
// The docs are read through the repo layer (firestoreTextNotePages: each workspace's notes by type, no new index).
'use strict';

const loadRepo = () => require('@algominutes/db');
const loadFirestore = () => {
  const { getApps, initializeApp } = require('firebase-admin/app');
  if (!getApps().length) initializeApp();
  return require('firebase-admin/firestore').getFirestore();
};

// The doc's lines are named by their source, as the iPhone's builder named them.
const SOURCE_OF_LABEL = { 'Scanned image': 'scanned_image', 'PDF document': 'pdf', 'Imported document': 'imported' };

function positiveInt(value, fallback, name) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0`);
  return n;
}

/** The note's text, from the doc: its rawText, or its transcript when it has none. */
function textOf(data) {
  if (typeof data.rawText === 'string' && data.rawText.trim()) return data.rawText;
  const lines = Array.isArray(data.transcript) ? data.transcript : [];
  return lines.map((l) => (l && typeof l.text === 'string' ? l.text : '')).filter(Boolean).join('\n\n');
}

function sourceOf(data) {
  const first = Array.isArray(data.transcript) ? data.transcript[0] : null;
  return SOURCE_OF_LABEL[first && first.speaker] || 'imported';
}

function createdAtOf(data) {
  const ms = typeof data.createdAt === 'string' ? Date.parse(data.createdAt) : NaN;
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}

async function run({ log, traceId, env, repo = loadRepo(), firestore = loadFirestore() }) {
  const mode = env.MODE || 'dry-run';
  if (mode !== 'dry-run' && mode !== 'run') throw new Error(`MODE must be dry-run or run, not ${mode}`);
  const limit = positiveInt(env.BACKFILL_LIMIT, 500, 'BACKFILL_LIMIT');
  const page = positiveInt(env.BACKFILL_PAGE, 200, 'BACKFILL_PAGE');
  const counts = { seen: 0, already: 0, wouldCreate: 0, created: 0, accountDeleted: 0, refused: 0, failed: 0 };
  let limitReached = false;

  for await (const { workspaceId, docs } of repo.firestoreTextNotePages(firestore, page)) {
    const batch = docs.slice(0, limit - counts.seen);
    const existing = await repo.existingNoteIds(batch.map((d) => d.id));
    for (const { id: noteId, data } of batch) {
      counts.seen += 1;
      if (existing.has(noteId)) { counts.already += 1; continue; }
      if (mode === 'dry-run') { counts.wouldCreate += 1; continue; }
      const fields = { noteId, workspaceId, userId: data.authorId || null };
      try {
        const r = await repo.createTextNote(firestore, {
          uid: data.authorId,
          workspaceId,
          noteId,
          text: textOf(data),
          source: sourceOf(data),
          title: typeof data.title === 'string' ? data.title : undefined,
          createdAt: createdAtOf(data),
          traceId,
        }, log);
        if (r.replay) counts.already += 1;
        else counts.created += 1;
      } catch (err) {
        if (err && err.code === 'ACCOUNT_DELETED') {
          counts.accountDeleted += 1;
          log.warn({ ...fields, traceId }, 'backfill_text_note_account_deleted');
        } else if (err && ['WORKSPACE_BOUNDARY', 'TEXT_NOTE_CONFLICT', 'NOTE_DELETED'].includes(err.code)) {
          counts.refused += 1;
          log.warn({ ...fields, traceId, code: err.code }, 'backfill_text_note_refused');
        } else {
          counts.failed += 1;
          log.error({ err, ...fields, traceId }, 'backfill_text_note_failed');
        }
      }
    }
    if (counts.seen >= limit) { limitReached = true; break; }
  }

  const result = { mode, ...counts, limitReached };
  log.info({ traceId, ...result }, 'backfill_text_notes_done');
  return result;
}

module.exports = { run };
