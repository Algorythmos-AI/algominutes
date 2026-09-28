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
import express from 'express';
import helmet from 'helmet';
import rateLimitModule from '@algominutes/ai/rate-limit.cjs';
import pgConfigModule from '@algominutes/ai/pg-config.cjs';
import { getPool } from '@algominutes/db';
import { traceMiddleware, rootLogger } from './middleware/trace.js';
import { createRecallWebhookRoute } from './webhooks/recall.js';
import { createTaskAuth } from './lib/task-auth.js';
import { createSecretReader } from './lib/secrets.js';

const { pingPool } = pgConfigModule;
const { clientRateLimit, trustProxyHops } = rateLimitModule;

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function buildApp({
  env = process.env,
  readSecret = createSecretReader({ projectId: env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT }),
  taskAuth = createTaskAuth({ baseUrl: env.MEETINGS_URL, serviceAccountEmail: env.JOBS_SA_EMAIL }),
  tasks = {},
} = {}) {
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
  app.post('/webhooks/recall', express.raw({ type: '*/*', limit: '1mb' }), wrap(createRecallWebhookRoute({ readSecret, env })));

  app.use(express.json({ limit: '1mb' }));

  // Cloud Tasks handlers, added by the PRs that build them (create, ingest,
  // purge, reconcile). Each is idempotent: Cloud Tasks replay is normal.
  app.post('/tasks/:kind', taskAuth, wrap(async (req, res) => {
    const handler = tasks[req.params.kind];
    if (!handler) return res.status(404).json({ error: 'Unknown task' });
    return handler(req, res);
  }));

  app.use((_req, res) => res.status(404).json({ error: 'Not Found' }));
  app.use((err, req, res, _next) => {
    (req?.log || rootLogger).error({ err }, 'unhandled_error');
    if (res.headersSent) return;
    const status = err?.status || err?.statusCode ||
      (err?.type === 'entity.too.large' ? 413 : err?.type === 'entity.parse.failed' || err instanceof SyntaxError ? 400 : 500);
    res.status(status).json({ error: status === 413 ? 'Payload too large' : status === 400 ? 'Invalid request body' : 'Internal error' });
  });
  return app;
}
