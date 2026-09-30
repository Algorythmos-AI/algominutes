import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs script, no types
import { e2eConfig, runPipelineE2E, TRACED_SERVICES, formatFor, makeRecording, meetingScript, readyTargetSec } from '../scripts/e2e-pipeline.mjs';

// The pipeline e2e (scripts/e2e-pipeline.mjs), against a fake Identity Toolkit,
// api, GCS and Firestore that behave like the real ones.
const API = 'https://api-123.a.run.app';
const TOKEN = 'id-token-secret';
const CODE = 'BETA-7K2QX-M9D4R-TW8HN'; // gitleaks:allow
const SESSION = 'https://storage.googleapis.com/upload/resumable?upload_id=secret-session';
const UID = 'uid-1';
const FS = `https://firestore.googleapis.com/v1/projects/algominutes-staging/databases/(default)/documents/workspaces/workspace_${UID}/notes`;

const recording = (() => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pipeline-test-')), 'r.ogg');
  fs.writeFileSync(p, new Uint8Array(600 * 1024));
  return p;
})();

type Call = { method: string; url: string; headers: Record<string, string>; body?: any };

function world(opts: {
  ready?: 'ready' | 'error' | 'never';
  pgStatus?: string;
  chapters?: number;
  /** Where the chapters start, as a fraction of `spanMin` minutes (evenly spread when absent). */
  chapterSpan?: number;
  spanMin?: number;
  readyAfterPolls?: number;
  salvaged?: number;
  redeem?: number;
  services?: string[];
  deadLetters?: number;
  putFailsOnce?: boolean;
  sessionUri?: string;
} = {}) {
  const calls: Call[] = [];
  let held = 0;
  let total = 0;
  let noteId = '';
  let polls = 0;
  let deleted = false;
  let putFailed = false;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = async (url: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? 'GET', url, headers: (init.headers ?? {}) as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body };
    calls.push(call);
    const key = `${call.method} ${url.replace(API, '').replace(SESSION, 'SESSION').replace(FS, 'FS')}`;
    if (key === 'POST https://identitytoolkit.googleapis.com/v1/accounts:signUp') return json(200, { idToken: TOKEN, localId: UID });
    if (key === 'POST /v1/beta/redeem') {
      return opts.redeem === undefined ? json(200, { entitlement: { remainingMinutes: 600 } }) : json(opts.redeem, { error: 'invite_used_up' });
    }
    if (key === 'POST /v1/uploads') {
      noteId = call.body.noteId;
      total = call.body.totalBytes;
      const ext = String(call.body.fileName).split('.').pop();
      return json(200, { uploadId: 'up-1', sessionUri: opts.sessionUri ?? SESSION, chunkSize: 256 * 1024, storagePath: `recordings/workspace_${UID}/${noteId}.${ext}` });
    }
    if (key === 'PUT SESSION') {
      if (opts.putFailsOnce && !putFailed && held > 0) {
        putFailed = true;
        return new Response(null, { status: 503 });
      }
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(call.headers['Content-Range'])!;
      if (Number(m[1]) !== held) return new Response(null, { status: 503 });
      held = Number(m[2]) + 1;
      return new Response(null, { status: held < total ? 308 : 200 });
    }
    if (key === 'GET /v1/uploads/up-1') return json(200, { receivedBytes: held });
    if (key === 'POST /v1/uploads/up-1/complete') return held === total ? json(200, { complete: true }) : json(409, {});
    if (key.startsWith('POST FS?documentId=')) return json(200, { name: 'doc' });
    // The api's real answer: 200 with status queued (process-intelligence.js; tests/integration/process-kickoff.test.ts).
    if (key === 'POST /v1/process') return json(200, { success: true, noteId, status: 'queued' });
    if (key.startsWith('GET FS/')) {
      polls += 1;
      const status = opts.ready === 'never' || polls < (opts.readyAfterPolls ?? 2) ? 'processing' : opts.ready ?? 'ready';
      return json(200, { fields: { status: { stringValue: status }, ...(status === 'error' ? { errorMessage: { stringValue: 'transcription failed' } } : {}) } });
    }
    if (key === 'POST /v1/notes/read') {
      return json(200, {
        note: { status: opts.pgStatus ?? 'ready' },
        summary: {
          gist: 'The team agreed the launch date.',
          chapters: Array.from({ length: opts.chapters ?? 0 }, (_, i) => ({
            title: `c${i}`,
            startMs: Math.round((i / Math.max(1, (opts.chapters ?? 1) - 1)) * (opts.chapterSpan ?? 0.95) * (opts.spanMin ?? 0) * 60_000),
          })),
        },
        transcript: { lines: [{ text: 'hello' }] },
      });
    }
    if (key === 'POST /v1/account/delete') {
      deleted = true;
      return json(200, { ok: true });
    }
    return json(404, { error: `unexpected ${key}` });
  };
  const readLogs = (filter: string) => {
    if (filter.includes('dead_letter_recorded')) return Array.from({ length: opts.deadLetters ?? 0 }, () => ({}));
    if (filter.includes('summary_salvaged_partial')) return Array.from({ length: opts.salvaged ?? 0 }, () => ({}));
    return (opts.services ?? TRACED_SERVICES).map((s: string) => ({ resource: { labels: { service_name: s } } }));
  };
  return { fetch, readLogs, calls, deleted: () => deleted, noteId: () => noteId };
}

