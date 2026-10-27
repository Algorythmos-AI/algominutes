import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// The shared Gemini ladder (CLAUDE.md: summarizer + transcoder fast path both
// go through it). Driven through its injection points: no network, no GCP.
const require = createRequire(import.meta.url);
const { callGeminiWithLadder } = require('../packages/ai/src/gemini-call.cjs');

type Reply = { status: number; body?: unknown; text?: string };
function fakeFetch(replies: Record<string, Reply[]>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    const model = /models\/([^:]+):generateContent/.exec(url)![1]!;
    calls.push(model);
    const r = replies[model]!.shift()!;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => r.text ?? '',
    };
  };
  return { impl, calls };
}
const ok = (text: string, finishReason = 'STOP'): Reply => ({
  status: 200,
  body: { candidates: [{ content: { parts: [{ text }] }, finishReason }] },
});
function logSpy() {
  const events: Array<{ level: string; msg: string; obj: any }> = [];
  const at = (level: string) => (obj: any, msg: string) => events.push({ level, msg, obj });
  return { log: { info: at('info'), warn: at('warn'), error: at('error') }, events };
}
const base = (over: Record<string, unknown>) => ({
  parts: [{ text: 'hi' }],
  project: 'p',
  location: 'australia-southeast1',
  tokenProvider: async () => 't',
  sleepFn: async () => {},
  ...over,
});

afterEach(() => vi.useRealTimers());

