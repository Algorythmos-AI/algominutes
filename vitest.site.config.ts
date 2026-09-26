import { defineConfig } from 'vitest/config';

// The public site's built output (apps/site/dist): links, page metadata, and a
// real browser against scripts/serve-site.mjs (vercel.json's headers and CSP).
// Needs `npm run build -w apps/site` first, and Playwright's Chromium. CI job: site-build.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/site/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
