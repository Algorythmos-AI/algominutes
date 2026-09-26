import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs script, no types
import { initialScripts, initialGzipKB } from '../scripts/check-web-bundle.mjs';

// The web app's first-download budget counts what index.html loads up front,
// and nothing loaded later.
describe('check-web-bundle', () => {
  it('counts the module script and the modulepreloads, under the /app/ base', () => {
    const html = '<script type="module" crossorigin src="/app/assets/index-a.js"></script><link rel="modulepreload" crossorigin href="/app/assets/vendor-b.js"><link rel="stylesheet" href="/app/assets/x.css">';
    expect(initialScripts(html)).toEqual(['assets/index-a.js', 'assets/vendor-b.js']);
  });

  it('measures their gzipped size, leaving lazy chunks out', () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'web-dist-'));
    fs.mkdirSync(path.join(dist, 'assets'));
    fs.writeFileSync(path.join(dist, 'index.html'), '<script type="module" src="/app/assets/index-a.js"></script>');
    fs.writeFileSync(path.join(dist, 'assets/index-a.js'), 'x'.repeat(100_000));
    fs.writeFileSync(path.join(dist, 'assets/lazy.js'), Buffer.alloc(900_000, 7));
    const { files, kb } = initialGzipKB(dist);
    expect(files).toEqual(['assets/index-a.js']);
    expect(kb).toBeLessThan(5);
    fs.rmSync(dist, { recursive: true, force: true });
  });
});
