'use strict';

// Firestore status mirror. Cloud Run uses the bound SA via the admin
// SDK, which bypasses security rules — granting roles/datastore.user
// to wassup-jobs-sa is the supported pattern.

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

async function mirrorStatus({ workspaceId, noteId, status, extra }) {
  const ref = db().doc(`workspaces/${workspaceId}/notes/${noteId}`);
  const patch = {
    status,
    updatedAt: new Date().toISOString(),
    ...(extra || {}),
  };
  await ref.set(patch, { merge: true });
}

async function mirrorReady({ workspaceId, noteId, summary, transcriptPreview }) {
  const ref = db().doc(`workspaces/${workspaceId}/notes/${noteId}`);
  const patch = {
    status: 'ready',
    updatedAt: new Date().toISOString(),
  };
  if (summary) patch.summary = summary;
  // Firestore docs cap at 1 MB — long transcripts live in Postgres.
  // We mirror up to 200 lines so the existing detail view keeps
  // rendering without a separate fetch.
  if (Array.isArray(transcriptPreview)) {
    patch.transcript = transcriptPreview.slice(0, 200);
    patch.transcriptTruncated = transcriptPreview.length > 200;
  }
  await ref.set(patch, { merge: true });
}

async function mirrorError({ workspaceId, noteId, errorMessage }) {
  const ref = db().doc(`workspaces/${workspaceId}/notes/${noteId}`);
  await ref.set({
    status: 'error',
    errorMessage: errorMessage || 'Processing failed.',
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

async function mirrorProgress({ workspaceId, noteId, done, total }) {
  const ref = db().doc(`workspaces/${workspaceId}/notes/${noteId}`);
  await ref.set({
    progress: { done, total },
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

// `db` is exported so the terminal-failure helper can write the same Firestore
// mirror without opening a second admin app.
module.exports = { db, mirrorStatus, mirrorReady, mirrorError, mirrorProgress };
