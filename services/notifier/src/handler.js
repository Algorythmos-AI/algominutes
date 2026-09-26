'use strict';

// The notify task's handler (A7.3), apart from the express wiring so it can be
// tested. Cloud Tasks pushes { type, noteId, workspaceId, uid, noticeId }: look
// up the recipient's device tokens, send one multicast, prune the tokens FCM
// reports dead, and ack 2xx once handled.
//
// Each notice is sent once (note-notices.cjs, the outbox). A task carries its
// notice's id; the handler claims the notice before sending and marks it sent
// after. A second delivery (Cloud Tasks may deliver twice, and the sweep
// re-enqueues a notice left unsent) finds it sent, or held by the first, and
// sends nothing. A notice whose note was deleted is gone, and isn't sent.
// A task without a noticeId (from a worker deployed before the outbox) is sent
// as before.

const { noteDeepLink } = require('./deep-link');

const VALID_TYPES = new Set(['note_ready', 'note_failed']);
const NOTICE_ID = /^[0-9]{1,19}$/;

// FCM per-token errors that mean the token is dead and should be pruned. Codes
// are the messaging/* strings firebase-admin puts on response.error.code.
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered', // UNREGISTERED
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

function isDeadTokenError(err) {
  const code = err && err.code ? String(err.code) : '';
  return DEAD_TOKEN_CODES.has(code)
    || code.includes('registration-token-not-registered')
    || code.includes('invalid-argument')
    || code.includes('invalid-registration-token');
}

function defaultCopy(type, title, body) {
  if (title && body) return { title, body };
  if (type === 'note_ready') {
    return {
      title: title || 'Your note is ready',
      body: body || 'Your recording has been transcribed and summarized.',
    };
  }
  return {
    title: title || 'We could not process your recording',
    body: body || 'Something went wrong while processing this recording.',
  };
}

/**
 * Handle one notify task. `deps`: log, traceIdFromTask, tokensForUser,
 * deletePushToken, messaging() (firebase-admin), and the outbox's claimNotice,
 * markNoticeSent and releaseNotice. Returns { status, json }.
 */
async function handleNotify(reqBody, headers, deps) {
  const { type, noteId, workspaceId, uid, title, body, noticeId } = reqBody || {};
  // The traceId carried in the task body, so one recording stays followable
  // across the enqueue → notify hop (CLAUDE.md §1); validated, and falling back
  // to the request/Cloud Trace header otherwise.
  const traceId = deps.traceIdFromTask(reqBody, headers);
  const log = deps.log.child({ traceId, type, noteId, workspaceId, userId: uid, noticeId });

  const noticeOk = noticeId === undefined || NOTICE_ID.test(String(noticeId));
  if (!VALID_TYPES.has(type) || !noteId || !uid || !noticeOk) {
    // A malformed payload will never succeed on retry — ack it so Cloud Tasks
    // does not retry-storm, and log loudly so it is visible.
    log.error({ hasType: VALID_TYPES.has(type), hasNoteId: !!noteId, hasUid: !!uid, noticeOk }, 'notify_bad_payload');
    return { status: 400, json: { error: 'bad_payload' } };
  }

  const id = noticeId === undefined ? null : String(noticeId);
  if (id) {
    let claim;
    try {
      claim = await deps.claimNotice(id);
    } catch (err) {
      log.error({ err }, 'notify_claim_failed');
      return { status: 500, json: { error: 'claim_failed' } };
    }
    if (!claim.claimed) {
      // Sent already, held by another delivery, given up on, its note gone, or
      // superseded by a newer run or summary. Ack: sending now would be a
      // duplicate or out of date. (A delivery that dies holding it lets the
      // claim lapse, and the sweep re-enqueues the notice.)
      log.info({ state: claim.state }, 'notify_notice_not_sent');
      return { status: 200, json: { ok: true, sent: 0, reason: `notice_${claim.state}` } };
    }
  }
  const release = async () => {
    if (!id) return;
    try {
      await deps.releaseNotice(id);
    } catch (err) {
      log.error({ err }, 'notify_release_failed');
    }
  };
  const markSent = async () => {
    if (!id) return;
    try {
      await deps.markNoticeSent(id);
    } catch (err) {
      // The push went out, or there was nobody to send it to. Unmarked, the
      // sweep may enqueue it again once the claim lapses: logged, as a
      // possible duplicate.
      log.error({ err }, 'notify_mark_sent_failed');
    }
  };

  let tokens;
  try {
    tokens = await deps.tokensForUser(uid);
  } catch (err) {
    // Token lookup is a transient DB failure surface — 5xx so Cloud Tasks
    // retries per the queue backoff.
    log.error({ err }, 'notify_token_lookup_failed');
    await release();
    return { status: 500, json: { error: 'token_lookup_failed' } };
  }

  const tokenStrings = (tokens || []).map((t) => t.token).filter(Boolean);
  if (tokenStrings.length === 0) {
    // 0 tokens is a handled outcome, not an error: the on-device
    // local-notification fallback (A7.3) covers users with no push token.
    log.info({}, 'notify_no_tokens');
    await markSent();
    return { status: 200, json: { ok: true, sent: 0, reason: 'no_tokens' } };
  }

  const { title: outTitle, body: outBody } = defaultCopy(type, title, body);
  const message = {
    tokens: tokenStrings,
    notification: { title: outTitle, body: outBody },
    data: { type, noteId, deepLink: noteDeepLink(noteId) },
  };

  let batch;
  try {
    batch = await deps.messaging().sendEachForMulticast(message);
  } catch (err) {
    // A whole-batch throw is a genuine transient (FCM unreachable, auth blip);
    // 5xx so Cloud Tasks retries.
    log.error({ err }, 'notify_send_failed');
    await release();
    return { status: 500, json: { error: 'send_failed' } };
  }

  // Prune tokens FCM reported dead. Deletions are best-effort — a failed prune
  // must not fail the task (the push itself already went out).
  let pruned = 0;
  for (let i = 0; i < batch.responses.length; i++) {
    const r = batch.responses[i];
    if (r.success || !r.error) continue;
    if (isDeadTokenError(r.error)) {
      const dead = tokenStrings[i];
      try {
        await deps.deletePushToken(dead);
        pruned += 1;
      } catch (err) {
        log.error({ err }, 'notify_token_prune_failed');
      }
    } else {
      log.warn({ code: r.error.code }, 'notify_token_send_error');
    }
  }

  await markSent();
  log.info({ sent: batch.successCount, failed: batch.failureCount, pruned }, 'notify_sent');
  return { status: 200, json: { ok: true, sent: batch.successCount, failed: batch.failureCount, pruned } };
}

module.exports = { handleNotify, isDeadTokenError, defaultCopy, VALID_TYPES };
