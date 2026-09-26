import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
// @ts-expect-error: a plain .mjs script, no types
import { createServer } from '../../scripts/serve-site.mjs';
import { APP } from './shape';

// Every page in a real browser, served with vercel.json's headers
// (scripts/serve-site.mjs): nothing the CSP refuses, no console errors, it
// reads with JavaScript off, and nothing scrolls sideways on a phone.
const PAGES = ['/', '/privacy', '/terms', '/support', '/delete-account', '/s/tok', '/billing', '/billing/success', '/billing/cancel', '/app', '/nope'];

let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

describe.each(PAGES)('%s', (route) => {
  it('loads with no console errors and nothing refused by the CSP', async () => {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (m) => {
      // The 404 page's own status is logged as a failed load; nothing else may be.
      if (route === '/nope' && m.location().url === `${origin}${route}` && /status of 404/.test(m.text())) return;
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    const failed: string[] = [];
    page.on('response', (r) => { if (r.status() >= 400 && r.url() !== `${origin}${route}`) failed.push(`${r.status()} ${r.url()}`); });
    const res = await page.goto(`${origin}${route}`, { waitUntil: 'load' });
    expect(res!.status()).toBe(route === '/nope' ? 404 : 200);
    expect(res!.headers()['content-security-policy']).toMatch(/default-src 'self'/);
    // The stylesheets applied (a CSP refusal would leave the default white page).
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(problems).toEqual([]);
    expect(failed).toEqual([]);
    await page.close();
  });

  it('reads with JavaScript off', async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${origin}${route}`);
    if (APP && route === '/app') {
      // The app needs JavaScript, and says so.
      expect(await page.locator('body').textContent()).toMatch(/needs JavaScript/);
      await context.close();
      return;
    }
    expect(await page.locator('h1').first().isVisible()).toBe(true);
    expect((await page.locator('h1').first().textContent())!.length).toBeGreaterThan(3);
    await context.close();
  });

  it('fits a 320px phone without sideways scrolling, in both colour schemes', async () => {
    for (const colorScheme of ['dark', 'light'] as const) {
      const context = await browser.newContext({ viewport: { width: 320, height: 640 }, colorScheme });
      const page = await context.newPage();
      await page.goto(`${origin}${route}`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, colorScheme).toBeLessThanOrEqual(0);
      await context.close();
    }
  });
});

describe.runIf(APP)('the web app in the browser (staging shape)', () => {
  // Signed out, every page of the app leads to sign-in (the signed-in pages are tested in apps/web).
  it.each([
    ['/app', 'Sign in to AlgoMinutes'],
    ['/app/search', 'Sign in to AlgoMinutes'],
    ['/app/settings', 'Sign in to AlgoMinutes'],
    ['/app/no-such-page', 'Sign in to AlgoMinutes'],
  ])('%s renders %s, straight from the address bar, with nothing refused by the CSP', async (route, heading) => {
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    const res = await page.goto(`${origin}${route}`);
    expect(res!.status()).toBe(200);
    await expect.poll(() => page.locator('h1').first().textContent()).toBe(heading);
    expect(problems).toEqual([]);
    await page.close();
  });
});
