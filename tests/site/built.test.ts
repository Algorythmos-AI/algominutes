import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error: a plain .mjs script, no types
import { loadConfig, resolve } from '../../scripts/serve-site.mjs';
import { PUBLIC_PAGES } from '../../apps/site/src/lib/public-pages';
import { APP, DIST } from './shape';

// The built site (apps/site/dist), resolved as Vercel serves it
// (scripts/serve-site.mjs): every page the apps, server and stores link to
// exists, every link on every page resolves, and each page has its metadata.
const SITE = 'https://algominutes.algorythmos.com';
const config = loadConfig();
if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('apps/site/dist is missing: run `npm run build -w apps/site` first');

const htmlFiles = (fs.readdirSync(DIST, { recursive: true }) as string[]).filter((f) => f.endsWith('.html') && !f.startsWith(`app${path.sep}`));
const routeOf = (f: string) => `/${f.replace(/\.html$/, '').replace(/(^|\/)index$/, '')}`;
const pages = htmlFiles.map((f) => ({ file: f, route: routeOf(f), html: fs.readFileSync(path.join(DIST, f), 'utf8') }));
const status = (p: string) => {
  const r = resolve(config, DIST, p);
  return r.redirect ? 308 : r.status;
};

// Everything outside the site that links into it. Checked against the source too (tests/site-facts.test.ts).
const LINKED_FROM_OUTSIDE = [
  '/privacy', '/terms', '/support', // iOS LegalLinks, App Store Connect
  '/delete-account', // Google Play "Data deletion"
  '/s/a-share-token', // api shares.js
  '/billing', '/billing/success', '/billing/cancel', // billing checkout.js, portal.js
  '/app', '/app/notes/123', // the web app's mount
  '/robots.txt', '/sitemap.xml', '/.well-known/security.txt', '/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/og.png',
];

describe('the built site', () => {
  it.each(LINKED_FROM_OUTSIDE)('%s answers 200', (p) => {
    expect(status(p)).toBe(200);
  });

  it('builds exactly the expected pages', () => {
    expect(pages.map((p) => p.route).sort()).toEqual(
      ['/', '/404', ...(APP ? [] : ['/app']), '/billing', '/billing/cancel', '/billing/success', '/delete-account', '/privacy', '/s', '/support', '/terms'].sort(),
    );
  });

  it('ships no JavaScript on the public pages', () => {
    const js = (fs.readdirSync(DIST, { recursive: true }) as string[])
      .filter((f) => !f.startsWith(`app${path.sep}`))
      .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
    expect(js).toEqual([]);
    for (const p of pages) expect(p.html, p.route).not.toMatch(/<script/i);
  });

  it('has no inline styles or style attributes (the CSP allows neither)', () => {
    for (const p of pages) {
      expect(p.html, p.route).not.toMatch(/<style/i);
      expect(p.html, p.route).not.toMatch(/\sstyle=/i);
    }
  });
});

describe.each(pages)('$route', ({ route, html }) => {
  const attr = (re: RegExp) => re.exec(html)?.[1];

  it('has a title, a description and the canonical URL', () => {
    expect(attr(/<title>([^<]+)<\/title>/)).toMatch(/AlgoMinutes/);
    expect((attr(/<meta name="description" content="([^"]+)"/) ?? '').length).toBeGreaterThan(30);
    const canonical = route === '/404' ? undefined : `${SITE}${route}`;
    expect(attr(/<link rel="canonical" href="([^"]+)"/)).toBe(canonical);
    expect(attr(/<html lang="([^"]+)"/)).toBe('en-AU');
  });

  it('is indexable exactly when it is a public page', () => {
    const noindex = /<meta name="robots" content="noindex"/.test(html);
    expect(noindex).toBe(!(PUBLIC_PAGES as readonly string[]).includes(route));
  });

  it('every link and asset on it resolves', () => {
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of refs) {
      if (/^(mailto:|https:\/\/www\.oaic\.gov\.au)/.test(ref)) continue;
      const url = new URL(ref, `${SITE}${route}`);
      expect(url.origin, ref).toBe(SITE);
      expect(status(url.pathname), ref).toBe(200);
      if (url.hash && url.pathname === (route === '/' ? '/' : route)) expect(html, ref).toContain(`id="${url.hash.slice(1)}"`);
    }
  });

  it('has one h1 and the footer\'s company details', () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('Algorythmos Pty Ltd');
    expect(html).toContain('ABN 22 701 006 626');
  });
});

describe('robots.txt, sitemap.xml, security.txt', () => {
  const read = (f: string) => fs.readFileSync(path.join(DIST, f), 'utf8');

  it('the sitemap lists exactly the public pages', () => {
    const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(PUBLIC_PAGES.map((p) => `${SITE}${p}`));
  });

  it('robots.txt disallows nothing (so crawlers see the noindex), and points at the sitemap', () => {
    const robots = read('robots.txt');
    expect(robots).not.toMatch(/^Disallow:/m);
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
  });

  it('security.txt is RFC 9116: a contact, and an expiry under a year away', () => {
    const txt = read('.well-known/security.txt');
    expect(txt).toMatch(/^Contact: mailto:privacy@algorythmos\.com$/m);
    const expires = new Date(/^Expires: (.+)$/m.exec(txt)![1]);
    const days = (expires.getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(30);
    expect(days).toBeLessThan(365);
    expect(txt.split('\n')).toContain(`Canonical: ${SITE}/.well-known/security.txt`);
  });

  it('the privacy page lists every processor in processing.json', async () => {
    const processing = (await import('../../apps/site/src/data/processing.json')).default;
    const html = read('privacy.html');
    for (const p of processing.processors) expect(html, p.id).toContain(`id="processor-${p.id}"`);
  });
});

describe.runIf(APP)('the web app at /app (staging shape)', () => {
  const html = APP ? fs.readFileSync(path.join(DIST, 'app/index.html'), 'utf8') : '';

  it('replaces the placeholder: /app and every deep link serve the app', () => {
    expect(fs.existsSync(path.join(DIST, 'app.html'))).toBe(false);
    for (const p of ['/app', '/app/search', '/app/notes/123']) {
      const r = resolve(config, DIST, p);
      expect(r.file, p).toBe(path.join(DIST, 'app/index.html'));
    }
  });

  it('is kept out of search, and loads only its own files under /app/', () => {
    expect(html).toMatch(/<meta name="robots" content="noindex"/);
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(2);
    for (const ref of refs) {
      expect(ref, ref).toMatch(/^\/app\//);
      expect(status(ref), ref).toBe(200);
    }
    expect(html).not.toMatch(/<style|\sstyle=|<script(?![^>]*\ssrc=)/i);
  });
});
