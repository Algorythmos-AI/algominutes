import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
// @ts-expect-error: plain ESM modules, no type declarations
import { verifyRecallSignature, TOLERANCE_SECONDS } from '../services/meetings/src/lib/recall-signature.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { createRecallWebhookRoute, eventFields } from '../services/meetings/src/webhooks/recall.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { createTaskAuth } from '../services/meetings/src/lib/task-auth.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { splitSecrets, createSecretReader } from '../services/meetings/src/lib/secrets.js';
// @ts-expect-error: plain ESM modules, no type declarations
import { buildApp } from '../services/meetings/src/app.js';

// services/meetings (docs/plans/MEETINGS.md): Recall's webhooks are verified
// over the raw body and stored, and never answered with a 4xx for a real
// delivery (Svix disables an endpoint after 5 days of failures); /tasks/* is
// Cloud Tasks only, checked in the app because the service is public.
const KEY = crypto.randomBytes(24);
const SECRET = `whsec_${KEY.toString('base64')}`;
const OTHER = `whsec_${crypto.randomBytes(24).toString('base64')}`;
const NOW = 1_800_000_000_000;
function sign(body: string, { secret = SECRET, id = 'msg_1', ts = Math.floor(NOW / 1000) } = {}) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': `v1,${sig}` };
}
const BODY = JSON.stringify({
  event: 'bot.status_change',
  data: { data: { code: 'in_call_recording', sub_code: null, updated_at: '2026-09-28T01:02:03Z' }, bot: { id: 'recall-1', metadata: { meeting_bot_id: '7f0e0c1a-0000-4000-8000-000000000001', env: 'staging' } } },
});

describe('the Recall signature', () => {
  it('accepts Recall\'s signature over the exact bytes', () => {
    expect(verifyRecallSignature({ rawBody: Buffer.from(BODY), headers: sign(BODY), secrets: [SECRET], now: NOW })).toEqual({ ok: true, id: 'msg_1' });
  });

  it('refuses a changed body, another secret, and a missing header', () => {
    const h = sign(BODY);
    expect(verifyRecallSignature({ rawBody: BODY.replace('recall-1', 'recall-2'), headers: h, secrets: [SECRET], now: NOW })).toMatchObject({ ok: false, reason: 'signature_mismatch' });
    expect(verifyRecallSignature({ rawBody: BODY, headers: h, secrets: [OTHER], now: NOW })).toMatchObject({ ok: false, reason: 'signature_mismatch' });
    const { 'webhook-signature': _, ...noSig } = h;
    expect(verifyRecallSignature({ rawBody: BODY, headers: noSig, secrets: [SECRET], now: NOW })).toMatchObject({ ok: false, reason: 'missing_headers' });
  });

  it('refuses a replay older than the tolerance, either way', () => {
    const late = sign(BODY, { ts: Math.floor(NOW / 1000) - TOLERANCE_SECONDS - 1 });
    const early = sign(BODY, { ts: Math.floor(NOW / 1000) + TOLERANCE_SECONDS + 1 });
    expect(verifyRecallSignature({ rawBody: BODY, headers: late, secrets: [SECRET], now: NOW })).toMatchObject({ reason: 'stale_timestamp' });
    expect(verifyRecallSignature({ rawBody: BODY, headers: early, secrets: [SECRET], now: NOW })).toMatchObject({ reason: 'stale_timestamp' });
  });

  it('keeps working through a rotation: two of our secrets, or several signatures from Recall', () => {
    expect(verifyRecallSignature({ rawBody: BODY, headers: sign(BODY), secrets: [OTHER, SECRET], now: NOW }).ok).toBe(true);
    const h = sign(BODY);
    const many = { ...h, 'webhook-signature': `v1,${Buffer.from('x').toString('base64')} ${h['webhook-signature']}` };
    expect(verifyRecallSignature({ rawBody: BODY, headers: many, secrets: [SECRET], now: NOW }).ok).toBe(true);
  });

  it('accepts the legacy svix-* headers the same way', () => {
    const h = sign(BODY);
    const svix = { 'svix-id': h['webhook-id'], 'svix-timestamp': h['webhook-timestamp'], 'svix-signature': h['webhook-signature'] };
    expect(verifyRecallSignature({ rawBody: BODY, headers: svix, secrets: [SECRET], now: NOW }).ok).toBe(true);
  });

  it('splits a rotated secret into its values', () => {
    expect(splitSecrets(` ${SECRET}\n${OTHER} `)).toEqual([SECRET, OTHER]);
    expect(splitSecrets(null)).toEqual([]);
  });
});

