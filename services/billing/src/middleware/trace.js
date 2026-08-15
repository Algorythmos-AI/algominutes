// Per-request structured-logging context for services/billing.
//
// CLAUDE.md §2: every server log line carries a stable traceId and, where they
// exist, userId. This middleware establishes the trace identity once, at the
// edge, and attaches a child logger to `req.log` that every downstream handler
// enriches (auth adds `uid`/`userId`; webhook handlers add `rail`/`railId`).
//
// The logger is the shared @algominutes/ai logger — imported, never
// re-implemented — so the whole platform emits one log shape.

import loggerModule from '@algominutes/ai/logger.cjs';

const { logger, traceIdFrom } = loggerModule;

// One service-tagged root logger, mirroring how the other services derive theirs.
export const rootLogger = logger.child({ svc: 'billing' });
export { traceIdFrom };

export function traceMiddleware(req, _res, next) {
  const traceId = traceIdFrom(req.headers);
  req.traceId = traceId;
  req.log = rootLogger.child({ traceId, path: req.path, method: req.method });
  next();
}
