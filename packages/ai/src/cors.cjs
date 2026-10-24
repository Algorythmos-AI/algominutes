'use strict';
// ONE CORS configuration for every browser-facing service: the api, and billing
// (the web's checkout and portal, RELEASE.md PR 17). CLAUDE.md: never
// `cors: true`, always this allowlist, driven by ALLOWED_ORIGINS.
//
// Deployed origins (the public site, the beta web app) come from Terraform's var.allowed_origins, as
// ALLOWED_ORIGINS (comma-separated). Only the local development origins are built in, and only outside
// production (plan rev 12 S9): they used to apply in every environment, prod included, along with the
// Capacitor/Ionic WebView origins of a hybrid app that no longer exists (the iOS app is native and sends no
// Origin; a request with none is allowed, below).

const cors = require('cors');

/** The web app run locally (Vite, the site's dev server), against staging. Never production. */
const LOCAL_DEV_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://localhost',
];
// The name the rest of the repo knew them by.
const DEFAULT_ALLOWED_ORIGINS = LOCAL_DEV_ORIGINS;

function buildAllowedOriginSet(env = process.env) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // ALGOMINUTES_ENV is Terraform's (staging | prod); unset is local development.
  const local = env.ALGOMINUTES_ENV === 'prod' ? [] : LOCAL_DEV_ORIGINS;
  return new Set([...local, ...configured]);
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

module.exports = { buildAllowedOriginSet, buildCorsMiddleware, DEFAULT_ALLOWED_ORIGINS, LOCAL_DEV_ORIGINS };
