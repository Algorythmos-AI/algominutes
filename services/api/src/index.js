// services/api entrypoint — the single HTTP edge for all three AlgoMinutes
// clients (web, iOS, Android). Consolidates the source's Express server.ts and
// the five Firebase Functions handlers into one Cloud Run service
// (BUILD-PLAN §3.1).

import { initFirebase } from './firebase.js';
import { buildApp } from './app.js';
import { rootLogger } from './middleware/trace.js';
import requireEnvMod from '@algominutes/ai/require-env.cjs';
import spendGuardMod from '@algominutes/ai/spend-guard.cjs';
import spendRepoMod from '@algominutes/db/spend-repo.cjs';
import { getPool } from '@algominutes/db';
import envSpec from './env-spec.cjs';

const { requireEnv } = requireEnvMod;

// Cloud Run injects PORT (8080 by convention); default for local runs.
const PORT = Number(process.env.PORT) || 8080;

// Fail fast if the edge is started without the config it silently mis-defaults
// on: the storage bucket, the Cloud Tasks target, the downstream worker URLs,
// and the CORS allowlist (unset ALLOWED_ORIGINS would fall back to localhost).
requireEnv(
  'api',
  envSpec,
  { logger: rootLogger },
);

initFirebase();

// §4.6: a kickoff at the daily spend cap is refused before anything is queued
// or charged (packages/db kickoff.ts). It reads the same paid-work minutes as
// the transcoder's gate, cached for a minute per instance.
spendGuardMod.setDailySpendReader(spendRepoMod.createPaidWorkSpendReader({ pool: () => getPool() }));

const app = buildApp();

const server = app.listen(PORT, '0.0.0.0', () => {
  rootLogger.info({ port: PORT }, 'api_listening');
});

// Cloud Run sends SIGTERM before reclaiming an instance; drain in-flight
// requests rather than dropping them.
function shutdown(signal) {
  rootLogger.info({ signal }, 'api_shutting_down');
  server.close(() => process.exit(0));
  // Hard cap so a stuck connection cannot block the reclaim indefinitely.
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
