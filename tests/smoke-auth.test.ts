import { describe, it, expect } from 'vitest';
import { runAuthSmoke, FIRST_CHUNK, TOTAL_BYTES } from '../scripts/smoke-auth.mjs';

// The authenticated deploy smoke (scripts/smoke-auth.mjs), against a fake
// Identity Toolkit, api and GCS that behave like the real ones.
const API = 'https://api-123.a.run.app';
const TOKEN = 'id-token-secret';
const SESSION = 'https://storage.googleapis.com/upload/resumable?upload_id=secret-session';
const UID = 'uid-1';

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };

function fakeWorld(overrides: Record<string, (call: Call) => Response | undefined> = {}) {
  const calls: Call[] = [];
  let received = 0;
  let userExists = false;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetch = async (url: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    };
    calls.push(call);
    const key = `${call.method} ${url.replace(API, '').replace(SESSION, 'SESSION')}`;
    const override = overrides[key]?.(call);
    if (override) return override;
    switch (key) {
      case 'POST https://identitytoolkit.googleapis.com/v1/accounts:signUp':
        userExists = true;
        return json(200, { idToken: TOKEN, localId: UID });
      case 'POST https://identitytoolkit.googleapis.com/v1/accounts:lookup':
        return userExists ? json(200, { users: [{ localId: UID }] }) : json(400, { error: { message: 'USER_NOT_FOUND' } });
      case 'GET /v1/config':
        return json(200, { broadcastCapture: true });
      case 'GET /v1/entitlement':
        return json(200, { plan: 'free' });
      case 'POST /v1/uploads':
        return json(200, { uploadId: 'up-1', sessionUri: SESSION, storagePath: `recordings/workspace_${UID}/deploy-smoke.m4a` });
      case 'PUT SESSION': {
        received += (call.body as Uint8Array).length;
        return new Response(null, { status: received < TOTAL_BYTES ? 308 : 200 });
      }
      case 'GET /v1/uploads/up-1':
        return json(200, { uploadId: 'up-1', receivedBytes: received, complete: received === TOTAL_BYTES });
      case 'POST /v1/uploads/up-1/complete':
        return received === TOTAL_BYTES ? json(200, { complete: true }) : json(409, { error: 'Upload is not complete yet.' });
      case 'POST /v1/search':
        return json(200, { hits: [] });
      case 'POST /v1/account/delete':
        userExists = false;
        return json(200, { deleted: true });
      default:
        return json(404, { error: `unexpected ${key}` });
    }
  };
  return { fetch, calls };
}

async function run(overrides?: Parameters<typeof fakeWorld>[0]) {
  const world = fakeWorld(overrides);
  let out = '';
  const masked: string[] = [];
  const result = await runAuthSmoke({
    apiUrl: API,
    apiKey: 'the-key',
    fetch: world.fetch,
    write: (s: string) => (out += s),
    mask: (v: string) => masked.push(v),
    traceId: 'a'.repeat(32),
  });
  return { ...result, out, masked, calls: world.calls };
}

