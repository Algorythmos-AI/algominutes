// POST /v1/client-error — a crash beacon from the web app. PUBLIC.
//
// Ported from functions/index.js `exports.clientError` (BUILD-PLAN §3.1).
//
// Unauthenticated on purpose: the most valuable crash to hear about is the one
// that happened before or during sign-in. That makes it an anonymous write
// surface, so it is deliberately cheap and bounded — nothing touches Postgres,
// nothing is stored, and every field is length-capped before it reaches the
// log. It is also EXEMPT from the client-version gate (a crashing app must be
// able to report even if it never sent the version header) — see app.js.
//
// No shared-lib repointing needed: this handler only logs via req.log (a child
// of the shared @algominutes/ai logger).

const CLIENT_ERROR_FIELD_CAPS = {
  kind: 60, name: 100, message: 500, stack: 2000,
  url: 200, userAgent: 300, componentStack: 2000, source: 200,
};

// Reports that describe what happened rather than a crash (the web's sign-in
// trace and CSP reporter: apps/web/src/lib/diagnostics). Everything else is a crash.
//
// A refused screen wake lock is one of those: a browser refuses it for a hidden
// tab or a low battery, and headless Chrome always does. The recording carries
// on; only the screen may sleep. It was 51 of staging's 57 error lines on
// 2026-10-06, every one from the web journey.
const DIAGNOSTIC_KINDS = new Set(['auth.signInCancelled', 'csp.violation', 'record.wakeLock', 'record.wakeLockRelease']);

export function clientErrorRoute(req, res) {
  const log = req.log;
  const body = req.body || {};
  const report = {};
  for (const [field, cap] of Object.entries(CLIENT_ERROR_FIELD_CAPS)) {
    const value = body[field];
    if (typeof value === 'string' && value.length > 0) {
      // Control characters flattened (line breaks become ' | ', so a stack
      // stays readable): an anonymous caller must not shape the log's layout.
      // The logger writes JSON, so this is defence in depth.
      const flat = value.slice(0, cap).replace(/\r?\n|\r/g, ' | ').replace(/[\u0000-\u001f\u007f]/g, ' ');
      // A no-op by now, but it is the one shape CodeQL's js/log-injection
      // treats as a sanitiser: a global replace of "\n" with "" (its
      // StringReplaceSanitizer). Without it the alert stays open.
      report[field] = flat.replace(/\n/g, '');
    }
    // Anything else (numbers included) is dropped: every capped field is a
    // string, and a raw request value must never reach the log unsanitised.
    // (The web beacon's one numeric field, `line`, isn't in the caps.)
  }

  // A stable event name so a log-based metric can count it. A crash is logged as
  // an error, because a blank screen for a doctor is one. A diagnostic report is
  // a warning: a sign-in window closed without a result (people close it on
  // purpose, and it's what a blocked flow looks like) and a CSP violation are
  // worth reading, but mustn't look like crashes to an error-rate alert.
  const diagnostic = DIAGNOSTIC_KINDS.has(report.kind ?? '');
  (diagnostic ? log.warn : log.error).call(log, { ...report, ua: report.userAgent }, diagnostic ? 'web_client_diagnostic' : 'web_client_crash');
  // 204 rather than a body: sendBeacon ignores the response, and there is
  // nothing useful to say back to a page that has already crashed.
  return res.status(204).send('');
}
