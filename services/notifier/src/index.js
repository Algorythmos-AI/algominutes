'use strict';

// services/notifier (A7.3) — FCM push fan-out.
//
// Cloud Tasks pushes a JSON body to POST /; we look up the recipient's device
// tokens, send one multicast via firebase-admin, prune any tokens FCM reports
// dead, and ack 2xx once handled. IAM is enforced by Cloud Run via
// --no-allow-unauthenticated; this process trusts that the request reached it.
//
// House style mirrors services/transcoder: express, /healthz, POST / for a
// Cloud Tasks push, traceId on every log line, no silent catches, no console.*,
// no @google/generative-ai.

const express = require('express');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}

// Repo layer (A7.3 push_tokens). Authored in TypeScript under @algominutes/db;
// resolvable at runtime on Node 24 (type-stripping + .js→.ts resolution). Loaded
// here rather than behind a try/skip because token fan-out is this service's
// entire job — a missing repo is a broken deploy that must fail loudly, not
// degrade to a silent no-op.
const pushTokensRepo = require('@algominutes/db/push-tokens-repo');
const { tokensForUser, deletePushToken } = pushTokensRepo;

const sharedLogger = loadShared('logger.cjs');
const { requireEnv } = loadShared('require-env.cjs');
requireEnv(
  'notifier',
  {
    exact: { WRITE_POSTGRES: 'true' },
    oneOf: [
      { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
      { label: 'a GCP project', of: [['GOOGLE_CLOUD_PROJECT'], ['GCLOUD_PROJECT']] },
    ],
  },
  { logger: sharedLogger.logger },
);
const { noteDeepLink } = require('./deep-link');

const app = express();
app.use(express.json({ limit: '64kb' }));

const rootLog = sharedLogger.logger.child({ svc: 'notifier' });

let _messagingReady = false;
function messaging() {
  if (!_messagingReady) {
    if (!getApps().length) initializeApp();
    _messagingReady = true;
  }
  return getMessaging();
}

const VALID_TYPES = new Set(['note_ready', 'note_failed']);

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

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/', async (req, res) => {
  const { type, noteId, workspaceId, uid, title, body } = req.body || {};
  // The traceId carried in the task body, so one recording stays followable
  // across the enqueue → notify hop (CLAUDE.md §1); validated, and falling back
  // to the request/Cloud Trace header otherwise.
  const traceId = sharedLogger.traceIdFromTask(req.body, req.headers);
  const log = rootLog.child({ traceId, type, noteId, workspaceId, userId: uid });

  if (!VALID_TYPES.has(type) || !noteId || !uid) {
    // A malformed payload will never succeed on retry — ack it so Cloud Tasks
    // does not retry-storm, and log loudly so it is visible.
    log.error({ hasType: VALID_TYPES.has(type), hasNoteId: !!noteId, hasUid: !!uid }, 'notify_bad_payload');
    return res.status(400).json({ error: 'bad_payload' });
  }

  let tokens;
  try {
    tokens = await tokensForUser(uid);
  } catch (err) {
    // Token lookup is a transient DB failure surface — 5xx so Cloud Tasks
    // retries per the queue backoff.
    log.error({ err }, 'notify_token_lookup_failed');
    return res.status(500).json({ error: 'token_lookup_failed' });
  }

  const tokenStrings = (tokens || []).map((t) => t.token).filter(Boolean);
  if (tokenStrings.length === 0) {
    // 0 tokens is a handled outcome, not an error: the on-device
    // local-notification fallback (A7.3) covers users with no push token.
    log.info({}, 'notify_no_tokens');
    return res.status(200).json({ ok: true, sent: 0, reason: 'no_tokens' });
  }

  const { title: outTitle, body: outBody } = defaultCopy(type, title, body);
  const message = {
    tokens: tokenStrings,
    notification: { title: outTitle, body: outBody },
    data: { type, noteId, deepLink: noteDeepLink(noteId) },
  };

  let batch;
  try {
    batch = await messaging().sendEachForMulticast(message);
  } catch (err) {
    // A whole-batch throw is a genuine transient (FCM unreachable, auth blip);
    // 5xx so Cloud Tasks retries.
    log.error({ err }, 'notify_send_failed');
    return res.status(500).json({ error: 'send_failed' });
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
        await deletePushToken(dead);
        pruned += 1;
      } catch (err) {
        log.error({ err }, 'notify_token_prune_failed');
      }
    } else {
      log.warn({ code: r.error.code }, 'notify_token_send_error');
    }
  }

  log.info({ sent: batch.successCount, failed: batch.failureCount, pruned }, 'notify_sent');
  return res.status(200).json({ ok: true, sent: batch.successCount, failed: batch.failureCount, pruned });
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => rootLog.info({ port }, 'notifier_started'));
