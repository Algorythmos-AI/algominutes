import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';

const { clientRateLimit, userRateLimit, trustProxyHops } = createRequire(import.meta.url)('@algominutes/ai/rate-limit.cjs');

// Request rate limits for /v1 and billing (@algominutes/ai/rate-limit.cjs),
// driven over real HTTP.
const servers: Array<{ close: () => void }> = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function serve(app: express.Express) {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  return (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json(), headers: r.headers }));
}

function appWith(...mw: express.RequestHandler[]) {
  const app = express();
  app.set('trust proxy', trustProxyHops());
  app.use((req, _res, next) => { (req as any).uid = req.header('x-test-uid'); next(); });
  app.use(...mw);
  app.get(['/health', '/thing'], (_req, res) => res.json({ ok: true }));
  return app;
}

describe('userRateLimit', () => {
  it('limits each verified user separately, and answers 429 as JSON', async () => {
    const get = await serve(appWith(userRateLimit({ limit: 2 })));
    const alice = { 'x-test-uid': 'alice' };
    expect((await get('/thing', alice)).status).toBe(200);
    expect((await get('/thing', alice)).status).toBe(200);
    const limited = await get('/thing', alice);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited', message: expect.any(String) });
    expect((await get('/thing', { 'x-test-uid': 'bob' })).status).toBe(200);
  });
});

describe('clientRateLimit', () => {
  // Cloud Run's front end appends the real client as the RIGHTMOST
  // X-Forwarded-For entry. With the hop count trusted (not `true`), a client
  // can't get a fresh bucket by sending a different leftmost value.
  it('keys on the address the proxy appended, so a spoofed X-Forwarded-For buys nothing', async () => {
    const get = await serve(appWith(clientRateLimit({ limit: 2 })));
    const from = (spoofed: string, real: string) => ({ 'x-forwarded-for': `${spoofed}, ${real}` });
    expect((await get('/thing', from('9.9.9.1', '203.0.113.5'))).status).toBe(200);
    expect((await get('/thing', from('9.9.9.2', '203.0.113.5'))).status).toBe(200);
    expect((await get('/thing', from('9.9.9.3', '203.0.113.5'))).status).toBe(429);
    expect((await get('/thing', from('9.9.9.3', '203.0.113.6'))).status).toBe(200);
  });

  it('never limits the health probes', async () => {
    const get = await serve(appWith(clientRateLimit({ limit: 1 })));
    for (let i = 0; i < 3; i++) expect((await get('/health')).status).toBe(200);
  });
});

describe('trust proxy', () => {
  const saved = process.env.TRUST_PROXY_HOPS;
  afterEach(() => {
    if (saved === undefined) delete process.env.TRUST_PROXY_HOPS;
    else process.env.TRUST_PROXY_HOPS = saved;
  });

  it('is a hop count (default 1), never `true`', () => {
    delete process.env.TRUST_PROXY_HOPS;
    expect(trustProxyHops()).toBe(1);
    process.env.TRUST_PROXY_HOPS = '2';
    expect(trustProxyHops()).toBe(2);
    process.env.TRUST_PROXY_HOPS = 'true';
    expect(trustProxyHops()).toBe(1);
  });

  it('the api app uses it, and mounts the client limit on /v1', () => {
    const src = fs.readFileSync('services/api/src/app.js', 'utf8');
    expect(src).toMatch(/app\.set\('trust proxy', trustProxyHops\(\)\)/);
    expect(src).not.toMatch(/app\.set\('trust proxy', true\)/);
    expect(src).toMatch(/app\.use\(API_PREFIX, clientRateLimit\(\)\)/);
  });
});

describe('the /v1 router', () => {
  // Every authenticated route goes through `authed` (auth + the per-user
  // limit). A route wired with a bare authMiddleware would skip the limit.
  it('wires every authenticated route through the per-user limit', () => {
    const src = fs.readFileSync('services/api/src/routes/index.js', 'utf8');
    const routes = src.split('\n').filter((l) => /router\.(get|post|put|patch|delete)\(/.test(l));
    expect(routes.filter((l) => l.includes('authed,')).length).toBeGreaterThanOrEqual(22);
    expect(routes.filter((l) => l.includes('authMiddleware'))).toEqual([]);
  });
});

// services/billing uses the same shared limiter (@algominutes/ai/rate-limit.cjs).
describe('billing', () => {
  it('trusts the hop count, limits every client, and wires every authed route through the per-user limit', () => {
    const src = fs.readFileSync('services/billing/src/app.js', 'utf8');
    expect(src).toMatch(/app\.set\('trust proxy', trustProxyHops\(\)\)/);
    expect(src).not.toMatch(/app\.set\('trust proxy', true\)/);
    expect(src).toMatch(/app\.use\(clientRateLimit\(\)\)/);
    const routes = src.split('\n').filter((l) => /app\.(get|post|put|patch|delete)\('\/v1\//.test(l));
    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(routes.filter((l) => !l.includes('authed,'))).toEqual([]);
    // The client limit is mounted before the raw Stripe webhook route.
    expect(src.indexOf('app.use(clientRateLimit())')).toBeLessThan(src.indexOf("app.post('/webhooks/stripe'"));
  });

  it('the live billing app limits a client and never its health probes', async () => {
    const saved = process.env.RATE_LIMIT_IP_PER_MIN;
    process.env.RATE_LIMIT_IP_PER_MIN = '2';
    try {
      // @ts-expect-error: plain ESM module, no type declarations
      const { buildApp } = await import('../services/billing/src/app.js');
      const server = buildApp().listen(0);
      servers.push(server);
      await new Promise((r) => server.once('listening', r));
      const { port } = server.address() as AddressInfo;
      const status = (path: string) => fetch(`http://127.0.0.1:${port}${path}`).then((r) => r.status);
      for (let i = 0; i < 4; i++) expect(await status('/health')).toBe(200);
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push(await status('/v1/nope'));
      expect(statuses).toEqual([404, 404, 429]);
    } finally {
      if (saved === undefined) delete process.env.RATE_LIMIT_IP_PER_MIN;
      else process.env.RATE_LIMIT_IP_PER_MIN = saved;
    }
  });
});
