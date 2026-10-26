// Where Stripe sends a buyer back (RELEASE.md PR 28): the web app they came from, at its own origin
// (staging's, the beta's, prod's), so checkout returns to /app/billing/success on the right host.
//
// The Origin header is the browser's, and a return URL is where Stripe redirects the buyer: only an
// origin on the one CORS allowlist (@algominutes/ai/cors.cjs, ALLOWED_ORIGINS) is used, and only https
// (http only on localhost). Anything else falls back to the public site's pages, so it can't send anyone
// elsewhere.
import corsModule from '@algominutes/ai/cors.cjs';

const { buildAllowedOriginSet } = corsModule;

/** The request's web app origin when it's one we serve, else null. */
export function webAppOrigin(origin, env = process.env) {
  if (typeof origin !== 'string' || !origin) return null;
  let url;
  try {
    url = new URL(origin);
  } catch {
    // silent-catch-ok: not a URL is simply not our origin; the caller falls back to the public site
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  // Only an exact allowlisted origin, compared as sent: a path or credentials never match.
  return buildAllowedOriginSet(env).has(origin) ? origin : null;
}
