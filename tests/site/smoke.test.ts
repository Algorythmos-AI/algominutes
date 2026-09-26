import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
// @ts-expect-error: plain .mjs scripts, no types
import { createServer } from '../../scripts/serve-site.mjs';
// @ts-expect-error: plain .mjs scripts, no types
import { smoke, PAGES } from '../../scripts/smoke-site.mjs';
import { stripComments } from '../helpers/terraform';

// scripts/smoke-site.mjs, run after each deploy, passes against the built site
// served the way vercel.json says, and reports each way a deploy can be wrong.
let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

/** fetch, with the response changed the way a broken deploy would change it. */
const tampered = (change: (url: string, res: Response) => Response | undefined) => async (url: string, init: RequestInit) => {
  const res = await fetch(url, init);
  return change(url, res) ?? res;
};
const withHeaders = (res: Response, edit: (h: Headers) => void) => {
  const h = new Headers(res.headers);
  edit(h);
  return new Response(res.body, { status: res.status, headers: h });
};

describe('smoke-site', () => {
  it('passes on a correct deploy', async () => {
    expect(await smoke(origin)).toEqual([]);
  });

  it('catches a dropped security header', async () => {
    const f = await smoke(origin, { fetchImpl: tampered((u, r) => (u.endsWith('/privacy') ? withHeaders(r, (h) => h.delete('content-security-policy')) : undefined)) });
    expect(f).toEqual([expect.stringMatching(/^\/privacy: Content-Security-Policy is null/)]);
  });

  it('catches a share link that can be cached', async () => {
    const f = await smoke(origin, { fetchImpl: tampered((u, r) => (u.includes('/s/') ? withHeaders(r, (h) => h.set('cache-control', 'public')) : undefined)) });
    expect(f).toEqual([expect.stringMatching(/^\/s\/smoke-test-token: Cache-Control is "public"/)]);
  });

  it('catches a missing page, a wrong 404 and a security.txt about to expire', async () => {
    const soon = new Date(Date.now() + 170 * 86400000);
    const f = await smoke(origin, {
      now: soon,
      fetchImpl: tampered((u) => (u.endsWith('/terms') ? new Response('gone', { status: 404 }) : u.includes('no-such') ? new Response('x', { status: 200 }) : undefined)),
    });
    expect(f).toEqual([
      '/terms: status 404, want 200',
      expect.stringMatching(/^\/\.well-known\/security\.txt: Expires is .*; deploy the site to renew it$/),
      '/smoke-no-such-page: status 200, want 404',
    ]);
  });

  it('checks what the uptime checks look for', () => {
    // monitoring.tf's content matchers must be on the pages, or the checks alert on a healthy site.
    const tf = stripComments(fs.readFileSync('infra/terraform/modules/environment/monitoring.tf', 'utf8'));
    const uptime = [...tf.matchAll(/\{ path = "([^"]+)", content = "([^"]+)" \}/g)].map((m) => [m[1], m[2]]);
    expect(uptime.map(([p]) => p)).toEqual(['/', '/privacy', '/terms', '/support', '/delete-account']);
    const smoked = new Map(PAGES as [string, string][]);
    for (const [p, content] of uptime) expect(smoked.get(p), p).toBe(content);
  });
});
