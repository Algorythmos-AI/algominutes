import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
// @ts-expect-error: plain ESM module, no type declarations
import { buildApp as buildApiApp } from '../services/api/src/app.js';
// @ts-expect-error: plain ESM module, no type declarations
import { buildApp as buildBillingApp } from '../services/billing/src/app.js';

// CLAUDE.md: CSP stays enabled in production. The two JSON services send the
// strictest policy (nothing may load, run or frame a response), which also
// closes CodeQL js/insecure-helmet-configuration.
const servers: Array<{ close: () => void }> = [];
afterEach(() => { while (servers.length) servers.pop()!.close(); });

async function headersOf(app: { listen: (p: number) => any }, path: string) {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.headers;
}

describe.each([
  ['api', () => buildApiApp(), '/v1/health'],
  ['billing', () => buildBillingApp(), '/health'],
])('%s security headers', (_name, build, path) => {
  it("sends a strict CSP (default-src 'none', no framing) and helmet's other protections", async () => {
    const h = await headersOf(build(), path);
    const csp = h.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(h.get('x-content-type-options')).toBe('nosniff');
    expect(h.get('x-powered-by')).toBeNull();
  });
});
