#!/usr/bin/env node
// Builds what Vercel serves at algominutes.algorythmos.com (vercel.json's buildCommand):
//
//   1. the public site (apps/site → apps/site/dist);
//   2. when APP_ENABLED=true, the web app (apps/web, Vite base /app/), copied
//      into apps/site/dist/app in place of the "coming soon" placeholder.
//
// APP_ENABLED is set on Vercel's Preview environment (staging) and, from the
// prod launch (plan Phase 3), on Production. Anything else leaves the
// placeholder, so the app can't reach the public by accident.
//
//   APP_ENABLED=true node scripts/build-site.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_DIST = path.join(ROOT, 'apps/site/dist');
const WEB_DIST = path.join(ROOT, 'apps/web/dist');

/** APP_ENABLED as Vercel passes it: only the exact string "true" turns the app on. */
export function appEnabled(env = process.env) {
  return String(env.APP_ENABLED ?? '').trim() === 'true';
}

/** Puts the web build at dist/app, replacing the placeholder (both would be served at /app). */
export function compose(siteDist = SITE_DIST, webDist = WEB_DIST) {
  if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error(`build-site: ${webDist}/index.html is missing; the web build failed`);
  const target = path.join(siteDist, 'app');
  if (fs.existsSync(target)) throw new Error(`build-site: ${target} already exists; the site must not have an app/ directory of its own`);
  fs.rmSync(path.join(siteDist, 'app.html'), { force: true });
  fs.cpSync(webDist, target, { recursive: true });
}

const run = (args) => execFileSync('npm', args, { cwd: ROOT, stdio: 'inherit' });

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(['run', 'build', '-w', 'apps/site']);
  if (appEnabled()) {
    run(['run', 'build', '-w', 'apps/web']);
    compose();
    process.stdout.write('build-site: the web app is at /app\n');
  } else {
    process.stdout.write('build-site: APP_ENABLED is not "true"; /app is the placeholder\n');
  }
}
