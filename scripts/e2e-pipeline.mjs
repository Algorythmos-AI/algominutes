#!/usr/bin/env node
// The pipeline end to end on staging (RELEASE.md PR 14; rev 9's S2-PR2). One real
// recording through every service, sent as the clients send it, and checked in
// both stores:
//   1. an anonymous Firebase sign-up, and the e2e invite code redeemed (staging's
//      trial is off, so a new user has no minutes without one);
//   2. an N-minute recording (tests/fixtures/e2e-speech.ogg, looped by ffmpeg)
//      uploaded as the apps upload: POST /v1/uploads, the resumable session in
//      chunks, then /complete;
//   3. the note's Firestore doc written with the user's own token, as the apps
//      write it (the rules admit exactly those keys), then POST /v1/process;
//   4. the note ready within READY_MS (Firestore, polled with the user's token),
//      and how long it took (SLO-4);
//   5. Postgres agrees (POST /v1/notes/read): ready, a summary, a transcript; a
//      recording of 15 minutes or more has chapters;
//   6. with the project's logs readable (LOG_PROJECT): the run's one traceId is in
//      the api's, the transcoder's, the summarizer's and the embedder's logs, and
//      no dead letter was recorded for the note;
//   7. the account is deleted, whatever failed before, so no test user is left.
//
// Env: API_URL (the api's run.app URL), FIREBASE_API_KEY, FIREBASE_PROJECT_ID,
//   E2E_INVITE_CODE, MINUTES (default 2), READY_MS (default 10 minutes plus 20 s per
//   recorded minute), LOG_PROJECT (optional: without it the log checks say they
//   were skipped). Needs ffmpeg, and gcloud for the log checks.
// Exit 1 on any failure. The ID token, the invite code and the upload's session URI
// never reach the output.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
const FIRESTORE = 'https://firestore.googleapis.com/v1';
export const FIXTURE = path.resolve(import.meta.dirname, '../tests/fixtures/e2e-speech.ogg');
/** The services a recording passes through, each of which must log the run's traceId. */
export const TRACED_SERVICES = ['api', 'transcoder', 'summarizer', 'embedder'];
// Ten minutes or less goes through the transcoder's fast path (services/transcoder/src/route.js,
// FAST_PATH_MAX_SEC), which writes the summary itself: the summarizer never sees the note.
export const FAST_PATH_MAX_MINUTES = 10;
export const tracedServices = (minutes) =>
  (minutes <= FAST_PATH_MAX_MINUTES ? TRACED_SERVICES.filter((s) => s !== 'summarizer') : TRACED_SERVICES);
/** A recording this long or longer is summarised with chapters. */
export const CHAPTERS_FROM_MINUTES = 15;


/** A GCS resumable-upload session URL, or null: https on storage.googleapis.com only. */
export function gcsUploadUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    // silent-catch-ok: not a URL is simply not an upload session; the caller fails the check
    return null;
  }
  return u.protocol === 'https:' && u.hostname === 'storage.googleapis.com' && !u.username && !u.password && (!u.port || u.port === '443') ? u.href : null;
}

export function e2eConfig(env = process.env) {
  const need = (k) => {
    const v = (env[k] || '').trim();
    if (!v) throw new Error(`e2e-pipeline: ${k} is not set`);
    return v;
  };
  const minutes = Number(env.MINUTES || 2);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw new Error('e2e-pipeline: MINUTES is a whole number of minutes, 1 to 240');
  const ready = Number(env.READY_MS);
  return {
    apiUrl: need('API_URL').replace(/\/+$/, ''),
    apiKey: need('FIREBASE_API_KEY'),
    projectId: need('FIREBASE_PROJECT_ID'),
    inviteCode: need('E2E_INVITE_CODE'),
    minutes,
    readyMs: Number.isFinite(ready) && ready > 0 ? ready : 10 * 60_000 + minutes * 20_000,
    logProject: (env.LOG_PROJECT || '').trim(),
  };
}

/** The fixture looped to `minutes`, as Ogg Opus (what Chrome's recorder makes is WebM Opus; both go the same way). */
export function makeRecording(minutes, fixture = FIXTURE, run = execFileSync) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pipeline-')), `e2e-${minutes}min.ogg`);
  run('ffmpeg', ['-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', fixture, '-t', String(minutes * 60), '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', out]);
  return out;
}

