'use strict';

// A meeting link, encrypted at rest (docs/plans/MEETINGS.md). Zoom links carry
// a pwd=, Teams links a join token: whoever has one can join the meeting. So the
// link is stored only as Cloud KMS ciphertext (meeting_bots.meeting_url_ciphertext),
// only until the bot is in the call, and never logged or put in a task body.
//
// Cloud KMS, in the environment's region: the api may only encrypt, the meetings
// service may only decrypt (per-key IAM, kms.tf). Each ciphertext is bound to its
// bot's id as additional authenticated data, so one bot's link can't be pasted
// onto another's row and decrypted there.

const { GoogleAuth } = require('google-auth-library');

const TIMEOUT_MS = 10_000;

function meetingUrlKeyName({ projectId, region, env }) {
  if (!projectId || !region || !env) throw new Error('meetingUrlKeyName: projectId, region and env are required');
  return `projects/${projectId}/locations/${region}/keyRings/algominutes-${env}/cryptoKeys/meeting-url`;
}

function createMeetingUrlCrypto({
  keyName,
  auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloudkms'] }),
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  if (!keyName) throw new Error('createMeetingUrlCrypto: no key');
  async function call(op, body) {
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    const res = await fetchImpl(`https://cloudkms.googleapis.com/v1/${keyName}:${op}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`kms ${op}: HTTP ${res.status}`);
    return res.json();
  }
  const aadOf = (boundTo) => {
    if (!boundTo) throw new Error('meeting-url-crypto: a bot id to bind the ciphertext to is required');
    return Buffer.from(String(boundTo), 'utf8').toString('base64');
  };
  return {
    /** The link as ciphertext (a Buffer for a BYTEA column), bound to boundTo (the bot's id). */
    async encrypt(meetingUrl, boundTo) {
      const out = await call('encrypt', {
        plaintext: Buffer.from(String(meetingUrl), 'utf8').toString('base64'),
        additionalAuthenticatedData: aadOf(boundTo),
      });
      return Buffer.from(out.ciphertext, 'base64');
    },
    /** The link back, only for the same bot id it was bound to. */
    async decrypt(ciphertext, boundTo) {
      const out = await call('decrypt', {
        ciphertext: Buffer.from(ciphertext).toString('base64'),
        additionalAuthenticatedData: aadOf(boundTo),
      });
      return Buffer.from(out.plaintext, 'base64').toString('utf8');
    },
  };
}

module.exports = { meetingUrlKeyName, createMeetingUrlCrypto };
