import { defineConfig } from 'vitest/config';

// The build-time constants (build.mjs), as a staging build would set them.
export default defineConfig({
  define: {
    __EXT_API_ORIGIN__: JSON.stringify('https://api.example.test'),
    __EXT_WEB_ORIGINS__: JSON.stringify(['https://beta.example.test']),
    __EXT_FIREBASE_API_KEY__: JSON.stringify('test-firebase-web-key'),
    __EXT_VERSION__: JSON.stringify('1.0.0'),
  },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'build.test.ts'] },
});
