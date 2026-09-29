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

/** `new Error('<label> <status> <ENUM>')`: e.g. "Vertex Gemini 503 UNAVAILABLE", "vertex_embed_failed: 400 INVALID_ARGUMENT". */
function vertexRefusal(label, status, bodyText) {
  const reason = refusalReason(status, bodyText);
  return new Error(`${label} ${status}${reason ? ` ${reason}` : ''}`);
}

module.exports = { vertexRefusal, refusalReason };
