// services/api entrypoint — the single HTTP edge for all three AlgoMinutes
// clients (web, iOS, Android). Consolidates the source's Express server.ts and
// the five Firebase Functions handlers into one Cloud Run service
// (BUILD-PLAN §3.1).

import { initFirebase } from './firebase.js';
import { buildApp } from './app.js';
import { rootLogger } from './middleware/trace.js';

// Cloud Run injects PORT (8080 by convention); default for local runs.
const PORT = Number(process.env.PORT) || 8080;

initFirebase();

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
