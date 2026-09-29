import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
// @ts-expect-error: a plain .mjs script, no types
import { bypassHeaders, e2eConfig, fixtureWav, isSiteRequest, runWebE2E } from '../../scripts/e2e-web.mjs';

// scripts/e2e-web.mjs walks the real web app on staging. Here it walks a stand-in
// with the same labels, in a real Chromium, to prove what the script itself must
// get right: the bypass secret goes to the site and nowhere else, the account is
// deleted even after a failed step, and a page error fails the run.

describe('its settings', () => {
  it('defaults to staging, and takes only an https origin', () => {
    expect(e2eConfig({})).toEqual({ siteUrl: 'https://staging.algominutes.algorythmos.com', bypass: '', readyMs: 480_000, budgetMs: 1_200_000 });
    expect(e2eConfig({ SITE_URL: 'https://example.test/', VERCEL_BYPASS: ' s ', E2E_READY_MS: '1000', E2E_BUDGET_MS: '2000' })).toEqual({ siteUrl: 'https://example.test', bypass: 's', readyMs: 1000, budgetMs: 2000 });
    expect(e2eConfig({ E2E_READY_MS: 'soon', E2E_BUDGET_MS: '-1' })).toMatchObject({ readyMs: 480_000, budgetMs: 1_200_000 });
    expect(() => e2eConfig({ SITE_URL: 'http://example.test' })).toThrow(/https/);
    expect(() => e2eConfig({ SITE_URL: 'https://example.test/app' })).toThrow(/origin/);
  });

  it('sends the bypass only to the site itself', () => {
    const site = 'https://staging.algominutes.algorythmos.com';
    expect(isSiteRequest(`${site}/app/assets/x.js`, site)).toBe(true);
    for (const u of ['https://identitytoolkit.googleapis.com/v1/x', 'https://api-627101926311.australia-southeast1.run.app/v1/config', 'https://staging.algominutes.algorythmos.com.evil.test/', 'http://staging.algominutes.algorythmos.com/', 'data:text/plain,x']) {
      expect(isSiteRequest(u, site), u).toBe(false);
    }
    expect(bypassHeaders('')).toEqual({});
    expect(bypassHeaders('sec')).toEqual({ 'x-vercel-protection-bypass': 'sec', 'x-vercel-set-bypass-cookie': 'true' });
  });

  it('turns the fixture into a WAV for the fake microphone', () => {
    const calls: string[][] = [];
    const out = fixtureWav('/f.ogg', (_cmd: string, args: string[]) => calls.push(args));
    expect(out).toMatch(/speech\.wav$/);
    expect(calls[0]).toEqual(expect.arrayContaining(['-i', '/f.ogg', out]));
  });
});

// When it runs (the decision itself: tests/e2e-web-gate.test.ts).
describe('its workflow', () => {
  const wf = fs.readFileSync('.github/workflows/web-e2e.yml', 'utf8');

  it('wakes when deploy-staging finishes or Vercel deploys, and lets the gate decide', () => {
    expect(wf).toMatch(/workflow_run:\s*\n\s*workflows: \[deploy-staging\]\s*\n\s*types: \[completed\]\s*\n\s*branches: \[integration\]/);
    expect(wf).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(wf).toContain("github.event.deployment.creator.login == 'vercel[bot]'");
    // Vercel's ref is the commit SHA: this never matched a site deploy.
    expect(wf).not.toMatch(/deployment\.ref == 'integration'/);
    expect(wf).toContain('run: node scripts/e2e-web-gate.mjs');
    expect(wf).toContain("if: needs.gate.outputs.run == 'true'");
  });

  it('queues journeys only after the gate, so a skipped event never cancels a real run', () => {
    // A workflow-level group applies before any `if:`, and a newer pending run replaces an older one.
    expect(wf).not.toMatch(/^concurrency:/m);
    expect(wf).toMatch(/\n  e2e:\n(?:    .*\n)*?    concurrency:\n      group: web-e2e\n      cancel-in-progress: false\n/);
  });

  it('gives the bypass secret to the journey step only', () => {
    expect(wf.match(/secrets\.VERCEL_AUTOMATION_BYPASS_SECRET/g)).toHaveLength(2);
    expect(wf).toContain("HAS_BYPASS: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET != '' }}");
    expect(wf).toMatch(/- name: The journey\n(?:        .*\n)*?          VERCEL_BYPASS: \$\{\{ secrets\.VERCEL_AUTOMATION_BYPASS_SECRET \}\}\n/);
  });
});

