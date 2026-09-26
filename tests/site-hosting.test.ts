import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs script, no types
import { loadConfig, headersFor, resolve, sourceRegex } from '../scripts/serve-site.mjs';

// apps/site/vercel.json: the security headers each path gets, and how paths
// resolve (cleanUrls, the /s and /app rewrites, the 404 page). Read through
// scripts/serve-site.mjs, the same emulation the site's browser tests run on,
// so what's asserted here is what those tests exercised.
const config = loadConfig();
const csp = (p: string) => headersFor(config, p)['Content-Security-Policy'] as string;

describe('security headers', () => {
  it.each(['/', '/privacy', '/terms', '/support', '/delete-account', '/s/abc', '/app', '/billing/success', '/nope'])(
    '%s gets the full set',
    (p) => {
      const h = headersFor(config, p);
      expect(Number(/max-age=(\d+)/.exec(h['Strict-Transport-Security'])![1])).toBeGreaterThanOrEqual(31536000);
      expect(h['X-Content-Type-Options']).toBe('nosniff');
      expect(h['X-Frame-Options']).toBe('DENY');
      expect(h['Referrer-Policy']).toMatch(/^(strict-origin-when-cross-origin|no-referrer)$/);
      expect(h['Permissions-Policy']).toMatch(/camera=\(\)/);
      expect(h['Permissions-Policy']).toMatch(/microphone=\(\)/);
      expect(h['Permissions-Policy']).toMatch(/geolocation=\(\)/);
    },
  );

  it('the CSP is strict: self only, no inline or eval, no framing', () => {
    const policy = csp('/privacy');
    const directives = Object.fromEntries(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['style-src']).toEqual(["'self'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'self'"]);
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('every path gets exactly one CSP and one Permissions-Policy: the strict one, or the app\'s under /app', () => {
    const setters = (p: string, key: string) =>
      config.headers.filter((r: { source: string; headers: { key: string }[] }) => sourceRegex(r.source).test(p) && r.headers.some((h) => h.key === key));
    for (const p of ['/', '/privacy', '/application', '/apps', '/s/abc', '/billing', '/app', '/app/', '/app/notes/1', '/app/assets/x.js']) {
      expect(setters(p, 'Content-Security-Policy'), p).toHaveLength(1);
      expect(setters(p, 'Permissions-Policy'), p).toHaveLength(1);
    }
    for (const p of ['/application', '/apps', '/privacy']) expect(csp(p), p).toBe(csp('/'));
    for (const p of ['/app', '/app/notes/1']) expect(csp(p), p).not.toBe(csp('/'));
  });

  it("the app's CSP: its own script and Firebase Auth's loader only, no inline or eval, no framing", () => {
    const policy = csp('/app/notes/1');
    const directives = Object.fromEntries(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    expect(directives['script-src']).toEqual(["'self'", 'https://apis.google.com']);
    expect(directives['style-src']).toEqual(["'self'"]);
    expect(directives['object-src']).toEqual(["'none'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
    expect(directives['base-uri']).toEqual(["'self'"]);
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });

  it('share links are never indexed, cached, or leaked in a Referer', () => {
    for (const p of ['/s', '/s/abc', '/s/a/b']) {
      const h = headersFor(config, p);
      expect(h['X-Robots-Tag'], p).toBe('noindex, nofollow');
      expect(h['Cache-Control'], p).toBe('no-store');
      expect(h['Referrer-Policy'], p).toBe('no-referrer');
    }
  });

  it('the app and billing pages are kept out of search; the public pages are not', () => {
    for (const p of ['/app', '/app/notes/1', '/billing', '/billing/success', '/billing/cancel']) {
      expect(headersFor(config, p)['X-Robots-Tag'], p).toBe('noindex, nofollow');
    }
    for (const p of ['/', '/privacy', '/terms', '/support', '/delete-account', '/sitemap.xml', '/robots.txt', '/.well-known/security.txt', '/apple-touch-icon.png']) {
      expect(headersFor(config, p)['X-Robots-Tag'], p).toBeUndefined();
    }
  });

  it('hashed assets are cached for a year; pages are not', () => {
    expect(headersFor(config, '/_astro/Base.abc.css')['Cache-Control']).toMatch(/max-age=31536000, immutable/);
    expect(headersFor(config, '/app/assets/index-abc.js')['Cache-Control']).toMatch(/max-age=31536000, immutable/);
    expect(headersFor(config, '/app')['Cache-Control']).toBeUndefined();
    expect(headersFor(config, '/privacy')['Cache-Control']).toBeUndefined();
  });
});

describe('path resolution (cleanUrls, rewrites, 404)', () => {
  let dist: string;
  beforeAll(() => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), 'site-dist-'));
    for (const f of ['index.html', 'privacy.html', 's.html', 'app.html', '404.html', 'billing.html', 'billing/success.html', 'robots.txt']) {
      fs.mkdirSync(path.dirname(path.join(dist, f)), { recursive: true });
      fs.writeFileSync(path.join(dist, f), f);
    }
  });
  afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));
  const served = (p: string) => {
    const r = resolve(config, dist, p);
    return r.redirect ? `→ ${r.redirect}` : `${r.status} ${path.relative(dist, r.file)}`;
  };

  it('serves pages without .html, and redirects the .html and trailing-slash forms', () => {
    expect(served('/')).toBe('200 index.html');
    expect(served('/privacy')).toBe('200 privacy.html');
    expect(served('/billing/success')).toBe('200 billing/success.html');
    expect(served('/robots.txt')).toBe('200 robots.txt');
    expect(served('/privacy.html')).toBe('→ /privacy');
    expect(served('/index.html')).toBe('→ /');
    expect(served('/privacy/')).toBe('→ /privacy');
    expect(served('/index')).toBe('→ /');
    expect(served('/billing/success.html')).toBe('→ /billing/success');
  });

  it('a rewrite to a .html path is refused: with cleanUrls, Vercel serves s.html only at /s', () => {
    const broken = { ...config, rewrites: [{ source: '/s/:token*', destination: '/s.html' }] };
    expect(() => resolve(broken, dist, '/s/tok')).toThrow(/use \/s$/);
    const missing = { ...config, rewrites: [{ source: '/s/:token*', destination: '/share' }] };
    expect(() => resolve(missing, dist, '/s/tok')).toThrow(/doesn't serve/);
  });

  it('every share link and every /app path reaches its placeholder', () => {
    expect(served('/s/tok_123')).toBe('200 s.html');
    expect(served('/s/a/b')).toBe('200 s.html');
    expect(served('/app/notes/1')).toBe('200 app.html');
    expect(served('/app')).toBe('200 app.html');
  });

  it("a missing hashed asset is a 404, never the app's HTML (which the year-long asset cache would then keep)", () => {
    expect(served('/app/assets/index-oldhash.js')).toBe('404 404.html');
    expect(served('/app/assetsx')).toBe('200 app.html');
  });

  it('anything else is the 404 page, with a 404', () => {
    expect(served('/nope')).toBe('404 404.html');
    expect(served('/billing/other')).toBe('404 404.html');
    expect(served('/../package.json')).toBe('404 404.html');
  });

  it('reads the source patterns vercel.json uses', () => {
    expect(sourceRegex('/s/:token*').test('/s/abc/def')).toBe(true);
    expect(sourceRegex('/s(/.*)?').test('/sitemap.xml')).toBe(false);
    expect(sourceRegex('/(app|billing)(/.*)?').test('/application')).toBe(false);
  });
});

