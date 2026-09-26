// Express application factory for the AlgoMinutes API service.
//
// The middleware order encodes the consolidation contract (BUILD-PLAN §3.1):
//
//   helmet → trace → CORS → client-version gate → client rate limit → JSON body → /v1 router
//
// ONE trace context, ONE CORS config, ONE client-version gate, and — inside
// the router — ONE auth path. The public share read and the health check are
// the only endpoints exempt from the version gate.

import express from 'express';
import helmet from 'helmet';

import { traceMiddleware, rootLogger } from './middleware/trace.js';
import { buildCorsMiddleware } from './middleware/cors.js';
import { clientVersionMiddleware } from './middleware/client-version.js';
// Imported straight from the shared module, as billing does: CodeQL
// (js/missing-rate-limiting) can't follow a destructured re-export to the
// express-rate-limit call, and flagged every /v1 route.
import rateLimitModule from '@algominutes/ai/rate-limit.cjs';
import { buildRouter } from './routes/index.js';

const { clientRateLimit, trustProxyHops } = rateLimitModule;

const API_PREFIX = '/v1';

// A JSON API needs no content sources at all. See docs/DECISIONS.md.
export const STRICT_CSP = {
  defaultSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
};

// The version gate does not apply to the health probe (infra calls it without
// an app identity), the public share read (the stranger surface, kept
// maximally reachable), or the crash beacon (a crashing client must be able to
// report even if it never sent the version header). Everything else must
// present X-AlgoMinutes-Client.
const VERSION_EXEMPT_PATHS = new Set([
  `${API_PREFIX}/health`,
  `${API_PREFIX}/health/ready`,
  `${API_PREFIX}/shares/read`,
  `${API_PREFIX}/client-error`,
]);

export function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  // The API serves JSON and file downloads, never HTML, so the strictest CSP
  // costs nothing: nothing may load, run or frame a response. (It used to be
  // disabled outright, which CLAUDE.md forbids without a recorded decision.)
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: STRICT_CSP } }));

  // Trust exactly the proxy hops in front of the service, so req.ip is the
  // address Cloud Run's front end appended (the rightmost X-Forwarded-For
  // entry). This used to be `true`, which made req.ip the LEFTMOST entry, a
  // value the client controls, so the share-read limiter keyed on something
  // any caller could rotate.
  app.set('trust proxy', trustProxyHops());

  app.use(traceMiddleware);
  app.use(buildCorsMiddleware());
  app.use(
    clientVersionMiddleware({
      exempt: (req) => VERSION_EXEMPT_PATHS.has(req.path),
    }),
  );
  app.use(API_PREFIX, clientRateLimit());
  app.use(express.json({ limit: '1mb' }));

  app.use(API_PREFIX, buildRouter());

  // Any unmatched path returns JSON 404 rather than an HTML error page.
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // JSON error handler. Must be last. Covers body-parser errors (which would
  // otherwise return HTML stack traces) and any unhandled route rejection
  // forwarded by the router's async wrapper.
  app.use((err, req, res, _next) => {
    (req?.log || rootLogger).error({ err }, 'unhandled_error');
    if (res.headersSent) return;
    const status =
      err?.status || err?.statusCode ||
      (err?.type === 'entity.too.large' ? 413 :
       err?.type === 'entity.parse.failed' || err instanceof SyntaxError ? 400 : 500);
    const publicMessage =
      status === 413 ? 'Payload too large' :
      status === 400 ? 'Invalid request body' :
      'Internal error';
    res.status(status).json({ error: publicMessage });
  });

  return app;
}
