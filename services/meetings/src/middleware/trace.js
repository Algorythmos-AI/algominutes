// Per-request logging context for services/meetings (CLAUDE.md §1): a traceId
// from X-Cloud-Trace-Context or a new one, on a child of the shared logger.
import loggerModule from '@algominutes/ai/logger.cjs';

const { logger, traceIdFrom } = loggerModule;

export const rootLogger = logger.child({ svc: 'meetings' });

export function traceMiddleware(req, _res, next) {
  const traceId = traceIdFrom(req.headers);
  req.traceId = traceId;
  req.log = rootLogger.child({ traceId, path: req.path, method: req.method });
  next();
}
