import { describe, it, expect } from 'vitest';
import { handleExternal } from './messages';
import { readSession, saveSession } from './session';
import { fakeStorage, fakeFetch, json, idTokenFor } from './testing';

const PAGE = { origin: 'https://beta.example.test', url: 'https://beta.example.test/app/connect-extension' };

function world() {
  const storage = fakeStorage();
  const net = fakeFetch(() => json(500, {}));
  return { deps: { storage, fetch: net.fetch, now: () => 0, extensionId: 'abcdefghijklmnopabcdefghijklmnop' }, storage, calls: net.calls };
}

describe('messages from web pages', () => {
  it('only the web app\'s own origins are heard', async () => {
    const w = world();
    for (const sender of [{ origin: 'https://evil.example.test' }, { origin: 'http://beta.example.test' }, {}]) {
      expect(await handleExternal(w.deps, { type: 'hello' }, sender)).toEqual({ ok: false, error: 'origin' });
    }
    expect(w.storage.data.size).toBe(0);
  });

  it('anything but the four messages is refused', async () => {
    const w = world();
    expect(await handleExternal(w.deps, { type: 'record' }, PAGE)).toEqual({ ok: false, error: 'invalid' });
    expect(await handleExternal(w.deps, { type: 'link' }, PAGE)).toEqual({ ok: false, error: 'invalid' });
    expect(await handleExternal(w.deps, 'hello', PAGE)).toEqual({ ok: false, error: 'invalid' });
    expect(await handleExternal(w.deps, { type: 'link', code: 'x'.repeat(129) }, PAGE)).toEqual({ ok: false, error: 'invalid' });
    expect(await handleExternal(w.deps, { type: 'hello', code: 'c' }, PAGE)).toEqual({ ok: false, error: 'invalid' });
    expect(await handleExternal(w.deps, { type: 'hello', extra: 1 }, PAGE)).toEqual({ ok: false, error: 'invalid' });
    expect(await handleExternal(w.deps, null, PAGE)).toEqual({ ok: false, error: 'invalid' });
  });

  it('hello, status and sign-out', async () => {
    const w = world();
    expect(await handleExternal(w.deps, { type: 'hello' }, PAGE)).toMatchObject({ ok: true, version: '1.0.0', verifierHash: expect.any(String) });
    expect(await handleExternal(w.deps, { type: 'status' }, PAGE)).toEqual({ ok: true, signedIn: false, version: '1.0.0' });
    await saveSession(w.deps, { idToken: idTokenFor('alice'), refreshToken: 'r1', expiresIn: 3600 });
    expect(await handleExternal(w.deps, { type: 'status' }, PAGE)).toEqual({ ok: true, signedIn: true, version: '1.0.0' });
    expect(await handleExternal(w.deps, { type: 'sign-out' }, PAGE)).toEqual({ ok: true });
    expect(await readSession(w.deps)).toBeNull();
  });

  it('a link from another origin never reaches the api', async () => {
    const w = world();
    await handleExternal(w.deps, { type: 'hello' }, PAGE);
    expect(await handleExternal(w.deps, { type: 'link', code: 'c' }, { origin: 'https://evil.example.test' })).toEqual({ ok: false, error: 'origin' });
    expect(w.calls).toHaveLength(0);
  });
});