describe('the authenticated deploy smoke', () => {
  it("walks a user's life: sign-up, config, entitlement, a two-chunk upload, search, deletion", async () => {
    const { ok, results, calls } = await run();
    expect(results.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
    expect(ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, '').replace(SESSION, 'SESSION').replace(/.*accounts:/, 'id:')}`)).toEqual([
      'POST id:signUp',
      'GET /v1/config',
      'GET /v1/entitlement',
      'POST /v1/uploads',
      'PUT SESSION',
      'GET /v1/uploads/up-1',
      'POST /v1/uploads/up-1/complete',
      'PUT SESSION',
      'POST /v1/uploads/up-1/complete',
      'POST /v1/search',
      'POST /v1/account/delete',
      'POST id:lookup',
    ]);
  });

  it('sends what the api and GCS require', async () => {
    const { calls } = await run();
    const apiCalls = calls.filter((c) => new URL(c.url).origin === API);
    for (const c of apiCalls) {
      expect(c.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(c.headers['X-AlgoMinutes-Client']).toBe('smoke/1.0.0');
      expect(c.headers['X-Cloud-Trace-Context']).toBe(`${'a'.repeat(32)}/1;o=1`);
    }
    expect(calls[3].body).toMatchObject({ workspaceId: `workspace_${UID}`, totalBytes: TOTAL_BYTES });
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.headers['Content-Range'])).toEqual([
      `bytes 0-${FIRST_CHUNK - 1}/${TOTAL_BYTES}`,
      `bytes ${FIRST_CHUNK}-${TOTAL_BYTES - 1}/${TOTAL_BYTES}`,
    ]);
    // GCS: every chunk but the last is a multiple of 256 KiB.
    expect(FIRST_CHUNK % (256 * 1024)).toBe(0);
    // The API key travels in a header, never in a URL.
    for (const c of calls.filter((x) => new URL(x.url).host === 'identitytoolkit.googleapis.com')) {
      expect(c.url).not.toContain('key=');
      expect(c.headers['X-Goog-Api-Key']).toBe('the-key');
    }
  });

  it('never prints the ID token or the upload session, and masks both', async () => {
    const { out, masked } = await run();
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('secret-session');
    expect(masked).toEqual([TOKEN, SESSION]);
    expect(out).toContain(`jsonPayload.userId="${UID}"`);
  });

  it('a failing step fails the smoke, and the test user is still deleted', async () => {
    const { ok, results, calls } = await run({
      'POST /v1/search': () => new Response(JSON.stringify({ error: 'Search failed' }), { status: 500 }),
    });
    expect(ok).toBe(false);
    expect(results.find((r: { name: string }) => r.name.startsWith('POST /v1/search')).ok).toBe(false);
    expect(calls.at(-2)?.url).toBe(`${API}/v1/account/delete`);
    expect(results.at(-1)).toEqual({ name: 'the test user is gone', ok: true });
  });

  it('an upload the api refuses skips the chunks but still deletes the user', async () => {
    const { ok, calls } = await run({
      'POST /v1/uploads': () => new Response(JSON.stringify({ error: 'no' }), { status: 502 }),
    });
    expect(ok).toBe(false);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(calls.at(-2)?.url).toBe(`${API}/v1/account/delete`);
  });

  it('a chunk the api does not see, or an early complete that is accepted, fails', async () => {
    const lost = await run({
      'GET /v1/uploads/up-1': () => new Response(JSON.stringify({ receivedBytes: 0, complete: false }), { status: 200 }),
    });
    expect(lost.ok).toBe(false);
    const early = await run({
      'POST /v1/uploads/up-1/complete': () => new Response(JSON.stringify({ complete: true }), { status: 200 }),
    });
    expect(early.results.find((r: { name: string }) => r.name === 'completing early is refused').ok).toBe(false);
  });

  it('a network error mid-way still deletes the test user, then fails', async () => {
    const world = fakeWorld({
      'POST /v1/search': () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(
      runAuthSmoke({ apiUrl: API, apiKey: 'k', fetch: world.fetch, write: () => {}, traceId: 'b'.repeat(32) }),
    ).rejects.toThrow('fetch failed');
    expect(world.calls.at(-2)?.url).toBe(`${API}/v1/account/delete`);
  });

  it('GCS answering the first chunk with anything but 308 fails', async () => {
    let puts = 0;
    const { ok, results } = await run({
      'PUT SESSION': () => (++puts === 1 ? new Response(null, { status: 400 }) : undefined),
    });
    expect(ok).toBe(false);
    expect(results.find((r: { name: string }) => r.name === 'first chunk accepted, upload incomplete').ok).toBe(false);
  });

  it('a deletion that fails, or a user still there afterwards, fails the smoke', async () => {
    const failed = await run({
      'POST /v1/account/delete': () => new Response(JSON.stringify({ error: 'x' }), { status: 500 }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.results.at(-1)).toEqual({ name: 'the test user is gone', ok: false });
  });

  it('a failed sign-up stops before calling the api', async () => {
    const { ok, calls } = await run({
      'POST https://identitytoolkit.googleapis.com/v1/accounts:signUp': () =>
        new Response(JSON.stringify({ error: { message: 'ADMIN_ONLY_OPERATION' } }), { status: 400 }),
    });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
