/**
 * Report a web crash so it is as findable as an iOS one.
 *
 * iOS has Crashlytics — which is how the Sign in with Apple crash was located
 * in under a minute after five TestFlight builds had shipped it. The web app
 * had nothing: `componentDidCatch` only wrote to `console.error`, and there was
 * no `window.onerror` or `unhandledrejection` handler anywhere, so every
 * unhandled rejection on the note-creation path was invisible. A doctor whose
 * screen went blank had no way to tell us and we had no way to know.
 *
 * Deliberately small: a fire-and-forget beacon into Cloud Logging via
 * `/api/client-error`, where the existing log-based alerting can see it. No
 * third-party SDK, no bundle cost, nothing new to authorise.
 */

/** Never let reporting a crash cause one. */
let sent = 0;
const MAX_PER_SESSION = 10;

function truncate(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function reportCrash(kind: string, error: unknown, extra?: Record<string, unknown>): void {
  // A crash loop must not turn into a request loop.
  if (sent >= MAX_PER_SESSION) return;
  sent += 1;

  const err = error as { message?: unknown; stack?: unknown; name?: unknown } | null;
  const body = JSON.stringify({
    kind,
    name: truncate(err?.name, 100),
    message: truncate(err?.message ?? error, 500),
    // Enough to identify the frame; not enough to be a payload.
    stack: truncate(err?.stack, 2000),
    url: truncate(typeof location !== 'undefined' ? location.pathname : '', 200),
    userAgent: truncate(typeof navigator !== 'undefined' ? navigator.userAgent : '', 300),
    at: new Date().toISOString(),
    ...(extra || {}),
  });

  try {
    // sendBeacon survives the page being torn down, which is exactly when a
    // crash report is most likely to be lost.
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/client-error', new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch((err) => console.warn('crash_report_failed', err));
  } catch (err) {
    console.warn('crash_report_failed', err);
  }
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
    reportCrash('window.onerror', event.error ?? event.message, {
      source: truncate((event as ErrorEvent).filename, 200),
      line: (event as ErrorEvent).lineno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportCrash('unhandledrejection', (event as PromiseRejectionEvent).reason);
  });
}
