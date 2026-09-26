/**
 * Report a web crash so it is as findable as an iOS one: a fire-and-forget
 * POST to the api's public /v1/client-error, which logs it where the log-based
 * alerting sees it. No third-party SDK, no bundle cost.
 *
 * It goes cross-origin (the api isn't on the site's origin), so it's a fetch
 * with keepalive, not sendBeacon: a beacon can't carry a JSON body across
 * origins without a CORS preflight, which beacons don't make.
 */
import { CLIENT_HEADER_VALUE, originsFromEnv } from './api/config';

/** Never let reporting a crash cause one. */
let sent = 0;
const MAX_PER_SESSION = 10;

function truncate(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Where reports go; null when the build has no api origin (a local build), so nothing is sent. */
function endpoint(): string | null {
  try {
    return `${originsFromEnv().api}/v1/client-error`;
  } catch {
    // silent-catch-ok: an unconfigured build has nowhere to report to; the crash still shows on screen.
    return null;
  }
}

export function reportCrash(kind: string, error: unknown, extra?: { componentStack?: string; source?: string }): void {
  // A crash loop must not turn into a request loop.
  if (sent >= MAX_PER_SESSION) return;
  const url = endpoint();
  if (!url) return;
  sent += 1;

  const err = error as { message?: unknown; stack?: unknown; name?: unknown } | null;
  // ClientErrorReport (@algominutes/contracts): all optional, each capped server-side too.
  const body = JSON.stringify({
    kind: truncate(kind, 100),
    name: truncate(err?.name, 100),
    message: truncate(err?.message ?? error, 500),
    // Enough to identify the frame; not enough to be a payload.
    stack: truncate(err?.stack, 2000),
    url: truncate(typeof location !== 'undefined' ? location.pathname : '', 200),
    userAgent: truncate(typeof navigator !== 'undefined' ? navigator.userAgent : '', 300),
    ...(extra?.componentStack ? { componentStack: truncate(extra.componentStack, 2000) } : {}),
    ...(extra?.source ? { source: truncate(extra.source, 200) } : {}),
  });

  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AlgoMinutes-Client': CLIENT_HEADER_VALUE },
    body,
    keepalive: true,
    credentials: 'omit',
  }).catch(() => {
    // silent-catch-ok: this is the last channel; a report that can't be sent has nowhere left to go.
  });
}

/**
 * Catch the two things React's error boundary cannot: errors outside the render
 * tree, and rejected promises nobody handled. The audit found several of the
 * latter on the note-creation path, where a failed Firestore write produced no
 * UI at all — the doctor stopped recording and simply nothing happened.
 */
export function installGlobalCrashHandlers(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event) => {
    const e = event as ErrorEvent;
    reportCrash('window.onerror', e.error ?? e.message, { source: `${e.filename ?? ''}:${e.lineno ?? ''}` });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportCrash('unhandledrejection', (event as PromiseRejectionEvent).reason);
  });
}