describe('callGeminiWithLadder', () => {
  it('falls through to the next rung when a model is unavailable (404), without retrying it', async () => {
    const { impl, calls } = fakeFetch({ 'model-a': [{ status: 404, text: 'NOT_FOUND' }], 'model-b': [ok('{"a":1}')] });
    const { log, events } = logSpy();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a', 'model-b'], fetchImpl: impl, log }));
    expect(out).toMatchObject({ rawText: '{"a":1}', model: 'model-b', error: null });
    expect(calls).toEqual(['model-a', 'model-b']);
    expect(events.find((e) => e.msg === 'gemini_model_unavailable')?.obj).toMatchObject({ model: 'model-a' });
  });

  it('retries a transient error on the same model before moving on', async () => {
    const { impl, calls } = fakeFetch({ 'model-a': [{ status: 503, text: 'UNAVAILABLE' }, ok('{"a":1}')] });
    const { log } = logSpy();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log }));
    expect(out.model).toBe('model-a');
    expect(calls).toEqual(['model-a', 'model-a']);
  });

  // Plan rev 12 S2: a quota refusal is the case for asking Google for more quota or provisioned throughput; an
  // outage (503) is not. Both stay gemini_transient (and retried); a 429 also logs gemini_rate_limited.
  it('a quota refusal (429 / RESOURCE_EXHAUSTED) is logged as rate-limited too; a 503 is not', async () => {
    const { log, events } = logSpy();
    const { impl } = fakeFetch({
      'model-a': [
        { status: 429, text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' },
        { status: 503, text: '{"error":{"status":"UNAVAILABLE"}}' },
        ok('{"gist":"x"}'),
      ],
    });
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log }));
    expect(out).toMatchObject({ rawText: '{"gist":"x"}', error: null });
    expect(events.filter((e) => e.msg === 'gemini_transient')).toHaveLength(2);
    const limited = events.filter((e) => e.msg === 'gemini_rate_limited');
    expect(limited).toHaveLength(1);
    expect(limited[0]!.obj).toMatchObject({ model: 'model-a', attempt: 1 });
  });

  // Production, 2026-10-27: a 23 s note's fast path hit 429s 2–4 s apart, gave the rung up after 3, and the task
  // went back to Cloud Tasks four times (19 minutes). A quota refusal now backs off longer (2, 4, 8, 16 s, with
  // jitter) and gets 5 attempts on the rung, all inside the ladder's budget; an outage keeps 3 quick ones.
  it('a 429 backs off for longer and gets 5 attempts on the rung; a 503 keeps 3 quick ones', async () => {
    const waits: number[] = [];
    const sleepFn = async (ms: number) => { waits.push(ms); };
    const limited = { status: 429, text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' };
    const { impl, calls } = fakeFetch({ 'model-a': [limited, limited, limited, limited, ok('{"a":1}')] });
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log: logSpy().log, sleepFn }));
    expect(out).toMatchObject({ rawText: '{"a":1}', error: null });
    expect(calls).toHaveLength(5);
    expect(waits).toHaveLength(4);
    [2_000, 4_000, 8_000, 16_000].forEach((floor, i) => {
      expect(waits[i]).toBeGreaterThanOrEqual(floor);
      expect(waits[i]).toBeLessThan(floor + 1_000);
    });

    const outage = { status: 503, text: '{"error":{"status":"UNAVAILABLE"}}' };
    const quick: number[] = [];
    const { impl: down, calls: downCalls } = fakeFetch({ 'model-a': [outage, outage, outage] });
    const failed = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: down, log: logSpy().log, sleepFn: async (ms: number) => { quick.push(ms); } }));
    expect(failed.error?.message).toMatch(/503/);
    expect(downCalls).toHaveLength(3);
    expect(Math.max(...quick)).toBeLessThan(2_500);
  });

  it('a 429 that never clears ends the rung after 5 attempts, then the next rung is asked', async () => {
    const limited = { status: 429, text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' };
    const { impl, calls } = fakeFetch({ 'model-a': Array(5).fill(limited), 'model-b': [ok('{"b":1}')] });
    const { log, events } = logSpy();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a', 'model-b'], fetchImpl: impl, log }));
    expect(out).toMatchObject({ model: 'model-b', error: null });
    expect(calls.filter((m) => m === 'model-a')).toHaveLength(5);
    expect(events.filter((e) => e.msg === 'gemini_rate_limited')).toHaveLength(5);
    expect(events.find((e) => e.msg === 'gemini_model_exhausted')?.obj).toMatchObject({ model: 'model-a' });
  });

  it('never sleeps past the budget: a 429 backoff longer than what is left ends the call with the 429', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const waits: number[] = [];
    const limited = { status: 429, text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' };
    const { impl, calls } = fakeFetch({ 'model-a': [limited, limited, limited, limited, limited] });
    const out = await callGeminiWithLadder(base({
      modelLadder: ['model-a'], fetchImpl: impl, log: logSpy().log, deadlineMs: 10_000,
      sleepFn: async (ms: number) => { waits.push(ms); now += ms; },
    }));
    // 2 s and 4 s fit in 10 s; 8 s more would not.
    expect(waits).toHaveLength(2);
    expect(calls).toHaveLength(3);
    expect(out.error?.message).toMatch(/429/);
    vi.restoreAllMocks();
  });

  it('stops on a non-transient request error (400): another model will not fix a bad request', async () => {
    const { impl, calls } = fakeFetch({ 'model-a': [{ status: 400, text: 'INVALID_ARGUMENT' }], 'model-b': [ok('{}')] });
    const { log } = logSpy();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a', 'model-b'], fetchImpl: impl, log }));
    expect(out.error?.message).toMatch(/400/);
    expect(calls).toEqual(['model-a']);
  });

  it("never keeps a refusal's body text, which can quote the transcript back: only the status and its enum", async () => {
    const quoted = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: "Invalid value at 'contents[0].parts[0].text': Priya's card 4111 1111 1111 1111" } });
    const { impl } = fakeFetch({ 'model-a': [{ status: 400, text: quoted }] });
    const { log, events } = logSpy();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log }));
    expect(out.error?.message).toBe('Vertex Gemini 400 INVALID_ARGUMENT');
    const logged = JSON.stringify(events.map((e) => ({ ...e, obj: { ...e.obj, err: e.obj?.err && { message: e.obj.err.message, stack: e.obj.err.stack } } })));
    expect(logged).not.toMatch(/Priya|4111|contents\[0\]/);
    // A body that isn't Vertex's JSON (a proxy's page) adds nothing but what its status means.
    const page = fakeFetch({ 'model-a': [{ status: 400, text: '<html>Priya</html>' }] });
    expect((await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: page.impl, log }))).error?.message).toBe('Vertex Gemini 400 INVALID_ARGUMENT');
  });

  it("a 500 or 503 whose body isn't readable JSON is still retried, as before (by what its status means)", async () => {
    for (const reply of [{ status: 500, text: '<html>500 Internal Server Error</html>' }, { status: 500, text: JSON.stringify([{ error: { status: 'INTERNAL', message: 'x' } }]) }, { status: 503, text: '' }]) {
      const { impl, calls } = fakeFetch({ 'model-a': [reply, ok('{"a":1}')] });
      const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log: logSpy().log }));
      expect(out.model).toBe('model-a');
      expect(calls).toEqual(['model-a', 'model-a']);
    }
  });

  it("a 2xx body that isn't JSON fails without quoting it", async () => {
    const impl = async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>Priya'), text: async () => '' });
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log: logSpy().log }));
    expect(out.error?.message).toBe('Vertex Gemini 200 unparseable body');
  });

  it('still retries what is transient by its status enum: a 500 INTERNAL, a 504 DEADLINE_EXCEEDED', async () => {
    for (const [status, enumName] of [[500, 'INTERNAL'], [504, 'DEADLINE_EXCEEDED']] as const) {
      const body = JSON.stringify({ error: { code: status, status: enumName, message: 'transcript text here' } });
      const { impl, calls } = fakeFetch({ 'model-a': [{ status, text: body }, ok('{"a":1}')] });
      const { log } = logSpy();
      const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log }));
      expect(out.model).toBe('model-a');
      expect(calls).toEqual(['model-a', 'model-a']);
    }
  });

  it('reports finishReason and flags truncated structured output', async () => {
    const { impl } = fakeFetch({ 'model-a': [ok('{"gist":"cut', 'MAX_TOKENS')] });
    const { log, events } = logSpy();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log }));
    expect(out.finishReason).toBe('MAX_TOKENS');
    expect(events.some((e) => e.level === 'warn' && e.msg === 'gemini_output_truncated')).toBe(true);
  });

  // RELEASE.md rev 11, LM4: what a truncation cost, to tell thinking that ate the budget from a long answer.
  it('logs the tokens each answer used: prompt, output and thinking', async () => {
    const reply: Reply = {
      status: 200,
      body: {
        candidates: [{ content: { parts: [{ text: '{"gist":"cut' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 52000, candidatesTokenCount: 14300, thoughtsTokenCount: 2048 },
      },
    };
    const { impl } = fakeFetch({ 'model-a': [reply] });
    const { log, events } = logSpy();
    await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log }));
    const tokens = { promptTokens: 52000, outputTokens: 14300, thoughtsTokens: 2048 };
    expect(events.find((e) => e.msg === 'gemini_output_truncated')?.obj).toMatchObject(tokens);
    expect(events.find((e) => e.msg === 'gemini_ok')?.obj).toMatchObject(tokens);
  });

  it('by default uses the registry ladder, minus retired models', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z')); // after gemini-2.5-flash retires
    const { impl, calls } = fakeFetch({ 'gemini-3.5-flash': [{ status: 404, text: 'NOT_FOUND' }] });
    const { log } = logSpy();
    const out = await callGeminiWithLadder(base({ fetchImpl: impl, log }));
    expect(calls).toEqual(['gemini-3.5-flash']); // the retired 2.5 rung is never called
    expect(out.error?.message).toMatch(/404/);
  });

  it('calls the regional Vertex endpoint it was given (data residency)', async () => {
    const urls: string[] = [];
    const { impl } = fakeFetch({ 'model-a': [ok('{"a":1}')] });
    const { log } = logSpy();
    await callGeminiWithLadder(base({
      modelLadder: ['model-a'],
      fetchImpl: async (url: string, init: unknown) => { urls.push(url); return impl(url); },
      log,
    }));
    expect(urls[0]).toMatch(/^https:\/\/australia-southeast1-aiplatform\.googleapis\.com\/v1\/projects\/p\/locations\/australia-southeast1\//);
  });

  describe('location fallback (S17, plan A2)', () => {
    const limited = { status: 429, text: '{"error":{"status":"RESOURCE_EXHAUSTED"}}' };
    // Answers by location: the URL's /locations/<loc>/ segment picks the queue.
    function byLocation(replies: Record<string, Reply[]>) {
      const urls: string[] = [];
      const impl = async (url: string) => {
        urls.push(url);
        const loc = /\/locations\/([^/]+)\//.exec(url)![1]!;
        const r = replies[loc]!.shift()!;
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body, text: async () => r.text ?? '' };
      };
      return { impl, urls };
    }
    afterEach(() => { delete process.env.VERTEX_FALLBACK_LOCATIONS; });

    it('off by default: a location that stays at 429 is the only one asked', async () => {
      const f = byLocation({ 'australia-southeast1': Array(5).fill(limited) });
      const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: f.impl, log: logSpy().log }));
      expect(out.error?.message).toMatch(/429/);
      expect(f.urls.every((u) => u.includes('/locations/australia-southeast1/'))).toBe(true);
    });

    it('asks the next location, in order, only after the primary ends on a 429; global uses the global host', async () => {
      process.env.VERTEX_FALLBACK_LOCATIONS = ' australia-southeast2 , global, australia-southeast1';
      const f = byLocation({
        'australia-southeast1': Array(5).fill(limited),
        'australia-southeast2': Array(5).fill(limited),
        global: [ok('{"g":1}')],
      });
      const { log, events } = logSpy();
      const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: f.impl, log }));
      expect(out).toMatchObject({ rawText: '{"g":1}', error: null });
      expect(f.urls.at(-1)).toMatch(/^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/p\/locations\/global\//);
      expect(f.urls.filter((u) => u.includes('/locations/australia-southeast2/'))[0]).toMatch(/^https:\/\/australia-southeast2-aiplatform\.googleapis\.com\//);
      expect(events.filter((e) => e.msg === 'gemini_location_fallback').map((e) => e.obj)).toEqual([
        { from: 'australia-southeast1', to: 'australia-southeast2' },
        { from: 'australia-southeast2', to: 'global' },
      ]);
    });

    it('an outage or a bad request is not a reason to send the data elsewhere', async () => {
      for (const failure of [{ status: 503, text: 'UNAVAILABLE' }, { status: 400, text: 'INVALID_ARGUMENT' }]) {
        const f = byLocation({ 'australia-southeast1': [failure, failure, failure], global: [ok('{}')] });
        const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: f.impl, log: logSpy().log, fallbackLocations: ['global'] }));
        expect(out.error).toBeTruthy();
        expect(f.urls.some((u) => u.includes('/locations/global/'))).toBe(false);
      }
    });

    it('falls back only when every rung ended on a 429, not when one rung was an outage', async () => {
      // Rung a: an outage (503 ×3). Rung b: quota (429 ×5). The last error is a 429, but this location is also down.
      const replies = { a: [503, 503, 503].map((s) => ({ status: s, text: 'UNAVAILABLE' })), b: Array(5).fill(limited) };
      const urls: string[] = [];
      const impl = async (url: string) => {
        urls.push(url);
        const model = /models\/([^:]+):/.exec(url)![1]! as 'a' | 'b';
        const r = url.includes('/locations/global/') ? ok('{}') : replies[model].shift()!;
        return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r as any).body, text: async () => (r as any).text ?? '' };
      };
      const out = await callGeminiWithLadder(base({ modelLadder: ['a', 'b'], fetchImpl: impl, log: logSpy().log, fallbackLocations: ['global'] }));
      expect(out.error?.message).toMatch(/429/);
      expect(urls.some((u) => u.includes('/locations/global/'))).toBe(false);
    });
  });

  it('aborts a call that hangs past the budget, instead of holding the worker until Cloud Run times out', async () => {
    const { log, events } = logSpy();
    let signalSeen: AbortSignal | undefined;
    // Never answers; only the abort signal can end it.
    const hang = (_url: string, init: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      signalSeen = init.signal;
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    });
    const started = Date.now();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a', 'model-b'], fetchImpl: hang, log, deadlineMs: 150 }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(signalSeen).toBeDefined();
    expect(out).toMatchObject({ rawText: null, model: null });
    expect(String(out.error)).toMatch(/TIME_BUDGET/);
    // It gives up rather than moving on to the next rung with no budget left.
    expect(events.find((e) => e.msg === 'gemini_timeout')?.obj).toMatchObject({ model: 'model-a', attempt: 1 });
  });

  // Plan rev 12 S3 (BLOCKERS 2026-10-06): the model hung for the whole 240 s budget on a ten-second recording,
  // and the task's retry answered in 3 s. With a per-attempt cap, a hung attempt is cut and asked again while
  // the budget lasts, instead of spending all of it on one call.
  it('cuts a hung attempt at its own cap and asks again, within the budget', async () => {
    const { log, events } = logSpy();
    let calls = 0;
    const hangThenAnswer = (_url: string, init: { signal?: AbortSignal }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ok('{"gist":"x"}').body, text: async () => '' });
    };
    const started = Date.now();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: hangThenAnswer, log, deadlineMs: 5_000, attemptTimeoutMs: 100 }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(out).toMatchObject({ rawText: '{"gist":"x"}', model: 'model-a', error: null });
    expect(calls).toBe(2);
    expect(events.find((e) => e.msg === 'gemini_attempt_timeout')?.obj).toMatchObject({ model: 'model-a', attempt: 1, attemptTimeoutMs: 100 });
    expect(events.find((e) => e.msg === 'gemini_ok')?.obj).toMatchObject({ attempt: 2 });
  });

  it('every attempt hung: it moves to the next rung, and stops with TIME_BUDGET once the budget is gone', async () => {
    const { log, events } = logSpy();
    const seen: string[] = [];
    const hang = (url: string, init: { signal?: AbortSignal }) => {
      seen.push(/models\/([^:]+):generateContent/.exec(url)![1]!);
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    };
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a', 'model-b'], fetchImpl: hang, log, deadlineMs: 1_000, attemptTimeoutMs: 150 }));
    expect(String(out.error)).toMatch(/TIME_BUDGET/);
    // Three cut attempts on model-a, then model-b, until the budget ends.
    expect(seen.slice(0, 4)).toEqual(['model-a', 'model-a', 'model-a', 'model-b']);
    expect(events.filter((e) => e.msg === 'gemini_attempt_timeout').length).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.msg === 'gemini_model_exhausted' && e.obj.model === 'model-a')).toBe(true);
  });

  it('with no per-attempt cap, an attempt may use the whole budget, as before (the summarizer)', async () => {
    const { log, events } = logSpy();
    let calls = 0;
    const hang = (_url: string, init: { signal?: AbortSignal }) => {
      calls += 1;
      return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    };
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: hang, log, deadlineMs: 200 }));
    expect(String(out.error)).toMatch(/TIME_BUDGET/);
    expect(calls).toBe(1);
    expect(events.some((e) => e.msg === 'gemini_attempt_timeout')).toBe(false);
  });
});

