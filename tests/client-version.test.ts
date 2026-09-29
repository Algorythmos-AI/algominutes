import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { MIN_SUPPORTED_CLIENT } from '@algominutes/contracts/version';
// @ts-expect-error: plain ESM module, no type declarations
import { clientVersionMiddleware, MIN_SUPPORTED_CLIENTS } from '../services/api/src/middleware/client-version.js';

// The 426 "please update" gate (RELEASE.md PR 4): its floors come from the
// contract the clients are generated from, so they can't drift apart.
describe('the client-version gate', () => {
  it("uses the contract's minimums, one list", () => {
    expect(MIN_SUPPORTED_CLIENTS).toEqual(MIN_SUPPORTED_CLIENT);
  });

  async function call(header: string | undefined, minimums?: Record<string, string>, method = 'GET') {
    const app = express();
    app.use(clientVersionMiddleware(minimums ? { minimums } : {}));
    app.all('/x', (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/x`, { method, headers: header === undefined ? {} : { 'X-AlgoMinutes-Client': header } });
      return { status: res.status, body: method === 'OPTIONS' ? null : await res.json() };
    } finally {
      server.close();
    }
  }

  it('lets a supported client through, and refuses an older one with 426, never a 500', async () => {
    expect((await call('ios/1.0.0')).status).toBe(200);
    expect((await call('web/2.3.1-beta+7')).status).toBe(200);
    const old = await call('ios/1.4.9', { ios: '1.5.0' });
    expect(old).toMatchObject({ status: 426, body: { error: 'please_update' } });
  });

  it('lets an unknown platform through, and answers 400 for a missing or malformed header', async () => {
    expect((await call('extension/0.1.0')).status).toBe(200);
    expect(await call(undefined)).toMatchObject({ status: 400, body: { error: 'client_version_required' } });
    expect(await call('garbage')).toMatchObject({ status: 400, body: { error: 'invalid_client_version' } });
  });

  it('leaves a CORS preflight to the CORS layer', async () => {
    expect((await call(undefined, undefined, 'OPTIONS')).status).toBe(200);
  });
});
