'use strict';
/**
 * A refused Vertex call (Gemini, the embedder, the chat stream), described
 * without its body's text (RELEASE.md PR 15a; audit Q29). A 400 can quote the
 * request back, and every request here carries transcript text or a user's
 * query: it would land in the logs, a task's failure and its dead letter.
 *
 * What's kept: the HTTP status, and the google.rpc status enum from Vertex's
 * error body (`{"error":{"status":"RESOURCE_EXHAUSTED"}}`, or the same inside
 * an array), else the enum that status means. isTransientError
 * (intelligence.cjs) matches on both: 503 and 429, and INTERNAL,
 * DEADLINE_EXCEEDED, UNAVAILABLE.
 */

// google.rpc.Code names: nothing else is kept from a body.
const RPC_STATUS = new Set([
  'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
  'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE',
  'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
]);

// What an HTTP status means when the body doesn't say (a proxy's HTML page, an empty body).
const BY_HTTP_STATUS = {
  400: 'INVALID_ARGUMENT',
  401: 'UNAUTHENTICATED',
  403: 'PERMISSION_DENIED',
  404: 'NOT_FOUND',
  429: 'RESOURCE_EXHAUSTED',
  500: 'INTERNAL',
  503: 'UNAVAILABLE',
  504: 'DEADLINE_EXCEEDED',
};

/** The refusal's status enum: from Vertex's error body when it names one, else from the HTTP status. */
function refusalReason(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const named = (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.status;
    if (RPC_STATUS.has(named)) return named;
  } catch {
    // silent-catch-ok: a body that isn't Vertex's JSON (a proxy's page) says nothing that's kept; the HTTP status stands
  }
  return BY_HTTP_STATUS[status] || '';
}

// What else a body may say that names the problem without quoting the request: the paths of the fields it
// refused (BadRequest.fieldViolations[].field, e.g. "contents[0].parts[0].inline_data") and machine reasons
// (ErrorInfo.reason). Never a description or a message. Each must look like a path or an enum, or it's dropped.
const FIELD_PATH = /^[A-Za-z0-9_.[\]]{1,80}$/;
const REASON = /^[A-Z0-9_]{1,64}$/;

/**
 * `{ fields, reasons }` from Vertex's error details, at most 3 of each, or null when there are none. A 400 whose
 * reason can't otherwise be seen (one came and went on 2026-10-01) says which field it refused.
 */
function refusalDetail(bodyText) {
  let details;
  try {
    const parsed = JSON.parse(bodyText);
    details = (Array.isArray(parsed) ? parsed[0] : parsed)?.error?.details;
  } catch {
    // silent-catch-ok: a body that isn't Vertex's JSON has no details to keep
    return null;
  }
  if (!Array.isArray(details)) return null;
  const fields = [];
  const reasons = [];
  for (const d of details) {
    for (const v of (d && Array.isArray(d.fieldViolations) ? d.fieldViolations : [])) {
      if (typeof v?.field === 'string' && FIELD_PATH.test(v.field) && fields.length < 3) fields.push(v.field);
    }
    if (typeof d?.reason === 'string' && REASON.test(d.reason) && reasons.length < 3) reasons.push(d.reason);
  }
  return fields.length || reasons.length ? { fields, reasons } : null;
}

/**
 * `new Error('<label> <status> <ENUM>')`: e.g. "Vertex Gemini 503 UNAVAILABLE", "vertex_embed_failed: 400 INVALID_ARGUMENT".
 * The details go on `err.detail`, not in the message: isTransientError matches words in the message, and a reason
 * naming INTERNAL mustn't make a 400 retryable.
 */
function vertexRefusal(label, status, bodyText) {
  const reason = refusalReason(status, bodyText);
  const err = new Error(`${label} ${status}${reason ? ` ${reason}` : ''}`);
  const detail = refusalDetail(bodyText);
  if (detail) err.detail = detail;
  return err;
}

module.exports = { vertexRefusal, refusalReason, refusalDetail };
