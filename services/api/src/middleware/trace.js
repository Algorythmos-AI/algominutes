// Per-request structured-logging context.
//
// CLAUDE.md §2 / BUILD-PLAN require every server log line to carry a stable
// traceId and, where they exist, userId / noteId / workspaceId. This
// middleware establishes the trace identity once, at the edge, and attaches a
// child logger to `req.log` that every downstream handler enriches (auth adds
// `uid`/`userId`; the ported handlers add `noteId`/`workspaceId`).
//
// The logger is the shared @algominutes/ai logger — imported, never
// re-implemented — so the whole platform emits one log shape.

import loggerModule from '@algominutes/ai/logger.cjs';

const { logger: rootLogger, traceIdFrom, isTraceId } = loggerModule;

export { rootLogger, traceIdFrom };

/** Cloud Run's trace id, from X-Cloud-Trace-Context (TRACE_ID/SPAN_ID;o=1), or null when there's none. */
function cloudTraceIdFrom(headers) {
  const raw = headers && headers['x-cloud-trace-context'];
  const id = typeof raw === 'string' ? raw.split(/[/;]/)[0] : '';
  return isTraceId(id) ? id : null;
}

/**
 * The request's trace identity. traceId is the client's X-Trace-Id when it's
 * well formed (the web app sends one on every call, and keeps it on any
 * error, so a failure it reports is findable here; a browser can't send
 * X-Cloud-Trace-Context cross-origin), else Cloud Run's trace id, else a
 * fresh one. cloudTraceId is Cloud Run's id when it differs from traceId, so
 * the request stays findable in Cloud Trace; null when there's no real one.
 */
export function traceContext(headers) {
  const client = headers && headers['x-trace-id'];
  const cloud = cloudTraceIdFrom(headers);
  const traceId = typeof client === 'string' && isTraceId(client) ? client : cloud ?? traceIdFrom(headers);
  return { traceId, cloudTraceId: cloud && cloud !== traceId ? cloud : null };
}

export function traceMiddleware(req, res, next) {
  const { traceId, cloudTraceId } = traceContext(req.headers);
  req.traceId = traceId;
  req.log = rootLogger.child({ traceId, ...(cloudTraceId ? { cloudTraceId } : {}), path: req.path, method: req.method });
  // Every answer names its traceId, so any client can quote it (CORS exposes the header).
  res.setHeader('X-Trace-Id', traceId);
  next();
}
