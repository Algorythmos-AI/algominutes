import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// Apple DeviceCheck's two bits (RELEASE.md PR 22): the client in @algominutes/ai, and the api's verdict for a
// new iOS user's trial. Apple is faked; the ES256 signature is checked with a real key pair.
const require = createRequire(import.meta.url);
const { createDeviceCheckClient, deviceCheckJwt, DeviceCheckError, HOSTS } = require('../packages/ai/src/devicecheck.cjs');

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
// A stand-in for the app's DeviceCheck token (opaque base64 to the server), built here so no literal looks like a key.
const TOKEN = Buffer.from('a device token, for tests').toString('base64');

function fakeApple(answers: Array<{ status: number; body: string }>) {
  const calls: any[] = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const a = answers.shift() ?? { status: 200, body: '' };
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => a.body };
  };
  return { calls, fetchImpl };
}
const decode = (part: string) => JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

describe('the auth token', () => {
  it('is an ES256 JWT, kid in the header and the team as issuer, signed so Apple can check it', () => {
    const jwt = deviceCheckJwt({ keyId: 'KEY123', teamId: 'TEAM45', privateKeyPem: PEM, nowMs: 1_700_000_000_000 });
    const [h, c, sig] = jwt.split('.');
    expect(decode(h)).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(decode(c)).toEqual({ iss: 'TEAM45', iat: 1_700_000_000 });
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    expect(ok).toBe(true);
  });
});