describe('attemptTimeoutForAudioMs: how long one call may take on audio of a given length', () => {
  const { attemptTimeoutForAudioMs, RETRY_DEADLINE_MS } = require('../packages/ai/src/intelligence.cjs');

  it('grows with the audio, from a floor to a ceiling inside the ladder budget', () => {
    expect(attemptTimeoutForAudioMs(10)).toBe(60_000);
    expect(attemptTimeoutForAudioMs(5 * 60)).toBe(105_000);
    expect(attemptTimeoutForAudioMs(10 * 60)).toBe(150_000);
    expect(attemptTimeoutForAudioMs(60 * 60)).toBe(150_000);
    // Always room for a second attempt inside the budget.
    expect(attemptTimeoutForAudioMs(60 * 60)).toBeLessThan(RETRY_DEADLINE_MS);
  });

  it('an unknown length gets no cap (undefined): the whole budget, as before', () => {
    for (const d of [undefined, null, NaN, 0, -5]) expect(attemptTimeoutForAudioMs(d)).toBeUndefined();
  });
});

// 2026-10-01: thinkingBudget was sent to every rung. Some of gemini-3.5-flash's Sydney backends refuse it ("Thinking
// budget is not supported for this model", 7 of 12 identical calls), so over half of all first attempts failed.
describe("the thinking cap is each rung's own field", () => {
  const { thinkingConfigFor } = require('../packages/ai/src/models.cjs');
  function recording(replies: Record<string, Reply[]>) {
    const bodies: Array<{ model: string; generationConfig: any }> = [];
    const f = fakeFetch(replies);
    const impl = async (url: string, init: { body: string }) => {
      bodies.push({ model: /models\/([^:]+):generateContent/.exec(url)![1]!, generationConfig: JSON.parse(init.body).generationConfig });
      return f.impl(url);
    };
    return { impl, bodies };
  }

  it('gemini-3.x gets thinkingLevel, gemini-2.5 gets thinkingBudget, and neither gets the other', () => {
    expect(thinkingConfigFor('gemini-3.5-flash', { budget: 2048 })).toEqual({ thinkingLevel: 'LOW' });
    expect(thinkingConfigFor('gemini-2.5-flash', { budget: 2048 })).toEqual({ thinkingBudget: 2048 });
    expect(thinkingConfigFor('gemini-3.5-flash', { budget: 1024, level: 'MEDIUM' })).toEqual({ thinkingLevel: 'MEDIUM' });
  });

  it('each rung of the ladder is asked with its own field, and the rest of the config is kept', async () => {
    const r = recording({ 'gemini-3.5-flash': [{ status: 404 }], 'gemini-2.5-flash': [ok('{"a":1}')] });
    const { log } = logSpy();
    const out = await callGeminiWithLadder(base({ log, fetchImpl: r.impl, modelLadder: ['gemini-3.5-flash', 'gemini-2.5-flash'], thinking: { budget: 2048 }, generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 16384 } }));
    expect(out.model).toBe('gemini-2.5-flash');
    expect(r.bodies.map((b) => [b.model, b.generationConfig.thinkingConfig])).toEqual([
      ['gemini-3.5-flash', { thinkingLevel: 'LOW' }],
      ['gemini-2.5-flash', { thinkingBudget: 2048 }],
    ]);
    expect(r.bodies[0].generationConfig.maxOutputTokens).toBe(16384);
  });

  it('a 400 with a cap sent is asked again without it, on the same rung, and answers', async () => {
    const r = recording({ 'gemini-3.5-flash': [{ status: 400, text: JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'Thinking level is not supported for this model.' } }) }, ok('{"a":1}')] });
    const { log, events } = logSpy();
    const out = await callGeminiWithLadder(base({ log, fetchImpl: r.impl, modelLadder: ['gemini-3.5-flash'], thinking: { budget: 2048 }, generationConfig: { maxOutputTokens: 100 } }));
    expect(out.rawText).toBe('{"a":1}');
    expect(r.bodies.map((b) => b.generationConfig.thinkingConfig)).toEqual([{ thinkingLevel: 'LOW' }, undefined]);
    expect(events.filter((e) => e.msg === 'gemini_thinking_cap_refused')).toHaveLength(1);
    expect(events.some((e) => e.msg === 'gemini_non_retryable')).toBe(false);
  });

  it('a 400 that persists without the cap is still a refusal, after one extra call', async () => {
    const bad = { status: 400, text: JSON.stringify({ error: { status: 'INVALID_ARGUMENT' } }) };
    const r = recording({ 'gemini-3.5-flash': [bad, bad] });
    const { log, events } = logSpy();
    const out = await callGeminiWithLadder(base({ log, fetchImpl: r.impl, modelLadder: ['gemini-3.5-flash'], thinking: { budget: 2048 } }));
    expect(out.rawText).toBeNull();
    expect(r.bodies).toHaveLength(2);
    expect(events.some((e) => e.msg === 'gemini_non_retryable')).toBe(true);
  });

  it('with no cap asked for, nothing is added and a 400 is refused at once', async () => {
    const r = recording({ 'gemini-3.5-flash': [{ status: 400, text: '' }] });
    const { log } = logSpy();
    const out = await callGeminiWithLadder(base({ log, fetchImpl: r.impl, modelLadder: ['gemini-3.5-flash'], generationConfig: { maxOutputTokens: 5 } }));
    expect(out.rawText).toBeNull();
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].generationConfig).toEqual({ maxOutputTokens: 5 });
  });
});
