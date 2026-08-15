'use strict';

/**
 * Lightweight structured logger that emits Cloud Logging-friendly JSON
 * lines on stdout. Designed to work identically in the dev Express server
 * (server.ts) and in Cloud Functions / Cloud Run.
 *
 * Cloud Logging picks up the `severity` field automatically when logs
 * arrive on stdout, so emitting `{ severity: 'ERROR', ... }` is enough
 * to surface the right log level in the console.
 */

const SEVERITY = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

function emit(level, base, payload, msg) {
  const merged = typeof payload === 'string' && msg === undefined
    ? { msg: payload }
    : { ...payload, msg };
  const record = {
    severity: SEVERITY[level] || 'DEFAULT',
    time: new Date().toISOString(),
    ...base,
    ...merged,
  };
  if (record.err instanceof Error) {
    record.err = {
      name: record.err.name,
      message: record.err.message,
      stack: record.err.stack,
      code: record.err.code,
    };
  }
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'fatal') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function makeLogger(base = {}) {
  return {
    child(extra) {
      return makeLogger({ ...base, ...extra });
    },
    debug(payload, msg) { emit('debug', base, payload, msg); },
    info(payload, msg) { emit('info', base, payload, msg); },
    warn(payload, msg) { emit('warn', base, payload, msg); },
    error(payload, msg) { emit('error', base, payload, msg); },
    fatal(payload, msg) { emit('fatal', base, payload, msg); },
  };
}

function traceIdFrom(headers) {
  const raw = headers && (headers['x-cloud-trace-context'] || headers['X-Cloud-Trace-Context']);
  if (typeof raw === 'string' && raw.length) return raw.split('/')[0];
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

module.exports = {
  logger: makeLogger({ service: 'algominutes' }),
  makeLogger,
  traceIdFrom,
};