// A fake req/res for the route.
function call(route: (req: any, res: any) => Promise<unknown>, { body = BODY, headers = sign(BODY) as Record<string, string> } = {}) {
  const out = { status: 0, body: undefined as unknown, logs: [] as string[] };
  const log = { info: (_o: unknown, m: string) => out.logs.push(m), warn: (_o: unknown, m: string) => out.logs.push(m), error: (_o: unknown, m: string) => out.logs.push(m) };
  const res = { status: (s: number) => ((out.status = s), res), json: (b: unknown) => ((out.body = b), res) };
  return route({ body: Buffer.from(body), headers, log }, res).then(() => out);
}

describe('POST /webhooks/recall', () => {
  const route = (over: Record<string, unknown> = {}) => {
    const recorded: any[] = [];
    const r = createRecallWebhookRoute({
      readSecret: async () => SECRET, env: { ALGOMINUTES_ENV: 'staging' }, now: () => NOW,
      record: async (e: unknown) => { recorded.push(e); return { inserted: recorded.length === 1, id: recorded.length }; },
      ...over,
    });
    return { r, recorded };
  };

  it('stores a verified event with the fields we key on, and answers 200', async () => {
    const { r, recorded } = route();
    const out = await call(r);
    expect(out.status).toBe(200);
    expect(recorded).toEqual([expect.objectContaining({
      webhookId: 'msg_1', event: 'bot.status_change', recallBotId: 'recall-1',
      meetingBotId: '7f0e0c1a-0000-4000-8000-000000000001', subCode: null,
    })]);
    expect(out.logs).toContain('recall_webhook_received');
  });

  it('a redelivery is answered 200 again (stored once, by the repo)', async () => {
    const { r } = route();
    expect((await call(r)).status).toBe(200);
    expect((await call(r)).status).toBe(200);
  });

  it('refuses a bad signature with 401 and stores nothing (not from Recall)', async () => {
    const { r, recorded } = route();
    const out = await call(r, { headers: sign(BODY, { secret: OTHER }) });
    expect(out.status).toBe(401);
    expect(recorded).toEqual([]);
    expect(out.logs).toContain('recall_webhook_signature_failed');
  });

  it('answers 200 and ignores an event for another environment', async () => {
    const { r, recorded } = route({ env: { ALGOMINUTES_ENV: 'prod' } });
    const out = await call(r);
    expect(out.status).toBe(200);
    expect(recorded).toEqual([]);
    expect(out.logs).toContain('recall_webhook_other_env');
  });

  it('answers 503 until the owner has added the webhook secret', async () => {
    const { r } = route({ readSecret: async () => null });
    expect((await call(r)).status).toBe(503);
  });

  it('a signed body that isn\'t JSON is answered 200 (a retry would change nothing)', async () => {
    const { r, recorded } = route();
    const out = await call(r, { body: 'not json', headers: sign('not json') });
    expect(out.status).toBe(200);
    expect(recorded).toEqual([]);
  });

  it('reads the bot and our metadata from either kind of Recall event', () => {
    expect(eventFields({ event: 'audio_mixed.done', data: { bot: { id: 'r2', metadata: { meeting_bot_id: 'm2', env: 'prod' } }, recording: { id: 'rec' } } }))
      .toMatchObject({ event: 'audio_mixed.done', recallBotId: 'r2', meetingBotId: 'm2', env: 'prod', subCode: null, occurredAt: null });
    expect(eventFields({})).toMatchObject({ event: 'unknown', recallBotId: null, meetingBotId: null });
  });
});

