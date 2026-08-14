'use strict';

// Public read for a share link. THE ONLY UNAUTHENTICATED SURFACE IN THE APP.
//
// Framework-agnostic like handleSearch / handleNoteRead, so a single mount
// serves every caller.
//
// Consolidated into services/api (BUILD-PLAN §3.1) from functions/shared-note.cjs.
// The ONLY change from the source is the shared-lib import path: pg-query comes
// from @algominutes/db, share-links and redaction from @algominutes/ai.
//
// Three things make this different from every other reader, and all three are
// load-bearing:
//
// 1. There is no uid. Authorisation is the token itself, so the token is
//    checked against a hash and every failure answers identically — see
//    @algominutes/ai share-links.cjs.
// 2. The reader does not own the data. Bug 20b established that the app has
//    NO read-time redaction: a row that bypassed write-time scrubbing is
//    served verbatim by /api/note. That is defensible for an owner reading
//    their own note and is not defensible here, so this endpoint scrubs on the
//    way out. It is the one surface where the reader is a stranger.
// 3. Cost is unbounded by design. A leaked or crawled link is a billable loop,
//    so the caller pairs this with an IP-keyed limiter and maxInstances.

const { withQueryTimeout, pool } = require('@algominutes/ai/pg-query.cjs');
const shareLinks = require('@algominutes/ai/share-links.cjs');
const redaction = require('@algominutes/ai/redaction.cjs');

const TIMEOUT_MS = 10000;
// A shared page is a page, not an archive. Beyond this the reader gets a
// truncation notice rather than a 30-second render of a 6,000-line transcript.
const MAX_LINES = 3000;

/**
 * Resolve a token and return the shareable view of the note.
 *
 * @returns {{ status:number, body:object }}
 */
async function handleSharedNote({ token, ip, userAgent, db, log }) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 200) {
    // Same shape as a miss. A malformed token must not be distinguishable
    // from a well-formed one that does not exist.
    return { status: 404, body: { error: 'not_found' } };
  }

  // Rate-limit BEFORE the database lookup.
  //
  // This ran after findLiveShare, so an invalid token was never limited at all:
  // every guess still cost a pooled Postgres connection and an indexed query,
  // bounded only by maxInstances. Enumeration was effectively free.
  //
  // The pre-lookup limit is keyed on the IP alone, since there is no note to
  // salt with yet. The per-note limit below still applies once the token
  // resolves, so a valid reader is bounded by both.
  const enforce = async (key, label) => {
    if (!db) return null;
    try {
      await shareLinks.enforceShareReadBudget(db, key);
      return null;
    } catch (err) {
      if (err && err.code === 429) {
        log.warn({ stage: label }, 'share_read_rate_limited');
        return { status: 429, body: { error: 'too_many_requests' } };
      }
      throw err;
    }
  };

  const preLimit = await enforce(shareLinks.hashIp(ip, 'anon'), 'pre_lookup');
  if (preLimit) return preLimit;

  const tokenHash = shareLinks.hashToken(token);
  const { share, outcome } = await withShareClient(async (client) =>
    shareLinks.findLiveShare(client, tokenHash), log);

  if (!share) {
    // Log the real reason for forensics; tell the caller nothing.
    await recordAccess({ share: null, noteId: null, ip, userAgent, outcome, log });
    log.info({ outcome }, 'share_read_denied');
    return { status: 404, body: { error: 'not_found' } };
  }

  const perNoteLimit = await enforce(shareLinks.hashIp(ip, share.note_id), 'per_note');
  if (perNoteLimit) return perNoteLimit;

  const view = await fetchShareView({ noteId: share.note_id, scope: share.scope, log });
  if (!view) {
    await recordAccess({ share, noteId: share.note_id, ip, userAgent, outcome: 'not_found', log });
    return { status: 404, body: { error: 'not_found' } };
  }

  await recordAccess({ share, noteId: share.note_id, ip, userAgent, outcome: 'ok', log });
  log.info(
    { noteId: share.note_id, workspaceId: share.workspace_id, shareId: share.id, scope: share.scope },
    'share_read',
  );

  return {
    status: 200,
    body: {
      // The title goes through the redactor too. It is auto-generated from
      // summary text and freely editable, so it is a route by which an
      // identifier reaches a public page even once the body has been scrubbed —
      // and redactSummaryOutput covers gist, longSummary, actionItems,
      // keyDecisions, keyPoints and topics, but never touched the title.
      note: {
        title: typeof share.title === 'string' ? redaction.redactPII(share.title).text : share.title,
        createdAt: view.createdAt,
        scope: share.scope,
      },
      summary: view.summary,
      transcript: view.transcript,
      expiresAt: share.expires_at,
      redaction: { applied: true, scheme: 'shared/redaction.cjs' },
    },
  };
}

