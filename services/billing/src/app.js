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
  // JSON + webhook service, never HTML — keep helmet's protections, drop CSP.
  app.use(helmet({ contentSecurityPolicy: false }));

  // Trust the proxy so req.ip / X-Forwarded-For behave behind Cloud Run's LB.
  app.set('trust proxy', true);

  app.use(traceMiddleware);

  // ── health ── (no auth — infra probes it without an app identity) ──────
  // Cloud Run's front end reserves request paths ending in "z", so an external
  // GET /healthz is answered 404 by Google before it reaches this container.
  // /health is the externally reachable probe; /healthz is kept for callers
  // that already use it from inside the platform.
  const health = (_req, res) => res.status(200).send('ok');
  app.get('/health', health);
  app.get('/healthz', health);

  // ── PUBLIC webhook: Stripe ── RAW body BEFORE express.json ──────────────
  // Signature is verified over these exact bytes (see lib/stripe.js).
  app.post('/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), wrap(stripeWebhookRoute));

  // Everything past here parses JSON.
  app.use(express.json({ limit: '1mb' }));

  // ── PUBLIC webhooks: Apple (ASSN V2) + Google (Play RTDN / Pub/Sub) ─────
  app.post('/webhooks/apple', wrap(appleWebhookRoute));
  app.post('/webhooks/google', wrap(googleWebhookRoute));

  // ── AUTHED client endpoints (Firebase ID token → req.uid) ───────────────
  app.post('/v1/purchases/verify', authMiddleware, wrap(verifyPurchaseRoute));
  app.post('/v1/billing/checkout', authMiddleware, wrap(checkoutRoute));
  app.post('/v1/billing/portal', authMiddleware, wrap(portalRoute));

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