// monitoring.tf watches the public site from exactly one environment (one site,
// so two would alert twice), and staging's api admits the staging web app.
describe('the site in Terraform', () => {
  const env = (e: string) => fs.readFileSync(`infra/terraform/envs/${e}/main.tf`, 'utf8').replace(/#.*$/gm, '');
  const host = (e: string) => /^\s*site_uptime_host\s*=\s*"([^"]*)"/m.exec(env(e))?.[1] ?? '';

  it('exactly one environment runs the site uptime checks, on the public host', () => {
    const watching = ['staging', 'prod'].filter((e) => host(e) !== '');
    expect(watching).toHaveLength(1);
    expect(host(watching[0])).toBe('algominutes.algorythmos.com');
    expect(fs.readFileSync('infra/terraform/modules/environment/variables.tf', 'utf8')).toMatch(/variable "site_uptime_host"\s*\{[^}]*default\s*=\s*""/);
  });

  it("staging's api allows the site and the staging web app; prod's allows only the site", () => {
    const origins = (e: string) => /^\s*allowed_origins\s*=\s*"([^"]+)"/m.exec(env(e))![1].split(',');
    expect(origins('staging')).toEqual(['https://algominutes.algorythmos.com', 'https://staging.algominutes.algorythmos.com']);
    expect(origins('prod')).toEqual(['https://algominutes.algorythmos.com']);
  });
});