/** One pooled client for the token lookup, released on every path. */
async function withShareClient(fn, log) {
  const client = await pool().connect();
  try {
    return await fn(client);
  } catch (err) {
    log.error({ err }, 'share_lookup_failed');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Access log + read counters. Best-effort by design: a shared page must not
 * fail because bookkeeping did, but the failure is logged rather than
 * swallowed.
 */
async function recordAccess({ share, noteId, ip, userAgent, outcome, log }) {
  if (!share) return; // no FK to hang the row on; the log line above suffices
  const ipHash = shareLinks.hashIp(ip, noteId || share.note_id);
  try {
    await withShareClient(async (client) => {
      await shareLinks.logShareAccess(client, {
        shareId: share.id, noteId: share.note_id, ipHash, userAgent, outcome,
      });
      if (outcome === 'ok') await shareLinks.touchShareRead(client, share.id);
    }, log);
  } catch (err) {
    log.error({ err, shareId: share.id, outcome }, 'share_access_log_failed');
  }
}

/**
 * The note content a share link exposes.
 *
 * Redacts on the way out (Bug 20b). Write-time scrubbing already covers the
 * current corpus, so this is belt-and-braces — but it is the difference
 * between "our ingest was correct on the day this row landed" and "a stranger
 * cannot read a card number", and only the second is a property of THIS
 * endpoint.
 */
async function fetchShareView({ noteId, scope, log }) {
  const noteRes = await withQueryTimeout({
    timeoutMs: TIMEOUT_MS,
    text: `SELECT id, created_at FROM notes WHERE id = $1 AND deleted_at IS NULL`,
    values: [noteId], log, op: 'share_note_meta',
  });
  if (noteRes.rows.length === 0) return null;

  const out = {
    createdAt: noteRes.rows[0].created_at,
    summary: null,
    transcript: null,
  };

  if (scope !== 'transcript') {
    // action_items is the source, not summaries.topics — topics is stale by
    // design because /api/update-note never refreshes it.
    const [summary, items, decisions] = await Promise.all([
      withQueryTimeout({
        timeoutMs: TIMEOUT_MS,
        text: `SELECT gist FROM summaries WHERE note_id = $1`,
        values: [noteId], log, op: 'share_summary',
      }),
      withQueryTimeout({
        timeoutMs: TIMEOUT_MS,
        text: `SELECT text FROM action_items WHERE note_id = $1 ORDER BY created_at ASC, id ASC`,
        values: [noteId], log, op: 'share_items',
      }),
      withQueryTimeout({
        timeoutMs: TIMEOUT_MS,
        text: `SELECT text FROM key_decisions WHERE note_id = $1 ORDER BY created_at ASC, id ASC`,
        values: [noteId], log, op: 'share_decisions',
      }),
    ]);
    const scrub = (t) => (t ? redaction.redactPII(String(t)).text : t);
    out.summary = {
      gist: scrub(summary.rows[0] ? summary.rows[0].gist : null),
      actionItems: items.rows.map((r) => scrub(r.text)),
      keyDecisions: decisions.rows.map((r) => scrub(r.text)),
    };
  }

  if (scope !== 'summary') {
    const lines = await withQueryTimeout({
      timeoutMs: TIMEOUT_MS,
      text: `SELECT speaker_tag, speaker_name, start_ms, text
               FROM transcript_lines WHERE note_id = $1
              ORDER BY start_ms ASC, id ASC
              LIMIT $2`,
      values: [noteId, MAX_LINES + 1], log, op: 'share_lines',
    });
    const truncated = lines.rows.length > MAX_LINES;
    out.transcript = {
      lines: lines.rows.slice(0, MAX_LINES).map((r, i) => ({
        id: i,
        speakerTag: r.speaker_tag,
        speakerName: r.speaker_name,
        startMs: r.start_ms,
        text: redaction.redactPII(String(r.text || '')).text,
      })),
      truncated,
    };
  }

  return out;
}

module.exports = { handleSharedNote, fetchShareView, MAX_LINES };
