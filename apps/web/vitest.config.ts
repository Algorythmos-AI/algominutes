import { defineConfig } from 'vitest/config';

// apps/web's own tests: components and the api client, in jsdom.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
