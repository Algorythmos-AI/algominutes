#!/usr/bin/env node
// The web app end to end, in a real browser, against a deployed site (plan "site
// and web app", Phase 2's quality bar). One guest's life, as a person would live it:
//   1. /app opens signed out; "Try it as a guest" gets an empty notes list;
//   2. a recording is imported (tests/fixtures/e2e-speech.ogg, ten seconds of
//      synthetic speech) and becomes a note with a summary;
//   3. search finds a moment in it, and a question about it gets an answer;
//   4. a recording made in the browser (a fake microphone playing the same
//      speech) becomes a note with a summary;
//   5. the account is deleted from Settings, back to the sign-in page.
// The deletion runs whatever failed before it, so no test user is left behind.
// Any console error or page error (a CSP refusal is one) fails the run.
//
// Env:
//   SITE_URL       the site (default https://staging.algominutes.algorythmos.com)
//   VERCEL_BYPASS  the Vercel project's "Protection Bypass for Automation" secret:
//                  staging is behind Vercel Authentication. It's sent only to the
//                  site's own origin, never to Google or the api.
//   E2E_READY_MS   how long a note may take to be ready (default 8 minutes)
// Needs Playwright's Chromium and ffmpeg (the fake microphone plays a WAV).
// Exit 1 on any failure.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FIXTURE = path.resolve(import.meta.dirname, '../tests/fixtures/e2e-speech.ogg');
const DEFAULT_SITE = 'https://staging.algominutes.algorythmos.com';

export function e2eConfig(env = process.env) {
  const siteUrl = (env.SITE_URL || DEFAULT_SITE).trim().replace(/\/+$/, '');
  const url = new URL(siteUrl);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !local) throw new Error(`e2e-web: SITE_URL must be https (got ${url.protocol})`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('e2e-web: SITE_URL is an origin, with no path');
  const readyMs = Number(env.E2E_READY_MS);
  return { siteUrl: url.origin, bypass: (env.VERCEL_BYPASS || '').trim(), readyMs: Number.isFinite(readyMs) && readyMs > 0 ? readyMs : 8 * 60_000 };
}

/** Whether a request goes to the site itself: only those carry the bypass secret. */
export function isSiteRequest(requestUrl, siteUrl) {
  try {
    return new URL(requestUrl).origin === new URL(siteUrl).origin;
  } catch {
    // silent-catch-ok: a URL that doesn't parse (data:, blob:) isn't the site
    return false;
  }
}

/** The headers that let automation through Vercel Authentication (and set its cookie for the rest of the run). */
export const bypassHeaders = (bypass) => (bypass ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' } : {});

/** The fixture as a WAV, for Chromium's fake microphone. */
export function fixtureWav(fixture = FIXTURE, run = execFileSync) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-web-')), 'speech.wav');
  run('ffmpeg', ['-loglevel', 'error', '-y', '-i', fixture, '-ac', '1', '-ar', '48000', out]);
  return out;
}

const within = (p) => p.then(
  () => true,
  () => false,
);

export async function runWebE2E({ siteUrl, bypass, readyMs, chromium, micWav, fixture = FIXTURE, recordMs = 12_000, actionMs = 30_000, write = (s) => process.stdout.write(s) }) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok) });
    write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
    return Boolean(ok);
  };
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(micWav ? [`--use-file-for-fake-audio-capture=${micWav}`] : [])],
  });
  const context = await browser.newContext();
  await context.grantPermissions(['microphone'], { origin: siteUrl });
  if (bypass) {
    await context.route(
      (url) => isSiteRequest(url.href, siteUrl),
      (route) => route.continue({ headers: { ...route.request().headers(), ...bypassHeaders(bypass) } }),
    );
  }
  // The push card would sit over the page's buttons; it's tested in apps/web.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('algominutes.pushPrompt.dismissed', '1');
    } catch {
      // silent-catch-ok: storage blocked; the card may show, and the run carries on
    }
  });
  const page = await context.newPage();
  // Every click and fill waits at most this long for its element.
  page.setDefaultTimeout(actionMs);
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  const heading = (name, timeout = 30_000) => within(page.getByRole('heading', { name, exact: true }).first().waitFor({ timeout }));
  const toNote = () => within(page.waitForURL(/\/app\/notes\/[^/?#]+/, { timeout: 180_000 }));

  let guest = false;
  const journey = async () => {
    const res = await page.goto(`${siteUrl}/app`);
    if (!check('/app opens, signed out', res?.status() === 200 && (await heading('Sign in to AlgoMinutes')), `HTTP ${res?.status()}`)) return;
    await page.getByRole('button', { name: 'Try it as a guest' }).click();
    guest = check('a guest gets their notes', await heading('Your notes'));
    if (!guest) return;

    await page.getByRole('link', { name: 'Import a recording' }).first().click();
    await page.getByLabel('Audio file').setInputFiles(fixture);
    const imported = (await toNote()) && (await heading('Summary', readyMs));
    check('an imported recording becomes a note with a summary', imported, page.url().replace(siteUrl, ''));

    await page.goto(`${siteUrl}/app/search`);
    await page.getByLabel('Search your notes').fill('budget');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    check('search finds a moment in it', await within(page.locator('main a[href*="/app/notes/"]').first().waitFor({ timeout: 60_000 })));
    await page.getByRole('tab', { name: 'Ask your notes' }).click();
    await page.getByLabel('Ask a question about your notes').fill('When is the website launch?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    check('a question about it gets an answer', await within(page.getByText('Answer ready.').waitFor({ state: 'attached', timeout: 120_000 })));

    await page.goto(`${siteUrl}/app/record`);
    await page.getByRole('checkbox', { name: /I have permission/ }).check();
    await page.getByRole('button', { name: 'Start recording' }).click();
    if (check('the browser records', await within(page.getByText('● RECORDING').waitFor({ timeout: 30_000 })))) {
      await page.waitForTimeout(recordMs);
      await page.getByRole('button', { name: 'Stop and save' }).click();
      check('a browser recording becomes a note with a summary', (await toNote()) && (await heading('Summary', readyMs)), page.url().replace(siteUrl, ''));
    }
  };
  try {
    await journey().catch((err) => check('the journey ran to the end', false, err?.message?.slice(0, 200)));
  } finally {
    if (guest) {
      const deleted = await (async () => {
        await page.goto(`${siteUrl}/app/settings`);
        await page.getByRole('button', { name: 'Delete my account' }).click();
        await page.getByLabel(/Type DELETE to confirm/).fill('DELETE');
        await page.getByRole('button', { name: 'Delete account', exact: true }).click();
        return heading('Sign in to AlgoMinutes', 60_000);
      })().catch((err) => {
        write(`     deletion: ${err?.message?.slice(0, 200)}\n`);
        return false;
      });
      check('the account is deleted from Settings', deleted);
    }
    check('no console or page errors (a CSP refusal is one)', problems.length === 0, problems.slice(0, 3).join(' | '));
    await browser.close();
  }
  // After the deletion and the console check, which count too.
  return results.every((r) => r.ok);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = e2eConfig();
  const { chromium } = await import('playwright');
  const ok = await runWebE2E({ ...config, chromium, micWav: fixtureWav() });
  process.exit(ok ? 0 : 1);
}
