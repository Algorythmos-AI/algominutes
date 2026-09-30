import { describe, it, expect } from 'vitest';
import { idToken, readSession, saveSession } from './session';
import { fakeStorage, fakeFetch, json, idTokenFor } from './testing';

function world(answer: () => Response) {
  const storage = fakeStorage();
  let t = 0;
  const net = fakeFetch(answer);
  return { deps: { storage, fetch: net.fetch, now: () => t }, calls: net.calls, at: (ms: number) => { t = ms; } };
}

describe('idToken', () => {
  it('signed out: none, and no call', async () => {
    const w = world(() => json(500, {}));
    expect(await idToken(w.deps)).toBeNull();
    expect(w.calls).toHaveLength(0);
  });

  it('a token with more than five minutes left is used as it is', async () => {
    const w = world(() => json(500, {}));
    await saveSession(w.deps, { idToken: idTokenFor('alice'), refreshToken: 'r1', expiresIn: 3600 });
    w.at(3600_000 - 5 * 60_000 - 1);
    expect(await idToken(w.deps)).toBe(idTokenFor('alice'));
    expect(w.calls).toHaveLength(0);
  });

  it('one about to lapse is refreshed, and the new tokens kept', async () => {
    const w = world(() => json(200, { id_token: idTokenFor('alice', 2), refresh_token: 'r2', expires_in: '3600' }));
    await saveSession(w.deps, { idToken: idTokenFor('alice'), refreshToken: 'r1', expiresIn: 3600 });
    w.at(3600_000 - 60_000);
    expect(await idToken(w.deps)).toBe(idTokenFor('alice', 2));
    expect(w.calls[0]!.url).toBe('https://securetoken.googleapis.com/v1/token?key=test-firebase-web-key');
    expect(w.calls[0]!.body).toBe('grant_type=refresh_token&refresh_token=r1');
    expect(await readSession(w.deps)).toMatchObject({ refreshToken: 'r2', expiresAt: 3600_000 - 60_000 + 3600_000 });
  });

  it('Firebase refusing the refresh (deleted, or revoked) signs the extension out', async () => {
    const w = world(() => json(400, { error: { message: 'TOKEN_EXPIRED' } }));
    await saveSession(w.deps, { idToken: idTokenFor('alice'), refreshToken: 'r1', expiresIn: 3600 });
    w.at(3600_000);
    expect(await idToken(w.deps)).toBeNull();
    expect(await readSession(w.deps)).toBeNull();
  });

  it('the network failing keeps the session for the next try', async () => {
    const w = world(() => { throw new TypeError('Failed to fetch'); });
    await saveSession(w.deps, { idToken: idTokenFor('alice'), refreshToken: 'r1', expiresIn: 3600 });
    w.at(3600_000);
    await expect(idToken(w.deps)).rejects.toThrow('Failed to fetch');
    expect(await readSession(w.deps)).not.toBeNull();
  });
});
