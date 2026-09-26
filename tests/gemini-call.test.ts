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

  it('stops on a non-transient request error (400): another model will not fix a bad request', async () => {
    const { impl, calls } = fakeFetch({ 'model-a': [{ status: 400, text: 'INVALID_ARGUMENT' }], 'model-b': [ok('{}')] });
    const { log } = logSpy();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a', 'model-b'], fetchImpl: impl, log }));
    expect(out.error?.message).toMatch(/400/);
    expect(calls).toEqual(['model-a']);
  });

  it('reports finishReason and flags truncated structured output', async () => {
    const { impl } = fakeFetch({ 'model-a': [ok('{"gist":"cut', 'MAX_TOKENS')] });
    const { log, events } = logSpy();
    const out = await callGeminiWithLadder(base({ modelLadder: ['model-a'], fetchImpl: impl, log }));
    expect(out.finishReason).toBe('MAX_TOKENS');
    expect(events.some((e) => e.level === 'warn' && e.msg === 'gemini_output_truncated')).toBe(true);
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
});
