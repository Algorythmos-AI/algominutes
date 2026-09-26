#!/usr/bin/env node
// Authenticated post-deploy smoke (plan L47). smoke-staging.sh proves the
// services are reachable and private where they should be. This proves a real
// user can use them: a missing role (run-api without Vertex, L31) or a broken
// auth path passes every unauthenticated check and fails here.
//
// It walks one user's life, as the app would, then deletes it:
//   1. an anonymous Firebase sign-up (Identity Toolkit, the app's API key);
//   2. GET /v1/config and GET /v1/entitlement;
//   3. a resumable upload against live GCS: POST /v1/uploads, a first chunk,
//      the api's status probe (it must see the chunk), a refused early
//      /complete, the last chunk, then /complete;
//   4. POST /v1/search, which embeds the query through Vertex as run-api
//      (the upload made the user a workspace member, so search gets that far);
//   5. POST /v1/account/delete, then an Identity Toolkit lookup that must say
//      the user is gone.
// Deletion runs even when an earlier step fails, so no test user is left
// behind. The ID token and the upload's session URI never reach the output.
//
// Env: API_URL (the api's run.app URL), FIREBASE_API_KEY (the iOS app's key,
// the GitHub secret STAGING_FIREBASE_API_KEY). Exit 1 on any failure.
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
// GCS takes every chunk but the last in multiples of 256 KiB.
export const FIRST_CHUNK = 256 * 1024;
export const TOTAL_BYTES = FIRST_CHUNK + 1024;

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // silent-catch-ok: a body that isn't JSON (an HTML error page) is kept as text for the report
    return { raw: text.slice(0, 200) };
  }
}

export async function runAuthSmoke({
  apiUrl,
  apiKey,
  fetch = globalThis.fetch,
  write = (s) => process.stdout.write(s),
  mask = () => {},
  traceId = randomBytes(16).toString('hex'),
}) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok) });
    write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
    return Boolean(ok);
  };
  const identity = (method, body) =>
    fetch(`${IDENTITY}/accounts:${method}`, {
      method: 'POST',
      // The key goes in a header, not the URL, so it isn't in request logs.
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify(body),
    });

  const signUp = await identity('signUp', { returnSecureToken: true });
  const account = await readJson(signUp);
  if (!check('anonymous sign-up', signUp.status === 200 && account.idToken && account.localId, `HTTP ${signUp.status}`)) {
    return { ok: false, results };
  }
  const { idToken, localId: uid } = account;
  mask(idToken);
  write(`test user ${uid}, traceId ${traceId}\n`);
  write(`logs: gcloud logging read 'jsonPayload.userId="${uid}"' --freshness=1h\n`);

  const api = async (method, path, body) => {
    const res = await fetch(`${apiUrl}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${idToken}`,
        'X-AlgoMinutes-Client': 'smoke/1.0.0',
        'X-Cloud-Trace-Context': `${traceId}/1;o=1`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await readJson(res) };
  };
  const put = (uri, from, to) =>
    fetch(uri, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${from}-${to - 1}/${TOTAL_BYTES}` },
      body: new Uint8Array(to - from),
    });

  try {
    const config = await api('GET', '/config');
    check('GET /v1/config', config.status === 200 && typeof config.body.broadcastCapture === 'boolean', `HTTP ${config.status}`);

    const ent = await api('GET', '/entitlement');
    check('GET /v1/entitlement', ent.status === 200 && ['free', 'pro', 'team'].includes(ent.body.plan), `HTTP ${ent.status}`);

    const workspaceId = `workspace_${uid}`;
    const created = await api('POST', '/uploads', {
      noteId: 'deploy-smoke',
      workspaceId,
      fileName: 'deploy-smoke.m4a',
      contentType: 'audio/mp4',
      totalBytes: TOTAL_BYTES,
    });
    const upload = created.body;
    if (
      check(
        'POST /v1/uploads (a live GCS resumable session)',
        created.status === 200 && upload.sessionUri && upload.uploadId &&
          upload.storagePath === `recordings/${workspaceId}/deploy-smoke.m4a`,
        `HTTP ${created.status}`,
      )
    ) {
      mask(upload.sessionUri);
      const first = await put(upload.sessionUri, 0, FIRST_CHUNK);
      check('first chunk accepted, upload incomplete', first.status === 308, `GCS HTTP ${first.status}`);

      const midway = await api('GET', `/uploads/${upload.uploadId}`);
      check(
        'the api sees the first chunk',
        midway.status === 200 && midway.body.receivedBytes === FIRST_CHUNK && midway.body.complete === false,
        `HTTP ${midway.status}, receivedBytes ${midway.body.receivedBytes}`,
      );

      const early = await api('POST', `/uploads/${upload.uploadId}/complete`);
      check('completing early is refused', early.status === 409, `HTTP ${early.status}`);

      const last = await put(upload.sessionUri, FIRST_CHUNK, TOTAL_BYTES);
      check('last chunk finalizes the object', last.status === 200 || last.status === 201, `GCS HTTP ${last.status}`);

      const done = await api('POST', `/uploads/${upload.uploadId}/complete`);
      check('POST /v1/uploads/:id/complete', done.status === 200 && done.body.complete === true, `HTTP ${done.status}`);

      const search = await api('POST', '/search', { query: 'deploy smoke check' });
      check('POST /v1/search (Vertex, as run-api)', search.status === 200 && Array.isArray(search.body.hits), `HTTP ${search.status}`);
    }
  } finally {
    const deleted = await api('POST', '/account/delete');
    check('POST /v1/account/delete', deleted.status === 200, `HTTP ${deleted.status}`);
    const lookup = await identity('lookup', { idToken });
    const gone = await readJson(lookup);
    check('the test user is gone', lookup.status === 400 && gone.error?.message === 'USER_NOT_FOUND', `HTTP ${lookup.status}`);
  }
  return { ok: results.every((r) => r.ok), results };
}

async function main() {
  const apiUrl = process.env.API_URL;
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiUrl || !apiKey) {
    process.stdout.write(
      'FAIL API_URL and FIREBASE_API_KEY are required (the GitHub secret STAGING_FIREBASE_API_KEY: runbook resume-staging-and-deploy.md)\n',
    );
    process.exit(1);
  }
  const mask = process.env.GITHUB_ACTIONS ? (v) => process.stdout.write(`::add-mask::${v}\n`) : () => {};
  const { ok } = await runAuthSmoke({ apiUrl: apiUrl.replace(/\/$/, ''), apiKey, mask });
  process.stdout.write(ok ? 'authenticated smoke: OK\n' : 'authenticated smoke: FAILED\n');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stdout.write(`FAIL authenticated smoke crashed: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