// Firebase sign-in on the site's own origin (plan W3): /__/auth and /__/firebase
// are proxied to the environment's firebaseapp.com, by host, and keep
// Firebase's own headers: our CSP, X-Frame-Options and COOP would break the
// auth handler page and the iframe the app frames it in.
describe('the Firebase auth proxy', () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'site-auth-'));
  fs.writeFileSync(path.join(dist, '404.html'), '404');
  const STAGING = 'staging.algominutes.algorythmos.com';

  it("proxies staging's /__/auth and /__/firebase to algominutes-staging.firebaseapp.com", () => {
    expect(resolve(config, dist, '/__/auth/handler', undefined, STAGING)).toEqual({ external: 'https://algominutes-staging.firebaseapp.com/__/auth/handler' });
    expect(resolve(config, dist, '/__/auth/iframe', undefined, `${STAGING}:443`)).toEqual({ external: 'https://algominutes-staging.firebaseapp.com/__/auth/iframe' });
    expect(resolve(config, dist, '/__/firebase/init.json', undefined, STAGING)).toEqual({ external: 'https://algominutes-staging.firebaseapp.com/__/firebase/init.json' });
  });

  it('proxies nothing on the public host (the app is off there until the prod launch)', () => {
    expect(resolve(config, dist, '/__/auth/handler', undefined, 'algominutes.algorythmos.com').status).toBe(404);
  });

  it("adds none of the site's framing, CSP or COOP headers to Firebase's pages", () => {
    for (const p of ['/__/auth/handler', '/__/auth/iframe', '/__/firebase/init.json']) {
      const h = headersFor(config, p);
      for (const key of ['Content-Security-Policy', 'X-Frame-Options', 'Cross-Origin-Opener-Policy', 'Permissions-Policy']) expect(h[key], `${p} ${key}`).toBeUndefined();
    }
  });

  it('the app lets its sign-in popups talk back; the public pages stay same-origin', () => {
    expect(headersFor(config, '/app')['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
    expect(headersFor(config, '/app/notes/1')['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
    expect(headersFor(config, '/privacy')['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headersFor(config, '/privacy')['X-Frame-Options']).toBe('DENY');
  });

  it("the app's CSP allows Firebase Auth's script and endpoints, and frames only itself", () => {
    const policy = csp('/app');
    expect(policy).toMatch(/script-src 'self' https:\/\/apis\.google\.com;/);
    expect(policy).toMatch(/connect-src [^;]*https:\/\/identitytoolkit\.googleapis\.com/);
    expect(policy).toMatch(/connect-src [^;]*https:\/\/securetoken\.googleapis\.com/);
    expect(policy).toMatch(/frame-src 'self';/);
  });
});