async function run(w: ReturnType<typeof world>, over: Record<string, unknown> = {}) {
  const lines: string[] = [];
  let clock = 0;
  const r = await runPipelineE2E({
    apiUrl: API, apiKey: 'key', projectId: 'algominutes-staging', inviteCode: CODE, minutes: 2, readyMs: 10 * 60_000,
    logProject: 'algominutes-staging', recording, readLogs: w.readLogs, fetch: w.fetch,
    sleep: async (ms: number) => void (clock += ms), now: () => clock, pollMs: 15_000, logWaitMs: 1,
    write: (s: string) => lines.push(s), traceId: 'e2e-trace-1', ...over,
  });
  const out = lines.join('');
  return { ...r, lines, out, fails: lines.filter((l) => l.startsWith('FAIL')).map((l) => l.slice(5).split(' (')[0]) };
}

describe('the pipeline e2e', () => {
  it('walks a recording through every service and both stores, then deletes the account', async () => {
    const w = world();
    const r = await run(w);
    expect(r.fails).toEqual([]);
    expect(r.ok).toBe(true);
    expect(w.deleted()).toBe(true);
    // The note's doc has only the keys the rules admit, as the apps write it.
    const doc = w.calls.find((c) => c.url.includes('?documentId='))!;
    expect(Object.keys(doc.body.fields).sort()).toEqual(['authorId', 'createdAt', 'duration', 'mimeType', 'status', 'storagePath', 'title', 'type', 'updatedAt', 'workspaceId']);
    expect(doc.body.fields.status.stringValue).toBe('processing');
    // Every api call carries the one traceId.
    for (const c of w.calls.filter((x) => new URL(x.url).origin === new URL(API).origin)) expect(c.headers['X-Trace-Id']).toBe('e2e-trace-1');
    // The token, the code and the session URI never reach the output.
    expect(r.out).not.toContain(TOKEN);
    expect(r.out).not.toContain(CODE);
    expect(r.out).not.toContain('secret-session');
    expect(r.out).toMatch(/time to summary: \d+ s for 2 min/);
  });

  it('resumes the upload from what the api says GCS holds', async () => {
    const w = world({ putFailsOnce: true });
    const r = await run(w);
    expect(r.fails).toEqual([]);
    expect(w.calls.some((c) => c.url === `${API}/v1/uploads/up-1`)).toBe(true);
  });

  it('a note that fails says why, and the account is still deleted', async () => {
    const w = world({ ready: 'error' });
    const r = await run(w);
    expect(r.ok).toBe(false);
    expect(r.lines.find((l) => l.startsWith('FAIL ready within'))).toMatch(/transcription failed/);
    expect(w.deleted()).toBe(true);
  });

  it('a note that never gets ready fails at READY_MS', async () => {
    const w = world({ ready: 'never' });
    const r = await run(w, { readyMs: 60_000 });
    expect(r.fails).toEqual(['ready within 1 min']);
    expect(w.deleted()).toBe(true);
  });

  it('Postgres disagreeing with Firestore fails the run', async () => {
    const r = await run(world({ pgStatus: 'summarizing' }));
    expect(r.fails).toEqual(['Postgres agrees: ready, a summary and a transcript']);
  });

  // Staging, 2026-09-30 (run 36729415737): a 2-minute note was ready in 33 s, and the run failed "not in:
  // summarizer". Ten minutes or less goes through the transcoder's fast path, which writes the summary itself.
  it('follows the traceId through the services that length of recording uses', async () => {
    const fast = ['api', 'transcoder', 'embedder'];
    expect((await run(world({ services: fast }), { minutes: 2 })).fails).toEqual([]);
    expect((await run(world({ services: fast, chapters: 4 }), { minutes: 15 })).fails).toEqual(['one traceId, followed through every service']);
    expect((await run(world({ services: [...fast, 'summarizer'], chapters: 4 }), { minutes: 15 })).fails).toEqual([]);
  });

  // RELEASE.md rev 11, LM3 (H12): long meetings, proven.
  describe('a long meeting', () => {
    const long = (over: Parameters<typeof world>[0] = {}) => world({ chapters: 10, spanMin: 60, ...over });
    it('passes with 8 or more chapters reaching its last quarter, whole, and inside the time bar', async () => {
      const r = await run(long(), { minutes: 60, format: 'webm' });
      expect(r.fails).toEqual([]);
      expect(r.out).toMatch(/ready within the bar \(10 min for 60 min\)/);
    });

    it('uploads as the format the apps make', async () => {
      const w = long();
      await run(w, { minutes: 60, format: 'webm' });
      expect(w.calls.find((c) => c.url.endsWith('/v1/uploads'))!.body).toMatchObject({ fileName: 'recording.webm', contentType: 'audio/webm' });
      expect(w.calls.find((c) => c.url.endsWith('/v1/process'))!.body.mimeType).toBe('audio/webm');
    });

    it('fails with too few chapters, chapters that stop early, a salvaged summary, or a slow run', async () => {
      expect((await run(long({ chapters: 7 }), { minutes: 60 })).fails).toEqual(['at least 8 chapters']);
      expect((await run(long({ chapterSpan: 0.5 }), { minutes: 60 })).fails).toEqual(['the chapters reach the last quarter of the meeting']);
      expect((await run(long({ salvaged: 1 }), { minutes: 60 })).fails).toEqual(['the summary came back whole, not salvaged']);
      // 45 polls of 15 s is over the 10-minute bar for an hour.
      expect((await run(long({ readyAfterPolls: 45 }), { minutes: 60, readyMs: 60 * 60_000 })).fails).toEqual(['ready within the bar']);
    });

    it('the time bar is 10 min for an hour, 15 for two, 25 up to four', () => {
      expect([60, 120, 180, 240].map(readyTargetSec)).toEqual([600, 900, 1500, 1500]);
    });

    it('each length goes as the format an app makes, the long ones alternating Chrome and iPhone', () => {
      expect([2, 15, 60, 120, 180, 240].map(formatFor)).toEqual(['ogg', 'adts', 'webm', 'adts', 'webm', 'adts']);
    });
  });

  describe('the meeting it speaks', () => {
    it('never repeats a sentence, moves through topics, and is long enough to fill the recording', () => {
      const text = meetingScript(60);
      const sentences = text.split(/(?<=\.)\s+/);
      expect(new Set(sentences).size).toBe(sentences.length);
      expect(text.split(/\s+/).length).toBeGreaterThanOrEqual(60 * 150);
      expect((text.match(/Next item/g) ?? []).length).toBeGreaterThanOrEqual(8);
    });

    it('with espeak-ng, the recording is that speech, encoded as the format; without it, the fixture looped', () => {
      const calls: Array<[string, string[]]> = [];
      const run = ((cmd: string, args: string[]) => { calls.push([cmd, args]); return Buffer.from(''); }) as never;
      makeRecording(60, 'fixture.ogg', run, 'adts', { speech: true, write: () => {} });
      expect(calls.map(([c]) => c)).toEqual(['espeak-ng', 'ffmpeg']);
      expect(calls[1][1]).toEqual(expect.arrayContaining(['-t', '3600', '-c:a', 'aac', '-f', 'adts']));
      calls.length = 0;
      makeRecording(15, 'fixture.ogg', run, 'webm', { speech: false, write: () => {} });
      expect(calls.map(([c]) => c)).toEqual(['ffmpeg']);
      expect(calls[0][1]).toEqual(expect.arrayContaining(['-stream_loop', '-1', '-i', 'fixture.ogg', '-f', 'webm']));
    });
  });

  it('a recording of 15 minutes or more must have chapters', async () => {
    expect((await run(world({ chapters: 0 }), { minutes: 15 })).fails).toEqual(['a 15-minute recording has chapters']);
    expect((await run(world({ chapters: 4 }), { minutes: 15 })).fails).toEqual([]);
    // A short one isn't asked for them.
    expect((await run(world({ chapters: 0 }), { minutes: 2 })).fails).toEqual([]);
  });

  it('a service the traceId never reached, or a dead letter, fails the run', async () => {
    const lost = await run(world({ services: ['api', 'transcoder'] }));
    expect(lost.lines.find((l) => l.startsWith('FAIL one traceId'))).toMatch(/not in: embedder$|not in: embedder\)/);
    const dead = await run(world({ deadLetters: 1 }));
    expect(dead.fails).toEqual(['no dead letter for the note']);
  });

  it('without the logs, their checks say they were skipped, not passed', async () => {
    const r = await run(world(), { logProject: '' });
    expect(r.ok).toBe(true);
    expect(r.out).toMatch(/^skip the traceId in every service, and no dead letters \(LOG_PROJECT not set\)$/m);
    expect(r.out).not.toMatch(/ok {3}one traceId/);
  });

  it('a refused invite code stops the run before anything is uploaded, and deletes the account', async () => {
    const w = world({ redeem: 409 });
    const r = await run(w);
    expect(r.fails).toEqual(['the e2e invite code gives minutes']);
    expect(w.calls.some((c) => c.url.endsWith('/v1/uploads'))).toBe(false);
    expect(w.deleted()).toBe(true);
  });

  it('takes its settings from the environment', () => {
    const env = { API_URL: 'https://api/', FIREBASE_API_KEY: 'k', FIREBASE_PROJECT_ID: 'p', E2E_INVITE_CODE: 'c' };
    expect(e2eConfig(env)).toMatchObject({ apiUrl: 'https://api', minutes: 2, readyMs: 10 * 60_000 + 40_000, logProject: '' });
    expect(e2eConfig({ ...env, MINUTES: '180' }).readyMs).toBe(10 * 60_000 + 180 * 20_000);
    expect(() => e2eConfig({ ...env, E2E_INVITE_CODE: '' })).toThrow(/E2E_INVITE_CODE/);
    expect(() => e2eConfig({ ...env, MINUTES: '2.5' })).toThrow(/MINUTES/);
  });
});