describe('the DeviceCheck client', () => {
  const client = (fetchImpl: any, over: object = {}) => createDeviceCheckClient({ keyId: 'KEY123', teamId: 'TEAM45', privateKeyPem: PEM, fetchImpl, now: () => 1_700_000_000_000, ...over });

  it('a device never marked is "not found"; a marked one reads its bits', async () => {
    const a = fakeApple([{ status: 200, body: 'Bit State Not Found' }, { status: 200, body: '{"bit0":true,"bit1":false,"last_update_time":"2026-09"}' }]);
    const dc = client(a.fetchImpl);
    expect(await dc.queryTwoBits(TOKEN)).toEqual({ found: false });
    expect(await dc.queryTwoBits(TOKEN)).toEqual({ found: true, bit0: true, bit1: false, lastUpdateTime: '2026-09' });
    expect(a.calls[0].url).toBe(`${HOSTS.production}/query_two_bits`);
    expect(a.calls[0].headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(a.calls[0].body).toEqual({ device_token: TOKEN, transaction_id: expect.stringMatching(/^[0-9a-f-]{36}$/), timestamp: 1_700_000_000_000 });
    expect(a.calls[1].body.transaction_id).not.toBe(a.calls[0].body.transaction_id);
  });

  it('writes both bits, to the environment asked for', async () => {
    const a = fakeApple([{ status: 200, body: '' }]);
    await client(a.fetchImpl, { environment: 'development' }).updateTwoBits(TOKEN, { bit0: true, bit1: true });
    expect(a.calls[0].url).toBe(`${HOSTS.development}/update_two_bits`);
    expect(a.calls[0].body).toMatchObject({ device_token: TOKEN, bit0: true, bit1: true });
  });

  it('keeps one auth token for 40 minutes, then signs a new one', async () => {
    let t = 1_700_000_000_000;
    const a = fakeApple([]);
    const dc = createDeviceCheckClient({ keyId: 'K', teamId: 'T', privateKeyPem: PEM, fetchImpl: a.fetchImpl, now: () => t });
    await dc.queryTwoBits(TOKEN);
    t += 39 * 60_000;
    await dc.queryTwoBits(TOKEN);
    t += 2 * 60_000;
    await dc.queryTwoBits(TOKEN);
    const auths = a.calls.map((c) => c.headers.Authorization);
    expect(auths[1]).toBe(auths[0]);
    expect(auths[2]).not.toBe(auths[0]);
  });

  it('a refusal carries Apple\'s status and descriptive string, and never the device token', async () => {
    const a = fakeApple([
      { status: 400, body: 'Bad Device Token' },
      { status: 401, body: '{"echo":"' + TOKEN + '"}' },
      { status: 200, body: `{"bit0":` },
    ]);
    const dc = client(a.fetchImpl);
    const bad = await dc.queryTwoBits(TOKEN).catch((e: Error) => e);
    expect(bad).toBeInstanceOf(DeviceCheckError);
    expect(bad).toMatchObject({ status: 400, reason: 'Bad Device Token', message: 'devicecheck query_two_bits: HTTP 400 Bad Device Token' });
    const odd = await dc.queryTwoBits(TOKEN).catch((e: Error) => e);
    expect(odd).toMatchObject({ status: 401, reason: null });
    const broken = await dc.queryTwoBits(TOKEN).catch((e: Error) => e);
    expect(broken.message).toBe('devicecheck query_two_bits: answer is not JSON');
    for (const e of [bad, odd, broken]) expect(JSON.stringify({ m: e.message, s: e.stack })).not.toContain(TOKEN);
  });

  it('a key that can\'t sign is its own error, never "network error"; a network failure keeps only its code', async () => {
    const badKey = createDeviceCheckClient({ keyId: 'K', teamId: 'T', privateKeyPem: 'not a key', fetchImpl: async () => { throw new Error('fetched'); } });
    const e = await badKey.queryTwoBits(TOKEN).catch((x: Error) => x);
    expect(e).not.toBeInstanceOf(DeviceCheckError);
    expect(e.message).not.toMatch(/network error|fetched/);
    const dns = client(async () => { throw Object.assign(new TypeError(`fetch failed ${TOKEN}`), { cause: { code: 'ENOTFOUND', message: `getaddrinfo ${TOKEN}` } }); });
    const n = await dns.queryTwoBits(TOKEN).catch((x: any) => x);
    expect(n).toMatchObject({ message: 'devicecheck query_two_bits: network error', code: 'ENOTFOUND', status: 0 });
    expect(n.permanent).toBe(false);
    // A body that breaks off mid-read is a DeviceCheckError too.
    const cut = client(async () => ({ ok: true, status: 200, text: async () => { throw Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } }); } }));
    await expect(cut.queryTwoBits(TOKEN)).rejects.toMatchObject({ name: 'DeviceCheckError', code: 'UND_ERR_SOCKET' });
  });

  it('a network failure or timeout says which, without the token; no token asks Apple nothing', async () => {
    const dc = client(async () => { throw Object.assign(new Error(`connect ${TOKEN}`), { name: 'TimeoutError' }); });
    const e = await dc.queryTwoBits(TOKEN).catch((x: Error) => x);
    expect(e.message).toBe('devicecheck query_two_bits: timed out');
    const a = fakeApple([]);
    await expect(client(a.fetchImpl).queryTwoBits('')).rejects.toMatchObject({ reason: 'Bad Device Token' });
    expect(a.calls).toEqual([]);
  });

  it('refuses to start without its key, team and a known environment', () => {
    expect(() => createDeviceCheckClient({ keyId: '', teamId: 'T', privateKeyPem: PEM })).toThrow(/required/);
    expect(() => createDeviceCheckClient({ keyId: 'K', teamId: 'T', privateKeyPem: PEM, environment: 'sandbox' })).toThrow(/unknown environment/);
  });
});

