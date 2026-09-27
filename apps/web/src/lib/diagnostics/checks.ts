// The checks /app/diagnostics runs from the user's own browser: each link of the
// sign-in chain that can fail silently (docs/runbooks/site.md, "Sign-in
// troubleshooting"). Every check says what it looked at and, when it fails,
// what to change. Nothing here needs a signed-in user, and nothing secret is
// shown (the API key is masked).

export type CheckStatus = 'ok' | 'fail' | 'warn';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to change, when it isn't ok. */
  fix?: string;
}

export interface DiagConfig {
  host: string;
  authDomain: string;
  projectId: string;
  apiKey: string;
  apiOrigin: string;
}

type Fetch = typeof fetch;

export const maskKey = (key: string) => (key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : key ? '…' : '(not set)');

/** A CSP header as directive → sources. */
export function parseCsp(header: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

/** The page's own CSP lets the sign-in chain through: Google's script, Firebase's endpoints, the auth iframe, the api. */
export function cspChecks(header: string, c: DiagConfig): Check[] {
  if (!header) {
    return [{ id: 'csp', label: 'Content-Security-Policy', status: 'warn', detail: 'This page was served without a CSP header (a local build?).' }];
  }
  const csp = parseCsp(header);
  const has = (directive: string, source: string) => {
    const list = csp.get(directive) ?? csp.get('default-src') ?? [];
    return list.includes(source) || list.includes('*');
  };
  const needs: Array<[string, string, string]> = [
    ['script-src', 'https://apis.google.com', "Google's sign-in script"],
    ['connect-src', 'https://identitytoolkit.googleapis.com', 'Firebase Auth'],
    ['connect-src', 'https://securetoken.googleapis.com', "Firebase's token refresh"],
    ['connect-src', c.apiOrigin, 'the api'],
  ];
  // Signing in on another domain (staging: Firebase's own) needs its iframe allowed; on our own domain it's 'self'.
  if (c.authDomain && c.authDomain !== c.host) needs.push(['frame-src', `https://${c.authDomain}`, "Firebase's sign-in iframe"]);
  return needs.map(([directive, source, what]) => {
    const ok = has(directive, source);
    return {
      id: `csp:${directive}:${source}`,
      label: `CSP ${directive} allows ${what}`,
      status: ok ? 'ok' : 'fail',
      detail: ok ? `${directive} includes ${source}` : `${directive} doesn't include ${source}`,
      ...(ok ? {} : { fix: `Add ${source} to /app's ${directive} in apps/site/vercel.json.` }),
    };
  });
}

/**
 * Firebase's project config, fetched with the app's key from this page: it proves the Browser key accepts this
 * site (its website restrictions), and returns the authorized domains to check this host and the auth domain against.
 */
export async function projectChecks(c: DiagConfig, doFetch: Fetch = fetch): Promise<Check[]> {
  let res: Response;
  try {
    res = await doFetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(c.apiKey)}`, { credentials: 'omit' });
  } catch (err) {
    return [{ id: 'key', label: 'Firebase is reachable with the app’s key', status: 'fail', detail: `The request failed: ${(err as Error).message}`, fix: 'Check the network, and that /app’s CSP connect-src allows identitytoolkit.googleapis.com.' }];
  }
  let body: { authorizedDomains?: string[]; error?: { message?: string; details?: Array<{ reason?: string }> } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // silent-catch-ok: a body that isn't JSON is judged by its status alone, below.
  }
  if (!res.ok) {
    const reason = body.error?.details?.find((d) => d.reason)?.reason ?? body.error?.message ?? `HTTP ${res.status}`;
    const refererBlocked = reason === 'API_KEY_HTTP_REFERRER_BLOCKED';
    return [{
      id: 'key',
      label: 'The Browser API key accepts this site',
      status: 'fail',
      detail: `Firebase refused the key (${reason}).`,
      fix: refererBlocked
        ? `Add https://${c.host}/*${c.authDomain && c.authDomain !== c.host ? ` and https://${c.authDomain}/*` : ''} to the Browser key's website restrictions (Google Cloud → Credentials).`
        : 'Check VITE_FIREBASE_API_KEY is this project’s Browser key.',
    }];
  }
  const domains = body.authorizedDomains ?? [];
  const checks: Check[] = [{ id: 'key', label: 'The Browser API key accepts this site', status: 'ok', detail: `Firebase answered with the project config (key ${maskKey(c.apiKey)}).` }];
  for (const d of [...new Set([c.host.split(':')[0], c.authDomain].filter(Boolean))]) {
    const ok = domains.includes(d);
    checks.push({
      id: `domain:${d}`,
      label: `${d} is an authorized domain`,
      status: ok ? 'ok' : 'fail',
      detail: ok ? 'In Firebase Auth’s authorized domains.' : `Not in Firebase Auth’s authorized domains (${domains.join(', ')}).`,
      ...(ok ? {} : { fix: `Add ${d} in Firebase → Authentication → Settings → Authorized domains.` }),
    });
  }
  return checks;
}