// The stand-in: each page the journey visits, with the real app's roles and names.
const PAGES: Record<string, string> = {
  '/app': `<h1>Sign in to AlgoMinutes</h1><button onclick="location='/app/notes-list'">Try it as a guest</button>`,
  // A recording cut off by a reload is "cut" until it's uploaded (as n3), the way IndexedDB keeps it in the app.
  '/app/notes-list': `<main><h1>Your notes</h1><a href="/app/import">Import a recording</a><div id="left" hidden><p>A recording wasn’t uploaded</p><a href="/app/record">Upload it</a></div><ul id="notes"></ul></main>
    <script>document.getElementById('left').hidden = !localStorage.getItem('cut');
      for (const n of ['n1', 'n2'].concat(localStorage.getItem('uploaded') ? ['n3'] : [])) document.getElementById('notes').insertAdjacentHTML('beforeend', '<li><a href="/app/notes/' + n + '">' + n + '</a></li>');</script>`,
  '/app/import': `<h1>Import a recording</h1><input type="file" aria-label="Audio file" onchange="location='/app/notes/n1'">`,
  '/app/notes/n1': `<main><h1>Note</h1><h2>Summary</h2></main>`,
  '/app/notes/n2': `<main><h1>Note</h1><h2>Summary</h2></main>`,
  '/app/notes/n3': `<main><p><a href="/app/notes-list">← Your notes</a></p><h1>Note</h1><h2>Summary</h2></main>`,
  '/app/notes/n4': `<main><h1>Note</h1><h2>Summary</h2></main>`,
  '/app/search': `<main><h1>Search</h1><div role="tablist"><button role="tab">Search transcripts</button><button role="tab" onclick="document.getElementById('ask').hidden=false">Ask your notes</button></div>
    <label>Search your notes <input></label><button onclick="document.getElementById('hits').innerHTML='<a href=&quot;/app/notes/n1&quot;>n1</a>'">Search</button><div id="hits"></div>
    <div id="ask" hidden><label>Ask a question about your notes <input></label><button onclick="document.getElementById('st').textContent='Answer ready.'">Ask</button><p id="st" role="status"></p></div>
    <script>fetch(window.PROBE).catch(() => {})</script></main>`,
  // Recording asks before the page goes, as the app does; Stop takes the guard down first. A call (the radio)
  // shows the call's meter, which hears it a moment after it starts.
  '/app/record': `<p><a href="/app/notes-list">← Your notes</a></p><h1>Record a meeting</h1>
    <label><input type="radio" name="source" onchange="window.call = true"> A call in another tab, with my microphone</label>
    <label><input type="checkbox"> I have permission from anyone whose voice may be captured.</label>
    <label><input type="checkbox"> Everyone on the call has agreed to be recorded.</label>
    <button onclick="localStorage.setItem('cut', '1'); onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ''; }; document.getElementById('r').hidden=false">Start recording</button>
    <button onclick="document.getElementById('r').hidden=false; document.getElementById('m').hidden=false; setTimeout(() => document.getElementById('m').setAttribute('aria-valuenow', window.METER ?? '60'), 200)">Choose the call’s tab</button>
    <div id="r" hidden><p>● RECORDING</p><div id="m" hidden role="meter" aria-label="The call" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></div>
      <button onclick="onbeforeunload = null; localStorage.removeItem('cut'); location = window.call ? '/app/notes/n4' : '/app/notes/n2'">Stop and save</button></div>
    <div id="left" hidden><button onclick="localStorage.removeItem('cut'); localStorage.setItem('uploaded', '1'); location='/app/notes/n3'">Upload it</button></div>
    <script>document.getElementById('left').hidden = !localStorage.getItem('cut');</script>`,
  '/app/settings': `<h1>Settings</h1><button onclick="document.getElementById('d').hidden=false">Delete my account</button>
    <form id="d" hidden onsubmit="event.preventDefault(); fetch('/deleted', { method: 'POST' }).then(() => location='/app')"><label>Type DELETE to confirm: <input></label><button type="submit">Delete account</button></form>`,
};

