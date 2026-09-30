#!/usr/bin/env node
// The web app end to end, in a real browser, against a deployed site (plan "site
// and web app", Phase 2's quality bar). One guest's life, as a person would live it:
//   1. /app opens signed out; "Try it as a guest" gets an empty notes list;
//   2. a recording is imported (tests/fixtures/e2e-speech.ogg, ten seconds of
//      synthetic speech) and becomes a note with a summary;
//   3. search finds a moment in it, and a question about it gets an answer;
//   4. a recording made in the browser (a fake microphone playing the same
//      speech) becomes a note with a summary;
//   5. a recording cut off by a reload (as a crash or a closed tab leaves one)
//      is asked about first, kept, shown on the notes list, and uploads as one
//      note: the list then holds three;
//   6. a call in another tab (Chrome's fake tab share, playing the same speech)
//      is recorded with the microphone: its meter hears it, and it becomes a
//      note with a summary. Needs the api's broadcastCapture switch on;
//   7. the account is deleted from Settings, back to the sign-in page.
// The deletion runs whatever failed before it, so no test user is left behind.
// Any console error or page error (a CSP refusal is one) fails the run.
//
// Env:
//   SITE_URL       the site (default https://staging.algominutes.algorythmos.com)
//   VERCEL_BYPASS  the Vercel project's "Protection Bypass for Automation" secret:
//                  staging is behind Vercel Authentication. It's sent only to the
//                  site's own origin, never to Google or the api.
//   E2E_READY_MS   how long a note may take to be ready (default 8 minutes)
//   E2E_STRIPE     'true' to buy Pro with Stripe's test card 4242 before the deletion (RELEASE.md PR 28b),
//                  once staging's billing has Stripe's test-mode keys; the deletion then cancels it
//   E2E_BUDGET_MS  how long the journey may take in all, before the deletion (default 20 minutes);
//                  every wait is cut to what's left, so the deletion always runs inside the job's timeout
// Needs Playwright's Chromium and ffmpeg (the fake microphone, and the fake tab's
// sound, play a WAV).
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
  const ms = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  return {
    siteUrl: url.origin,
    bypass: (env.VERCEL_BYPASS || '').trim(),
    readyMs: ms(env.E2E_READY_MS, 8 * 60_000),
    budgetMs: ms(env.E2E_BUDGET_MS, 20 * 60_000),
    stripe: env.E2E_STRIPE === 'true',
  };
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

/** Whether a page is Stripe's (Checkout): its own console messages aren't ours to fail on. */
export const isStripePage = (pageUrl) => {
  try {
    const { hostname } = new URL(pageUrl);
    return hostname === 'stripe.com' || hostname.endsWith('.stripe.com');
  } catch {
    // silent-catch-ok: about:blank and the like aren't Stripe's
    return false;
  }
};

/**
 * Pays on Stripe's hosted Checkout with the test card 4242 (Stripe's test mode charges nothing). Its fields
 * are Stripe's: an email when Stripe asks for one, the card, a name, and a postcode where the country needs one.
 */
export async function payWithTestCard(page) {
  const optional = async (selector, value) => {
    const field = page.locator(selector);
    if (await field.isVisible()) await field.fill(value);
  };
  await optional('#email', 'e2e-checkout@example.com');
  await page.locator('#cardNumber').fill('4242 4242 4242 4242');
  await page.locator('#cardExpiry').fill('12 / 34');
  await page.locator('#cardCvc').fill('123');
  await page.locator('#billingName').fill('AlgoMinutes E2E');
  await optional('#billingPostalCode', '2000');
  await page.locator('button[type="submit"]').click();
}

/** The fixture as a WAV, for Chromium's fake microphone. */
export function fixtureWav(fixture = FIXTURE, run = execFileSync) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-web-')), 'speech.wav');
  run('ffmpeg', ['-loglevel', 'error', '-y', '-i', fixture, '-ac', '1', '-ar', '48000', out]);
  return out;
}

