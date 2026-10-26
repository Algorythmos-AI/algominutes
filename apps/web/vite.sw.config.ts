import path from 'node:path';
import { defineConfig } from 'vite';

// The service worker (src/sw.ts), built on its own into dist/sw.js as one
// classic script: served at /app/sw.js, scope /app/. Runs after the app's
// build (package.json "build"), so it mustn't empty dist.
export default defineConfig({
  base: '/app/',
  build: {
    emptyOutDir: false,
    outDir: 'dist',
    lib: { entry: path.resolve(import.meta.dirname, 'src/sw.ts'), formats: ['iife'], name: 'algominutesSw', fileName: () => 'sw.js' },
  },
});
