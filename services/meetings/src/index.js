// services/meetings entrypoint (docs/plans/MEETINGS.md).
import { buildApp } from './app.js';
import { rootLogger } from './middleware/trace.js';
import requireEnvMod from '@algominutes/ai/require-env.cjs';
import envSpec from './env-spec.cjs';

const { requireEnv } = requireEnvMod;
const PORT = Number(process.env.PORT) || 8080;

// Recall's secrets are read at run time (lib/secrets.js), not required here: a
// deploy must not depend on the owner having added them yet.
requireEnv('meetings', envSpec, { logger: rootLogger });

const app = buildApp();
const server = app.listen(PORT, '0.0.0.0', () => rootLogger.info({ port: PORT }, 'meetings_listening'));

function shutdown(signal) {
  rootLogger.info({ signal }, 'meetings_shutting_down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
