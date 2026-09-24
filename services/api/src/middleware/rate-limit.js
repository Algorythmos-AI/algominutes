// Request rate limits for the /v1 API (plan PR-16b).
//
// Two layers:
//   - clientRateLimit: every /v1 request, keyed by the client IP. It sits in
//     front of the public routes (share read, crash beacon, account delete)
//     and anything unauthenticated. Health probes are exempt.
//   - userRateLimit: every authenticated route, keyed by the verified uid. It
//     runs right after authMiddleware, so the key can't be forged.
//
// Counters are per instance (in memory), so with N instances a client can get
// up to N times the limit. That makes this a coarse abuse guard, not a quota.
// The costly routes keep their own durable budgets (usage metering, the
// per-uid rate budget, the daily spend cap).
//
// req.ip only means the client's address when `trust proxy` is the exact hop
// count (see app.js); with `true`, a client could send any X-Forwarded-For
// and get a fresh bucket each time.

import { rateLimit, ipKeyGenerator } from 'express-rate-limit';

const WINDOW_MS = 60_000;

const envLimit = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

function onLimited(event) {
  return (req, res, _next, options) => {
    req.log?.warn({ limit: options.limit, windowMs: options.windowMs }, event);
    res.status(options.statusCode).json({ error: 'rate_limited', message: 'Too many requests. Please wait a moment.' });
  };
}

/** Per client IP, on every /v1 request except the health probes. */
export function clientRateLimit({ limit = envLimit('RATE_LIMIT_IP_PER_MIN', 300) } = {}) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // IPv6 clients are grouped by /56, so one host can't rotate addresses.
    keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
    skip: (req) => req.path === '/health' || req.path === '/health/ready',
    handler: onLimited('rate_limited_ip'),
  });
}

/** Per verified user. Mount after authMiddleware (req.uid is set by it). */
export function userRateLimit({ limit = envLimit('RATE_LIMIT_USER_PER_MIN', 120) } = {}) {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `uid:${req.uid}`,
    handler: onLimited('rate_limited_user'),
  });
}

/**
 * How many proxies in front of the service to trust for req.ip. Cloud Run's
 * front end appends the real client address as the rightmost
 * X-Forwarded-For entry, so the default is 1. An external load balancer in
 * front would make it 2. Never `true`.
 */
export function trustProxyHops() {
  const n = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}
