import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
    expect(e2eConfig({})).toMatchObject({ siteUrl: 'https://staging.algominutes.algorythmos.com', bypass: '', readyMs: 480_000 });
    expect(e2eConfig({ SITE_URL: 'https://example.test/', VERCEL_BYPASS: ' s ', E2E_READY_MS: '1000' })).toEqual({ siteUrl: 'https://example.test', bypass: 's', readyMs: 1000 });
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

// The stand-in: each page the journey visits, with the real app's roles and names.
const PAGES: Record<string, string> = {
  '/app': `<h1>Sign in to AlgoMinutes</h1><button onclick="location='/app/notes-list'">Try it as a guest</button>`,
  '/app/notes-list': `<main><h1>Your notes</h1><a href="/app/import">Import a recording</a></main>`,
  '/app/import': `<h1>Import a recording</h1><input type="file" aria-label="Audio file" onchange="location='/app/notes/n1'">`,
  '/app/notes/n1': `<main><h1>Note</h1><h2>Summary</h2></main>`,
  '/app/notes/n2': `<main><h1>Note</h1><h2>Summary</h2></main>`,
  '/app/search': `<main><h1>Search</h1><div role="tablist"><button role="tab">Search transcripts</button><button role="tab" onclick="document.getElementById('ask').hidden=false">Ask your notes</button></div>
    <label>Search your notes <input></label><button onclick="document.getElementById('hits').innerHTML='<a href=&quot;/app/notes/n1&quot;>n1</a>'">Search</button><div id="hits"></div>
    <div id="ask" hidden><label>Ask a question about your notes <input></label><button onclick="document.getElementById('st').textContent='Answer ready.'">Ask</button><p id="st" role="status"></p></div>
    <script>fetch(window.PROBE).catch(() => {})</script></main>`,
  '/app/record': `<h1>Record a meeting</h1><label><input type="checkbox"> I have permission from anyone whose voice may be captured.</label>
    <button onclick="document.getElementById('r').hidden=false">Start recording</button><div id="r" hidden><p>● RECORDING</p><button onclick="location='/app/notes/n2'">Stop and save</button></div>`,
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

const run = (lines: string[]) => runWebE2E({ siteUrl, bypass: 'the-secret', readyMs: 5000, chromium, recordMs: 50, actionMs: 3000, fixture: 'tests/fixtures/e2e-speech.ogg', write: (s: string) => lines.push(s) });

describe('the journey, in a real browser', () => {
  it('walks every step, sends the bypass to the site only, and deletes the account', async () => {
    const lines: string[] = [];
    const ok = await run(lines);
    expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(ok).toBe(true);
    expect(lines.filter((l) => l.startsWith('FAIL'))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('ok'))).toHaveLength(9);
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
