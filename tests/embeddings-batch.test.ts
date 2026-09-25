import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// The embedder's Vertex calls: chunks go in batches (a 3-hour transcript is a
// handful of calls, not ~80), vectors come back in chunk order, and a 429/5xx
// or a dropped connection is retried in place instead of failing the note.
// fetch and the token are fakes: nothing reaches Google.
const require = createRequire(import.meta.url);
const { embedChunks, EMBED_BATCH, EMBED_MAX_ATTEMPTS, EMBED_DIM } = require('@algominutes/ai/embeddings.cjs');

const noop = () => {};
const warns: string[] = [];
const log: any = { info: noop, error: noop, warn: (_o: unknown, m: string) => void warns.push(m) };
const getToken = async () => ({ token: 't', projectId: async () => 'p' });
const chunks = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `chunk ${i}` }));
const vectorFor = (text: string) => Array.from({ length: EMBED_DIM }, () => Number(text.split(' ')[1]));
const ok = (instances: any[]) => ({
  ok: true, status: 200,
  json: async () => ({ predictions: instances.map((i) => ({ embeddings: { values: vectorFor(i.content) } })) }),
  text: async () => '',
});
const fail = (status: number) => ({ ok: false, status, json: async () => ({}), text: async () => `error ${status}` });

function fakeFetch(script: Array<'ok' | number | 'net'> = []) {
  const calls: any[] = [];
  const impl = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body.instances.length);
    const step = script.shift() ?? 'ok';
    if (step === 'net') throw new Error('socket hang up');
    return step === 'ok' ? ok(body.instances) : fail(step);
  };
  return { impl, calls };
}
const run = (n: number, f: ReturnType<typeof fakeFetch>) => embedChunks({
  chunks: chunks(n), log, project: 'p', location: 'l', fetchImpl: f.impl, getToken, sleep: async () => {},
});

describe('embedChunks', () => {
  it('sends chunks in batches and returns one vector per chunk, in order', async () => {
    const f = fakeFetch();
    const vectors = await run(2 * EMBED_BATCH + 5, f);
    expect(f.calls).toEqual([EMBED_BATCH, EMBED_BATCH, 5]);
    expect(vectors.map((v: number[]) => v[0])).toEqual(Array.from({ length: 2 * EMBED_BATCH + 5 }, (_, i) => i));
  });

  it('a 429, a 503 or a dropped connection is retried in place', async () => {
    const f = fakeFetch([429, 503, 'net', 'ok']);
    const vectors = await run(3, f);
    expect(f.calls).toEqual([3, 3, 3, 3]);
    expect(vectors).toHaveLength(3);
    expect(warns).toEqual(expect.arrayContaining(['vertex_embed_retry', 'vertex_embed_network_retry']));
  });

  it(`gives up after ${EMBED_MAX_ATTEMPTS} attempts, and never retries a request Vertex refused (4xx)`, async () => {
    const busy = fakeFetch(Array(EMBED_MAX_ATTEMPTS).fill(503));
    await expect(run(3, busy)).rejects.toThrow('vertex_embed_failed: 503');
    expect(busy.calls).toHaveLength(EMBED_MAX_ATTEMPTS);
    const refused = fakeFetch([400]);
    await expect(run(3, refused)).rejects.toThrow('vertex_embed_failed: 400');
    expect(refused.calls).toHaveLength(1);
  });

  it('an answer with the wrong number of vectors is refused, not misaligned', async () => {
    const impl = async (_u: string, init: any) => ok(JSON.parse(init.body).instances.slice(1));
    await expect(embedChunks({ chunks: chunks(3), log, project: 'p', location: 'l', fetchImpl: impl, getToken, sleep: async () => {} }))
      .rejects.toThrow('embedding_missing_values');
  });
});
