'use strict';

// A7.4 terminal hook for the embedder: dead-letter the exhausted job ONLY.
//
// Embedding failures are deliberately NOT refunded and NOT notified: by the time
// embedding runs the transcript and summary already exist and the note is
// genuinely readable (see index.js), so it must not walk back the note's state
// or charge/refund the user. But a permanently-failed embed still silently
// drops the note out of Search/Chat, so it is dead-lettered for the admin view
// and alerting rather than lost.
//
// Best-effort and never throws; the A7.4 repo layer is reached ONLY through
// @algominutes/db (CLAUDE.md §Data plane), never re-implemented here.

let _repoWarned = false;
function requireRepo(basename, misses = []) {
  const specs = [`@algominutes/db/${basename}.ts`, `@algominutes/db/${basename}`];
  for (const spec of specs) {
    try {
      return require(spec);
    } catch (err) {
      if (err && (err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_MODULE_NOT_FOUND')) {
        // Kept for repoFn's warning: a spec that resolves but whose own import
        // fails looks the same here, and only the message tells them apart.
        misses.push(err);
        continue;
      }
      throw err;
    }
  }
  return null;
}

function repoFn(basename, fnName, log) {
  const misses = [];
  const mod = requireRepo(basename, misses);
  if (mod && typeof mod[fnName] === 'function') return mod[fnName];
  if (!_repoWarned) {
    _repoWarned = true;
    log.warn({ basename, fnName, misses: misses.map((e) => String(e.message)) }, 'db_repo_unavailable_skipping');
  }
  return null;
}

/** FINAL-ATTEMPT FAILURE: DLQ only. `payload` must be metadata only (no PII). */
async function onEmbedTerminalFailure({ noteId, workspaceId, err, attempts, traceId, payload, log }) {
  const fn = repoFn('dead-letter-repo', 'recordDeadLetter', log);
  if (!fn) return;
  try {
    const r = await fn({
      queue: 'embed',
      noteId: noteId || null,
      workspaceId: workspaceId || null,
      payload,
      error: err && err.message ? err.message : (err ? String(err) : null),
      attempts: attempts != null ? attempts : null,
      traceId: traceId || null,
      reason: 'embed_failed',
    });
    // Once per lost piece of work (migration 027): the alert counts dead_letter_recorded.
    if (r && r.duplicate) log.info({ deadLetterId: r.id, noteId }, 'dead_letter_already_recorded');
    else log.info({ deadLetterId: r && r.id, noteId, reason: 'embed_failed' }, 'dead_letter_recorded');
  } catch (dlErr) {
    log.error({ err: dlErr, noteId }, 'dead_letter_record_failed');
  }
}

module.exports = { onEmbedTerminalFailure };
