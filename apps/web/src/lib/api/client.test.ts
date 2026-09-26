import { describe, expect, it, vi } from 'vitest';
import openapi from '../../../../../packages/contracts/openapi/openapi.v1.json';
import { createApiClient, type ApiClient, type ChatEvent } from './client';
import { ApiError } from './errors';
import { CLIENT_HEADER_VALUE, originsFromEnv, parseOrigin } from './config';

// The web client against a fake fetch: what each call sends (method, host,
// path, headers, body), how it reads answers, and how each failure maps. The
// iOS twin is APIClientTests.
const ORIGINS = { api: 'https://api.example.test', billing: 'https://billing.example.test' };

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(respond: (sent: Sent, n: number) => Response = () => json({})) {
  const sent: Sent[] = [];
  const tokens: boolean[] = [];
  const onUpdateRequired = vi.fn();
  let trace = 0;
  const client = createApiClient({
    origins: ORIGINS,
    getIdToken: async (force) => {
      tokens.push(force);
      return force ? 'token-2' : 'token-1';
    },
    newTraceId: () => `trace-${++trace}`,
    onUpdateRequired,
    fetch: async (input, init) => {
      const s: Sent = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      };
      sent.push(s);
      return respond(s, sent.length);
    },
  });
  return { client, sent, tokens, onUpdateRequired };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

