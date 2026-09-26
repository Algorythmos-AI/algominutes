import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// What users type into search stays out of the logs, scrubbed or not: the
// embed lines carry the query's length. (Chat already keeps meeting content
// out of its logs.)
const require = createRequire(import.meta.url);
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'test-project';
const { embedQuery } = require('../services/api/src/routes/search-and-chat.cjs');

const QUERY = 'budget for the Henderson account renewal';
function capture() {
  const lines: Array<{ level: string; o: any; m: string }> = [];
  const at = (level: string) => (o: any, m: string) => void lines.push({ level, o, m });
  return { lines, log: { info: at('info'), warn: at('warn'), error: at('error') } };
}
const authHeader = async () => 'Bearer test';

afterEach(() => { vi.useRealTimers(); });

describe('search query logging', () => {
  it('a failed embed call logs the length, not the text', async () => {
    const c = capture();
    const fetchImpl = async () => { throw new Error('connect ECONNREFUSED'); };
    await expect(embedQuery(null, QUERY, c.log, { fetchImpl, authHeader })).rejects.toThrow('ECONNREFUSED');
    expect(c.lines.map((l) => l.m)).toEqual(['embed_query_failed']);
    expect(c.lines[0].o.queryLen).toBe(QUERY.length);
    expect(JSON.stringify(c.lines[0].o)).not.toContain('Henderson');
  });

  it('a timed-out embed call logs the length, not the text', async () => {
    vi.useFakeTimers();
    const c = capture();
    const fetchImpl = (_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const done = embedQuery(null, QUERY, c.log, { fetchImpl, authHeader });
    const settled = expect(done).rejects.toThrow('embed_query_timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(c.lines.map((l) => l.m)).toEqual(['embed_query_timeout']);
    expect(c.lines[0].o.queryLen).toBe(QUERY.length);
    expect(JSON.stringify(c.lines[0].o)).not.toContain('Henderson');
  });

  it('a successful embed call logs the length', async () => {
    const c = capture();
    const fetchImpl = async () => ({ ok: true, json: async () => ({ predictions: [{ embeddings: { values: [0.1, 0.2] } }] }) });
    expect(await embedQuery(null, QUERY, c.log, { fetchImpl, authHeader })).toEqual([0.1, 0.2]);
    expect(c.lines.map((l) => [l.m, l.o.queryLen])).toEqual([['embed_query_ok', QUERY.length]]);
  });
});
