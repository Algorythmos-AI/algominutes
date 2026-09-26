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

/**
 * The request's traceId: the client's X-Trace-Id when it's well formed (the
 * web app sends one on every call, and keeps it on any error, so a failure it
 * reports is findable here; a browser can't send X-Cloud-Trace-Context
 * cross-origin), else Cloud Run's trace id, else a fresh one.
 */
export function requestTraceId(headers) {
  const client = headers && headers['x-trace-id'];
  return typeof client === 'string' && isTraceId(client) ? client : traceIdFrom(headers);
}

export function traceMiddleware(req, res, next) {
  const traceId = requestTraceId(req.headers);
  req.traceId = traceId;
  // Keep Cloud Run's own id too when the client chose the traceId, so the request is still findable in Cloud Trace.
  const cloudTraceId = traceIdFrom(req.headers);
  req.log = rootLogger.child({ traceId, ...(cloudTraceId !== traceId ? { cloudTraceId } : {}), path: req.path, method: req.method });
  // Every answer names its traceId, so any client can quote it (CORS exposes the header).
  res.setHeader('X-Trace-Id', traceId);
  next();
}
