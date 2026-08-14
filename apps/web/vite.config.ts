import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync } from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';

// Bundle tesseract.js worker + core wasm into dist/tesseract so they are
// served from the same origin as the app under capacitor://localhost.
// Avoids WKWebView CSP / cross-origin worker failures.
function copyTesseractAssets(): Plugin {
  const files = [
    ['node_modules/tesseract.js/dist/worker.min.js', 'worker.min.js'],
    ['node_modules/tesseract.js-core/tesseract-core.wasm.js', 'tesseract-core.wasm.js'],
    ['node_modules/tesseract.js-core/tesseract-core.wasm', 'tesseract-core.wasm'],
    ['node_modules/tesseract.js-core/tesseract-core-simd.wasm.js', 'tesseract-core-simd.wasm.js'],
    ['node_modules/tesseract.js-core/tesseract-core-simd.wasm', 'tesseract-core-simd.wasm'],
    ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
    ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm', 'tesseract-core-lstm.wasm'],
    ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
    ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', 'tesseract-core-simd-lstm.wasm'],
  ] as const;
  return {
    name: 'copy-tesseract-assets',
    apply: 'build',
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist/tesseract');
      mkdirSync(outDir, { recursive: true });
      for (const [src, name] of files) {
        copyFileSync(path.resolve(__dirname, src), path.resolve(outDir, name));
      }
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      copyTesseractAssets(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
