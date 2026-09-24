'use strict';

// Firestore status mirror. Cloud Run uses the bound SA via the admin
// SDK, which bypasses security rules — granting roles/datastore.user
// to algominutes-jobs-sa is the supported pattern.

const { NoteGoneError, isFirestoreNotFound } = require('./note-gone');

let _initialized = false;
function db() {
  if (!_initialized) {
    const { initializeApp } = require('firebase-admin/app');
    initializeApp();
    _initialized = true;
  }
  const { getFirestore } = require('firebase-admin/firestore');
  return getFirestore();
}

// Every helper UPDATES the note's doc, never set()s it. The doc is created at
// kickoff (notes-repo markQueued), so a missing doc means the note was deleted
// while this job ran. set({ merge: true }) would silently re-create it as a
// phantom. update() fails with NOT_FOUND instead, which becomes NoteGoneError
// and the handler acknowledges the task.
async function updateNote(fsdb, { workspaceId, noteId }, patch) {
  try {
    await fsdb.doc(`workspaces/${workspaceId}/notes/${noteId}`).update(patch);
  } catch (err) {
    if (isFirestoreNotFound(err)) throw new NoteGoneError('firestore');
    throw err;
  }
}

async function mirrorStatus({ workspaceId, noteId, status, extra }, fsdb = db()) {
  await updateNote(fsdb, { workspaceId, noteId }, {
    status,
    updatedAt: new Date().toISOString(),
    ...(extra || {}),
  });
}

async function mirrorReady({ workspaceId, noteId, summary, transcriptPreview }, fsdb = db()) {
  const patch = {
    status: 'ready',
    updatedAt: new Date().toISOString(),
  };
  // Field paths, so the summary map is merged the way set({ merge: true })
  // merged it (a Firestore-only summary.keyPoints survives).
  if (summary) for (const [k, v] of Object.entries(summary)) patch[`summary.${k}`] = v;
  // Firestore docs cap at 1 MB — long transcripts live in Postgres.
  // We mirror up to 200 lines so the existing detail view keeps
  // rendering without a separate fetch.
  if (Array.isArray(transcriptPreview)) {
    patch.transcript = transcriptPreview.slice(0, 200);
    patch.transcriptTruncated = transcriptPreview.length > 200;
  }
  await updateNote(fsdb, { workspaceId, noteId }, patch);
}

async function mirrorError({ workspaceId, noteId, errorMessage }, fsdb = db()) {
  await updateNote(fsdb, { workspaceId, noteId }, {
    status: 'error',
    errorMessage: errorMessage || 'Processing failed.',
    updatedAt: new Date().toISOString(),
  });
}

async function mirrorProgress({ workspaceId, noteId, done, total }, fsdb = db()) {
  await updateNote(fsdb, { workspaceId, noteId }, {
    progress: { done, total },
    updatedAt: new Date().toISOString(),
  });
}

// `db` is exported so the terminal-failure helper can write the same Firestore
// mirror without opening a second admin app.
module.exports = { db, mirrorStatus, mirrorReady, mirrorError, mirrorProgress };
