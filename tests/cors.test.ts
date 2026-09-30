import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// One CORS allowlist for the api and billing (@algominutes/ai/cors.cjs; RELEASE.md PR 17): the web app calls
// billing for its checkout and portal from its own origin. CLAUDE.md: never `cors: true`.
const BETA = 'https://beta.algominutes.algorythmos.com';
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serve(path: string) {
  const saved = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = BETA;
  try {
    // @ts-expect-error: plain ESM modules, no type declarations
    const { buildApp } = await import(path);
    const server = buildApp().listen(0);
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  } finally {
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
  }
}
const preflight = (base: string, route: string, origin: string) => fetch(`${base}${route}`, {
  method: 'OPTIONS',
  headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,x-algominutes-client' },
});

describe.each([
  ['the api', '../services/api/src/app.js', '/v1/process'],
  ['billing', '../services/billing/src/app.js', '/v1/billing/checkout'],
])('%s', (_name, path, route) => {
  // The first import of a whole service app (Stripe's SDK, firebase-admin, the repo layer) can pass vitest's 5 s
  // default on a cold transform cache under a full parallel run (it did, 2026-10-01). It's paid here, once, with
  // room; each test then times only its own work.
  // @ts-expect-error: plain ESM modules, no type declarations
  beforeAll(async () => { await import(path); }, 30_000);

  it('lets the beta web origin call it, with the headers the web sends', async () => {
    const base = await serve(path);
    const r = await preflight(base, route, BETA);
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe(BETA);
    expect(r.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-algominutes-client');
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it("gives another origin no CORS headers: the browser refuses it", async () => {
    const base = await serve(path);
    const r = await preflight(base, route, 'https://evil.example');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('one allowlist', () => {
  it('the api and billing both take it from @algominutes/ai/cors.cjs', () => {
    expect(fs.readFileSync('services/api/src/middleware/cors.js', 'utf8')).toContain("from '@algominutes/ai/cors.cjs'");
    expect(fs.readFileSync('services/billing/src/app.js', 'utf8')).toMatch(/app\.use\(corsModule\.buildCorsMiddleware\(\)\)/);
  });

  it("billing's deployed env carries the allowlist", () => {
    const tf = fs.readFileSync('infra/terraform/modules/environment/cloud-run.tf', 'utf8');
    expect(tf).toMatch(/billing\s+= merge\(local\.db_env, \{[^}]*ALLOWED_ORIGINS = var\.allowed_origins/);
  });
});