/** Cloud Logging entries matching `filter` (gcloud, as the job's account). */
export function gcloudLogs(project, filter, run = execFileSync) {
  const outText = run('gcloud', ['logging', 'read', filter, `--project=${project}`, '--format=json', '--freshness=1d', '--limit=1000'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(outText || '[]');
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // silent-catch-ok: a body that isn't JSON (an HTML error page) is kept as text for the report
    return { raw: text.slice(0, 200) };
  }
}

const str = (v) => ({ stringValue: v });
const firestoreString = (doc, key) => doc?.fields?.[key]?.stringValue;

export async function runPipelineE2E({
  apiUrl,
  apiKey,
  projectId,
  inviteCode,
  minutes,
  readyMs,
  logProject = '',
  recording,
  readLogs = (filter) => gcloudLogs(logProject, filter),
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  pollMs = 15_000,
  logWaitMs = 60_000,
  write = (s) => process.stdout.write(s),
  traceId = `e2e-${randomBytes(12).toString('hex')}`,
}) {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok) });
    write(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
    return Boolean(ok);
  };
  const skip = (name, why) => write(`skip ${name} (${why})\n`);
  const identity = (method, body) =>
    fetch(`${IDENTITY}/accounts:${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify(body),
    });

  const signUp = await identity('signUp', { returnSecureToken: true });
  const account = await readJson(signUp);
  if (!check('anonymous sign-up', signUp.status === 200 && account.idToken && account.localId, `HTTP ${signUp.status}`)) {
    return { ok: false, results };
  }
  const { idToken, localId: uid } = account;
  const workspaceId = `workspace_${uid}`;
  const noteId = `e2e${randomBytes(12).toString('hex')}`;
  write(`test user ${uid}, note ${noteId}, traceId ${traceId}, ${minutes} min\n`);
  write(`logs: gcloud logging read 'jsonPayload.traceId="${traceId}"' --freshness=1d\n`);

  const api = async (method, p, body) => {
    const res = await fetch(`${apiUrl}/v1${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${idToken}`,
        'X-AlgoMinutes-Client': 'e2e/1.0.0',
        'X-Trace-Id': traceId,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await readJson(res) };
  };
  const noteDoc = `${FIRESTORE}/projects/${projectId}/databases/(default)/documents/workspaces/${workspaceId}/notes`;
  const firestore = async (method, url, body) => {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await readJson(res) };
  };

  try {
    const redeemed = await api('POST', '/beta/redeem', { code: inviteCode });
    const left = redeemed.body?.entitlement?.remainingMinutes;
    if (!check('the e2e invite code gives minutes', redeemed.status === 200 && left >= minutes, `HTTP ${redeemed.status}${left === undefined ? '' : `, ${left} min`}`)) return { ok: false, results };

    const bytes = fs.readFileSync(recording);
    const created = await api('POST', '/uploads', { noteId, workspaceId, fileName: 'recording.ogg', contentType: 'audio/ogg', totalBytes: bytes.length });
    const session = created.body;
    if (!check('POST /v1/uploads', created.status === 200 && session.sessionUri && session.storagePath === `recordings/${workspaceId}/${noteId}.ogg`, `HTTP ${created.status}`)) return { ok: false, results };
    // The fixture's bytes go only to Cloud Storage's own upload host, over HTTPS: never wherever a response says.
    const sessionUrl = gcsUploadUrl(session.sessionUri);
    if (!check('upload session is Cloud Storage', sessionUrl != null, 'the session URI is not an https://storage.googleapis.com URL')) return { ok: false, results };

    // The resumable session, a chunk at a time, resuming from what the api says GCS holds after a failure.
    const chunk = Math.max(256 * 1024, Math.floor((session.chunkSize || 8 * 1024 * 1024) / (256 * 1024)) * 256 * 1024);
    let sent = 0;
    let failures = 0;
    let finished = false;
    while (!finished && failures <= 3) {
      const end = Math.min(sent + chunk, bytes.length);
      const res = await fetch(sessionUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${sent}-${end - 1}/${bytes.length}` }, body: bytes.subarray(sent, end) });
      if (res.status === 200 || res.status === 201) finished = true;
      else if (res.status === 308) sent = end;
      else {
        failures += 1;
        sent = (await api('GET', `/uploads/${session.uploadId}`)).body?.receivedBytes ?? sent;
      }
    }
    const done = finished ? await api('POST', `/uploads/${session.uploadId}/complete`) : { status: 0, body: {} };
    if (!check(`the ${Math.round(bytes.length / 1024)} KiB recording uploads, and /complete`, done.status === 200 && done.body.complete === true, finished ? `HTTP ${done.status}` : 'GCS kept refusing')) return { ok: false, results };

    const stamp = new Date(now()).toISOString();
    const doc = await firestore('POST', `${noteDoc}?documentId=${noteId}`, {
      fields: {
        title: str(`E2E ${minutes} min`),
        status: str('processing'),
        type: str('recording'),
        mimeType: str('audio/ogg'),
        storagePath: str(session.storagePath),
        duration: { integerValue: String(minutes * 60) },
        workspaceId: str(workspaceId),
        authorId: str(uid),
        createdAt: str(stamp),
        updatedAt: str(stamp),
      },
    });
    if (!check("the note's doc, written as the apps write it", doc.status === 200, `HTTP ${doc.status}`)) return { ok: false, results };

    const started = now();
    const kickoff = await api('POST', '/process', { noteId, workspaceId, type: 'recording', storagePath: session.storagePath, mimeType: 'audio/ogg', durationSec: minutes * 60 });
    // A fresh note is queued with 200 (process-intelligence.js); 202 means another run already has it in flight.
    if (!check('POST /v1/process', kickoff.status === 200 && kickoff.body.status === 'queued', `HTTP ${kickoff.status}${kickoff.body?.error ? `, ${kickoff.body.error}` : ''}`)) return { ok: false, results };

    let status = 'processing';
    let error = '';
    while (!['ready', 'error'].includes(status) && now() - started < readyMs) {
      await sleep(pollMs);
      const got = await firestore('GET', `${noteDoc}/${noteId}`);
      if (got.status === 200) {
        status = firestoreString(got.body, 'status') ?? status;
        error = firestoreString(got.body, 'errorMessage') ?? '';
      }
    }
    const took = Math.round((now() - started) / 1000);
    if (!check(`ready within ${Math.round(readyMs / 60_000)} min (Firestore)`, status === 'ready', status === 'error' ? `failed: ${error}` : `${status} after ${took} s`)) return { ok: false, results };
    write(`     time to summary: ${took} s for ${minutes} min recorded\n`);

    const read = await api('POST', '/notes/read', { noteId, workspaceId });
    const pg = read.body;
    const chaptersWanted = minutes >= CHAPTERS_FROM_MINUTES;
    check(
      'Postgres agrees: ready, a summary and a transcript',
      read.status === 200 && pg.note?.status === 'ready' && pg.summary?.gist?.length > 0 && pg.transcript?.lines?.length > 0,
      `HTTP ${read.status}, ${pg.note?.status}, ${pg.transcript?.lines?.length ?? 0} lines`,
    );
    if (chaptersWanted) check(`a ${minutes}-minute recording has chapters`, (pg.summary?.chapters?.length ?? 0) >= 2, `${pg.summary?.chapters?.length ?? 0} chapters`);

    if (!logProject) {
      skip('the traceId in every service, and no dead letters', 'LOG_PROJECT not set');
    } else {
      // Log entries arrive a little after the lines are written.
      let services = new Set();
      const expected = tracedServices(minutes);
      for (let i = 0; i < 3 && !expected.every((s) => services.has(s)); i++) {
        await sleep(logWaitMs);
        services = new Set(readLogs(`jsonPayload.traceId="${traceId}"`).map((e) => e.resource?.labels?.service_name).filter(Boolean));
      }
      const missing = expected.filter((s) => !services.has(s));
      check('one traceId, followed through every service', missing.length === 0, missing.length ? `not in: ${missing.join(', ')}` : [...services].sort().join(', '));
      const dead = readLogs(`jsonPayload.msg="dead_letter_recorded" AND jsonPayload.noteId="${noteId}"`);
      check('no dead letter for the note', dead.length === 0, dead.length ? `${dead.length} recorded` : '');
    }
  } catch (err) {
    check('the run went to the end', false, String(err?.message ?? err).slice(0, 200));
  } finally {
    const deleted = await api('POST', '/account/delete').catch((err) => ({ status: 0, body: { raw: String(err?.message ?? err) } }));
    check('the test account is deleted', deleted.status === 200, `HTTP ${deleted.status}`);
  }
  return { ok: results.every((r) => r.ok), results };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = e2eConfig();
  const recording = makeRecording(config.minutes);
  const { ok } = await runPipelineE2E({ ...config, recording });
  process.exit(ok ? 0 : 1);
}
