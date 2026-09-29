import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
// @ts-expect-error: plain ESM module, no type declarations
import { buildApp } from '../services/api/src/app.js';

// A body that isn't JSON: body-parser's error message quotes part of it
// ("Unexpected token 'B', "{"code": BETA-7K2QX"... is not valid JSON"), and the
// api's error handler logged that message at error level. For POST
// /v1/beta/redeem that's part of an invite code; for other routes it can be
// someone's words. The handler now logs that it happened, never what it said.
describe('an unparseable body is logged without its contents', () => {
  const servers: Array<{ close: () => void }> = [];
  let saved: string | undefined;
  let written: string[];
  beforeEach(() => {
    saved = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'https://algominutes.algorythmos.com';
    written = [];
    const capture = (chunk: unknown) => { written.push(String(chunk)); return true; };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    while (servers.length) servers.pop()!.close();
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
  });

  const post = async (path: string, body: string) => {
    const server = buildApp().listen(0);
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const { port } = server.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AlgoMinutes-Client': 'ios/1.0.0' },
      body,
    });
  };

  it('answers 400 and logs request_body_unparseable, with no fragment of the body', async () => {
    for (const body of ['{"code": BETA-7K2QX-M9D4R-TW8HN}', 'BETA-7K2QX-M9D4R-TW8HN']) { // gitleaks:allow
      written.length = 0;
      const res = await post('/v1/beta/redeem', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid request body' });
      const out = written.join('');
      expect(out).toContain('request_body_unparseable');
      expect(out).not.toContain('unhandled_error');
      expect(out.toUpperCase()).not.toContain('7K2QX');
    }
  });

  it('still logs any other error in full', async () => {
    const res = await post('/v1/beta/redeem', 'x'.repeat(1024 * 1024 + 10));
    expect(res.status).toBe(413);
    expect(written.join('')).toContain('unhandled_error');
  });
});
