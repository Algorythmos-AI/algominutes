// Where the web app's two backends are, and who it says it is.
//
// VITE_API_ORIGIN and VITE_BILLING_ORIGIN are set per Vercel environment
// (docs/runbooks/site.md) and checked by scripts/build-site.mjs, so a build
// without them fails instead of shipping an app that calls nowhere. There is
// deliberately no fallback origin: a guessed URL is how the old web app came to
// call an unregistered domain.
import pkg from '../../../package.json';

/** `X-AlgoMinutes-Client`: the api answers 400 without it and 426 below MIN_SUPPORTED_CLIENT.web. */
export const CLIENT_HEADER_VALUE = `web/${pkg.version}`;

/** An origin as the client uses it: https (or http on localhost), no path, no trailing slash. */
export function parseOrigin(raw: string | undefined, name: string): string {
  const value = (raw ?? '').trim();
  if (!value) throw new Error(`${name} is not set`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error(`${name} must be https: ${value}`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${name} must be an origin, with no path: ${value}`);
  return url.origin;
}

export interface ApiOrigins {
  api: string;
  billing: string;
}

/** The build's origins. Throws (at first use) when the build wasn't configured. */
export function originsFromEnv(env: Record<string, string | undefined> = import.meta.env): ApiOrigins {
  return {
    api: parseOrigin(env.VITE_API_ORIGIN, 'VITE_API_ORIGIN'),
    billing: parseOrigin(env.VITE_BILLING_ORIGIN, 'VITE_BILLING_ORIGIN'),
  };
}
