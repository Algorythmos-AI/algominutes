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

const { logger: rootLogger, traceIdFrom } = loggerModule;

export { rootLogger, traceIdFrom };

export function traceMiddleware(req, _res, next) {
  const traceId = traceIdFrom(req.headers);
  req.traceId = traceId;
  req.log = rootLogger.child({ traceId, path: req.path, method: req.method });
  next();
}
