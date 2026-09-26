'use strict';

// The transcoder's Postgres pool. The SQL itself lives in the repo layer
// (@algominutes/db/pipeline-repo.cjs; CLAUDE.md §1): the chunked-pipeline gates,
// the status writes, and the fast path's result. Re-exported here so the
// handler's `deps.db` shape is unchanged.

function loadShared(name) {
  try { return require(`@algominutes/ai/${name}`); }
  catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return require(`@algominutes/db/${name}`);
    throw err;
  }
}
const pipelineRepo = require('@algominutes/db/pipeline-repo.cjs');

let _pool = null;
function pool() {
  if (_pool) return _pool;
  const { Pool } = require('pg');
  // Shared connection config (TLS policy + defaults): @algominutes/ai/pg-config.cjs.
  const { buildPgConfig, attachPoolErrorLogger } = loadShared('pg-config.cjs');
  _pool = attachPoolErrorLogger(new Pool(buildPgConfig({ max: 4 })), loadShared('logger.cjs').logger, { pool: 'transcoder' });
  return _pool;
}

module.exports = { pool, ...pipelineRepo };
