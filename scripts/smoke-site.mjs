#!/usr/bin/env node
// Checks a deployed public site against what apps/site/vercel.json promises:
// every page the apps and stores link to answers, with exactly the headers
// vercel.json gives that path (read through scripts/serve-site.mjs, the same
// rules the site's CI tests ran on), plus the redirects, the 404, and a
// security.txt that isn't about to expire.
//
//   node scripts/smoke-site.mjs https://algominutes.algorythmos.com
//
// A deployment behind Vercel Authentication (staging) needs its automation
// bypass secret in VERCEL_AUTOMATION_BYPASS_SECRET. Exits 1 on any failure.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, headersFor } from './serve-site.mjs';

// Each checked path, and a string its body must contain.
export const PAGES = [
  ['/', 'Every meeting, summed up'],
  ['/privacy', 'Privacy Policy'],
  ['/terms', 'Terms of Service'],
  ['/support', 'Support'],
  ['/delete-account', 'Delete your AlgoMinutes account'],
  ['/s/smoke-test-token', 'Shared note'],
  ['/billing', 'Billing'],
  ['/billing/success', 'Thanks for subscribing'],
  ['/billing/cancel', 'Checkout cancelled'],
  ['/app', 'AlgoMinutes on the web'],
  ['/robots.txt', 'Sitemap:'],
  ['/sitemap.xml', '<urlset'],
  ['/.well-known/security.txt', 'Contact: mailto:'],
];

/** Runs every check against `base`; returns the list of failures (empty when all pass). */
export async function smoke(base, { fetchImpl = fetch, bypass = '', config = loadConfig(), now = new Date() } = {}) {
  const origin = base.replace(/\/+$/, '');
  const failures = [];
  const headers = bypass ? { 'x-vercel-protection-bypass': bypass } : {};
  const get = (p) => fetchImpl(`${origin}${p}`, { headers, redirect: 'manual' });
  const expectHeaders = (p, res) => {
    for (const [key, want] of Object.entries(headersFor(config, p))) {
      const got = res.headers.get(key);
      if (got !== want) failures.push(`${p}: ${key} is ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };

  for (const [p, content] of PAGES) {
    let res;
    try {
      res = await get(p);
    } catch (err) {
      failures.push(`${p}: request failed (${err.message})`);
      continue;
    }
    if (res.status !== 200) {
      failures.push(`${p}: status ${res.status}, want 200`);
      continue;
    }
    const body = await res.text();
    if (!body.includes(content)) failures.push(`${p}: body lacks ${JSON.stringify(content)}`);
    if (/(?:src|href)="http:\/\//.test(body)) failures.push(`${p}: links an http:// resource (mixed content)`);
    expectHeaders(p, res);
    if (p === '/.well-known/security.txt') {
      const expires = /^Expires: (.+)$/m.exec(body);
      const days = expires ? (new Date(expires[1]).getTime() - now.getTime()) / 86400000 : NaN;
      if (!(days > 30)) failures.push(`${p}: Expires is ${expires ? expires[1] : 'missing'}; deploy the site to renew it`);
    }
  }

  const missing = await get('/smoke-no-such-page');
  if (missing.status !== 404) failures.push(`/smoke-no-such-page: status ${missing.status}, want 404`);
  else if (!(await missing.text()).includes('Page not found')) failures.push('/smoke-no-such-page: not the site\'s 404 page');

  const html = await get('/privacy.html');
  if (![301, 308].includes(html.status) || !/\/privacy$/.test(html.headers.get('location') || '')) {
    failures.push(`/privacy.html: status ${html.status} to ${html.headers.get('location')}, want a redirect to /privacy`);
  }

  if (origin.startsWith('https://')) {
    try {
      const plain = await fetchImpl(`${origin.replace('https://', 'http://')}/privacy`, { headers, redirect: 'manual' });
      if (![301, 307, 308].includes(plain.status) || !(plain.headers.get('location') || '').startsWith('https://')) {
        failures.push(`http:// /privacy: status ${plain.status}, want a redirect to https://`);
      }
    } catch (err) {
      failures.push(`http:// /privacy: request failed (${err.message})`);
    }
  }
  return failures;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const base = process.argv[2];
  if (!base) {
    process.stderr.write('usage: node scripts/smoke-site.mjs <origin>\n');
    process.exit(2);
  }
  const failures = await smoke(base, { bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '' });
  for (const f of failures) process.stderr.write(`FAIL ${f}\n`);
  process.stdout.write(failures.length ? `${failures.length} check(s) failed on ${base}\n` : `site smoke passed on ${base}\n`);
  process.exit(failures.length ? 1 : 0);
}