// Every call, with what it must send. `run` may fail on the empty {} answer (invalid_response); only the request is checked here.
const CALLS: Array<{ name: keyof ApiClient; run: (c: ApiClient) => Promise<unknown>; method: string; url: string; body?: unknown; auth?: boolean }> = [
  { name: 'entitlement', run: (c) => c.entitlement(), method: 'GET', url: `${ORIGINS.api}/v1/entitlement` },
  { name: 'appConfig', run: (c) => c.appConfig(), method: 'GET', url: `${ORIGINS.api}/v1/config` },
  { name: 'acceptTerms', run: (c) => c.acceptTerms({ termsVersion: 't', privacyVersion: 'p' }), method: 'POST', url: `${ORIGINS.api}/v1/account/accept-terms`, body: { termsVersion: 't', privacyVersion: 'p' } },
  { name: 'setRetention', run: (c) => c.setRetention({ retentionDays: 30 }), method: 'POST', url: `${ORIGINS.api}/v1/account/retention`, body: { retentionDays: 30 } },
  { name: 'deleteAccount', run: (c) => c.deleteAccount(), method: 'POST', url: `${ORIGINS.api}/v1/account/delete`, body: {} },
  { name: 'support', run: (c) => c.support({ kind: 'contact', message: 'hi' }), method: 'POST', url: `${ORIGINS.api}/v1/support`, body: { kind: 'contact', message: 'hi' } },
  { name: 'trackEvent', run: (c) => c.trackEvent({ event: 'paywall_viewed' }), method: 'POST', url: `${ORIGINS.api}/v1/events`, body: { event: 'paywall_viewed' } },
  { name: 'registerPush', run: (c) => c.registerPush({ token: 'fcm', platform: 'web' }), method: 'POST', url: `${ORIGINS.api}/v1/push/register`, body: { token: 'fcm', platform: 'web' } },
  { name: 'readNote', run: (c) => c.readNote({ noteId: 'n1', workspaceId: 'w1' }), method: 'POST', url: `${ORIGINS.api}/v1/notes/read`, body: { noteId: 'n1', workspaceId: 'w1' } },
  { name: 'updateNote', run: (c) => c.updateNote({ noteId: 'n1', workspaceId: 'w1', title: 'T' }), method: 'POST', url: `${ORIGINS.api}/v1/notes/update`, body: { noteId: 'n1', workspaceId: 'w1', title: 'T' } },
  { name: 'deleteNote', run: (c) => c.deleteNote({ noteId: 'n1', workspaceId: 'w1' }), method: 'POST', url: `${ORIGINS.api}/v1/notes/delete`, body: { noteId: 'n1', workspaceId: 'w1' } },
  { name: 'noteAudioUrl', run: (c) => c.noteAudioUrl({ noteId: 'n1', workspaceId: 'w1' }), method: 'POST', url: `${ORIGINS.api}/v1/notes/audio-url`, body: { noteId: 'n1', workspaceId: 'w1' } },
  { name: 'setSpeakers', run: (c) => c.setSpeakers('n/1', { workspaceId: 'w1', speakers: [] }), method: 'POST', url: `${ORIGINS.api}/v1/notes/n%2F1/speakers`, body: { workspaceId: 'w1', speakers: [] } },
  { name: 'regenerateSummary', run: (c) => c.regenerateSummary({ noteId: 'n1', workspaceId: 'w1' }), method: 'POST', url: `${ORIGINS.api}/v1/notes/regenerate-summary`, body: { noteId: 'n1', workspaceId: 'w1' } },
  { name: 'noteFeedback', run: (c) => c.noteFeedback({ noteId: 'n1', workspaceId: 'w1', rating: 4 }), method: 'POST', url: `${ORIGINS.api}/v1/notes/feedback`, body: { noteId: 'n1', workspaceId: 'w1', rating: 4 } },
  { name: 'exportNote', run: (c) => c.exportNote({ noteId: 'n1', workspaceId: 'w1' }), method: 'POST', url: `${ORIGINS.api}/v1/export`, body: { noteId: 'n1', workspaceId: 'w1' } },
  { name: 'createUpload', run: (c) => c.createUpload({ noteId: 'n1', workspaceId: 'w1', fileName: 'a.webm', contentType: 'audio/webm', totalBytes: 10 }), method: 'POST', url: `${ORIGINS.api}/v1/uploads`, body: { noteId: 'n1', workspaceId: 'w1', fileName: 'a.webm', contentType: 'audio/webm', totalBytes: 10 } },
  { name: 'uploadStatus', run: (c) => c.uploadStatus('u 1'), method: 'GET', url: `${ORIGINS.api}/v1/uploads/u%201` },
  { name: 'completeUpload', run: (c) => c.completeUpload('u1'), method: 'POST', url: `${ORIGINS.api}/v1/uploads/u1/complete`, body: {} },
  { name: 'process', run: (c) => c.process({ noteId: 'n1', workspaceId: 'w1', type: 'recording', storagePath: 'p', durationSec: 60 }), method: 'POST', url: `${ORIGINS.api}/v1/process`, body: { noteId: 'n1', workspaceId: 'w1', type: 'recording', storagePath: 'p', durationSec: 60 } },
  { name: 'search', run: (c) => c.search({ query: 'q' }), method: 'POST', url: `${ORIGINS.api}/v1/search`, body: { query: 'q' } },
  { name: 'chat', run: async (c) => { for await (const _ of c.chat({ query: 'q' })) void _; }, method: 'POST', url: `${ORIGINS.api}/v1/chat`, body: { query: 'q' } },
  { name: 'createShare', run: (c) => c.createShare({ noteId: 'n1', workspaceId: 'w1' }), method: 'POST', url: `${ORIGINS.api}/v1/shares/create`, body: { noteId: 'n1', workspaceId: 'w1' } },
  { name: 'revokeShare', run: (c) => c.revokeShare({ noteId: 'n1', workspaceId: 'w1', shareId: 's1' }), method: 'POST', url: `${ORIGINS.api}/v1/shares/revoke`, body: { noteId: 'n1', workspaceId: 'w1', shareId: 's1' } },
  { name: 'readShare', run: (c) => c.readShare({ token: 'tok' }), method: 'POST', url: `${ORIGINS.api}/v1/shares/read`, body: { token: 'tok' }, auth: false },
  { name: 'checkout', run: (c) => c.checkout({ productId: 'pro_monthly', period: 'monthly' }), method: 'POST', url: `${ORIGINS.billing}/v1/billing/checkout`, body: { productId: 'pro_monthly', period: 'monthly' } },
  { name: 'portal', run: (c) => c.portal(), method: 'POST', url: `${ORIGINS.billing}/v1/billing/portal`, body: {} },
  { name: 'reportClientError', run: (c) => c.reportClientError({ kind: 'k', message: 'm' }), method: 'POST', url: `${ORIGINS.api}/v1/client-error`, body: { kind: 'k', message: 'm' }, auth: false },
];

