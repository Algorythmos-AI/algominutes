import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
// @ts-expect-error: plain ESM module, no type declarations
import { buildApp } from '../services/api/src/app.js';
// @ts-expect-error: plain ESM module, no type declarations
import { traceContext } from '../services/api/src/middleware/trace.js';

// The web app sends X-Trace-Id on every call and keeps it on any error. The
// api logs the request under it, and answers with it, so the id a user or a
// crash report quotes finds the server's log lines. A browser can't send
// X-Cloud-Trace-Context cross-origin, which was the only header read.
const CLOUD = '105445aa7843bc8bf206b12000100000/1;o=1';

describe('traceContext', () => {
  const WEB = '3f1c2a9e-2b0d-4a7e-9d0b-5f6f1a2b3c4d';

  it("prefers the client's well-formed X-Trace-Id, keeping Cloud Run's id beside it", () => {
    expect(traceContext({ 'x-trace-id': WEB, 'x-cloud-trace-context': CLOUD })).toEqual({ traceId: WEB, cloudTraceId: '105445aa7843bc8bf206b12000100000' });
  });

  it("falls back to Cloud Run's id for a missing or malformed X-Trace-Id, with no duplicate cloudTraceId", () => {
    for (const bad of [undefined, '', 'has spaces', 'x'.repeat(129), '<script>', ['a', 'b']]) {
      expect(traceContext({ 'x-trace-id': bad, 'x-cloud-trace-context': CLOUD }), String(bad)).toEqual({ traceId: '105445aa7843bc8bf206b12000100000', cloudTraceId: null });
    }
  });

  it('never invents a cloudTraceId: none without the header', () => {
    expect(traceContext({ 'x-trace-id': WEB })).toEqual({ traceId: WEB, cloudTraceId: null });
    const fresh = traceContext({});
    expect(fresh.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.cloudTraceId).toBeNull();
  });
});

describe('the api answers with the traceId, readable cross-origin', () => {
  const servers: Array<{ close: () => void }> = [];
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'https://algominutes.algorythmos.com';
  });
  afterEach(() => {
    while (servers.length) servers.pop()!.close();
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
  });
  const call = async (headers: Record<string, string>) => {
    const server = buildApp().listen(0);
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${port}/v1/health`, { headers });
  };

  it("echoes the client's id, and exposes the header to the site", async () => {
    const res = await call({ Origin: 'https://algominutes.algorythmos.com', 'X-Trace-Id': 'web-trace-1' });
    expect(res.headers.get('x-trace-id')).toBe('web-trace-1');
    expect(res.headers.get('access-control-expose-headers')).toMatch(/X-Trace-Id/i);
  });

  it('names a fresh id when the client sent none', async () => {
    const res = await call({});
    expect(res.headers.get('x-trace-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
