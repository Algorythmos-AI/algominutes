'use strict';

// A note deleted while the transcoder was working on it (POST /v1/notes/delete,
// which deletes Postgres first and then the Firestore doc) is not a failure.
// There is nothing left to write and nobody to tell. The task is acknowledged:
// no retry, no error mirror (which would re-create a phantom doc), no dead
// letter, no "note failed" push.

class NoteGoneError extends Error {
  /** where: 'postgres' (the row is gone) or 'firestore' (the doc is gone; Postgres not yet asked). */
  constructor(where) {
    super(`note_gone: ${where}`);
    this.name = 'NoteGoneError';
    this.code = 'NOTE_GONE';
    this.where = where;
  }
}

/** Firestore answers NOT_FOUND (gRPC 5) when update() targets a missing doc. */
function isFirestoreNotFound(err) {
  return !!err && (err.code === 5 || err.code === 'not-found' || /\bNOT_FOUND\b/.test(String(err.message || '')));
}

/**
 * The signals that mean "the note is gone": our own NoteGoneError, the
 * transcoder's NOTE_NOT_FOUND (an UPDATE that matched no row in the task's
 * workspace), and a Postgres foreign-key violation (23503), since everything
 * the transcoder inserts hangs off the note or its chunks, which the delete
 * cascaded away.
 */
function isNoteGone(err) {
  return !!err && (err.code === 'NOTE_GONE' || err.code === 'NOTE_NOT_FOUND' || err.code === '23503');
}

module.exports = { NoteGoneError, isNoteGone, isFirestoreNotFound };
