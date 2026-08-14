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

export function clientErrorRoute(req, res) {
  const log = req.log;
  const body = req.body || {};
  const report = {};
  for (const [field, cap] of Object.entries(CLIENT_ERROR_FIELD_CAPS)) {
    const value = body[field];
    if (typeof value === 'string' && value.length > 0) {
      report[field] = value.slice(0, cap);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      report[field] = value;
    }
  }

  // A stable event name so a log-based metric can count it. Logged as an
  // error because a blank screen for a doctor is one.
  log.error({ ...report, ua: report.userAgent }, 'web_client_crash');
  // 204 rather than a body: sendBeacon ignores the response, and there is
  // nothing useful to say back to a page that has already crashed.
  return res.status(204).send('');
}
