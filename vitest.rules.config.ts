import { defineConfig } from 'vitest/config';

// Firestore security rules (infra/firebase/firestore.rules) against the
// Firestore emulator. Needs FIRESTORE_EMULATOR_HOST, which emulators:exec sets:
//   npx firebase-tools --config infra/firebase/firebase.json emulators:exec \
//     --only firestore --project demo-algominutes "npx vitest run -c vitest.rules.config.ts"
// CI: .github/workflows/ci.yml job `firestore-rules` (the emulator needs Java).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rules/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
