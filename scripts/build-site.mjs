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

/**
 * The web build's backends, checked before building it: both origins must be
 * set, and both must be in /app's CSP connect-src in vercel.json, or the app
 * would load and then have every request refused by its own policy.
 */
export function checkAppEnv(env = process.env, vercelJson = path.join(ROOT, 'apps/site/vercel.json')) {
  const config = JSON.parse(fs.readFileSync(vercelJson, 'utf8'));
  const rule = config.headers.find((r) => r.source === '/app(/.*)?');
  const csp = rule?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
  const connect = (/(?:^|;)\s*connect-src ([^;]*)/.exec(csp)?.[1] ?? '').trim().split(/\s+/);
  const problems = [];
  for (const name of ['VITE_API_ORIGIN', 'VITE_BILLING_ORIGIN']) {
    const raw = String(env[name] ?? '').trim();
    if (!raw) {
      problems.push(`${name} is not set`);
      continue;
    }
    let origin;
    try {
      origin = new URL(raw).origin;
    } catch (err) {
      problems.push(`${name} is not a URL: ${raw} (${err.message})`);
      continue;
    }
    if (!connect.includes(origin)) problems.push(`${name} (${origin}) is not in /app's connect-src in apps/site/vercel.json`);
  }
  // Firebase (src/firebase.ts): the app signs in on its own host, through the
  // /__/auth proxy, so the proxy must lead to this build's project.
  for (const name of ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID', 'VITE_FIREBASE_MESSAGING_SENDER_ID']) {
    if (!String(env[name] ?? '').trim()) problems.push(`${name} is not set`);
  }
  // The auth domain is the environment's own site host, where vercel.json proxies /__/auth/* to the
  // project (src/firebase.ts). That rewrite must exist, for that host and that project.
  const project = String(env.VITE_FIREBASE_PROJECT_ID ?? '').trim();
  const authDomain = String(env.VITE_FIREBASE_AUTH_DOMAIN ?? '').trim();
  if (!authDomain) problems.push('VITE_FIREBASE_AUTH_DOMAIN is not set');
  else if (project && authDomain !== `${project}.firebaseapp.com`) {
    const proxied = (config.rewrites || []).some(
      (r) => r.source === '/__/auth/:path*'
        && r.destination === `https://${project}.firebaseapp.com/__/auth/:path*`
        && (r.has || []).some((c) => c.type === 'host' && c.value === authDomain),
    );
    if (!proxied) problems.push(`no /__/auth rewrite in apps/site/vercel.json proxies ${authDomain} to ${project}.firebaseapp.com`);
  }
  return problems;
}

/** Puts the web build at dist/app, replacing the placeholder (both would be served at /app). */
export function compose(siteDist = SITE_DIST, webDist = WEB_DIST) {
  // Both halves of the web build: the app, and its service worker (built second, vite.sw.config.ts).
  for (const f of ['index.html', 'sw.js']) {
    if (!fs.existsSync(path.join(webDist, f))) throw new Error(`build-site: ${webDist}/${f} is missing; the web build failed`);
  }
  const target = path.join(siteDist, 'app');
  if (fs.existsSync(target)) throw new Error(`build-site: ${target} already exists; the site must not have an app/ directory of its own`);
  fs.rmSync(path.join(siteDist, 'app.html'), { force: true });
  fs.cpSync(webDist, target, { recursive: true });
}

const run = (args) => execFileSync('npm', args, { cwd: ROOT, stdio: 'inherit' });

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(['run', 'build', '-w', 'apps/site']);
  if (appEnabled()) {
    const problems = checkAppEnv();
    if (problems.length) {
      for (const p of problems) process.stderr.write(`build-site: ${p}\n`);
      process.exit(1);
    }
    run(['run', 'build', '-w', 'apps/web']);
    compose();
    process.stdout.write('build-site: the web app is at /app\n');
  } else {
    process.stdout.write('build-site: APP_ENABLED is not "true"; /app is the placeholder\n');
  }
}
