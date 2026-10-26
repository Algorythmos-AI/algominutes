'use strict';

// A secret read from Secret Manager at run time (services/meetings/src/lib/secrets.js has the same, for
// Recall's). Not mounted into the Cloud Run env: a secret with no version yet (the owner adds it) would fail
// every deploy. Read on first use and cached for five minutes, so a rotation reaches every instance within
// that. A secret with no version reads as null, and the feature that needs it stays off.

const TTL_MS = 5 * 60 * 1000;

function createSecretReader({ projectId, auth, fetchImpl = globalThis.fetch, now = Date.now }) {
  const cache = new Map();
  let authClient = auth;
  return async function readSecret(secretId, { log } = {}) {
    const hit = cache.get(secretId);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    if (!authClient) {
      const { GoogleAuth } = require('google-auth-library');
      authClient = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    }
    const client = await authClient.getClient();
    const { token } = await client.getAccessToken();
    const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretId}/versions/latest:access`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    let value = null;
    if (res.ok) {
      const body = await res.json();
      value = Buffer.from((body && body.payload && body.payload.data) || '', 'base64').toString('utf8').trim() || null;
    } else if (res.status !== 404) {
      // Not "no version yet": a real failure the caller should see.
      throw new Error(`secret ${secretId}: HTTP ${res.status}`);
    } else if (log) {
      log.warn({ secretId }, 'secret_not_set');
    }
    cache.set(secretId, { value, at: now() });
    return value;
  };
}

module.exports = { createSecretReader };