describe('/tasks/* OIDC', () => {
  const JOBS = 'run-jobs@p.iam.gserviceaccount.com';
  const auth = (verify: (o: { idToken: string; audience: string }) => unknown) =>
    createTaskAuth({ baseUrl: 'https://meetings.example.run.app/', serviceAccountEmail: JOBS, client: { verifyIdToken: async (o: any) => ({ getPayload: () => verify(o) }) } });
  async function run(mw: any, authorization?: string) {
    let status = 0; let nexted = false;
    const res: any = { status: (s: number) => ((status = s), res), json: () => res };
    const log = { warn: () => {}, error: () => {} };
    await mw({ headers: authorization ? { authorization } : {}, originalUrl: '/tasks/ingest?x=1', log }, res, () => { nexted = true; });
    return { status, nexted };
  }

  it('lets through run-jobs\' token for exactly this URL', async () => {
    let audience = '';
    const mw = auth((o) => { audience = o.audience; return { email: JOBS, email_verified: true }; });
    expect(await run(mw, 'Bearer tok')).toEqual({ status: 0, nexted: true });
    expect(audience).toBe('https://meetings.example.run.app/tasks/ingest');
  });

  it('reads the token whatever the case of "Bearer", and treats a bare or padded header as no token', async () => {
    const mw = auth(() => ({ email: JOBS, email_verified: true }));
    expect(await run(mw, 'bearer tok')).toEqual({ status: 0, nexted: true });
    expect(await run(mw, 'BEARER tok')).toEqual({ status: 0, nexted: true });
    expect(await run(mw, 'Bearer ')).toEqual({ status: 401, nexted: false });
    expect(await run(mw, `Bearer${' '.repeat(10000)}`)).toEqual({ status: 401, nexted: false });
    expect(await run(mw, 'Basic abc')).toEqual({ status: 401, nexted: false });
  });

  it('refuses no token (401), another identity or an unverified email (403), and a bad token (401)', async () => {
    expect(await run(auth(() => ({ email: JOBS, email_verified: true })))).toEqual({ status: 401, nexted: false });
    expect(await run(auth(() => ({ email: 'someone@else.iam.gserviceaccount.com', email_verified: true })), 'Bearer t')).toEqual({ status: 403, nexted: false });
    expect(await run(auth(() => ({ email: JOBS, email_verified: false })), 'Bearer t')).toEqual({ status: 403, nexted: false });
    expect(await run(auth(() => { throw new Error('Wrong recipient'); }), 'Bearer t')).toEqual({ status: 401, nexted: false });
  });
});

describe('the Secret Manager reader', () => {
  const auth = { getClient: async () => ({ getAccessToken: async () => ({ token: 't' }) }) };
  it('reads the latest version, reads a missing secret as null, and caches', async () => {
    let calls = 0;
    const fetchImpl = async (url: string) => {
      calls++;
      if (url.includes('/missing/')) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ payload: { data: Buffer.from(`${SECRET}\n`).toString('base64') } }) };
    };
    const read = createSecretReader({ projectId: 'p', auth, fetchImpl, now: () => 0 });
    expect(await read('recall-webhook-secret')).toBe(SECRET);
    expect(await read('recall-webhook-secret')).toBe(SECRET);
    expect(await read('missing')).toBeNull();
    expect(calls).toBe(2);
  });

  it('throws on a real failure, so the webhook answers 503 rather than trusting nothing', async () => {
    const read = createSecretReader({ projectId: 'p', auth, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) });
    await expect(read('recall-webhook-secret')).rejects.toThrow(/HTTP 403/);
  });
});

describe('the app, over HTTP', () => {
  async function serve(app: any) {
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
  }

  it('checks the signature over the raw bytes, and keeps /tasks behind the OIDC check', async () => {
    const app = buildApp({
      env: { ALGOMINUTES_ENV: 'other-env' },
      readSecret: async () => SECRET,
      taskAuth: (_req: any, res: any) => res.status(401).json({ error: 'Unauthorized' }),
    });
    const s = await serve(app);
    try {
      const nowHeaders = sign(BODY, { ts: Math.floor(Date.now() / 1000) });
      // Valid, but for another environment: answered 200 and ignored, before any database write.
      const ok = await fetch(`${s.url}/webhooks/recall`, { method: 'POST', headers: { ...nowHeaders, 'content-type': 'application/json' }, body: BODY });
      expect(ok.status).toBe(200);
      const bad = await fetch(`${s.url}/webhooks/recall`, { method: 'POST', headers: { ...nowHeaders, 'content-type': 'application/json' }, body: BODY.replace('recall-1', 'x') });
      expect(bad.status).toBe(401);
      expect((await fetch(`${s.url}/tasks/ingest`, { method: 'POST' })).status).toBe(401);
      expect((await fetch(`${s.url}/health`)).status).toBe(200);
      expect((await fetch(`${s.url}/nope`)).status).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('a task name from the path can only reach a handler it was given (never an inherited property)', async () => {
    const app = buildApp({ env: {}, readSecret: async () => null, taskAuth: (_req: any, _res: any, next: () => void) => next(), tasks: { ping: async (_req: any, res: any) => res.status(200).json({ ok: true }) } });
    const s = await serve(app);
    try {
      const post = (k: string) => fetch(`${s.url}/tasks/${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect((await post('ping')).status).toBe(200);
      for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect((await post(k)).status, k).toBe(404);
    } finally {
      await s.close();
    }
  });

  it('an authorised task with no handler yet is a 404, not a crash', async () => {
    const app = buildApp({ env: {}, readSecret: async () => null, taskAuth: (_req: any, _res: any, next: () => void) => next() });
    const s = await serve(app);
    try {
      expect((await fetch(`${s.url}/tasks/unknown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    } finally {
      await s.close();
    }
  });
});
