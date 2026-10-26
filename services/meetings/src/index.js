// services/meetings entrypoint (docs/plans/MEETINGS.md).
import { buildApp } from './app.js';
import { createSecretReader } from './lib/secrets.js';
import { createRecallClient } from './lib/recall-client.js';
import { firestore } from './firebase.js';
import meetingUrlCryptoModule from '@algominutes/ai/meeting-url-crypto.cjs';
import { rootLogger } from './middleware/trace.js';
import requireEnvMod from '@algominutes/ai/require-env.cjs';
import envSpec from './env-spec.cjs';

const { requireEnv } = requireEnvMod;
const PORT = Number(process.env.PORT) || 8080;

// Recall's secrets are read at run time (lib/secrets.js), not required here: a
// deploy must not depend on the owner having added them yet.
requireEnv('meetings', envSpec, { logger: rootLogger });

const { createMeetingUrlCrypto } = meetingUrlCryptoModule;
const readSecret = createSecretReader({ projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT });
let crypto;
const app = buildApp({
  readSecret,
  taskDeps: {
    // Read on use: the owner may add the key after this deploy.
    getRecall: async (log) => {
      const apiKey = await readSecret('recall-api-key', { log });
      if (!apiKey) throw Object.assign(new Error('recall-api-key is not set'), { status: 503 });
      return createRecallClient({ apiKey, region: process.env.RECALL_REGION || 'ap-northeast-1' });
    },
    getCrypto: () => (crypto ??= createMeetingUrlCrypto({ keyName: process.env.MEETING_URL_KMS_KEY })),
    getFirestore: firestore,
  },
});
const server = app.listen(PORT, '0.0.0.0', () => rootLogger.info({ port: PORT }, 'meetings_listening'));

function shutdown(signal) {
  rootLogger.info({ signal }, 'meetings_shutting_down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
