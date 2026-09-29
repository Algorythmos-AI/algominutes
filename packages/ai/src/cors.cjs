'use strict';
// ONE CORS configuration for every browser-facing service: the api, and billing
// (the web's checkout and portal, RELEASE.md PR 17). CLAUDE.md: never
// `cors: true`, always this allowlist, driven by ALLOWED_ORIGINS.
//
// The api's source had two: server.ts used the `cors` package with a small
// localhost allowlist, while functions/index.js hand-rolled `applyCors` with a
// broader default set that also admits the native (Capacitor/Ionic) origins.
// The defaults here are the union: the functions default list, which keeps the
// native clients working. `ALLOWED_ORIGINS` (comma-separated env) is added on
// top. Deployed origins (the public site, the beta web app) come from
// Terraform's var.allowed_origins; only the localhost dev origins are baked in.

const cors = require('cors');

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://localhost',
  'capacitor://localhost',
  'ionic://localhost',
];

function buildAllowedOriginSet(env = process.env) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Env origins are additive to the defaults (not a replacement) so a deploy
  // that sets ALLOWED_ORIGINS to the production web origin does not lock out
  // the native clients.
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function buildCorsMiddleware(env = process.env) {
  const allowed = buildAllowedOriginSet(env);
  return cors({
    origin: (origin, cb) => {
      // Same-origin fetches, curl, native app WebViews, server-to-server calls
      // and the stores' webhooks send no Origin header: allowed.
      if (!origin) return cb(null, true);
      return cb(null, allowed.has(origin));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    // Authorization + Content-Type, the client version header and a trace
    // header, so a preflight doesn't strip them.
    allowedHeaders: ['Authorization', 'Content-Type', 'X-AlgoMinutes-Client', 'X-Trace-Id'],
    // What the web app reads from an answer: its traceId (trace.js), a 429's
    // Retry-After, and an export's file name (Content-Disposition). A browser
    // hides any other header from cross-origin code.
    exposedHeaders: ['X-Trace-Id', 'Retry-After', 'Content-Disposition'],
    maxAge: 3600,
    credentials: false,
  });
}

module.exports = { buildAllowedOriginSet, buildCorsMiddleware, DEFAULT_ALLOWED_ORIGINS };
