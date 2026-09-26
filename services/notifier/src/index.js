'use strict';

// services/notifier (A7.3) — FCM push fan-out.
//
// Cloud Tasks pushes a JSON body to POST /; handler.js sends it (once per
// notice: the outbox claim) and this acks 2xx once handled. IAM is enforced by
// Cloud Run via --no-allow-unauthenticated; this process trusts that the
// request reached it.
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

// Repo layer (A7.3 push_tokens, and the notices outbox). Authored in
// TypeScript under @algominutes/db; resolvable at runtime on Node 24
// (type-stripping + .js→.ts resolution). Loaded here rather than behind a
// try/skip because token fan-out is this service's entire job — a missing repo
// is a broken deploy that must fail loudly, not degrade to a silent no-op.
const { tokensForUser, deletePushToken } = require('@algominutes/db/push-tokens-repo');
const { claimNotice, markNoticeSent, releaseNotice } = require('@algominutes/db/notices-repo');

const sharedLogger = loadShared('logger.cjs');
const { requireEnv } = loadShared('require-env.cjs');
requireEnv(
  'notifier',
  require('./env-spec.cjs'),
  { logger: sharedLogger.logger },
);
const { handleNotify } = require('./handler');

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

const deps = {
  log: rootLog,
  traceIdFromTask: sharedLogger.traceIdFromTask,
  tokensForUser,
  deletePushToken,
  messaging,
  claimNotice,
  markNoticeSent,
  releaseNotice,
};

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/', async (req, res) => {
  const { status, json } = await handleNotify(req.body, req.headers, deps);
  return res.status(status).json(json);
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => rootLog.info({ port }, 'notifier_started'));
