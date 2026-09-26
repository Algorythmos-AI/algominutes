#!/usr/bin/env node
// The web app's first download: the JavaScript apps/web/dist/index.html loads
// before anything renders (its module script and every modulepreload), gzipped,
// must stay within the plan's budget (250 KB). Chunks loaded later (Firestore
// after sign-in, say) don't count.
//
//   node scripts/check-web-bundle.mjs [dist] [budgetKB]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const BUDGET_KB = 250;

/** The initial scripts named in index.html, as paths under `dist` (the /app/ base stripped). */
export function initialScripts(html, base = '/app/') {
  const refs = [
    ...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
  ].map((m) => m[1]);
  return [...new Set(refs)].map((r) => (r.startsWith(base) ? r.slice(base.length) : r.replace(/^\//, '')));
}

export function initialGzipKB(dist) {
  const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const files = initialScripts(html);
  if (!files.length) throw new Error('check-web-bundle: index.html names no module script');
  const bytes = files.reduce((sum, f) => sum + zlib.gzipSync(fs.readFileSync(path.join(dist, f)), { level: 9 }).length, 0);
  return { files, kb: bytes / 1024 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dist = process.argv[2] || 'apps/web/dist';
  const budget = Number(process.argv[3] || BUDGET_KB);
  const { files, kb } = initialGzipKB(dist);
  process.stdout.write(`web first download: ${kb.toFixed(1)} KB gzipped (${files.length} file(s)), budget ${budget} KB\n`);
  if (kb > budget) {
    process.stderr.write('check-web-bundle: over budget. Load what the first screen doesn\'t need with import(), or cut a dependency.\n');
    process.exit(1);
  }
}
