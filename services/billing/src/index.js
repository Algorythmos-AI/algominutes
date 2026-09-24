// services/billing entrypoint (BUILD-PLAN §3.2, A9.4/A9.5).
//
// The revenue rails: server-side receipt validation (StoreKit 2 / Play),
// Stripe Checkout + Billing Portal, and the PUBLIC store/Stripe webhooks that
// are the ONLY source of a paid entitlement. Runs in its own Cloud Run service
// so public webhook traffic never shares a scaling pool with authed user
// traffic in services/api.

import { initFirebase } from './firebase.js';
import { buildApp } from './app.js';
import { rootLogger } from './middleware/trace.js';
import requireEnvMod from '@algominutes/ai/require-env.cjs';

const { requireEnv } = requireEnvMod;

// Cloud Run injects PORT (8080 by convention); default for local runs.
const PORT = Number(process.env.PORT) || 8080;

// Boot needs Postgres (subscriptions repo) and the GCP project. The Stripe/Apple/Play secrets and
// product ids are still A11 stubs (services/billing/README) and become required
// when real verification lands (PR-27); validating them here now would block
// boot before that work exists.
requireEnv(
  'billing',
  {
    exact: { WRITE_POSTGRES: 'true' },
    oneOf: [
      { label: 'a Postgres target', of: [['DATABASE_URL'], ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD']] },
      { label: 'a GCP project', of: [['GOOGLE_CLOUD_PROJECT'], ['GCLOUD_PROJECT']] },
    ],
  },
  { logger: rootLogger },
);

// Needed to verify the client's Firebase ID token on the authed endpoints.
initFirebase();

const app = buildApp();

const server = app.listen(PORT, '0.0.0.0', () => {
  rootLogger.info({ port: PORT }, 'billing_listening');
});

// Cloud Run sends SIGTERM before reclaiming an instance; drain in-flight
// requests rather than dropping them (a half-processed webhook would be
// redelivered, but draining avoids the needless retry).
function shutdown(signal) {
  rootLogger.info({ signal }, 'billing_shutting_down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
