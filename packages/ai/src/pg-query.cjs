'use strict';

// Shared Postgres pool + per-query timeout helper for the Cloud Functions
// deploy.
//
// Extracted verbatim from functions/search-and-chat.cjs so that every
// read-path handler (search, chat, note-read, export, share) uses one pool
// and one timeout discipline instead of each growing its own copy. Behaviour
// is unchanged from the original; only the location moved.
//
// One pool per Node process. Because Cloud Functions serves a single request
// per instance at a time, sharing the pool across handlers does not increase
// concurrent connection pressure — `max: 10` remains the per-instance ceiling
// it was before, now counted once instead of once per module.
//
// Reused by:
//   - functions/search-and-chat.cjs  handleSearch / handleChatStream
//   - functions/note-read.cjs        handleNoteRead
//
// The pool's 'error' event (an idle client dying) is logged via the shared
// attachPoolErrorLogger — formerly an empty handler, now closed.

const { buildPgConfig, attachPoolErrorLogger } = require('./pg-config.cjs');
const { logger } = require('./logger.cjs');

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const { Pool } = require('pg');
  _pool = attachPoolErrorLogger(new Pool(buildPgConfig({ max: 10 })), logger, { pool: 'api-read' });
  return _pool;
}

// Per-query statement_timeout via SET LOCAL inside a transaction.
// pg-pool does not expose a per-call timeout natively; SET LOCAL only
// persists for the surrounding transaction so the connection returns
// to the pool with default settings. Postgres raises SQLSTATE 57014
// ("query_canceled") when the timeout fires; the catch arm distinguishes
// timeout from generic failure so Cloud Logging carries the right
// signal. Budgets sized so the worst case (3+12+12=27s) leaves ~30s
// of headroom under the 60s function timeout.
async function withQueryTimeout({ timeoutMs, text, values, log, op }) {
  const client = await pool().connect();
  const startedAt = Date.now();
  try {
    // READ ONLY, not a plain BEGIN. Every caller of this helper is a read
    // path (search, chat, note-read), and a read-only transaction makes that
    // a guarantee Postgres enforces rather than a property maintained by code
    // review. A future caller that needs to write fails loudly here instead
    // of quietly committing through a helper named "query". SET LOCAL is
    // permitted inside a read-only transaction; it changes no data.
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
    const result = await client.query({ text, values });
    await client.query('COMMIT');
    if (log && typeof log.info === 'function') {
      log.info({ ms: Date.now() - startedAt, op, rowCount: result.rowCount }, `pg_${op}_ok`);
    }
    return result;
  } catch (err) {
    const ms = Date.now() - startedAt;
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {
      if (log && typeof log.warn === 'function') {
        log.warn({ err: rbErr, op }, `pg_${op}_rollback_failed`);
      }
    }
    if (err && err.code === '57014') {
      if (log && typeof log.error === 'function') {
        // `err` included deliberately: isQueryTimeout() asserts that 57014
        // means our statement_timeout fired, but 57014 is also raised by
        // pg_cancel_backend(), by client-side cancellation, and by Cloud SQL
        // admin operations. err.message is the only field that distinguishes
        // them, so dropping it would make this line unable to falsify its
        // own assumption.
        log.error({ err, ms, timeoutMs, op }, `pg_${op}_timeout`);
      }
    } else if (log && typeof log.error === 'function') {
      log.error({ err, ms, op }, `pg_${op}_failed`);
    }
    throw err;
  } finally {
    client.release();
  }
}

// SQLSTATE 57014 = query_canceled, which for our callers always means the
// statement_timeout above fired. Callers map this to HTTP 504 rather than 500
// so a slow query is distinguishable from a broken one in the metrics.
function isQueryTimeout(err) {
  return Boolean(err && err.code === '57014');
}

function postgresEnabled() {
  return String(process.env.WRITE_POSTGRES || '').toLowerCase() === 'true';
}

module.exports = { pool, withQueryTimeout, isQueryTimeout, postgresEnabled };
