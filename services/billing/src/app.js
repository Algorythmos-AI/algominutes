// Express application factory for the AlgoMinutes billing service.
//
// Middleware order:
//   helmet → trace → [ /webhooks/stripe with RAW body ] → JSON body → routes
//
// The Stripe webhook MUST see the exact received bytes (its signature is
// computed over the raw body), so it is mounted with express.raw BEFORE the
// global express.json parser — a parsed-and-reserialized body would fail
// verification. The Apple/Google webhooks carry JSON envelopes and use the
// normal parser; their credential is the signed payload / re-verified receipt,
// not a body-bytes HMAC.
//
// TWO auth postures live here, deliberately:
//   • /v1/*      — authed CLIENT endpoints, behind Firebase ID-token auth.
//   • /webhooks/* — PUBLIC, signature/receipt-verified, NO Firebase auth.
// This is why billing runs in its own Cloud Run service (own scaling pool):
// public webhook traffic never shares capacity with authed user traffic (§3.2).

import express from 'express';
import helmet from 'helmet';
import rateLimitModule from '@algominutes/ai/rate-limit.cjs';
import pgConfigModule from '@algominutes/ai/pg-config.cjs';
import { getPool } from '@algominutes/db';

const { pingPool } = pgConfigModule;
const { clientRateLimit, userRateLimit, trustProxyHops } = rateLimitModule;

import { traceMiddleware, rootLogger } from './middleware/trace.js';
import { authMiddleware } from './middleware/auth.js';

import { verifyPurchaseRoute } from './routes/verify.js';
import { checkoutRoute } from './routes/checkout.js';
import { portalRoute } from './routes/portal.js';

import { stripeWebhookRoute } from './webhooks/stripe.js';
import { appleWebhookRoute } from './webhooks/apple.js';
import { googleWebhookRoute } from './webhooks/google.js';

// Express 4 does not forward rejected promises to the error handler; this
// adapter does, so an unhandled throw becomes a JSON 500 instead of a hung
// socket (same guarantee services/api uses).
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  // JSON + webhook service, never HTML, so the strictest CSP costs nothing
  // (docs/DECISIONS.md): nothing may load, run or frame a response.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"], frameAncestors: ["'none'"] },
    },
  }));

  // Trust exactly the proxy hops in front of the service (the rightmost
  // X-Forwarded-For entry is the one Cloud Run appended). `true` made req.ip
  // the leftmost entry, a value the client controls.
  app.set('trust proxy', trustProxyHops());

  app.use(traceMiddleware);
  // Per client IP on everything but the health probes, including the store
  // webhooks, which are public and signature-authenticated.
  app.use(clientRateLimit());

  // ── health ── (no auth — infra probes it without an app identity) ──────
  // Cloud Run's front end reserves request paths ending in "z", so an external
  // GET /healthz is answered 404 by Google before it reaches this container.
  // /health is the externally reachable probe; /healthz is kept for callers
  // that already use it from inside the platform.
  const health = (_req, res) => res.status(200).send('ok');
  app.get('/health', health);
  app.get('/healthz', health);
  // Readiness: proves the repo-layer pool reaches Postgres (post-deploy smoke).
  app.get('/health/ready', async (req, res) => {
    try {
      await pingPool(getPool());
      res.status(200).json({ status: 'ok', db: 'ok' });
    } catch (err) {
      req.log.error({ err }, 'readiness_db_unreachable');
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });

  // ── PUBLIC webhook: Stripe ── RAW body BEFORE express.json ──────────────
  // Signature is verified over these exact bytes (see lib/stripe.js).
  app.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), wrap(stripeWebhookRoute));

  // Everything past here parses JSON.
  app.use(express.json({ limit: '1mb' }));

  // ── PUBLIC webhooks: Apple (ASSN V2) + Google (Play RTDN / Pub/Sub) ─────
  app.post('/webhooks/apple', wrap(appleWebhookRoute));
  app.post('/webhooks/google', wrap(googleWebhookRoute));

  // ── AUTHED client endpoints (Firebase ID token → req.uid) ───────────────
  // Auth, then the caller's per-user budget (one limiter, shared by the three).
  const authed = [authMiddleware, userRateLimit()];
  app.post('/v1/purchases/verify', authed, wrap(verifyPurchaseRoute));
  app.post('/v1/billing/checkout', authed, wrap(checkoutRoute));
  app.post('/v1/billing/portal', authed, wrap(portalRoute));

  // Unmatched → JSON 404 (never an HTML error page).
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // JSON error handler. Must be last. Covers body-parser errors and any
  // unhandled route rejection forwarded by wrap().
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
      status === 503 ? 'Billing not configured' :
      'Internal error';
    res.status(status).json({ error: publicMessage });
  });

  return app;
}