describe('the api\'s trial device (services/api device-check.js)', async () => {
  // @ts-expect-error: plain ESM module, no type declarations
  const { createTrialDevices } = await import('../services/api/src/device-check.js');
  const ENV = { DEVICECHECK_KEY_ID: 'KEY123', APPLE_TEAM_ID: 'TEAM45' };
  function logger() {
    const lines: any[] = [];
    const log = {
      info: (o: any, m: string) => lines.push({ level: 'info', m, ...o }),
      warn: (o: any, m: string) => lines.push({ level: 'warn', m, ...o }),
      error: (o: any, m: string) => lines.push({ level: 'error', m, ...o }),
    };
    return { log, lines };
  }
  function apple(bits: any) {
    const calls: string[] = [];
    return {
      calls,
      createClient: (cfg: any) => {
        calls.push(`client:${cfg.environment}:${cfg.privateKeyPem.length}`);
        return {
          queryTwoBits: async () => { calls.push('query'); return bits; },
          updateTwoBits: async (_t: string, b: any) => { calls.push(`update:${b.bit0}:${b.bit1}`); },
        };
      },
    };
  }

  it('only an iOS kickoff with a token has a device to ask about', () => {
    const devices = createTrialDevices({ env: ENV, readSecret: async () => PEM, createClient: apple({ found: false }).createClient });
    const { log } = logger();
    expect(devices({ token: '', platform: 'ios', log })).toBeUndefined();
    expect(devices({ token: TOKEN, platform: 'android', log })).toBeUndefined();
    expect(devices({ token: TOKEN, platform: undefined, log })).toBeUndefined();
  });

  it('a device Apple has never marked is unused; its trial marks bit0 and keeps bit1', async () => {
    const a = apple({ found: true, bit0: false, bit1: true });
    const { log, lines } = logger();
    const d = createTrialDevices({ env: ENV, readSecret: async () => PEM, createClient: a.createClient })({ token: TOKEN, platform: 'ios', log });
    expect(await d.trialUsed()).toBe(false);
    await d.markTrialUsed();
    expect(a.calls).toEqual([`client:production:${PEM.length}`, 'query', 'update:true:true']);
    expect(lines.map((l) => l.m)).toEqual(['trial_device_checked', 'trial_device_marked']);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it('a device that has had its trial is used', async () => {
    const d = createTrialDevices({ env: ENV, readSecret: async () => PEM, createClient: apple({ found: true, bit0: true, bit1: false }).createClient })({ token: TOKEN, platform: 'ios', log: logger().log });
    expect(await d.trialUsed()).toBe(true);
  });

  it('not configured (no key id, or no key in Secret Manager): no trial, it says which, and marking fails loudly', async () => {
    for (const [cfg, missing] of [[{ env: {}, readSecret: async () => PEM }, 'env'], [{ env: ENV, readSecret: async () => null }, 'secret']] as const) {
      const a = apple({ found: false });
      const { log, lines } = logger();
      const d = createTrialDevices({ ...cfg, createClient: a.createClient })({ token: TOKEN, platform: 'ios', log });
      expect(await d.trialUsed()).toBe(true);
      await expect(d.markTrialUsed()).rejects.toThrow(`devicecheck_not_configured: ${missing}`);
      expect(a.calls).toEqual([]);
      expect(lines).toEqual([expect.objectContaining({ level: 'error', m: 'devicecheck_not_configured', missing })]);
    }
  });

  it('Apple refusing for good (our key, this token) is no trial and an error line; an outage is thrown for a retry', async () => {
    const refusing = (status: number, reason: string) => createTrialDevices({
      env: ENV, readSecret: async () => PEM,
      createClient: () => ({ queryTwoBits: async () => { throw new DeviceCheckError(`devicecheck query_two_bits: HTTP ${status} ${reason}`, { status, reason }); } }),
    });
    for (const [status, reason] of [[401, 'Invalid Authorization Token'], [403, 'Forbidden'], [400, 'Bad Device Token']] as const) {
      const { log, lines } = logger();
      expect(await refusing(status, reason)({ token: TOKEN, platform: 'ios', log }).trialUsed(), String(status)).toBe(true);
      expect(lines).toEqual([expect.objectContaining({ level: 'error', m: 'devicecheck_refused', status, reason })]);
    }
    for (const status of [429, 500, 503]) {
      await expect(refusing(status, 'Service Unavailable')({ token: TOKEN, platform: 'ios', log: logger().log }).trialUsed()).rejects.toMatchObject({ status });
    }
  });

  it('Apple unreachable throws, so the kickoff is retried rather than the trial denied', async () => {
    const d = createTrialDevices({
      env: ENV, readSecret: async () => PEM,
      createClient: () => ({ queryTwoBits: async () => { throw new DeviceCheckError('devicecheck query_two_bits: HTTP 503', { status: 503 }); } }),
    })({ token: TOKEN, platform: 'ios', log: logger().log });
    await expect(d.trialUsed()).rejects.toMatchObject({ status: 503 });
  });

  it('a rotated key makes a new client', async () => {
    let pem = PEM;
    const a = apple({ found: false });
    const devices = createTrialDevices({ env: { ...ENV, DEVICECHECK_ENV: 'development' }, readSecret: async () => pem, createClient: a.createClient });
    await devices({ token: TOKEN, platform: 'ios', log: logger().log }).trialUsed();
    await devices({ token: TOKEN, platform: 'ios', log: logger().log }).trialUsed();
    pem = `${PEM}\n`;
    await devices({ token: TOKEN, platform: 'ios', log: logger().log }).trialUsed();
    expect(a.calls.filter((c) => c.startsWith('client:'))).toEqual([`client:development:${PEM.length}`, `client:development:${PEM.length + 1}`]);
  });
});
