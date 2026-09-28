// Recall's API key and webhook secret(s), read from Secret Manager at run time.
//
// Not mounted into the Cloud Run env: a secret with no version yet (the owner
// adds them, docs/BLOCKERS.md) would fail every deploy. Read on first use and
// cached for five minutes, so a rotation reaches every instance within that. A
// secret that doesn't exist yet reads as null: the webhook answers 503 and the
// notetaker stays off.
import { GoogleAuth } from 'google-auth-library';

const TTL_MS = 5 * 60 * 1000;

export function createSecretReader({ projectId, auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }), fetchImpl = globalThis.fetch, now = Date.now }) {
  const cache = new Map();
  return async function readSecret(secretId, { log } = {}) {
    const hit = cache.get(secretId);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    const client = await auth.getClient();
    const { token } = await client.getAccessToken();
    const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretId}/versions/latest:access`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    let value = null;
    if (res.ok) {
      const body = await res.json();
      value = Buffer.from(body?.payload?.data || '', 'base64').toString('utf8').trim() || null;
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

/** The webhook secret may hold two values (a rotation), one per line. */
export function splitSecrets(value) {
  return String(value || '').split(/\s+/).map((s) => s.trim()).filter(Boolean);
}
