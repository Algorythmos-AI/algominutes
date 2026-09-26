'use strict';

// One Postgres connection config for every pool in the system (repo layer,
// api read path, transcoder, summarizer, embedder, migrations). Before this,
// five copies disagreed: the repo layer connected WITHOUT TLS while the
// workers forced it (Cloud SQL once rejected unencrypted VPC-connector
// traffic: "pg_hba.conf rejects connection ... no encryption", Bug 16), and
// defaults differed (`postgres` vs the real `algominutes` database).
//
// TLS policy (libpq-style PGSSLMODE):
//   disable              -> plaintext
//   require|prefer|verify-* -> encrypted. The server certificate is not
//                            chain-verified: Cloud SQL private-IP certs are not
//                            issued by a public CA, and traffic never leaves the
//                            VPC. (Encryption, not identity, is what pg_hba and
//                            ssl_mode=ENCRYPTED_ONLY demand.)
//   unset                -> encrypted unless the host is local (dev / CI).
// Terraform sets PGSSLMODE=require and the instance to ENCRYPTED_ONLY.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '']);

function hostFromUrl(url) {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch (err) {
    // A malformed URL must not silently downgrade to plaintext.
    throw new Error(`DATABASE_URL is not a valid URL: ${err.message}`);
  }
}

function isLocalHost(host) {
  return LOCAL_HOSTS.has(String(host || '').toLowerCase()) || String(host || '').startsWith('/');
}

function resolveSsl(env = process.env) {
  const mode = String(env.PGSSLMODE || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode) return { rejectUnauthorized: false };
  const host = env.DATABASE_URL ? hostFromUrl(env.DATABASE_URL) : env.PGHOST;
  return isLocalHost(host) ? false : { rejectUnauthorized: false };
}

// pg lets an `sslmode` in the connection string OVERRIDE the explicit `ssl`
// option, so strip it and let resolveSsl be the single authority.
function stripSslParams(url) {
  const u = new URL(url);
  for (const k of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey']) u.searchParams.delete(k);
  return u.toString();
}

/**
 * pg Pool config. `max` is per-process connection ceiling for this pool.
 * @param {{ max?: number, idleTimeoutMillis?: number }} [opts]
 * @param {NodeJS.ProcessEnv} [env]
 */
/**
 * The per-service connection budget (PG_POOL_MAX, set by Terraform from
 * infra/terraform/envs/<env>/connection-budget.json): every pool the service
 * opens is capped at it, so max instances x pools x cap fits the database's
 * connection limit. It only ever lowers a pool's size. A pool that's too small
 * just queues (a pg.Pool waits for a free client), where too many connections
 * make Postgres refuse them.
 */
function poolCap(env) {
  const n = Number(env.PG_POOL_MAX);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function buildPgConfig(opts = {}, env = process.env) {
  const cap = poolCap(env);
  const max = cap ? Math.min(opts.max ?? 4, cap) : (opts.max ?? 4);
  const idleTimeoutMillis = opts.idleTimeoutMillis ?? 30000;
  const ssl = resolveSsl(env);
  if (env.DATABASE_URL) {
    return { connectionString: stripSslParams(env.DATABASE_URL), ssl, max, idleTimeoutMillis };
  }
  return {
    host: env.PGHOST,
    port: env.PGPORT ? Number(env.PGPORT) : 5432,
    database: env.PGDATABASE || 'algominutes',
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ssl,
    max,
    idleTimeoutMillis,
  };
}

/**
 * pg.Pool emits 'error' when an IDLE client dies (Cloud SQL maintenance,
 * failover, a NAT flow reset). With no listener Node rethrows and kills the
 * instance; with an empty listener the churn is invisible. Always log it.
 */
function attachPoolErrorLogger(pool, logger, fields = {}) {
  pool.on('error', (err) => logger.error({ err, ...fields }, 'pg_pool_idle_client_error'));
  return pool;
}

/**
 * Readiness probe: prove the pool can reach Postgres, bounded in time so a
 * hung connection can never hang the probe. Resolves on success, rejects with
 * the underlying error (or a timeout) otherwise.
 */
async function pingPool(pool, timeoutMs = 3000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`postgres ping timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([pool.query('SELECT 1'), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { buildPgConfig, resolveSsl, attachPoolErrorLogger, pingPool };
