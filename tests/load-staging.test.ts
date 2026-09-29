import { describe, it, expect } from 'vitest';
// @ts-expect-error: plain ESM script, no type declarations
import { loadConfig, runLimited, percentile, summarise, peakMetric, runLoad, METRICS, CPU_LIMIT } from '../scripts/load-staging.mjs';

// RELEASE.md PR 31: load on staging, as many pipeline e2e journeys at once. It spends real minutes, so it
// plans until LOAD_CONFIRM=run; these tests stand in for the journey and for Cloud Monitoring.
describe('the load plan', () => {
  it('defaults to 50 users of 15 minutes, all at once, and costs it before anything runs', () => {
    expect(loadConfig({})).toMatchObject({ users: 50, minutes: 15, parallel: 50, confirmed: false, estimate: { minutes: 750, aud: 22.5 } });
    expect(loadConfig({ USERS: '10', MINUTES: '2', PARALLEL: '99', LOAD_CONFIRM: 'run', COGS_AUD_PER_MINUTE: '0.05' }))
      .toMatchObject({ users: 10, minutes: 2, parallel: 10, confirmed: true, estimate: { minutes: 20, aud: 1 } });
    expect(loadConfig({ LOAD_CONFIRM: 'yes' }).confirmed).toBe(false);
    for (const bad of [{ USERS: '0' }, { USERS: '1.5' }, { MINUTES: '1000' }, { PARALLEL: '-1' }]) expect(() => loadConfig(bad), JSON.stringify(bad)).toThrow(/whole number/);
  });

  it('runs at most so many at once, and keeps the results in order', async () => {
    let live = 0;
    let most = 0;
    const tasks = Array.from({ length: 9 }, (_, i) => async () => {
      live += 1;
      most = Math.max(most, live);
      await new Promise((r) => setTimeout(r, 5 + (i % 3)));
      live -= 1;
      return i;
    });
    expect(await runLimited(tasks, 3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(most).toBe(3);
  });

  it('reports p50 and p95, and fails on any unfinished recording or Cloud SQL at 70%', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 95)).toBe(95);
    expect(percentile([], 50)).toBeNull();
    const runs = [{ ok: true, tookSec: 100 }, { ok: true, tookSec: 300 }, { ok: true, tookSec: 200 }];
    expect(summarise(runs, { cloudSqlCpu: 0.4 })).toMatchObject({ users: 3, ready: 3, failed: 0, timeToSummarySec: { p50: 200, p95: 300, max: 300 }, ok: true });
    expect(summarise([...runs, { ok: false, tookSec: null }]).ok).toBe(false);
    expect(summarise(runs, { cloudSqlCpu: CPU_LIMIT }).ok).toBe(false);
  });

  it('reads the peak of a metric over the run, across every series', async () => {
    const asked: string[] = [];
    const fetch = async (url: string, init: { headers: Record<string, string> }) => {
      asked.push(url);
      expect(init.headers.Authorization).toBe('Bearer tok');
      return { ok: true, json: async () => ({ timeSeries: [{ points: [{ value: { doubleValue: 0.31 } }, { value: { doubleValue: 0.52 } }] }, { points: [{ value: { int64Value: '3' } }] }] }) };
    };
    expect(await peakMetric({ project: 'p', filter: METRICS.cloudSqlCpu, startMs: 0, endMs: 60_000, token: 'tok', fetch })).toBe(3);
    const u = new URL(asked[0]);
    expect(u.pathname).toBe('/v3/projects/p/timeSeries');
    expect(u.searchParams.get('filter')).toBe(METRICS.cloudSqlCpu);
    expect(u.searchParams.get('interval.startTime')).toBe('1970-01-01T00:00:00.000Z');
    expect(await peakMetric({ project: 'p', filter: 'x', startMs: 0, endMs: 1, token: 't', fetch: async () => ({ ok: false }) })).toBeNull();
  });
});

describe('the run', () => {
  const lines = () => {
    const out: string[] = [];
    return { out, write: (s: string) => out.push(s) };
  };

  it('only plans until LOAD_CONFIRM=run: no user is made', async () => {
    const { out, write } = lines();
    let runs = 0;
    const r = await runLoad({ config: loadConfig({ USERS: '3' }), e2e: {}, recording: 'r', run: async () => { runs += 1; return { ok: true }; }, write });
    expect(r).toEqual({ ran: false });
    expect(runs).toBe(0);
    expect(out.join('')).toMatch(/3 users × 15 min.*A\$1\.35[\s\S]*LOAD_CONFIRM=run/);
  });

  it('runs every user, labels each one\'s lines, survives one that throws, and reads the peaks', async () => {
    const { out, write } = lines();
    let i = 0;
    const run = async ({ minutes, write: w }: { minutes: number; write: (s: string) => void }) => {
      i += 1;
      expect(minutes).toBe(2);
      w('ok  step\n');
      if (i === 2) throw new Error('boom');
      return { ok: true, tookSec: 100 * i };
    };
    const fetch = async () => ({ ok: true, json: async () => ({ timeSeries: [{ points: [{ value: { doubleValue: 0.5 } }] }] }) });
    const r = await runLoad({ config: loadConfig({ USERS: '3', MINUTES: '2', LOAD_CONFIRM: 'run', MONITOR_PROJECT: 'p' }), e2e: {}, recording: 'r', run, token: 't', fetch, write });
    expect(r.report).toMatchObject({ users: 3, ready: 2, failed: 1, peaks: { cloudSqlCpu: 0.5, transcoderInstances: 0.5 }, ok: false });
    expect(out.join('')).toMatch(/\[001\] ok {2}step/);
    expect(out.join('')).toMatch(/\[002\] FAIL the run threw \(boom\)/);
  });
});
