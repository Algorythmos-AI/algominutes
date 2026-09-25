// ONE CORS configuration for the whole API surface.
//
// The source had two: server.ts used the `cors` package with a small
// localhost allowlist, while functions/index.js hand-rolled `applyCors` with a
// broader default set that also admits the native (Capacitor/Ionic) origins.
// Because services/api replaces BOTH surfaces and is consumed by all three
// clients (web, iOS, Android), the defaults here are the UNION superset — the
// functions default list, which is the one that keeps the native clients
// working. `ALLOWED_ORIGINS` (comma-separated env) is added on top / overrides.
//
// NOTE: deployed origins (the public site, https://algominutes.algorythmos.com)
// come from Terraform's var.allowed_origins as ALLOWED_ORIGINS; only the
// localhost dev origins are baked in here so the native clients keep working.

import cors from 'cors';

// From functions/index.js DEFAULT_ALLOWED_ORIGINS (the superset that supports
// the native clients Capacitor serves from localhost-like origins) plus
// server.ts's localhost pair — deduped.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://localhost',
  'capacitor://localhost',
  'ionic://localhost',
];

export function buildAllowedOriginSet() {
  const configured = String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Env origins are additive to the source defaults (not a replacement) so a
  // deploy that sets ALLOWED_ORIGINS to the production web origin does not
  // accidentally lock out the native clients.
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

export function buildCorsMiddleware() {
  const allowed = buildAllowedOriginSet();
  return cors({
    origin: (origin, cb) => {
      // Same-origin fetches, curl, native app WebViews, and server-to-server
      // calls send no Origin header — allow them, exactly as both source
      // surfaces did.
      if (!origin) return cb(null, true);
      return cb(null, allowed.has(origin));
    },
    // The union of what the source surfaces accepted: functions/applyCors used
    // POST/OPTIONS; the consolidated service also serves GET (health) and
    // DELETE (delete-account).
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    // Authorization + Content-Type as before, plus the new required client
    // version header and a trace header so preflight does not strip them.
    allowedHeaders: ['Authorization', 'Content-Type', 'X-AlgoMinutes-Client', 'X-Trace-Id'],
    maxAge: 3600,
    credentials: false,
  });
}