/** Loads a URL in a hidden iframe, as Firebase does with its sign-in iframe; true once it loads. */
export function frameProbe(url: string, timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.hidden = true;
    const done = (ok: boolean) => {
      clearTimeout(timer);
      f.remove();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    f.addEventListener('load', () => done(true));
    f.src = url;
    document.body.appendChild(f);
  });
}

/**
 * The auth handler answers where sign-in runs: on our own domain, through the /__/auth proxy (a same-origin
 * fetch); on another domain (staging: Firebase's own), in a hidden iframe, which is also what the page's
 * frame-src must allow.
 */
export async function handlerCheck(c: DiagConfig, doFetch: Fetch = fetch, probe: (url: string) => Promise<boolean> = frameProbe): Promise<Check> {
  const label = 'The sign-in handler answers';
  if (c.authDomain === c.host) {
    try {
      const res = await doFetch('/__/auth/iframe', { credentials: 'include' });
      return res.ok
        ? { id: 'handler', label, status: 'ok', detail: `/__/auth/iframe on this site answered ${res.status}.` }
        : { id: 'handler', label, status: 'fail', detail: `/__/auth/iframe on this site answered ${res.status}.`, fix: 'Check apps/site/vercel.json proxies /__/auth/* for this host to the project’s firebaseapp.com.' };
    } catch (err) {
      return { id: 'handler', label, status: 'fail', detail: `/__/auth/iframe: ${(err as Error).message}`, fix: 'Check the /__/auth proxy in apps/site/vercel.json.' };
    }
  }
  const url = `https://${c.authDomain}/__/auth/iframe`;
  const ok = await probe(url);
  return ok
    ? { id: 'handler', label, status: 'ok', detail: `${url} loaded in a frame, as sign-in loads it.` }
    : { id: 'handler', label, status: 'fail', detail: `${url} didn't load in a frame.`, fix: `Check /app's frame-src allows https://${c.authDomain}, and the auth domain (VITE_FIREBASE_AUTH_DOMAIN).` };
}

/** The api answers this page: its CORS allowlist has this origin (a response is only readable if it does). */
export async function apiCheck(c: DiagConfig, origin: string, doFetch: Fetch = fetch): Promise<Check> {
  try {
    const res = await doFetch(`${c.apiOrigin}/v1/health`, { credentials: 'omit' });
    return {
      id: 'api',
      label: 'The api accepts this site (CORS)',
      status: res.ok ? 'ok' : 'fail',
      detail: `GET ${c.apiOrigin}/v1/health answered ${res.status}.`,
      ...(res.ok ? {} : { fix: 'The api is up but unhealthy: check its logs.' }),
    };
  } catch (err) {
    return {
      id: 'api',
      label: 'The api accepts this site (CORS)',
      status: 'fail',
      detail: `The api couldn't be read from ${origin} (${(err as Error).message}): its CORS allowlist doesn't have this origin, or it's down.`,
      fix: `Add ${origin} to the api's allowed_origins (Terraform) and apply.`,
    };
  }
}

/** Popups (the sign-in window) are allowed: only callable from a click. */
export function popupCheck(open: typeof window.open = window.open.bind(window)): Check {
  const w = open('about:blank', 'algominutes-popup-check', 'width=80,height=80');
  const ok = Boolean(w);
  w?.close();
  return {
    id: 'popup',
    label: 'This browser allows the sign-in window',
    status: ok ? 'ok' : 'warn',
    detail: ok ? 'A test window opened and closed.' : 'The browser blocked a test window.',
    ...(ok ? {} : { fix: 'Allow pop-ups for this site (the icon at the end of the address bar).' }),
  };
}
