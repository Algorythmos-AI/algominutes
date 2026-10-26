'use strict';

// Apple DeviceCheck's two bits (RELEASE.md PR 22; developer.apple.com "Accessing and modifying per-device
// data"): a device that has had its reverse trial keeps bit0 set at Apple, across reinstalls, so a reinstall
// can't start a second trial. The app sends a fresh DeviceCheck token with its kickoff; the server asks Apple
// what that device's bits are, and sets bit0 once the trial starts.
//
// The token identifies a device: it is never logged or stored. The auth token is an ES256 JWT, as for APNs
// ({ alg: ES256, kid } / { iss: team id, iat }), reused for up to 40 minutes (Apple accepts one for an hour).

const crypto = require('node:crypto');

const HOSTS = {
  production: 'https://api.devicecheck.apple.com/v1',
  development: 'https://api.development.devicecheck.apple.com/v1',
};
const JWT_REUSE_MS = 40 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;

class DeviceCheckError extends Error {
  constructor(message, { status = 0, reason = null, code = null } = {}) {
    super(message);
    this.name = 'DeviceCheckError';
    this.status = status;
    // Apple's descriptive string ("Bad Device Token", "Invalid Authorization Token"), short and fixed.
    this.reason = reason;
    // What failed underneath, as a fixed identifier (ENOTFOUND, TimeoutError): never a message, which could
    // carry more. The logger keeps `code`.
    this.code = code;
  }

  /** Apple refused this request for good (a bad token, our key, a bad payload), not an outage to retry. */
  get permanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** The ES256 auth token Apple expects (the APNs provider-token shape). */
function deviceCheckJwt({ keyId, teamId, privateKeyPem, nowMs = Date.now() }) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(signature)}`;
}

/**
 * A DeviceCheck client. `environment`: 'production' for TestFlight and App Store builds (every tester and
 * user), 'development' for builds run from Xcode.
 */
function createDeviceCheckClient({
  keyId, teamId, privateKeyPem, environment = 'production', fetchImpl = globalThis.fetch,
  now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!keyId || !teamId || !privateKeyPem) throw new Error('devicecheck: keyId, teamId and privateKeyPem are required');
  const base = HOSTS[environment];
  if (!base) throw new Error(`devicecheck: unknown environment ${environment}`);
  let jwt = null;
  let jwtAt = 0;
  const authToken = () => {
    if (!jwt || now() - jwtAt > JWT_REUSE_MS) {
      jwt = deviceCheckJwt({ keyId, teamId, privateKeyPem, nowMs: now() });
      jwtAt = now();
    }
    return jwt;
  };

  async function call(path, deviceToken, extra = {}) {
    if (typeof deviceToken !== 'string' || !deviceToken) throw new DeviceCheckError('devicecheck: no device token', { status: 400, reason: 'Bad Device Token' });
    // Signed first, outside the network's try: a bad key is its own error, not "network error".
    const bearer = authToken();
    let res;
    let text;
    try {
      res = await fetchImpl(`${base}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_token: deviceToken, transaction_id: crypto.randomUUID(), timestamp: now(), ...extra }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = (await res.text()).trim();
    } catch (err) {
      // The fetch's own message and cause can quote the request: kept only as fixed identifiers.
      const code = String(err?.cause?.code || err?.code || err?.name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || null;
      throw new DeviceCheckError(`devicecheck ${path}: ${err?.name === 'TimeoutError' ? 'timed out' : 'network error'}`, { code });
    }
    if (!res.ok) {
      // Apple's body is its descriptive string; kept only if it is one (short, no JSON), never the request.
      const reason = /^[A-Za-z ]{1,60}$/.test(text) ? text : null;
      throw new DeviceCheckError(`devicecheck ${path}: HTTP ${res.status}${reason ? ` ${reason}` : ''}`, { status: res.status, reason });
    }
    return text;
  }

  return {
    /** { found: false } for a device whose bits were never set; else { found: true, bit0, bit1, lastUpdateTime }. */
    async queryTwoBits(deviceToken) {
      const text = await call('query_two_bits', deviceToken);
      if (!text || /bit state not found/i.test(text)) return { found: false };
      let body;
      try {
        body = JSON.parse(text);
      } catch (err) {
        // Not JSON.parse's message: it would quote the body.
        if (err instanceof SyntaxError) throw new DeviceCheckError('devicecheck query_two_bits: answer is not JSON', { status: 200 });
        throw err;
      }
      return { found: true, bit0: body.bit0 === true, bit1: body.bit1 === true, lastUpdateTime: body.last_update_time ?? null };
    },
    /** Set the device's bits (both are written: pass the one you keep, too). */
    async updateTwoBits(deviceToken, { bit0, bit1 }) {
      await call('update_two_bits', deviceToken, { bit0: Boolean(bit0), bit1: Boolean(bit1) });
    },
  };
}

module.exports = { createDeviceCheckClient, deviceCheckJwt, DeviceCheckError, HOSTS };
