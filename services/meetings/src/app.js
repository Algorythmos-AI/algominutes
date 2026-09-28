// services/meetings: the only code that talks to Recall.ai
// (docs/plans/MEETINGS.md, DECISIONS "Online meetings are captured by a
// Recall.ai notetaker bot first").
//
// Public, like billing, so Recall's webhooks never share a scaling pool with
// the api's user traffic. Two surfaces:
//   • POST /webhooks/recall — signed by Recall (checked over the raw body);
//   • POST /tasks/*         — Cloud Tasks only, OIDC-checked in the app (the
//     service is public, so Cloud Run itself checks nothing).
//
// Middleware order: helmet → trace → rate limit → [webhook, RAW body] → JSON →
// [tasks, OIDC] → 404 → error handler.
import { createHash } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import rateLimitModule from '@algominutes/ai/rate-limit.cjs';
import pgConfigModule from '@algominutes/ai/pg-config.cjs';
import { getPool } from '@algominutes/db';
import { traceMiddleware, rootLogger } from './middleware/trace.js';
import { createRecallWebhookRoute } from './webhooks/recall.js';
import { createTaskAuth } from './lib/task-auth.js';
import { createSecretReader } from './lib/secrets.js';
import { createNotetakerTasks } from './tasks/notetaker.js';
import cloudTasksModule from '@algominutes/ai/cloud-tasks.cjs';

const { enqueueTask } = cloudTasksModule;

/** Enqueue a notetaker task on the meetings queue, to this service, as run-jobs. */
export function createEnqueuer(env = process.env) {
  return async function enqueue(kind, payload, { traceId, log, taskId, scheduleSeconds } = {}) {
    return enqueueTask({
      projectId: env.TASKS_PROJECT,
      location: env.TASKS_LOCATION,
      queue: env.MEETINGS_QUEUE || 'meetings',
      targetUrl: `${String(env.MEETINGS_URL || '').replace(/\/+$/, '')}/tasks/${kind}`,
      oidcServiceAccount: env.JOBS_SA_EMAIL,
      payload: { kind, ...payload },
      traceId,
      log,
      taskId,
      scheduleSeconds,
    });
  };
}

/**
 * One task per stored webhook, so a second enqueue of the same event is dropped
 * (ALREADY_EXISTS). The ids are sequential; a hash in front keeps task names
 * from sharing a prefix, which Cloud Tasks' naming guidance says slows dispatch.
 */
export function eventTaskId(recallEventId) {
  const id = String(recallEventId);
  return `evt-${createHash('sha256').update(id).digest('hex').slice(0, 12)}-${id}`;
}

const { pingPool } = pgConfigModule;
const { clientRateLimit, trustProxyHops } = rateLimitModule;

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function buildApp({
  env = process.env,
  readSecret = createSecretReader({ projectId: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT }),
  taskAuth = createTaskAuth({ baseUrl: env.MEETINGS_URL, serviceAccountEmail: env.JOBS_SA_EMAIL }),
  enqueue = createEnqueuer(env),
  tasks,
  taskDeps,
} = {}) {
  // The notetaker's handlers, unless a test gives its own.
  tasks = tasks ?? (taskDeps ? createNotetakerTasks({ env, ...taskDeps }) : {});
  // One fixed route per task, registered at startup: nothing from the request
  // path ever picks the function that runs.
  const handlers = Object.entries(tasks).filter(([kind, fn]) => /^[a-z_]+$/.test(kind) && typeof fn === 'function');
  const app = express();
  app.disable('x-powered-by');
  // JSON only, never HTML: the strictest CSP costs nothing.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"], frameAncestors: ["'none'"] },
    },
  }));
  app.set('trust proxy', trustProxyHops());
  app.use(traceMiddleware);
  app.use(clientRateLimit());

  const health = (_req, res) => res.status(200).send('ok');
  app.get('/health', health);
  app.get('/healthz', health);
  app.get('/health/ready', async (req, res) => {
    try {
      await pingPool(getPool());
      res.status(200).json({ status: 'ok', db: 'ok' });
    } catch (err) {
      req.log.error({ err }, 'readiness_db_unreachable');
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });

  // Signed over these exact bytes: before any JSON parser.
  const enqueueEvent = ({ recallEventId, traceId, log }) =>
    enqueue('process_event', { recallEventId }, { traceId, log, taskId: eventTaskId(recallEventId) });
  app.post('/webhooks/recall', express.raw({ type: '*/*', limit: '1mb' }), wrap(createRecallWebhookRoute({ readSecret, env, enqueue: enqueueEvent })));

  app.use(express.json({ limit: '1mb' }));

  // Cloud Tasks handlers, added by the PRs that build them (create, ingest,
  // purge, reconcile). Each is idempotent: Cloud Tasks replay is normal.
  // Authenticated first, so an unknown task is a 404 only to Cloud Tasks.
  app.use('/tasks', taskAuth);
  for (const [kind, handler] of handlers) app.post(`/tasks/${kind}`, wrap(handler));
  app.use('/tasks', (_req, res) => res.status(404).json({ error: 'Unknown task' }));

  app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));
  app.use((err, req, res, _next) => {
    (req?.log || rootLogger).error({ err }, 'unhandled_error');
    if (res.headersSent) return;
    const bodyStatus = err?.type === 'entity.too.large' ? 413 : err?.type === 'entity.parse.failed' ? 400 : null;
    // A task's failure is always a 500: Cloud Tasks retries it either way, but
    // a 429 or 503 (a Recall rate limit passed through) throttles the whole queue.
    const status = String(req?.originalUrl || '').startsWith('/tasks/')
      ? bodyStatus || 500
      : err?.status || err?.statusCode || bodyStatus || (err instanceof SyntaxError ? 400 : 500);
    res.status(status).json({ error: status === 413 ? 'Payload too large' : status === 400 ? 'Invalid request body' : 'Internal error' });
  });
  return app;
}