describe('its workflow', () => {
  const wf = fs.readFileSync('.github/workflows/e2e.yml', 'utf8');
  const job = wf.slice(wf.indexOf('\n  e2e:\n'));

  // RELEASE.md rev 11, LM3: an hour every night, two and four hours every week, with real speech (espeak-ng).
  it('runs 2, 15 and 60 minutes nightly, 120 and 240 weekly, and any of them by hand', () => {
    expect(wf).toMatch(/- cron: '47 17 \* \* \*'/);
    expect(wf).toMatch(/- cron: '7 15 \* \* 6'/);
    expect(wf).toContain("elif [ \"$SCHEDULE\" = \"7 15 * * 6\" ]; then minutes='[120,240]'");
    expect(wf).toContain("else minutes='[2,15,60]'; fi");
    expect(wf).toMatch(/options: \['2', '15', '60', '120', '180', '240'\]/);
    expect(wf).toMatch(/apt-get install -y -q ffmpeg espeak-ng/);
  });

  it('runs in the staging environment (the only one the deployer trusts), one length at a time', () => {
    expect(job).toMatch(/\n    environment: staging\n/);
    expect(job).toMatch(/\n      fail-fast: false\n      max-parallel: 1\n/);
    expect(job).toMatch(/\n      id-token: write\n/);
  });

  it('gives the invite code and the API key to the journey step only', () => {
    expect(wf.match(/secrets\.[A-Z0-9_]+/g)).toEqual(['secrets.E2E_INVITE_CODE', 'secrets.STAGING_FIREBASE_API_KEY', 'secrets.STAGING_FIREBASE_API_KEY', 'secrets.E2E_INVITE_CODE']);
    const step = job.slice(job.indexOf('- name: The pipeline, end to end'));
    expect(step).toContain('FIREBASE_API_KEY: ${{ secrets.STAGING_FIREBASE_API_KEY }}');
    expect(step).toContain('E2E_INVITE_CODE: ${{ secrets.E2E_INVITE_CODE }}');
    expect(job.slice(0, job.indexOf('- name: The pipeline, end to end'))).not.toContain('secrets.');
  });
});

describe('the upload session', () => {
  it('is used only when it is Cloud Storage over HTTPS', async () => {
    // @ts-expect-error: plain .mjs script, no type declarations
    const { gcsUploadUrl } = await import('../scripts/e2e-pipeline.mjs');
    expect(gcsUploadUrl('https://storage.googleapis.com/upload/resumable?upload_id=x')).toBe('https://storage.googleapis.com/upload/resumable?upload_id=x');
    for (const bad of ['http://storage.googleapis.com/u', 'https://storage.googleapis.com.evil.example/u', 'https://evilstorage.googleapis.com/u', 'https://evil.example/u', 'https://a:b@storage.googleapis.com/u', 'https://storage.googleapis.com:8443/u', 'nope']) {
      expect(gcsUploadUrl(bad), bad).toBeNull();
    }
  });

  it('an api that answers with another host gets no bytes: the run fails there', async () => {
    const w = world({ sessionUri: 'https://evil.example/upload?upload_id=x' });
    const r = await run(w);
    expect(r.ok).toBe(false);
    expect(r.fails).toContain('upload session is Cloud Storage');
    expect(w.calls.some((c) => new URL(c.url).hostname === 'evil.example')).toBe(false);
  });
});