describe('every call sends the right request', () => {
  it.each(CALLS)('$name → $method $url', async ({ run, method, url, body, auth = true }) => {
    const { client, sent } = harness();
    const r = await settle(run(client));
    if (!r.ok) expect((r.e as ApiError).kind).toBe('invalid_response');
    expect(sent).toHaveLength(1);
    const s = sent[0];
    expect(s.method).toBe(method);
    expect(s.url).toBe(url);
    expect(s.body).toEqual(body);
    expect(s.headers['X-AlgoMinutes-Client']).toBe(CLIENT_HEADER_VALUE);
    expect(s.headers['X-Trace-Id']).toBe('trace-1');
    if (auth) expect(s.headers.Authorization).toBe('Bearer token-1');
    else expect(s.headers.Authorization).toBeUndefined();
    expect(s.headers['Content-Type']).toBe(body === undefined ? undefined : 'application/json');
  });

  it('covers every operation in the published api contract (bar health and admin)', () => {
    const operations = Object.entries(openapi.paths as Record<string, Record<string, unknown>>)
      .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path.replace(/\{[^}]+\}/g, ':p')}`))
      .filter((op) => !/\/v1\/(health|admin)/.test(op) && op !== 'DELETE /v1/account/delete')
      .sort();
    const covered = CALLS.filter((c) => c.url.startsWith(ORIGINS.api))
      .map((c) => `${c.method} ${new URL(c.url).pathname.replace(/\/v1\/notes\/[^/]+\/speakers/, '/v1/notes/:p/speakers').replace(/\/v1\/uploads\/[^/]+(\/complete)?$/, '/v1/uploads/:p$1')}`)
      .sort();
    expect(covered).toEqual(operations);
  });

  it('says web and the package version, which the api must accept', () => {
    expect(CLIENT_HEADER_VALUE).toMatch(/^web\/\d+\.\d+\.\d+$/);
    const [maj] = CLIENT_HEADER_VALUE.slice(4).split('.').map(Number);
    expect(maj).toBeGreaterThanOrEqual(1); // MIN_SUPPORTED_CLIENT.web is 1.0.0
  });
});

describe('answers', () => {
  it('returns the typed body when it matches the contract', async () => {
    const entitlement = { state: 'trialing', plan: 'free', billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 5, remainingMinutes: 55, overQuota: false };
    const { client } = harness(() => json(entitlement));
    expect(await client.entitlement()).toEqual(entitlement);
  });

  it('refuses a 2xx body that breaks the contract, keeping the trace id', async () => {
    const { client } = harness(() => json({ state: 'nonsense' }));
    const r = await settle(client.entitlement());
    expect(r.ok).toBe(false);
    expect(r.ok || [(r.e as ApiError).kind, (r.e as ApiError).traceId]).toEqual(['invalid_response', 'trace-1']);
  });

  it('accepts each kickoff answer (queued, cached, in flight)', async () => {
    for (const body of [
      { success: true, noteId: 'n', jobId: 'j', status: 'queued' },
      { success: true, noteId: 'n', cached: true },
      { success: true, noteId: 'n', status: 'transcribing', inFlight: true },
    ]) {
      const { client } = harness(() => json(body, 202));
      expect(await client.process({ noteId: 'n', workspaceId: 'w', type: 'recording', storagePath: 'p' })).toEqual(body);
    }
  });

  it('a 204 is fine for the crash beacon', async () => {
    const { client } = harness(() => new Response(null, { status: 204 }));
    expect(await client.reportClientError({ kind: 'k' })).toBeUndefined();
  });

  it('downloads an export with its file name', async () => {
    const { client, sent } = harness(() => new Response('DOCX', { status: 200, headers: { 'Content-Disposition': `attachment; filename*=UTF-8''Stand%20up.docx` } }));
    const { blob, fileName } = await client.exportNote({ noteId: 'n', workspaceId: 'w' });
    expect(await blob.text()).toBe('DOCX');
    expect(fileName).toBe('Stand up.docx');
    expect(sent[0].headers.Accept).toBe('*/*');
  });
});

describe('failures map as iOS maps them', () => {
  const cases: Array<[string, Response, string]> = [
    ['402 quota', json({ error: 'quota_exceeded', entitlement: { state: 'expired', plan: 'free', billingPeriod: '2026-09', includedMinutes: 60, usedMinutes: 60, remainingMinutes: 0, overQuota: true } }, 402), 'quota_exceeded'],
    ['402 other', json({ error: 'payment_required' }, 402), 'bad_request'],
    ['404', json({ error: 'note_not_found' }, 404), 'not_found'],
    ['409', json({ error: 'already_regenerating', status: 'summarizing' }, 409), 'conflict'],
    ['413', json({ error: 'too_large' }, 413), 'too_large'],
    ['429', json({ error: 'rate_limited' }, 429, { 'Retry-After': '7' }), 'rate_limited'],
    ['500', json({ error: 'internal' }, 500), 'server'],
    ['502 html', new Response('<html>bad gateway</html>', { status: 502 }), 'server'],
    ['400', json({ error: 'invalid' }, 400), 'bad_request'],
  ];
  it.each(cases)('%s → %s', async (_, res, kind) => {
    const { client } = harness(() => res.clone());
    const r = await settle(client.entitlement());
    expect(r.ok).toBe(false);
    const e = (r as { e: ApiError }).e;
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe(kind);
    expect(e.traceId).toBe('trace-1');
    if (kind === 'quota_exceeded') expect(e.entitlement?.overQuota).toBe(true);
    if (kind === 'rate_limited') expect(e.retryAfterSec).toBe(7);
    if (kind === 'conflict') expect(e.body).toMatchObject({ status: 'summarizing' });
  });

  it('426 is update_required, and tells the app', async () => {
    const { client, onUpdateRequired } = harness(() => json({ error: 'client_version_unsupported' }, 426));
    const r = await settle(client.readNote({ noteId: 'n', workspaceId: 'w' }));
    expect((r as { e: ApiError }).e.kind).toBe('update_required');
    expect(onUpdateRequired).toHaveBeenCalledTimes(1);
  });

  it('a 401 refreshes the token once and retries with the same trace id', async () => {
    const entitlement = { state: 'active', plan: 'pro', billingPeriod: '2026-09', includedMinutes: null, usedMinutes: 0, remainingMinutes: null, overQuota: false };
    const { client, sent, tokens } = harness((_, n) => (n === 1 ? json({ error: 'unauthorized' }, 401) : json(entitlement)));
    expect(await client.entitlement()).toEqual(entitlement);
    expect(tokens).toEqual([false, true]);
    expect(sent.map((s) => s.headers.Authorization)).toEqual(['Bearer token-1', 'Bearer token-2']);
    expect(sent.map((s) => s.headers['X-Trace-Id'])).toEqual(['trace-1', 'trace-1']);
  });

  it('a second 401 is not_signed_in, with no third try', async () => {
    const { client, sent } = harness(() => json({ error: 'unauthorized' }, 401));
    const r = await settle(client.entitlement());
    expect((r as { e: ApiError }).e.kind).toBe('not_signed_in');
    expect(sent).toHaveLength(2);
  });

  it('a public call is never retried on a 401', async () => {
    const { client, sent } = harness(() => json({ error: 'unauthorized' }, 401));
    await settle(client.readShare({ token: 't' }));
    expect(sent).toHaveLength(1);
  });

  it('nobody signed in: nothing is sent', async () => {
    const sent: unknown[] = [];
    const client = createApiClient({ origins: ORIGINS, getIdToken: async () => null, fetch: async () => { sent.push(1); return json({}); } });
    const r = await settle(client.entitlement());
    expect((r as { e: ApiError }).e.kind).toBe('not_signed_in');
    expect(sent).toEqual([]);
  });

  it('no answer at all is network', async () => {
    const client = createApiClient({ origins: ORIGINS, getIdToken: async () => 't', fetch: async () => { throw new TypeError('Failed to fetch'); } });
    const r = await settle(client.entitlement());
    expect((r as { e: ApiError }).e.kind).toBe('network');
  });
});

describe('chat', () => {
  // Sent 7 bytes at a time, so frames and line ends split across chunks.
  const stream = (frames: string) => {
    const bytes = new TextEncoder().encode(frames);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const hit = { noteId: 'n', noteTitle: 'T', chunkText: 'c', startMs: 0, endMs: 1000 };
  const collect = async (client: ApiClient) => {
    const out: ChatEvent[] = [];
    for await (const ev of client.chat({ query: 'q' })) out.push(ev);
    return out;
  };

  it('yields citations, the answer in pieces, then done', async () => {
    const { client, sent } = harness(() => stream(`event: citations\ndata: ${JSON.stringify({ hits: [hit] })}\n\ndata: {"text":"Hel"}\n\ndata: {"text":"lo"}\n\nevent: done\ndata: {}\n\n`));
    expect(await collect(client)).toEqual([{ type: 'citations', hits: [hit] }, { type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'done' }]);
    expect(sent[0].headers.Accept).toBe('text/event-stream');
  });

  it('a stream error is an error event', async () => {
    const { client } = harness(() => stream(`data: {"text":"x"}\n\nevent: error\ndata: {"error":"stream_failed"}\n\n`));
    expect(await collect(client)).toEqual([{ type: 'text', text: 'x' }, { type: 'error', error: 'stream_failed' }]);
  });

  it('a stream cut off before done says so', async () => {
    const { client } = harness(() => stream(`data: {"text":"x"}\n\n`));
    expect(await collect(client)).toEqual([{ type: 'text', text: 'x' }, { type: 'error', error: 'stream_ended' }]);
  });

  it('a refused chat (404) throws before any event', async () => {
    const { client } = harness(() => json({ error: 'note_not_found' }, 404));
    const r = await settle(collect(client));
    expect((r as { e: ApiError }).e.kind).toBe('not_found');
  });
});

describe('origins', () => {
  it('takes https origins, and http only on localhost', () => {
    expect(parseOrigin('https://api-1.a.run.app/', 'X')).toBe('https://api-1.a.run.app');
    expect(parseOrigin('http://localhost:8080', 'X')).toBe('http://localhost:8080');
    for (const bad of ['', 'http://api.example.com', 'https://api.example.com/v1', 'not a url', 'https://a.com?x=1']) {
      expect(() => parseOrigin(bad, 'X'), bad).toThrow();
    }
  });

  it('needs both origins in the build', () => {
    expect(originsFromEnv({ VITE_API_ORIGIN: 'https://a.test', VITE_BILLING_ORIGIN: 'https://b.test' })).toEqual({ api: 'https://a.test', billing: 'https://b.test' });
    expect(() => originsFromEnv({ VITE_API_ORIGIN: 'https://a.test' })).toThrow(/VITE_BILLING_ORIGIN/);
  });
});

describe('aborts, timeouts and token failures (review)', () => {
  const abortable = () =>
    (async (_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const sig = init?.signal;
        // As fetch does: an already-aborted signal rejects at once.
        if (sig?.aborted) reject(sig.reason ?? new DOMException('Aborted', 'AbortError'));
        sig?.addEventListener('abort', () => reject(sig.reason ?? new DOMException('Aborted', 'AbortError')));
      })) as typeof fetch;

  it("Stop before the first byte aborts the request itself, as 'cancelled'", async () => {
    const stop = new AbortController();
    const client = createApiClient({ origins: ORIGINS, getIdToken: async () => 't', fetch: abortable() });
    const run = (async () => { for await (const _ of client.chat({ query: 'q' }, stop.signal)) void _; })();
    stop.abort();
    const r = await settle(run);
    expect((r as { e: ApiError }).e.kind).toBe('cancelled');
  });

  it("no answer in time is 'timeout'", async () => {
    const client = createApiClient({ origins: ORIGINS, getIdToken: async () => 't', fetch: abortable(), timeoutMs: 20 });
    const r = await settle(client.entitlement());
    expect((r as { e: ApiError }).e.kind).toBe('timeout');
  });

  it('Stop mid-answer ends the stream quietly and closes the connection', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"text":"one"}\n\n')); },
      cancel() { cancelled = true; },
    });
    const stop = new AbortController();
    const client = createApiClient({ origins: ORIGINS, getIdToken: async () => 't', fetch: async () => new Response(body, { status: 200 }) });
    const got: ChatEvent[] = [];
    for await (const ev of client.chat({ query: 'q' }, stop.signal)) {
      got.push(ev);
      stop.abort();
      break;
    }
    expect(got).toEqual([{ type: 'text', text: 'one' }]);
    expect(cancelled).toBe(true);
  });

  it('a malformed citations frame is still invalid_response, not a quiet stream end', async () => {
    const client = createApiClient({ origins: ORIGINS, getIdToken: async () => 't', fetch: async () => new Response('event: citations\ndata: {"hits":"nope"}\n\n', { status: 200 }) });
    const r = await settle((async () => { for await (const _ of client.chat({ query: 'q' })) void _; })());
    expect((r as { e: ApiError }).e.kind).toBe('invalid_response');
  });

  it('a token refresh that fails is an ApiError, never a raw Firebase error', async () => {
    const offline = Object.assign(new Error('Firebase: Error (auth/network-request-failed).'), { code: 'auth/network-request-failed' });
    const revoked = Object.assign(new Error('Firebase: Error (auth/user-token-expired).'), { code: 'auth/user-token-expired' });
    for (const [err, kind] of [[offline, 'network'], [revoked, 'not_signed_in']] as const) {
      const client = createApiClient({ origins: ORIGINS, getIdToken: async (force) => { if (force) throw err; return 't'; }, fetch: async () => json({ error: 'unauthorized' }, 401) });
      const r = await settle(client.entitlement());
      expect((r as { e: ApiError }).e).toBeInstanceOf(ApiError);
      expect((r as { e: ApiError }).e.kind).toBe(kind);
    }
  });

  it("an export whose plain file name has a stray % still downloads", async () => {
    const { client } = harness(() => new Response('DOCX', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="100% done.docx"' } }));
    expect((await client.exportNote({ noteId: 'n', workspaceId: 'w' })).fileName).toBe('100% done.docx');
  });
});