export async function runWebE2E({ siteUrl, bypass, readyMs, stripe = false, budgetMs = 20 * 60_000, chromium, micWav, fixture = FIXTURE, recordMs = 12_000, actionMs = 30_000, longMs = 180_000, write = (s) => process.stdout.write(s) }) {
  // Every wait is cut to what's left of the budget, and the fixed ones (not a note's summary, which waits
  // readyMs) also to longMs, so a test can bound the whole run. The deletion has its own waits, below.
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(1_000, deadline - Date.now());
  const wait = (ms) => Math.min(ms, longMs, left());
  const results = [];
  // Why the last wait gave up (a timeout, a selector), for the FAIL line that follows it.
  let lastWait = '';
  const within = (p) => p.then(
    () => true,
    (err) => {
      lastWait = String(err?.message ?? err).split('\n')[0].slice(0, 160);
      return false;
    },
  );
  const check = (name, ok, detail) => {
    const why = [detail, ok ? '' : lastWait].filter(Boolean).join('; ');
    lastWait = '';
    results.push({ name, ok: Boolean(ok) });
    write(`${ok ? 'ok  ' : 'FAIL'} ${name}${why ? ` (${why})` : ''}\n`);
    return Boolean(ok);
  };
  const browser = await chromium.launch({
    // A fake microphone, and a fake share that says it's a browser tab: both play micWav.
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream=display-media-type=browser', ...(micWav ? [`--use-file-for-fake-audio-capture=${micWav}`] : [])],
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
  // Ours only: Stripe's Checkout page logs its own.
  page.on('console', (m) => m.type() === 'error' && !isStripePage(page.url()) && problems.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => !isStripePage(page.url()) && problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  const heading = (name, timeout = wait(30_000)) => within(page.getByRole('heading', { name, exact: true }).first().waitFor({ timeout }));
  const toNote = () => within(page.waitForURL(/\/app\/notes\/[^/?#]+/, { timeout: wait(180_000) }));

  let guest = false;
  const journey = async () => {
    const res = await page.goto(`${siteUrl}/app`);
    if (!check('/app opens, signed out', res?.status() === 200 && (await heading('Sign in to AlgoMinutes')), `HTTP ${res?.status()}`)) return;
    await page.getByRole('button', { name: 'Try it as a guest' }).click();
    // A guest may exist from here, even if the notes never show: the deletion runs whatever happens next.
    guest = true;
    if (!check('a guest gets their notes', await heading('Your notes'))) return;

    await page.getByRole('link', { name: 'Import a recording' }).first().click();
    await page.getByLabel('Audio file').setInputFiles(fixture);
    const imported = (await toNote()) && (await heading('Summary', Math.min(readyMs, left())));
    check('an imported recording becomes a note with a summary', imported, page.url().replace(siteUrl, ''));

    await page.goto(`${siteUrl}/app/search`);
    await page.getByLabel('Search your notes').fill('budget');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    check('search finds a moment in it', await within(page.locator('main a[href*="/app/notes/"]').first().waitFor({ timeout: wait(60_000) })));
    await page.getByRole('tab', { name: 'Ask your notes' }).click();
    await page.getByLabel('Ask a question about your notes').fill('When is the website launch?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    check('a question about it gets an answer', await within(page.getByText('Answer ready.').waitFor({ state: 'attached', timeout: wait(120_000) })));

    await page.goto(`${siteUrl}/app/record`);
    await page.getByRole('checkbox', { name: /I have permission/ }).check();
    await page.getByRole('button', { name: 'Start recording' }).click();
    if (check('the browser records', await within(page.getByText('● RECORDING').waitFor({ timeout: wait(30_000) })))) {
      await page.waitForTimeout(recordMs);
      await page.getByRole('button', { name: 'Stop and save' }).click();
      check('a browser recording becomes a note with a summary', (await toNote()) && (await heading('Summary', Math.min(readyMs, left()))), page.url().replace(siteUrl, ''));
    }

    // RELEASE.md PR 12a: a Chrome tester never loses a recording.
    await page.goto(`${siteUrl}/app/record`);
    await page.getByRole('checkbox', { name: /I have permission/ }).check();
    await page.getByRole('button', { name: 'Start recording' }).click();
    if (!check('a second recording starts', await within(page.getByText('● RECORDING').waitFor({ timeout: wait(30_000) })))) return;
    await page.waitForTimeout(recordMs);
    // The page asks before it goes (beforeunload); the reload goes ahead as a closing tab would.
    let asked = false;
    page.once('dialog', (d) => {
      asked = d.type() === 'beforeunload';
      d.accept().catch((err) => write(`     dialog: ${String(err?.message ?? err).slice(0, 200)}\n`));
    });
    await page.reload();
    check('reloading mid-recording asks first', asked);
    await page.getByRole('link', { name: '← Your notes' }).click();
    if (!check('the cut-off recording is kept, and shown on the notes list', await within(page.getByText('A recording wasn’t uploaded').waitFor({ timeout: wait(30_000) })))) return;
    await page.getByRole('link', { name: 'Upload it' }).click();
    await page.getByRole('button', { name: 'Upload it' }).click();
    check('it uploads, and becomes a note with a summary', (await toNote()) && (await heading('Summary', Math.min(readyMs, left()))), page.url().replace(siteUrl, ''));
    await page.getByRole('link', { name: '← Your notes' }).click();
    const notes = page.locator('main a[href*="/app/notes/"]');
    const three = await within(notes.nth(2).waitFor({ timeout: wait(30_000) }));
    const count = await notes.count();
    check('uploaded once: three notes, and nothing left to upload', three && count === 3 && !(await page.getByText('A recording wasn’t uploaded').isVisible()), `${count} notes`);

    // RELEASE.md PR 13: a call in another tab, mixed with the microphone.
    await page.goto(`${siteUrl}/app/record`);
    const callOption = page.getByLabel('A call in another tab, with my microphone');
    if (!check('a call in another tab is offered (the broadcastCapture switch is on)', await within(callOption.waitFor({ timeout: wait(15_000) })))) return;
    await callOption.check();
    await page.getByRole('checkbox', { name: /I have permission/ }).check();
    await page.getByRole('checkbox', { name: 'Everyone on the call has agreed to be recorded.' }).check();
    await page.getByRole('button', { name: 'Choose the call’s tab' }).click();
    if (!check('the call records', await within(page.getByText('● RECORDING').waitFor({ timeout: wait(30_000) })))) return;
    const heard = page.waitForFunction(() => Number(document.querySelector('[role="meter"][aria-label="The call"]')?.getAttribute('aria-valuenow')) > 0, undefined, { timeout: wait(15_000) });
    check("the call's meter hears it", await within(heard));
    await page.waitForTimeout(recordMs);
    await page.getByRole('button', { name: 'Stop and save' }).click();
    check('a recorded call becomes a note with a summary', (await toNote()) && (await heading('Summary', Math.min(readyMs, left()))), page.url().replace(siteUrl, ''));

    // RELEASE.md PR 28b: Pro on the web, with Stripe's test card, back to the app, and the plan is Pro.
    // The deletion below then records the subscription, and billing's cancel-stripe task cancels it.
    if (stripe) {
      await page.goto(`${siteUrl}/app/settings`);
      await page.getByRole('button', { name: 'Pro, monthly' }).click();
      if (!check('Go Pro opens Stripe Checkout', await within(page.waitForURL((u) => isStripePage(String(u)), { timeout: wait(30_000) })))) return;
      await payWithTestCard(page);
      const back = await within(page.waitForURL(`${siteUrl}/app/billing/success`, { timeout: wait(90_000) }));
      check('the test card pays, and Stripe sends the buyer back to the app', back, page.url().split('?')[0]);
      check('the plan becomes Pro', back && (await heading('You’re on Pro', wait(60_000))));
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
        // Not cut to the budget: the deletion must get its full time even when the journey used it all.
        return heading('Sign in to AlgoMinutes', Math.min(60_000, longMs));
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