let site: Server;
let other: Server;
let siteUrl: string;
let otherUrl: string;
const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
const otherSeen: IncomingHttpHeaders[] = [];
let broken = new Set<string>();

beforeAll(async () => {
  other = http.createServer((req, res) => {
    otherSeen.push(req.headers);
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }).end('ok');
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}/probe`;
  site = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    seen.push({ path, headers: req.headers });
    if (path === '/deleted') return void res.writeHead(204).end();
    const body = PAGES[path];
    if (!body || broken.has(path)) return void res.writeHead(500).end('broken');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><script>window.PROBE=${JSON.stringify(otherUrl)}</script>${body}`);
  });
  await new Promise<void>((r) => site.listen(0, 'localhost', r));
  siteUrl = `http://localhost:${(site.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => site?.close(r));
  await new Promise((r) => other?.close(r));
});

beforeEach(() => {
  seen.length = 0;
  otherSeen.length = 0;
  broken = new Set();
});

const run = (lines: string[]) => runWebE2E({ siteUrl, bypass: 'the-secret', readyMs: 5000, chromium, recordMs: 50, actionMs: 3000, longMs: 4000, fixture: 'tests/fixtures/e2e-speech.ogg', write: (s: string) => lines.push(s) });

describe('the journey, in a real browser', () => {
  it('walks every step, sends the bypass to the site only, and deletes the account', async () => {
    const lines: string[] = [];
    const ok = await run(lines);
    expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(ok).toBe(true);
    expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('ok'))).toHaveLength(18);
    for (const step of ['reloading mid-recording asks first', 'the cut-off recording is kept, and shown on the notes list', 'uploaded once: three notes, and nothing left to upload', "the call's meter hears it", 'a recorded call becomes a note with a summary']) {
      expect(lines.some((l) => l.startsWith(`ok   ${step}`)), step).toBe(true);
    }
    expect(seen.length).toBeGreaterThan(8);
    for (const r of seen) expect(r.headers['x-vercel-protection-bypass'], r.path).toBe('the-secret');
    expect(otherSeen.length).toBeGreaterThan(0);
    for (const h of otherSeen) expect(h['x-vercel-protection-bypass']).toBeUndefined();
    expect(seen.some((r) => r.path === '/deleted')).toBe(true);
  }, 60_000);

  it('a failed step fails the run, and the account is still deleted', async () => {
    broken = new Set(['/app/search']);
    const lines: string[] = [];
    expect(await run(lines)).toBe(false);
    expect(lines.some((l) => l.startsWith('FAIL'))).toBe(true);
    expect(seen.some((r) => r.path === '/deleted')).toBe(true);
    expect(lines.some((l) => l.startsWith('ok   the account is deleted from Settings'))).toBe(true);
  }, 60_000);

  it("a guest whose notes never show is still deleted", async () => {
    broken = new Set(['/app/notes-list']);
    const lines: string[] = [];
    expect(await run(lines)).toBe(false);
    expect(lines.some((l) => l.startsWith('FAIL a guest gets their notes'))).toBe(true);
    expect(seen.some((r) => r.path === '/deleted')).toBe(true);
  }, 60_000);

  it('a step that never finishes fails within longMs, and the account is still deleted', async () => {
    const saved = PAGES['/app/search'];
    // The search and the question never answer: without the cap, those waits are 60 s and 120 s.
    PAGES['/app/search'] = saved.replace(/onclick="document\.getElementById\('(hits|st)'\)[^"]*"/g, '');
    try {
      const lines: string[] = [];
      const started = Date.now();
      expect(await run(lines)).toBe(false);
      expect(Date.now() - started).toBeLessThan(30_000);
      const fails = lines.filter((l) => l.startsWith('FAIL'));
      expect(fails.map((l) => l.slice(5).split(' (')[0].trim())).toEqual(['search finds a moment in it', 'a question about it gets an answer']);
      // Each says why it gave up.
      for (const l of fails) expect(l).toMatch(/\(.*Timeout 4000ms exceeded/);
      expect(seen.some((r) => r.path === '/deleted')).toBe(true);
    } finally {
      PAGES['/app/search'] = saved;
    }
  }, 60_000);

  it('the whole journey keeps to its budget, and the account is still deleted', async () => {
    const saved = PAGES['/app/search'];
    PAGES['/app/search'] = saved.replace(/onclick="document\.getElementById\('(hits|st)'\)[^"]*"/g, '');
    try {
      const lines: string[] = [];
      const started = Date.now();
      // Long waits allowed (60 s, 120 s), but a 3-second budget for everything.
      expect(await runWebE2E({ siteUrl, bypass: '', readyMs: 60_000, budgetMs: 3000, chromium, recordMs: 50, actionMs: 3000, longMs: 180_000, fixture: 'tests/fixtures/e2e-speech.ogg', write: (s: string) => lines.push(s) })).toBe(false);
      expect(Date.now() - started).toBeLessThan(30_000);
      expect(seen.some((r) => r.path === '/deleted')).toBe(true);
      expect(lines.some((l) => l.startsWith('ok   the account is deleted from Settings'))).toBe(true);
    } finally {
      PAGES['/app/search'] = saved;
    }
  }, 60_000);

  it('a recording page with no guard, or a second note, fails the run', async () => {
    const saved = PAGES['/app/record'];
    PAGES['/app/record'] = saved.replace("onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ''; }; ", '');
    try {
      const lines: string[] = [];
      expect(await run(lines)).toBe(false);
      expect(lines.some((l) => l.startsWith('FAIL reloading mid-recording asks first'))).toBe(true);
    } finally {
      PAGES['/app/record'] = saved;
    }
    const list = PAGES['/app/notes-list'];
    PAGES['/app/notes-list'] = list.replace("['n3']", "['n3', 'n4']");
    try {
      const lines: string[] = [];
      expect(await run(lines)).toBe(false);
      expect(lines.find((l) => l.includes('uploaded once'))).toMatch(/^FAIL.*4 notes/);
    } finally {
      PAGES['/app/notes-list'] = list;
    }
  }, 120_000);

  it("a call whose meter never moves fails the run, and one that isn't offered says so", async () => {
    const saved = PAGES['/app/record'];
    PAGES['/app/record'] = saved.replace('<p><a href="/app/notes-list">', '<script>window.METER = "0"</script><p><a href="/app/notes-list">');
    try {
      const lines: string[] = [];
      expect(await run(lines)).toBe(false);
      expect(lines.some((l) => l.startsWith("FAIL the call's meter hears it"))).toBe(true);
      PAGES['/app/record'] = saved.replace(/<label><input type="radio"[^]*?<\/label>/, '');
      lines.length = 0;
      expect(await run(lines)).toBe(false);
      expect(lines.some((l) => l.startsWith('FAIL a call in another tab is offered'))).toBe(true);
      expect(lines.some((l) => l.startsWith('ok   the account is deleted from Settings'))).toBe(true);
    } finally {
      PAGES['/app/record'] = saved;
    }
  }, 120_000);

  it('a page error fails the run, even when every step passed', async () => {
    const saved = PAGES['/app/notes-list'];
    PAGES['/app/notes-list'] = `${saved}<script>throw new Error('boom')</script>`;
    try {
      const lines: string[] = [];
      expect(await run(lines)).toBe(false);
      expect(lines.find((l) => l.includes('no console or page errors'))).toMatch(/^FAIL.*boom/);
    } finally {
      PAGES['/app/notes-list'] = saved;
    }
  }, 60_000);
});
