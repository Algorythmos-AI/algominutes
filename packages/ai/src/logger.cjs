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

const { randomUUID } = require('node:crypto');

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
  // node:crypto randomUUID exists on every runtime we ship (Node 22+). The old
  // Math.random() fallback was dead code, and CodeQL rightly flags it once the
  // id travels in a task body.
  return randomUUID();
}

// A traceId we accept from a task body: Cloud Trace ids (32 hex), UUIDs, and
// the like. Anything else (wrong type, oversized, odd characters) is ignored,
// so a body can't smuggle arbitrary text into every log line.
const TRACE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
function isTraceId(value) {
  return typeof value === 'string' && TRACE_ID.test(value);
}

/**
 * The traceId for a Cloud Tasks handler. It is the one the enqueuer carried in
 * the task body (cloud-tasks.cjs enqueueTask puts it there), so a recording is
 * followable under one traceId from the api through every worker (CLAUDE.md
 * §1). It falls back to the request's own trace header, or a fresh id.
 */
function traceIdFromTask(body, headers) {
  const carried = body && body.traceId;
  return isTraceId(carried) ? carried : traceIdFrom(headers);
}

module.exports = {
  logger: makeLogger({ service: 'algominutes' }),
  makeLogger,
  traceIdFrom,
  traceIdFromTask,
  isTraceId,
};
