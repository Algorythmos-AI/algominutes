import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// packages/ai/src/meeting-url-crypto.cjs and kms.tf: a notetaker's meeting link
// is stored only as Cloud KMS ciphertext bound to its bot's id; the api may only
// encrypt it (docs/plans/MEETINGS.md).
const require = createRequire(import.meta.url);
const { meetingUrlKeyName, createMeetingUrlCrypto } = require('../packages/ai/src/meeting-url-crypto.cjs');

const auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 't' }) }) };
const KEY = 'projects/p/locations/australia-southeast1/keyRings/algominutes-staging/cryptoKeys/meeting-url';

function fakeKms() {
  const calls: Array<{ url: string; body: any }> = [];
  // A stand-in for KMS: "ciphertext" is the plaintext reversed, and decrypt
  // refuses a different AAD, as KMS does.
  const fetchImpl = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    expect(init.headers.Authorization).toBe('Bearer t');
    if (url.endsWith(':encrypt')) {
      const ct = Buffer.concat([Buffer.from(body.additionalAuthenticatedData, 'base64'), Buffer.from('|'), Buffer.from(body.plaintext, 'base64').reverse()]);
      return { ok: true, status: 200, json: async () => ({ ciphertext: ct.toString('base64') }) };
    }
    const ct = Buffer.from(body.ciphertext, 'base64');
    const sep = ct.indexOf('|');
    if (ct.subarray(0, sep).toString('base64') !== body.additionalAuthenticatedData) return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ plaintext: Buffer.from(ct.subarray(sep + 1)).reverse().toString('base64') }) };
  };
  return { calls, fetchImpl };
}

describe('meeting-url-crypto', () => {
  it('names the environment\'s key in its region', () => {
    expect(meetingUrlKeyName({ projectId: 'p', region: 'australia-southeast1', env: 'staging' })).toBe(KEY);
    expect(() => meetingUrlKeyName({ projectId: 'p', region: '', env: 'staging' })).toThrow();
  });

  it('encrypts with the bot id as AAD, and decrypts only for that bot', async () => {
    const { calls, fetchImpl } = fakeKms();
    const c = createMeetingUrlCrypto({ keyName: KEY, auth, fetchImpl });
    const url = 'https://zoom.us/j/123?pwd=secret';
    const ct = await c.encrypt(url, 'bot-1');
    expect(Buffer.isBuffer(ct)).toBe(true);
    expect(ct.toString()).not.toContain('pwd=secret');
    expect(calls[0]).toMatchObject({ url: `https://cloudkms.googleapis.com/v1/${KEY}:encrypt`, body: { additionalAuthenticatedData: Buffer.from('bot-1').toString('base64') } });
    expect(await c.decrypt(ct, 'bot-1')).toBe(url);
    await expect(c.decrypt(ct, 'bot-2')).rejects.toThrow(/HTTP 400/);
  });

  it('refuses to encrypt or decrypt without a bot id to bind to', async () => {
    const c = createMeetingUrlCrypto({ keyName: KEY, auth, fetchImpl: fakeKms().fetchImpl });
    await expect(c.encrypt('https://meet.google.com/x', '')).rejects.toThrow(/bot id/);
    await expect(c.decrypt(Buffer.from('x'), undefined)).rejects.toThrow(/bot id/);
  });
});

describe('kms.tf', () => {
  const kms = readFileSync('infra/terraform/modules/environment/kms.tf', 'utf8');
  it('keeps the key in the environment\'s region, rotating, and never destroyed', () => {
    expect(kms).toMatch(/resource "google_kms_key_ring" "main"[\s\S]*?location\s*=\s*var\.region/);
    expect(kms).toMatch(/rotation_period\s*=\s*"7776000s"/);
    expect(kms).toMatch(/prevent_destroy\s*=\s*true/);
  });
  it('lets the api encrypt, and nothing on the api decrypt', () => {
    expect(kms).toMatch(/roles\/cloudkms\.cryptoKeyEncrypter"\s*\n\s*member\s*=\s*"serviceAccount:\$\{google_service_account\.runtime\["run-api"\]\.email\}"/);
    expect(kms).not.toMatch(/cryptoKeyDecrypter"[^}]*run-api/);
    expect(kms).not.toMatch(/cryptoKeyEncrypterDecrypter/);
  });
});
