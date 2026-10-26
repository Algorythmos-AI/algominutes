// Verifies that a webhook came from Recall.ai (docs/plans/MEETINGS.md).
//
// Recall signs each delivery the Standard Webhooks way
// (https://docs.recall.ai/docs/authenticating-requests-from-recallai):
//   webhook-id, webhook-timestamp, webhook-signature headers, and
//   HMAC-SHA256(key, "{id}.{timestamp}.{raw body}") in base64, where the key is
//   the base64 after the secret's "whsec_" prefix. The signature header may
//   carry several space-separated "v1,<sig>" entries (during Recall's rotation).
// Accounts created before 2025-12-15 send svix-id / svix-timestamp /
// svix-signature instead: the same scheme, accepted too.
//
// We also accept two secrets of our own, so rotating ours never drops a
// delivery, and refuse a timestamp more than five minutes off (a replayed
// capture). Every comparison is constant-time.
import crypto from 'node:crypto';

export const TOLERANCE_SECONDS = 5 * 60;

function header(headers, name) {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function keyOf(secret) {
  const s = String(secret || '').trim();
  const b64 = s.startsWith('whsec_') ? s.slice('whsec_'.length) : s;
  const key = Buffer.from(b64, 'base64');
  return key.length ? key : null;
}

function sameBytes(a, b) {
  const x = Buffer.from(a, 'base64');
  const y = Buffer.from(b, 'base64');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * @param {{ rawBody: Buffer|string, headers: Record<string, string|string[]>, secrets: string[], now?: number }} input
 * @returns {{ ok: true, id: string } | { ok: false, reason: string }}
 */
export function verifyRecallSignature({ rawBody, headers, secrets, now = Date.now() }) {
  const id = header(headers, 'webhook-id') ?? header(headers, 'svix-id');
  const ts = header(headers, 'webhook-timestamp') ?? header(headers, 'svix-timestamp');
  const sig = header(headers, 'webhook-signature') ?? header(headers, 'svix-signature');
  if (!id || !ts || !sig) return { ok: false, reason: 'missing_headers' };
  const seconds = Number(ts);
  if (!Number.isInteger(seconds)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(now / 1000 - seconds) > TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  const keys = (secrets || []).map(keyOf).filter(Boolean);
  if (!keys.length) return { ok: false, reason: 'no_secret' };

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  const signed = `${id}.${ts}.${body}`;
  const given = String(sig)
    .split(' ')
    .map((part) => part.split(',', 2))
    .filter(([version, value]) => version === 'v1' && value)
    .map(([, value]) => value);
  if (!given.length) return { ok: false, reason: 'no_v1_signature' };

  for (const key of keys) {
    const expected = crypto.createHmac('sha256', key).update(signed).digest('base64');
    if (given.some((g) => sameBytes(g, expected))) return { ok: true, id };
  }
  return { ok: false, reason: 'signature_mismatch' };
}
