'use strict';

// Shared writer + sanitizer for transcription-quality ratings.
//
// SQL lives here rather than in the Cloud Function so a dev-server twin is a
// thin wrapper if one is ever needed, matching the note-edit.cjs pattern.
//
// Reused by:
//   - functions/index.js  exports.noteFeedback

const MAX_COMMENT = 2000;

/**
 * Validate and normalise a feedback submission.
 *
 * Throws Error(publicMessage) on malformed input so the caller answers 400.
 * Returns { rating, kind, comment } with comment already trimmed and capped —
 * redaction happens in the writer, which has the redactPII dependency.
 */
function sanitizeFeedback(body) {
  const b = body || {};

  // Type-check before coercing. Number(true) is 1, so without this a boolean
  // would arrive as a silent 1-star rating — the worst possible default.
  // A numeric string is accepted because JSON clients legitimately send one.
  if (typeof b.rating !== 'number' && typeof b.rating !== 'string') {
    throw new Error('rating must be a whole number from 1 to 5');
  }
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error('rating must be a whole number from 1 to 5');
  }

  // Constrained rather than free-form so the column stays queryable and a
  // typo cannot silently create a new category nobody reports on.
  const kind = b.kind === undefined || b.kind === null ? 'transcription' : String(b.kind);
  if (!['transcription', 'summary'].includes(kind)) {
    throw new Error('kind must be "transcription" or "summary"');
  }

  let comment;
  if (b.comment !== undefined && b.comment !== null) {
    if (typeof b.comment !== 'string') throw new Error('comment must be text');
    const trimmed = b.comment.trim();
    // Empty after trimming is "no comment", not an empty string — keeps the
    // column meaningfully nullable.
    comment = trimmed.length ? trimmed.slice(0, MAX_COMMENT) : undefined;
  }

  return { rating, kind, comment };
}

/**
 * Upsert one rating.
 *
 * The primary key (note_id, uid, kind) is the idempotency: rating twice
 * corrects the first rating rather than accumulating rows.
 *
 * `redactPII` is injected so this module stays dependency-free and the
 * redaction call site is visible at the boundary rather than buried.
 */
async function writeFeedbackWithinTx(client, { noteId, uid, rating, kind, comment }, redactPII) {
  let storedComment = null;
  let counts = null;

  if (comment) {
    // CLAUDE.md §2 in spirit: this text never reaches Gemini, but a human
    // will read it and it would otherwise leak into any future eval corpus.
    // The free-text box is exactly where someone types a patient name.
    const redacted = redactPII(comment);
    storedComment = redacted.text;
    counts = redacted.counts && Object.keys(redacted.counts).length ? redacted.counts : null;
  }

  const { rows } = await client.query(
    `INSERT INTO note_feedback (note_id, uid, kind, rating, comment, redaction_counts)
       VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (note_id, uid, kind) DO UPDATE
       SET rating = EXCLUDED.rating,
           comment = EXCLUDED.comment,
           redaction_counts = EXCLUDED.redaction_counts,
           updated_at = NOW()
     RETURNING (xmax = 0) AS inserted`,
    [noteId, uid, kind, rating, storedComment, counts ? JSON.stringify(counts) : null],
  );

  return {
    inserted: Boolean(rows[0] && rows[0].inserted),
    redactionCounts: counts,
  };
}

module.exports = { sanitizeFeedback, writeFeedbackWithinTx, MAX_COMMENT };
